import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { buildReconciliationBlock } from '@/lib/outcomes/adapters/acuity/reconciliation-query'
import { purgePaidMeasurement } from './paid-measurement-purge'
import { insertOutcomeOutcome, removeAccountOutcomes } from './outcome-fixture'

// buildReconciliationBlock read the appointment ledger (now outcomes) with NO account filter. The
// ledger is account-agnostic by table design, so every account's bookings were reconciled into one
// account's report. It also treated a staff-created booking as a delivery FAILURE, even though the
// sender's own R4 origin gate intentionally never sends those.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT_A = '00000000-0000-4000-8000-0000000000d1'
const ACCT_B = '00000000-0000-4000-8000-0000000000d2'
const BASE = 993000000
const IDS = { a1: BASE + 1, a2: BASE + 2, b1: BASE + 3, staff: BASE + 4, unknownOrigin: BASE + 5 }
const SINCE = '2026-05-01'
const externalIds = (ids: number[]) => ids.map(String)
const UNTIL = '2026-05-31'

let c: pg.Client
const connect = async () => { const x = new pg.Client({ connectionString: DB }); await x.connect(); return x }

/**
 * Seed one appointment. `originObserved` mirrors the real writer: only a BY-ID payload (one that
 * actually carried Acuity's scheduledBy key) sets origin_observed_at. A sweep/list observation
 * leaves it null, which is what makes the booking origin-UNKNOWN rather than assumed-eligible.
 */
async function seedAppt(
  id: number, account: string, scheduledBy: string | null | undefined,
  opts: { originObserved?: boolean } = {},
) {
  const observed = opts.originObserved ?? true
  // scheduled_by -> origin: a staff value is staff_or_manual; a by-id observed client booking is
  // website; a row whose origin no by-id payload carried keeps the column default ('unknown').
  const origin = scheduledBy ? { origin: 'staff_or_manual' } : observed ? { origin: 'website' } : {}
  await insertOutcomeOutcome(c, account, id, {
    gross_value: 300, status: 'confirmed', occurred_at: '2026-05-10T12:00:00Z',
    business_date: '2026-05-10', observation_source: 'webhook', ...origin,
    origin_observed_at: observed ? '2026-05-10T12:00:00Z' : null,
    origin_observed_source: observed ? 'webhook' : null,
  })
}

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  c = await connect()
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
  await c.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
    SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [externalIds(Object.values(IDS))])
  await purgePaidMeasurement(c, [ACCT_A, ACCT_B])
  await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [externalIds(Object.values(IDS))])
  await removeAccountOutcomes(c, [ACCT_A, ACCT_B])
  await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_rec_a'), ($2,'act_rec_b')`, [ACCT_A, ACCT_B])

  await seedAppt(IDS.a1, ACCT_A, undefined)
  await seedAppt(IDS.a2, ACCT_A, undefined)
  await seedAppt(IDS.b1, ACCT_B, undefined)          // OTHER account
  await seedAppt(IDS.staff, ACCT_A, 'staff@example.invalid') // staff-created: never CAPI-eligible
}, 60000)

afterAll(async () => {
  if (c) {
    await c.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
      SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [externalIds(Object.values(IDS))])
    await purgePaidMeasurement(c, [ACCT_A, ACCT_B])
    await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [externalIds(Object.values(IDS))])
    await removeAccountOutcomes(c, [ACCT_A, ACCT_B])
    await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
    await c.end()
  }
})

describe('reconciliation — ACCOUNT ISOLATION', () => {
  it('account A reconciles ONLY its own bookings', async () => {
    const r = await buildReconciliationBlock(ACCT_A, SINCE, UNTIL)
    // a1 + a2 are eligible; the staff row is excluded; account B is not visible at all.
    expect(r.summary.total).toBe(2)
    expect(r.ineligible).toBe(1)
  })

  it('account B sees only its own single booking', async () => {
    const r = await buildReconciliationBlock(ACCT_B, SINCE, UNTIL)
    expect(r.summary.total).toBe(1)
    expect(r.ineligible).toBe(0)
  })

  it('an unknown account reconciles NOTHING — never the whole ledger', async () => {
    const r = await buildReconciliationBlock('00000000-0000-4000-8000-00000000dead', SINCE, UNTIL)
    expect(r.summary.total).toBe(0)
  })
})

describe('reconciliation — CAPI eligibility', () => {
  it('a staff-created booking is EXCLUDED, not called a delivery failure', async () => {
    const r = await buildReconciliationBlock(ACCT_A, SINCE, UNTIL)
    const text = r.lines.join('\n')
    // Closure: the two ineligible reasons are now reported SEPARATELY, because "staff-created"
    // is proven ineligible while "origin unknown" means eligibility itself was never established.
    expect(text).toMatch(/NOT CAPI-eligible/)
    expect(text).toMatch(/1 staff-created/)
    expect(text).toMatch(/0 with UNKNOWN origin/)
    expect(text).toMatch(/intentionally not sent, NOT a delivery failure/)
    // The two eligible rows ARE counted as delivery-missing (no deliveries seeded), the staff row is not.
    expect(r.summary.byState.capi_delivery_missing).toBe(2)
  })

  it('an ORIGIN-UNKNOWN booking is excluded as UNRESOLVED, not as proven ineligible', async () => {
    // scheduled_by = null observed through a SWEEP (list-shaped payload) never carried the field, so
    // null there is an ABSENCE, not a client-booked value.
    const SWEEP_ID = BASE + 6
    // Observed ONLY by a sweep: no by-id payload ever carried the origin.
    await seedAppt(SWEEP_ID, ACCT_A, undefined, { originObserved: false })
    try {
      const r = await buildReconciliationBlock(ACCT_A, SINCE, UNTIL)
      expect(r.ineligible).toBe(2) // the staff row + this origin-unknown row
      const text = r.lines.join('\n')
      expect(text).toMatch(/1 with UNKNOWN origin/)
      expect(text).toMatch(/eligibility itself is unresolved/)
      // It is NOT counted as a delivery failure.
      expect(r.summary.total).toBe(2)
    } finally {
      await purgePaidMeasurement(c, [ACCT_A])
      await c.query(`DELETE FROM outcomes WHERE ad_account_id=$1 AND external_id=$2`, [ACCT_A, String(SWEEP_ID)])
    }
  })

  it('a window of ONLY ineligible bookings reports zero reconcilable rows with the exclusion count', async () => {
    await purgePaidMeasurement(c, [ACCT_A])
    await c.query(`DELETE FROM outcomes WHERE ad_account_id=$1 AND external_id = ANY($2::text[])`, [ACCT_A, externalIds([IDS.a1, IDS.a2])])
    const r = await buildReconciliationBlock(ACCT_A, SINCE, UNTIL)
    expect(r.summary.total).toBe(0)
    expect(r.ineligible).toBe(1)
    expect(r.lines.join('\n')).toMatch(/not a delivery failure/i)
    // restore for repeatability
    await seedAppt(IDS.a1, ACCT_A, undefined)
    await seedAppt(IDS.a2, ACCT_A, undefined)
  })
})

describe('reconciliation — modelled disagreement is NOT EVALUATED', () => {
  it('renders UNAVAILABLE rather than a measured zero', async () => {
    const r = await buildReconciliationBlock(ACCT_A, SINCE, UNTIL)
    const text = r.lines.join('\n')
    expect(text).toMatch(/Modelled-attribution disagreement: NOT EVALUATED/)
    expect(text).toMatch(/UNAVAILABLE, not zero/)
    expect(text).not.toMatch(/Modelled-attribution disagreement: 0/)
  })

  it('the block stays aggregate-only and PII-free', async () => {
    const text = (await buildReconciliationBlock(ACCT_A, SINCE, UNTIL)).lines.join('\n')
    expect(text).not.toMatch(/[\w.]+@[\w.]+\.\w+/)
    expect(text).not.toMatch(/first_name|last_name|phone/i)
    // No appointment-level identifiers leak into the aggregate block.
    expect(text).not.toMatch(new RegExp(String(IDS.a1)))
  })
})
