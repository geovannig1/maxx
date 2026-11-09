import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { purgePaidMeasurement } from './paid-measurement-purge'
import { outcomeSourceId, removeAccountOutcomes } from './outcome-fixture'

// REAL LOCAL SUPABASE proofs for the outcome lineage — the properties PGlite's single in-process
// connection cannot establish:
//   • TRUE CONCURRENT upserts of the same appointment id from two live connections racing the row
//     lock (the "concurrent upserts cannot lose an observed change" contract).
//   • Role permissions as PostgREST applies them (browser roles denied, service_role read-write) —
//     under PGlite the migrations' role-gated GRANT blocks are inert.
//   • Account isolation across ad_account_id.
//   • Migration reversibility: the 050 objects can be dropped and re-applied without data loss in
//     the parent ledger.
//
// Loopback-guarded: the suite refuses to run against any non-loopback host.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT_A = '00000000-0000-4000-8000-0000000000a1'
const ACCT_B = '00000000-0000-4000-8000-0000000000a2'
// Ids far outside any real Acuity range so a stray production row can never collide.
const BASE = 990000000
const ids = { first: BASE + 1, race: BASE + 2, perm: BASE + 3, isoA: BASE + 4, isoB: BASE + 5, rev: BASE + 6, capi: BASE + 7 }
const EXTERNAL_IDS = Object.values(ids).map(String)

let admin: pg.Client

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: DB })
  await c.connect()
  return c
}

async function cleanup(c: pg.Client) {
  await purgePaidMeasurement(c, [ACCT_A, ACCT_B])
  await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
  await removeAccountOutcomes(c, [ACCT_A, ACCT_B])
  await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
}

/** The exact upsert shape the app's ledger writer emits ($1 Acuity id, $2 account, $3 price, $4 canceled,
 *  $5 observation source), keyed on (account, Acuity source, external id) as the writer's onConflict. */
const UPSERT = `
  INSERT INTO outcomes (ad_account_id, source_id, external_id, outcome_type, currency, gross_value, status,
    observation_source, occurred_at, business_date)
  VALUES ($2, (SELECT id FROM outcome_sources WHERE ad_account_id=$2 AND kind='acuity' AND label='Acuity Scheduling'),
    $1::text, 'booking', 'USD', $3, CASE WHEN $4::boolean THEN 'cancelled' ELSE 'confirmed' END,
    $5, '2026-07-20T14:00:00Z', '2026-07-20')
  ON CONFLICT (ad_account_id, source_id, external_id) DO UPDATE SET
    gross_value = EXCLUDED.gross_value, status = EXCLUDED.status,
    observation_source = EXCLUDED.observation_source, synced_at = now()`

/** The outcome uuid recorded for one Acuity id under one account. */
async function outcomeId(id: number, account = ACCT_A): Promise<string> {
  return (await admin.query(`SELECT id FROM outcomes WHERE ad_account_id=$1 AND external_id=$2`, [account, String(id)])).rows[0].id
}

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  if (!SERVICE) throw new Error('local service-role key is required')
  admin = await connect()

  // Fail closed if the outcome lineage objects are missing — a silent skip would look like a pass.
  const applied = await admin.query(
    `SELECT to_regclass('public.outcome_observations') AS obs,
            to_regclass('public.conversion_deliveries') AS del,
            to_regprocedure('public.record_conversion_delivery(uuid,text,timestamptz,numeric,text,text,integer,text,text,text)') AS fn`,
  )
  const { obs, del, fn } = applied.rows[0]
  if (!obs || !del || !fn) {
    throw new Error('the outcome lineage objects are missing from the local stack — run scripts/sb.sh db reset, then re-run')
  }

  await cleanup(admin)
  await admin.query(`INSERT INTO ad_accounts (id, account_id, is_active) VALUES ($1,'act_lin_a',true), ($2,'act_lin_b',false)`, [ACCT_A, ACCT_B])
  await outcomeSourceId(admin, ACCT_A)
  await outcomeSourceId(admin, ACCT_B)
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON outcomes, outcome_observations, conversion_deliveries TO service_role`)
}, 60000)

afterAll(async () => {
  if (admin) { await cleanup(admin); await admin.end() }
})

describe('real Supabase — observation lineage', () => {
  it('a live INSERT is labelled observed with the writer-declared source', async () => {
    await admin.query(UPSERT, [ids.first, ACCT_A, 410, false, 'webhook'])
    const r = await admin.query(
      `SELECT initial_gross_value AS initial_price, initial_provenance, initial_observation_source FROM outcomes WHERE id=$1`,
      [await outcomeId(ids.first)],
    )
    expect(Number(r.rows[0].initial_price)).toBe(410)
    expect(r.rows[0].initial_provenance).toBe('observed')
    expect(r.rows[0].initial_observation_source).toBe('webhook')

    const obs = await admin.query(`SELECT change_kind, provenance FROM outcome_observations WHERE outcome_id=$1`, [await outcomeId(ids.first)])
    expect(obs.rows).toHaveLength(1)
    expect(obs.rows[0]).toMatchObject({ change_kind: 'first_observation', provenance: 'observed' })
  })

  it('CONCURRENT same-day upserts from two connections lose NO observed change', async () => {
    // The property PGlite cannot prove. Two live connections both hold open transactions and update
    // the same appointment id; the row lock forces them to serialise, so the second must see the
    // first's committed value as its OLD and both transitions must appear exactly once.
    await admin.query(UPSERT, [ids.race, ACCT_A, 100, false, 'webhook'])

    const [c1, c2] = [await connect(), await connect()]
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      await c1.query(UPSERT, [ids.race, ACCT_A, 200, false, 'sweep'])

      // c2's identical-key update BLOCKS on c1's row lock until c1 commits. Fire it without
      // awaiting, commit c1, then let c2 proceed.
      const pending = c2.query(UPSERT, [ids.race, ACCT_A, 300, false, 'webhook'])
      await new Promise((r) => setTimeout(r, 250)) // give c2 time to actually block
      await c1.query('COMMIT')
      await pending
      await c2.query('COMMIT')
    } finally {
      await c1.end(); await c2.end()
    }

    const obs = await admin.query(
      `SELECT change_kind, old_gross_value, new_gross_value, observation_source
       FROM outcome_observations WHERE outcome_id=$1 ORDER BY id`,
      [await outcomeId(ids.race)],
    )
    expect(obs.rows.map((o) => o.change_kind)).toEqual(['first_observation', 'price_change', 'price_change'])
    // 100 -> 200 -> 300, with no transition swallowed and no phantom 100 -> 300.
    expect(obs.rows.slice(1).map((o) => [Number(o.old_gross_value), Number(o.new_gross_value)])).toEqual([[100, 200], [200, 300]])

    const cur = await admin.query(`SELECT gross_value AS price, initial_gross_value AS initial_price FROM outcomes WHERE id=$1`, [await outcomeId(ids.race)])
    expect(Number(cur.rows[0].price)).toBe(300)
    expect(Number(cur.rows[0].initial_price)).toBe(100)
  }, 30000)

  it('account isolation: an appointment carries only its own account, and observations follow the parent', async () => {
    await admin.query(UPSERT, [ids.isoA, ACCT_A, 100, false, 'webhook'])
    await admin.query(UPSERT, [ids.isoB, ACCT_B, 200, false, 'webhook'])
    await admin.query(UPSERT, [ids.isoA, ACCT_A, 150, false, 'sweep'])

    const a = await admin.query(
      `SELECT p.external_id AS appointment_id FROM outcome_observations o
       JOIN outcomes p ON p.id = o.outcome_id
       WHERE p.ad_account_id = $1 AND o.outcome_id = ANY($2::uuid[])`,
      [ACCT_A, [await outcomeId(ids.isoA), await outcomeId(ids.isoB, ACCT_B)]],
    )
    expect(a.rows.every((r) => Number(r.appointment_id) === ids.isoA)).toBe(true)
    expect(a.rows).toHaveLength(2) // first_observation + price_change, none from account B
  })

  it('deleting the parent CASCADEs its observations (no orphaned evidence)', async () => {
    await admin.query(UPSERT, [ids.rev, ACCT_A, 100, false, 'webhook'])
    await admin.query(UPSERT, [ids.rev, ACCT_A, 250, false, 'sweep'])
    const revId = await outcomeId(ids.rev)
    const before = await admin.query(`SELECT count(*)::int n FROM outcome_observations WHERE outcome_id=$1`, [revId])
    expect(before.rows[0].n).toBe(2)
    // The schema puts an ON DELETE RESTRICT amount-paid ledger under every appointment, written by
    // a trigger on the appointment itself, so the parent is undeletable until that ledger is cleared.
    // Production never deletes appointments; this suite does, so it clears the ledger explicitly.
    await purgePaidMeasurement(admin, [ACCT_A])
    await admin.query(`DELETE FROM outcomes WHERE id=$1`, [revId])
    const after = await admin.query(`SELECT count(*)::int n FROM outcome_observations WHERE outcome_id=$1`, [revId])
    expect(after.rows[0].n).toBe(0)
  })
})

describe('real Supabase — CAPI delivery persistence', () => {
  it('records lineage and stamps capi_sent_at in ONE transaction, idempotently across retries', async () => {
    await admin.query(UPSERT, [ids.capi, ACCT_A, 410, false, 'webhook'])
    const evt = `acuity-${ids.capi}`
    const capiId = await outcomeId(ids.capi)

    const first = await admin.query(
      `SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r`,
      [capiId, evt, '2026-07-20T14:00:00Z', 410, 'USD', 'live', 1, null, null, 'v25.0'],
    )
    expect(first.rows[0].r.accepted).toBe(true)
    expect(first.rows[0].r.marked_sent).toBe(true)

    const retry = await admin.query(
      `SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r`,
      [capiId, evt, '2026-07-20T14:00:00Z', 410, 'USD', 'live', 1, null, null, 'v25.0'],
    )
    expect(retry.rows[0].r.attempt_count).toBe(2)
    expect(retry.rows[0].r.accepted_at).toBe(first.rows[0].r.accepted_at)

    const n = await admin.query(`SELECT count(*)::int n FROM conversion_deliveries WHERE outcome_id=$1`, [capiId])
    expect(n.rows[0].n).toBe(1) // one lineage row, not two — the deterministic event_id prevents double-count

    const sent = await admin.query(`SELECT conversion_sent_at FROM outcomes WHERE id=$1`, [capiId])
    expect(sent.rows[0].conversion_sent_at).not.toBeNull()
  })

  it('a rolled-back transaction leaves NEITHER the lineage row NOR conversion_sent_at', async () => {
    const c = await connect()
    try {
      await c.query(UPSERT, [ids.perm, ACCT_A, 300, false, 'webhook'])
      await c.query('BEGIN')
      await c.query(`SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [await outcomeId(ids.perm), `acuity-${ids.perm}`, '2026-07-20T14:00:00Z', 300, 'USD', 'live', 1, null, null, 'v25.0'])
      await c.query('ROLLBACK')
    } finally { await c.end() }

    const permId = await outcomeId(ids.perm)
    const n = await admin.query(`SELECT count(*)::int n FROM conversion_deliveries WHERE outcome_id=$1`, [permId])
    expect(n.rows[0].n).toBe(0)
    const sent = await admin.query(`SELECT conversion_sent_at FROM outcomes WHERE id=$1`, [permId])
    expect(sent.rows[0].conversion_sent_at).toBeNull()
  })
})

describe('real Supabase — permissions', () => {
  it('anon has NO access to the lineage tables', async () => {
    const c = await connect()
    try {
      await c.query('SET ROLE anon')
      await expect(c.query('SELECT * FROM outcome_observations LIMIT 1')).rejects.toThrow(/permission denied/i)
      await c.query('RESET ROLE')
      await c.query('SET ROLE anon')
      await expect(c.query('SELECT * FROM conversion_deliveries LIMIT 1')).rejects.toThrow(/permission denied/i)
    } finally { await c.end() }
  })

  it('authenticated has NO direct lineage access', async () => {
    const c = await connect()
    const firstId = await outcomeId(ids.first)
    try {
      await c.query('SET ROLE authenticated')
      await expect(c.query('SELECT count(*) FROM outcome_observations')).rejects.toThrow(/permission denied/i)
      await c.query('RESET ROLE')
      await c.query('SET ROLE authenticated')
      await expect(c.query('SELECT count(*) FROM conversion_deliveries')).rejects.toThrow(/permission denied/i)
      await c.query('RESET ROLE')
      await c.query('SET ROLE authenticated')
      await expect(
        c.query(`INSERT INTO outcome_observations (outcome_id, change_kind) VALUES ($1,'price_change')`, [firstId]),
      ).rejects.toThrow(/permission denied/i)
      await c.query('RESET ROLE')
      await c.query('SET ROLE authenticated')
      await expect(c.query(`DELETE FROM conversion_deliveries`)).rejects.toThrow(/permission denied/i)
    } finally { await c.end() }
  })

  it('authenticated cannot execute the delivery RPC', async () => {
    const c = await connect()
    const firstId = await outcomeId(ids.first)
    try {
      await c.query('SET ROLE authenticated')
      await expect(
        c.query(`SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [firstId, `acuity-${ids.first}`, '2026-07-20T14:00:00Z', 1, 'USD', 'live', 1, null, null, 'v25.0']),
      ).rejects.toThrow(/permission denied/i)
    } finally { await c.end() }
  })

  it('service_role may execute the delivery RPC', async () => {
    const c = await connect()
    const firstId = await outcomeId(ids.first)
    try {
      await c.query('SET ROLE service_role')
      const r = await c.query(`SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r`,
        [firstId, `acuity-${ids.first}`, '2026-07-20T14:00:00Z', 410, 'USD', 'test', 1, null, null, 'v25.0'])
      expect(r.rows[0].r.accepted).toBe(true)
      expect(r.rows[0].r.marked_sent).toBe(false) // test mode never marks delivery
    } finally { await c.end() }
  })
})
