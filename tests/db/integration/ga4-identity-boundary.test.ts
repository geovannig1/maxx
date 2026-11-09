import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { purgePaidMeasurement } from './paid-measurement-purge'
import { removeAccountOutcomes } from './outcome-fixture'

// REAL-POSTGRES proofs for the appointment_id go-live boundary (`ga4_identity_boundary`).
//
// The baseline deliberately grants direct service_role DML while keeping browser roles isolated.
// The service role is trusted backend authority; the monotonicity trigger remains the backstop that
// blocks an accidental forward move unless provenance explicitly declares a manual override.
//
// These run as service_role (SET ROLE), which is what PostgREST actually uses, so a permission that
// only looks correct in the migration file cannot pass here.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT_A = '00000000-0000-4000-8000-0000000000b1'
const ACCT_B = '00000000-0000-4000-8000-0000000000b2'

let c: pg.Client

/** Run one statement as service_role, exactly as PostgREST would, then restore. */
async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await c.query('SET ROLE service_role')
  try { return await fn() } finally { await c.query('RESET ROLE') }
}

// to_char so the driver returns a plain string rather than a Date in the server's timezone.
const rpc = (acct: string, date: string | null) =>
  c.query<{ d: string | null }>(
    `SELECT to_char(record_ga4_identity_boundary($1::uuid, $2::date), 'YYYY-MM-DD') AS d`, [acct, date])

const boundaryOf = async (acct: string) =>
  (await c.query<{ d: string | null }>(
    `SELECT to_char(first_identified_date,'YYYY-MM-DD') AS d FROM ga4_identity_boundary WHERE ad_account_id=$1`, [acct])).rows[0]?.d ?? null

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  c = new pg.Client({ connectionString: DB }); await c.connect()
  await c.query(`DELETE FROM ga4_identity_boundary WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
  await purgePaidMeasurement(c, [ACCT_A, ACCT_B])
  await removeAccountOutcomes(c, [ACCT_A, ACCT_B])
  await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_b1'),($2,'act_b2')`, [ACCT_A, ACCT_B])
}, 60000)

afterAll(async () => {
  if (c) {
    await c.query('RESET ROLE').catch(() => {})
    await c.query(`DELETE FROM ga4_identity_boundary WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
    await purgePaidMeasurement(c, [ACCT_A, ACCT_B])
    await removeAccountOutcomes(c, [ACCT_A, ACCT_B])
    await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
    await c.end()
  }
})

describe('record_ga4_identity_boundary — monotonicity', () => {
  it('first observation establishes the boundary', async () => {
    const r = await asServiceRole(() => rpc(ACCT_A, '2026-05-10'))
    expect(r.rows[0].d).toBe('2026-05-10')
    expect(await boundaryOf(ACCT_A)).toBe('2026-05-10')
  }, 60000)

  it('a LATER observation does NOT move it forward', async () => {
    // A forward move would shrink the window that counts as covered, making an under-covered window
    // look covered — the precise failure the boundary exists to prevent.
    await asServiceRole(() => rpc(ACCT_A, '2026-06-01'))
    expect(await boundaryOf(ACCT_A)).toBe('2026-05-10')
  }, 60000)

  it('an EARLIER observation DOES move it backward', async () => {
    await asServiceRole(() => rpc(ACCT_A, '2026-04-02'))
    expect(await boundaryOf(ACCT_A)).toBe('2026-04-02')
  }, 60000)

  it('a NULL date reads the current value without writing', async () => {
    const r = await asServiceRole(() => rpc(ACCT_A, null))
    expect(r.rows[0].d).toBe('2026-04-02')
    expect(await boundaryOf(ACCT_A)).toBe('2026-04-02')
  }, 60000)

  it('reading an account with NO boundary returns null, not a fabricated date', async () => {
    const r = await asServiceRole(() => rpc(ACCT_B, null))
    expect(r.rows[0].d).toBeNull()
    expect(await boundaryOf(ACCT_B)).toBeNull()
  }, 60000)

  it('is ACCOUNT-ISOLATED — one account\'s boundary never touches another\'s', async () => {
    await asServiceRole(() => rpc(ACCT_B, '2026-07-01'))
    expect(await boundaryOf(ACCT_B)).toBe('2026-07-01')
    expect(await boundaryOf(ACCT_A)).toBe('2026-04-02')   // unchanged
  }, 60000)
})

describe('trusted service writes remain browser-isolated and trigger-guarded', () => {
  it('service_role has the deliberately restored direct DML grants', async () => {
    const r = await c.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name='ga4_identity_boundary'
         AND grantee='service_role' AND privilege_type IN ('INSERT','UPDATE','DELETE')
       ORDER BY privilege_type`)
    expect(r.rows.map((row) => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'UPDATE'])
  })

  it('browser roles have no table privileges', async () => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name='ga4_identity_boundary'
         AND grantee IN ('anon','authenticated')`)
    expect(r.rows[0].n).toBe(0)
  })

  it('service_role still cannot push the boundary forward without an explicit override', async () => {
    await expect(asServiceRole(() => c.query(
      `UPDATE ga4_identity_boundary SET first_identified_date='2026-12-31' WHERE ad_account_id=$1`, [ACCT_A])))
      .rejects.toThrow(/may only move earlier/i)
    expect(await boundaryOf(ACCT_A)).toBe('2026-04-02')
  }, 60000)

  it('service_role can move the boundary earlier directly', async () => {
    await asServiceRole(() => c.query(
      `UPDATE ga4_identity_boundary SET first_identified_date='2026-03-01' WHERE ad_account_id=$1`, [ACCT_A]))
    expect(await boundaryOf(ACCT_A)).toBe('2026-03-01')
  }, 60000)

  it('service_role CAN still read it, and CAN execute the RPC', async () => {
    // Revoking DML must not break the legitimate path.
    const read = await asServiceRole(() => c.query(`SELECT count(*)::int AS n FROM ga4_identity_boundary`))
    expect(Number(read.rows[0].n)).toBeGreaterThanOrEqual(2)
    const r = await asServiceRole(() => rpc(ACCT_A, '2026-04-02'))
    expect(r.rows[0].d).toBe('2026-03-01')
  }, 60000)

  it('a declared service_role manual_override is allowed', async () => {
    await asServiceRole(() => c.query(
      `UPDATE ga4_identity_boundary SET first_identified_date='2026-12-31', provenance='manual_override' WHERE ad_account_id=$1`, [ACCT_A])
    )
    expect(await boundaryOf(ACCT_A)).toBe('2026-12-31')
  }, 60000)
})
