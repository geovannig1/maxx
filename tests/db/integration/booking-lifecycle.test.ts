import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { buildReconciliationBlock } from '@/lib/outcomes/adapters/acuity/reconciliation-query'
import { toLedgerRow, upsertAppointments } from '@/lib/outcomes/adapters/acuity/ledger'
import { getAdminClient } from '@/lib/supabase/admin'
import { purgePaidMeasurement } from './paid-measurement-purge'
import { removeAccountOutcomes } from './outcome-fixture'

// THE FULL BOOKING LIFECYCLE: webhook -> live CAPI acceptance -> nightly sweep -> reconciliation.
//
// THE DEFECT: eligibility was decided from `observation_source`, which records the LATEST WRITER.
// The nightly sweep re-upserts every recent row with observation_source='sweep' while leaving
// the origin unset, so a genuine client booking — INCLUDING one with an accepted live CAPI delivery
// — was reclassified 'origin_unknown' and dropped from reconciliation the day after it was observed.
// Real delivery evidence vanished from reports.
//
// Origin provenance (`origin_observed_at`) is durable: only a by-id payload writes it, and no sweep
// clears it. These tests run the REAL ledger writer, so a regression in toLedgerRow fails them.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000b1'
const BASE = 995000000
const IDS = { client: BASE + 1, staff: BASE + 2, listOnly: BASE + 3, sweepKey: BASE + 4, reStamp: BASE + 5 }
const SINCE = '2026-05-01', UNTIL = '2026-05-31'
const CREATED = '2026-05-10T12:00:00Z'
const EXTERNAL_IDS = Object.values(IDS).map(String)

let c: pg.Client

/** A BY-ID payload — carries the scheduledBy key, exactly as getAppointment() returns. */
const byId = (id: number, scheduledBy: string | null) =>
  ({ id, scheduledBy, datetimeCreated: CREATED, price: 300, canceled: false, forms: [] }) as never
/** A LIST payload — omits scheduledBy entirely, exactly as the sweep's list fetch returns. */
const listShaped = (id: number) =>
  ({ id, datetimeCreated: CREATED, price: 300, canceled: false, forms: [] }) as never
/** A LIST payload that DOES carry the key. Acuity's list response shape is an external fact we have
 *  NOT verified; the origin contract must hold either way. */
const listShapedWithKey = (id: number) =>
  ({ id, scheduledBy: null, datetimeCreated: CREATED, price: 300, canceled: false, forms: [] }) as never

const row = async (id: number) =>
  (await c.query(`SELECT origin, observation_source, origin_observed_at, origin_observed_source FROM outcomes WHERE ad_account_id=$1 AND external_id=$2`, [ACCT, String(id)])).rows[0]
/** The outcome uuid the ledger writer recorded for one Acuity id (the conversion-delivery key). */
const outcomeId = async (id: number): Promise<string> =>
  (await c.query(`SELECT id FROM outcomes WHERE ad_account_id=$1 AND external_id=$2`, [ACCT, String(id)])).rows[0].id

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  c = new pg.Client({ connectionString: DB }); await c.connect()
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
  await c.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
    SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [EXTERNAL_IDS])
  await purgePaidMeasurement(c, [ACCT])
  await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
  await removeAccountOutcomes(c, [ACCT])
  await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_lifecycle')`, [ACCT])
}, 60000)

afterAll(async () => {
  if (c) {
    await c.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
      SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [EXTERNAL_IDS])
    await purgePaidMeasurement(c, [ACCT])
    await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
    await removeAccountOutcomes(c, [ACCT])
    await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
    await c.end()
  }
})

describe('booking lifecycle: webhook -> live acceptance -> sweep -> reconciliation', () => {
  it('a client booking stays CAPI-ELIGIBLE after the nightly sweep overwrites observation_source', async () => {
    const db = getAdminClient()

    // 1. WEBHOOK observes it by id: scheduledBy explicitly null = client-booked.
    await upsertAppointments([toLedgerRow(byId(IDS.client, null), ACCT, 'webhook')], db)
    let r = await row(IDS.client)
    expect(r.observation_source).toBe('webhook')
    expect(r.origin_observed_at).not.toBeNull()
    expect(r.origin_observed_source).toBe('webhook')

    // 2. A LIVE CAPI delivery is accepted for it.
    await c.query(
      `SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [await outcomeId(IDS.client), `acuity-${IDS.client}`, CREATED, 300, 'USD', 'live', 1, null, null, 'v25.0'])

    // 3. The NIGHTLY SWEEP re-upserts from a LIST payload (no scheduledBy key).
    await upsertAppointments([toLedgerRow(listShaped(IDS.client), ACCT, 'sweep')], db)
    r = await row(IDS.client)
    expect(r.observation_source).toBe('sweep')          // the latest writer moved...
    expect(r.origin_observed_source).toBe('webhook')    // ...but origin provenance is DURABLE
    expect(r.origin_observed_at).not.toBeNull()

    // 4. RECONCILIATION still sees it. Before the fix this returned total=0, ineligible=1 — the live
    //    delivery evidence disappeared from the report.
    const rec = await buildReconciliationBlock(ACCT, SINCE, UNTIL)
    expect(rec.summary.total).toBe(1)
    expect(rec.ineligible).toBe(0)
    // ...and it is NOT counted as a delivery failure, because the delivery was accepted.
    expect(rec.summary.byState.capi_delivery_missing).toBe(0)
  }, 60000)

  // An earlier version gated the origin write on the PAYLOAD'S SHAPE. If Acuity's list endpoint returns a
  // scheduledBy key, the sweep manufactured an origin observation it never made — promoting an
  // origin-UNKNOWN booking to eligible and stamping the SWEEP's clock as the observation time. The
  // rule is now enforced on the WRITER'S ROLE, so it holds whatever Acuity's list response contains.
  it('a SWEEP carrying scheduledBy cannot manufacture an origin for a never-observed booking', async () => {
    const db = getAdminClient()

    await upsertAppointments([toLedgerRow(listShapedWithKey(IDS.sweepKey), ACCT, 'sweep')], db)
    const r = await row(IDS.sweepKey)
    expect(r.origin_observed_at).toBeNull()
    expect(r.origin_observed_source).toBeNull()

    // ...so reconciliation reports it as origin-UNKNOWN, not as a proven client booking: it is
    // counted ineligible and named as unresolved rather than silently entering the delivery states.
    const rec = await buildReconciliationBlock(ACCT, SINCE, UNTIL)
    expect(rec.ineligible).toBeGreaterThanOrEqual(1)
    expect(rec.lines.join('\n')).toMatch(/origin UNKNOWN|UNKNOWN origin/)
  }, 60000)

  it('a SWEEP carrying scheduledBy cannot RE-STAMP an origin already established by a webhook', async () => {
    const db = getAdminClient()

    await upsertAppointments([toLedgerRow(byId(IDS.reStamp, null), ACCT, 'webhook')], db)
    const first = await row(IDS.reStamp)
    expect(first.origin_observed_source).toBe('webhook')

    await upsertAppointments([toLedgerRow(listShapedWithKey(IDS.reStamp), ACCT, 'sweep')], db)
    const after = await row(IDS.reStamp)
    expect(after.origin_observed_source).toBe('webhook')
    // The observation TIME is part of the fact: a sweep must not move it to its own clock.
    expect(new Date(after.origin_observed_at).toISOString())
      .toBe(new Date(first.origin_observed_at).toISOString())
  }, 60000)

  it('a STAFF-created booking stays ineligible across the same lifecycle', async () => {
    const db = getAdminClient()
    await upsertAppointments([toLedgerRow(byId(IDS.staff, 'staff@example.invalid'), ACCT, 'webhook')], db)
    await upsertAppointments([toLedgerRow(listShaped(IDS.staff), ACCT, 'sweep')], db)
    const r = await row(IDS.staff)
    expect(r.origin).toBe('staff_or_manual') // the sweep did not clobber the origin
    const rec = await buildReconciliationBlock(ACCT, SINCE, UNTIL)
    expect(rec.ineligible).toBeGreaterThanOrEqual(1)
    expect(rec.lines.join('\n')).toMatch(/staff-created/)
  }, 60000)

  it('a booking ONLY ever seen in a list payload is origin-UNKNOWN, never assumed eligible', async () => {
    const db = getAdminClient()
    await upsertAppointments([toLedgerRow(listShaped(IDS.listOnly), ACCT, 'sweep')], db)
    const r = await row(IDS.listOnly)
    expect(r.origin).not.toBe('staff_or_manual')
    expect(r.origin_observed_at).toBeNull() // never observed through a by-id path
    const rec = await buildReconciliationBlock(ACCT, SINCE, UNTIL)
    expect(rec.lines.join('\n')).toMatch(/with UNKNOWN origin/)
  }, 60000)

  it('a FAILED delivery on an eligible booking is still reconciled as a delivery gap', async () => {
    const db = getAdminClient()
    await upsertAppointments([toLedgerRow(byId(IDS.listOnly, null), ACCT, 'webhook')], db)
    await c.query(
      `SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [await outcomeId(IDS.listOnly), `acuity-${IDS.listOnly}`, CREATED, 300, 'USD', 'live', 0, 'no_events_received', 'no_events_received', 'v25.0'])
    await upsertAppointments([toLedgerRow(listShaped(IDS.listOnly), ACCT, 'sweep')], db)

    const rec = await buildReconciliationBlock(ACCT, SINCE, UNTIL)
    // Now eligible (a by-id path observed it), and its failed delivery is a real DELIVERY GAP —
    // which is exactly the evidence the old classification was hiding.
    expect(rec.summary.byState.capi_delivery_missing).toBeGreaterThanOrEqual(1)
  }, 60000)
})
