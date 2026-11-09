import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { purgePaidMeasurement } from './paid-measurement-purge'
import { insertOutcomeOutcome, removeAccountOutcomes } from './outcome-fixture'

// ADVERSARIAL CONCURRENCY for the rebuilt CAPI delivery contract, against the REAL local
// Supabase. PGlite has one connection and cannot produce two writers genuinely racing the same
// event_id; that race is exactly where the earlier overwrite semantics destroyed an acceptance.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000c1'
const BASE = 992000000
const IDS = { race: BASE + 1, mixed: BASE + 2, cross: BASE + 3, testlive: BASE + 4, apiver: BASE + 5 }
const EXTERNAL_IDS = Object.values(IDS).map(String)
/** Acuity id -> the outcome uuid seeded for it (the conversion-delivery key). */
const OUTCOME: Record<number, string> = {}

let admin: pg.Client
const connect = async () => { const c = new pg.Client({ connectionString: DB }); await c.connect(); return c }

const RPC = `SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r`

function args(id: number, over: Partial<{ value: number; mode: string; recv: number | null; state: string | null; cls: string | null }> = {}) {
  const p = { value: 410, mode: 'live', recv: 1 as number | null, state: null as string | null, cls: null as string | null, ...over }
  return [OUTCOME[id], `acuity-${id}`, '2026-07-20T14:00:00Z', p.value, 'USD', p.mode, p.recv, p.state, p.cls, 'v25.0']
}

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  admin = await connect()
  const applied = await admin.query(
    `SELECT to_regclass('public.conversion_deliveries') t,
            (SELECT count(*) FROM pg_trigger WHERE tgname = 'conversion_delivery_event_id_derived'
              AND tgrelid = 'public.conversion_deliveries'::regclass) c,
            (SELECT count(*) FROM information_schema.columns
              WHERE table_name='conversion_deliveries' AND column_name='live_accepted_at') l`,
  )
  if (!applied.rows[0].t || Number(applied.rows[0].c) !== 1) {
    throw new Error('the conversion-delivery contract is missing from the local stack — run scripts/sb.sh db reset, then re-run')
  }
  if (Number(applied.rows[0].l) !== 1) {
    throw new Error('the live/test conversion-delivery columns are missing from the local stack — run scripts/sb.sh db reset, then re-run')
  }
  await admin.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
    SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [EXTERNAL_IDS])
  await purgePaidMeasurement(admin, [ACCT])
  await admin.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
  await removeAccountOutcomes(admin, [ACCT])
  await admin.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
  await admin.query(`INSERT INTO ad_accounts (id, account_id, is_active) VALUES ($1,'act_capi_conc',true)`, [ACCT])
  for (const id of Object.values(IDS)) {
    OUTCOME[id] = await insertOutcomeOutcome(admin, ACCT, id, {
      gross_value: 410, status: 'confirmed', occurred_at: '2026-07-20T14:00:00Z',
      business_date: '2026-07-20', observation_source: 'webhook',
    })
  }
}, 60000)

afterAll(async () => {
  if (admin) {
    await admin.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
      SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [EXTERNAL_IDS])
    await purgePaidMeasurement(admin, [ACCT])
    await admin.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
    await removeAccountOutcomes(admin, [ACCT])
    await admin.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
    await admin.end()
  }
})

const row = async (id: number) =>
  (await admin.query(`SELECT * FROM conversion_deliveries WHERE outcome_id=$1`, [OUTCOME[id]])).rows[0]

describe('real Supabase — concurrent mixed-result retries', () => {
  it('an accepted delivery survives a FAILED retry racing it on another connection', async () => {
    const id = IDS.race
    const [c1, c2] = [await connect(), await connect()]
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')
      // c1 accepts.
      await c1.query(RPC, args(id))
      // c2 attempts a FAILED write on the same event_id; it blocks on c1's row lock.
      const pending = c2.query(RPC, args(id, { recv: 0, state: 'no_events_received', cls: 'no_events_received', value: 9999 }))
      await new Promise((r) => setTimeout(r, 250))
      await c1.query('COMMIT')
      await pending
      await c2.query('COMMIT')
    } finally { await c1.end(); await c2.end() }

    const r = await row(id)
    // The acceptance is intact despite losing the race to a later failure.
    expect(Number(r.accepted_value)).toBe(410)
    expect(Number(r.accepted_events_received)).toBe(1)
    expect(r.accepted_at).not.toBeNull()
    expect(Number(r.accepted_attempt_count)).toBe(1)
    expect(Number(r.failed_attempt_count)).toBe(1)
    expect(Number(r.attempt_count)).toBe(2)
    // The failure is recorded, separately.
    expect(r.last_attempt_error_state).toBe('no_events_received')
    expect(Number(r.last_attempt_value)).toBe(9999)
    // And the parent stays delivered.
    const p = await admin.query(`SELECT conversion_sent_at FROM outcomes WHERE id=$1`, [OUTCOME[id]])
    expect(p.rows[0].conversion_sent_at).not.toBeNull()
  }, 30000)

  it('N concurrent mixed-result writers converge on ONE row with a coherent record', async () => {
    const id = IDS.mixed
    const clients = await Promise.all(Array.from({ length: 6 }, () => connect()))
    try {
      // Three acceptances and three distinct failures, fired together.
      await Promise.all([
        clients[0].query(RPC, args(id)),
        clients[1].query(RPC, args(id, { recv: 0, state: 'no_events_received', cls: 'no_events_received' })),
        clients[2].query(RPC, args(id)),
        clients[3].query(RPC, args(id, { recv: 2, state: 'unexpected_events_received', cls: 'unexpected_events_received' })),
        clients[4].query(RPC, args(id, { recv: null, state: 'http_error', cls: 'http_error' })),
        clients[5].query(RPC, args(id)),
      ])
    } finally { await Promise.all(clients.map((c) => c.end())) }

    const n = await admin.query(`SELECT count(*)::int n FROM conversion_deliveries WHERE outcome_id=$1`, [OUTCOME[id]])
    expect(n.rows[0].n).toBe(1) // one deterministic event_id, one row — never six conversions

    const r = await row(id)
    expect(Number(r.attempt_count)).toBe(6)
    expect(Number(r.accepted_attempt_count) + Number(r.failed_attempt_count)).toBe(6)
    expect(Number(r.accepted_attempt_count)).toBe(3)
    expect(Number(r.failed_attempt_count)).toBe(3)
    // Whatever order they landed in, the accepted facts are self-consistent.
    expect(r.accepted_at).not.toBeNull()
    expect(Number(r.accepted_events_received)).toBe(1)
    expect(r.accepted_send_mode).toBe('live')
    expect(Number(r.accepted_value)).toBe(410)
    const p = await admin.query(`SELECT conversion_sent_at FROM outcomes WHERE id=$1`, [OUTCOME[id]])
    expect(p.rows[0].conversion_sent_at).not.toBeNull()
  }, 30000)

  it('a cross-appointment event_id is rejected under concurrency too', async () => {
    const c = await connect()
    try {
      await expect(
        c.query(RPC, [OUTCOME[IDS.cross], `acuity-${IDS.race}`, '2026-07-20T14:00:00Z', 410, 'USD', 'live', 1, null, null, 'v25.0']),
      ).rejects.toThrow(/does not match outcome/)
    } finally { await c.end() }
    // The victim row is untouched.
    expect((await row(IDS.race)).outcome_id).toBe(OUTCOME[IDS.race])
  })
})


describe('real Supabase — the test/live contract', () => {
  it('a TEST acceptance never blocks a later LIVE acceptance, even under concurrency', async () => {
    const id = IDS.testlive
    // A test rehearsal lands first.
    await admin.query(RPC, args(id, { mode: 'test' }))
    let p = await admin.query(`SELECT conversion_sent_at FROM outcomes WHERE id=$1`, [OUTCOME[id]])
    expect(p.rows[0].conversion_sent_at).toBeNull()

    // Then two LIVE senders race the same deterministic event_id.
    const [c1, c2] = [await connect(), await connect()]
    try {
      await Promise.all([c1.query(RPC, args(id, { mode: 'live' })), c2.query(RPC, args(id, { mode: 'live' }))])
    } finally { await c1.end(); await c2.end() }

    const r = await row(id)
    expect(r.live_accepted_at).not.toBeNull()
    expect(r.accepted_send_mode).toBe('live')
    expect(Number(r.test_accepted_count)).toBe(1)
    // Two live sends of the SAME event id — Meta dedups, so this is one delivery, not two.
    expect(Number(r.accepted_attempt_count)).toBe(2)
    const n = await admin.query(`SELECT count(*)::int n FROM conversion_deliveries WHERE outcome_id=$1`, [OUTCOME[id]])
    expect(n.rows[0].n).toBe(1)
    p = await admin.query(`SELECT conversion_sent_at FROM outcomes WHERE id=$1`, [OUTCOME[id]])
    expect(p.rows[0].conversion_sent_at).not.toBeNull()
  }, 30000)

  it('the accepted API VERSION cannot be rewritten by a later retry or a direct update', async () => {
    const id = IDS.apiver
    await admin.query(RPC, args(id))
    await admin.query(RPC, [OUTCOME[id], `acuity-${id}`, '2026-07-20T14:00:00Z', 410, 'USD', 'live', 1, null, null, 'v99.0'])
    const r = await row(id)
    expect(r.accepted_api_version).toBe('v25.0')
    expect(r.last_attempt_api_version).toBe('v99.0')
    await expect(
      admin.query(`UPDATE conversion_deliveries SET accepted_api_version='v98.0' WHERE outcome_id=$1`, [OUTCOME[id]]),
    ).rejects.toThrow(/accepted delivery facts are immutable/)
  })

  it('test-mode acceptances are NOT delivery evidence for the live-only reader', async () => {
    // The same predicate the evidence gate uses.
    const rows = await admin.query(
      `SELECT outcome_id FROM conversion_deliveries
       WHERE outcome_id = ANY($1::uuid[]) AND live_accepted_at IS NOT NULL`,
      [[OUTCOME[IDS.testlive]]],
    )
    expect(rows.rows).toHaveLength(1) // it went live eventually
    const testOnly = await admin.query(
      `SELECT count(*)::int n FROM conversion_deliveries
       WHERE test_accepted_at IS NOT NULL AND live_accepted_at IS NULL`,
    )
    expect(testOnly.rows[0].n).toBe(0)
  })
})
