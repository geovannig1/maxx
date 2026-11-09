import { describe, it, expect, beforeAll, vi } from 'vitest'
import pg from 'pg'
import { NextRequest } from 'next/server'

// OUTPUT-level proof for the report API consumer: invokes the REAL route GET handler against the
// local database and asserts the structured FIVE-state lineage in the JSON response, in a healthy state
// AND a degraded one. Only the server-auth client is mocked; the route's owner gate (ownerOnly) runs for
// real against a confirmed owner user; the admin client, resolver, and data are real.

const OWNER = 'owner@example.test'
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: {
    id: 'test-user', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z',
  } } }) } }),
}))

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const ACCT = '00000000-0000-4000-8000-0000000000e9'
const META_ACCT = 'act_api_test'
const DATE = '2026-05-20' // distinct from the other suites' dates/accounts
const F1 = '00000000-0000-4000-8000-00000000e901'
const R1 = '00000000-0000-4000-8000-00000000e902'
const F2 = '00000000-0000-4000-8000-00000000e903'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const get = async (date: string) => {
  const { GET } = await import('@/app/api/report/[date]/route')
  const req = new NextRequest(`http://127.0.0.1/api/report/${date}?account_id=${META_ACCT}`)
  const res = await GET(req, { params: Promise.resolve({ date }) })
  return { status: res.status, body: await res.json() as { lineage?: { state: string; notice: string | null }; data?: unknown } }
}

describe('report API - structured lineage at the response boundary', () => {
  beforeAll(async () => {
    vi.stubEnv('OWNER_EMAIL', OWNER)
    for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
      if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
    }
    const c = new pg.Client({ connectionString: DB }); await c.connect()
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
    for (const t of ['daily_reports', 'audit_tasks', 'decision_generations'])
      await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [ACCT])
    await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
    // The production route deliberately refuses to guess when multiple active rows exist. Establish
    // this suite's account-ownership precondition explicitly instead of inheriting another suite's row.
    await c.query(`UPDATE ad_accounts SET is_active=false WHERE id<>$1`, [ACCT])
    await c.query(`INSERT INTO ad_accounts (id, account_id, is_active) VALUES ($1,$2,true)`, [ACCT, META_ACCT])
    // Lineage fixture: flag gen F1 (current for the date) <- rec gen R1 (current) <- report pinned to R1.
    await c.query(`INSERT INTO decision_generations (id, ad_account_id, kind, reference_date, row_count, is_current, committed_at)
      VALUES ($1,$2,'flag',$3,0,true, now() - interval '2 hours')`, [F1, ACCT, DATE])
    await c.query(`INSERT INTO decision_generations (id, ad_account_id, kind, reference_date, parent_generation_id, row_count, is_current, committed_at)
      VALUES ($1,$2,'recommendation',$3,$4,0,true, now() - interval '1 hour')`, [R1, ACCT, DATE, F1])
    await c.query(`INSERT INTO daily_reports (
      ad_account_id,report_date,summary_text,recommendation_generation_id,report_json)
      VALUES ($1,$2,'api-test report',$3,$4::jsonb)`, [
      ACCT, DATE, R1, JSON.stringify({ money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: false,
        revenue_complete: null,
        observed_collected_value_lower_bound: null,
        covered_outcomes: null,
        total_outcomes: null,
      } }),
    ])
    await c.end()
  })

  it('healthy: 200 carries lineage.state=current with a null notice', async () => {
    const { status, body } = await get(DATE)
    expect(status).toBe(200)
    expect(body.data).toBeTruthy()
    expect(body.lineage).toMatchObject({ state: 'current', notice: null })
  })

  it('degraded: a newer flag generation FOR THE DATE flips the response to last_known_complete', async () => {
    const c = new pg.Client({ connectionString: DB }); await c.connect()
    // Newer flag generation for the SAME reference_date (not current - head flags are irrelevant to the
    // date-scoped resolver; committed_at ordering is what it reads).
    await c.query(`INSERT INTO decision_generations (id, ad_account_id, kind, reference_date, row_count, is_current, committed_at)
      VALUES ($1,$2,'flag',$3,0,false, now())`, [F2, ACCT, DATE])
    await c.end()
    const { status, body } = await get(DATE)
    expect(status).toBe(200)
    expect(body.lineage?.state).toBe('last_known_complete')
    expect(body.lineage?.notice).toMatch(/Last-known-complete/)
  })
})
