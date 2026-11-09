import { createHmac } from 'node:crypto'
import {
  purgePaidCohortLineageFixture,
  seedPaidCohortLineageFixture,
  type PaidCohortLineageFixture,
} from './paid-cohort-lineage-fixture'
import { reassertShippedPrivileges } from './shipped-privileges'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321'
const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SB_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const JWT_SECRET = process.env.SB_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const ACCOUNT = '00000000-0000-4000-8000-000000000065'
const LINEAGE: PaidCohortLineageFixture = {
  accountId: ACCOUNT,
  campaignDbId: '00000000-0000-4000-8000-000000000165',
  adsetDbId: '00000000-0000-4000-8000-000000000265',
  activationId: '00000000-0000-4000-8000-000000000365',
  evaluationRunId: '00000000-0000-4000-8000-000000000465',
  recentGenerationId: '00000000-0000-4000-8000-000000000565',
  maturedGenerationId: '00000000-0000-4000-8000-000000000665',
  metaCampaignId: '650001',
  metaAdsetId: '650002',
}
const ACTOR = '00000000-0000-4000-8000-000000000165'
const DEDUPE = 'security-boundary-065'
const DIRECT_BROWSER_DENIED_TABLES = [
  'action_decisions',
  'change_requests',
  'outcomes',
  'outcome_observations',
  'conversion_deliveries',
  'v_business_outcomes',
  'recommendations',
  'flags',
  'alerts',
  'audit_tasks',
  'daily_reports',
  'weekly_reports',
  'decision_generations',
  'pending_approvals',
  'tests',
  'creative_briefs',
  'ad_setup_decisions',
  'recommendation_decisions',
  'learned_patterns',
  'agent_memory',
  'memory_entries',
  'expert_insights',
  'custom_audiences',
]

let db: pg.Client
let decisionId = ''
let changeRequestId = ''

const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return '' } }
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

function authenticatedJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    aud: 'authenticated', exp: now + 3600, iat: now, iss: 'supabase-demo',
    role: 'authenticated', sub: ACTOR,
  })}`
  const signature = createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

async function rest(
  resource: string,
  token: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${SB_URL}/rest/v1/${resource}`, {
    ...init,
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

async function cleanup(): Promise<void> {
  await db.query(`DELETE FROM public.change_requests WHERE ad_account_id=$1`, [ACCOUNT])
  await db.query(`DELETE FROM public.action_decisions WHERE ad_account_id=$1`, [ACCOUNT])
  await purgePaidCohortLineageFixture(db, LINEAGE)
  await db.query(`DELETE FROM public.ad_accounts WHERE id=$1`, [ACCOUNT])
  await db.query(`DELETE FROM public.api_rate_limit_windows WHERE actor_key=$1`, [ACTOR])
}

beforeAll(async () => {
  for (const url of [SB_URL, DB]) {
    if (!LOOPBACK.has(hostOf(url))) throw new Error(`refusing non-loopback security test target: ${url}`)
  }
  if (!SERVICE) throw new Error('local service-role key is required')

  db = new pg.Client({ connectionString: DB })
  await db.connect()
  // Other suites blanket-GRANT tables for their fixtures; restore the shipped privilege contract first.
  await reassertShippedPrivileges(db)
  await cleanup()
  await db.query(`INSERT INTO public.ad_accounts(id,account_id) VALUES ($1,'act_security_065')`, [ACCOUNT])
  await seedPaidCohortLineageFixture(db, LINEAGE)

  const decision = await db.query(`
    SELECT (public.commit_action_decision(
      p_ad_account_id => $1,
      p_action_kind => 'budget_cut', p_target_level => 'adset', p_target_id => $3,
      p_evidence_plane => 'interaction_cohort', p_evidence_basis => 'interaction_cohort_complete',
      p_authority_tier => 'execution_eligible', p_authority_reason => 'integration proof',
      p_owner_copy => 'Owner-reviewed integration proof.',
      p_direction_ceiling => 'execution', p_direction_reason => 'integration proof',
      p_policy_version => 3, p_dedupe_key => $2,
      p_source_kind => 'evaluator', p_source_id => 'security-source-065',
      p_objective => 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      p_proposed_mutation => '{"action_type":"adjust_budget","new_daily_budget_usd":60}'::jsonb,
      p_paid_cohort_recent_generation_id => $4,
      p_paid_cohort_matured_generation_id => $5
    )).*`, [ACCOUNT, DEDUPE, LINEAGE.adsetDbId, LINEAGE.recentGenerationId, LINEAGE.maturedGenerationId])
  decisionId = String(decision.rows[0].id)

  // Reconstruct one legitimate pre-v4 PENDING audit row without weakening the live schema. The
  // bypass is transaction-local to this superuser session and represents history that the causal quarantine
  // intentionally preserves; every subsequent operation runs with all triggers enabled.
  await db.query('BEGIN')
  try {
    await db.query(`SET LOCAL session_replication_role='replica'`)
    await db.query(
      `UPDATE public.action_decisions SET approval_state='pending' WHERE id=$1`, [decisionId])
    const request = await db.query(`
      INSERT INTO public.change_requests(
        ad_account_id,action_type,entity_level,meta_entity_id,params,before_state,preview,
        reason,confidence,risk_level,rollback_plan,idempotency_key,requested_by,evidence,
        data_source,status,action_decision_id)
      VALUES ($1,'adjust_budget','adset',$2,
        '{"new_daily_budget_usd":60}'::jsonb,'{"daily_budget":"5000"}'::jsonb,
        'Change the daily budget to $60.','Original owner-reviewed reason.',5,'high',
        'Restore the prior budget.','security-request-065','integration',
        'integration fixture','local test','pending',$3)
      RETURNING id`, [ACCOUNT, LINEAGE.adsetDbId, decisionId])
    changeRequestId = String(request.rows[0].id)
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}, 60_000)

afterAll(async () => {
  if (!db) return
  await cleanup()
  await db.end()
})

describe('effective PostgREST permissions', () => {
  it('denies a real authenticated JWT direct reads of governed/service-only tables', async () => {
    const jwt = authenticatedJwt()
    for (const table of DIRECT_BROWSER_DENIED_TABLES) {
      const response = await rest(`${table}?select=*&limit=1`, jwt, ANON)
      expect(response.ok, `${table} unexpectedly returned ${response.status}`).toBe(false)
      expect([401, 403]).toContain(response.status)
    }
  })

  it('preserves service-role reads of every hardened table', async () => {
    for (const table of DIRECT_BROWSER_DENIED_TABLES) {
      const response = await rest(`${table}?select=*&limit=1`, SERVICE, SERVICE)
      expect(response.status, `${table}: ${await response.text()}`).toBe(200)
    }
  })

  it('denies authenticated direct change-request UPDATE and leaves proposal context unchanged', async () => {
    const response = await rest(
      `change_requests?id=eq.${changeRequestId}`,
      authenticatedJwt(),
      ANON,
      { method: 'PATCH', body: JSON.stringify({ reason: 'poisoned after review' }) },
    )
    expect(response.ok).toBe(false)
    expect([401, 403]).toContain(response.status)

    const stored = await db.query(`SELECT reason FROM public.change_requests WHERE id=$1`, [changeRequestId])
    expect(stored.rows[0].reason).toBe('Original owner-reviewed reason.')
  })

  it('freezes every owner-reviewed context field, even for a privileged accidental update', async () => {
    const mutations: Array<[string, string]> = [
      ['reason', `'changed'`],
      ['confidence', '1'],
      ['risk_level', `'low'`],
      ['rollback_plan', `'changed'`],
      ['requested_by', `'changed'`],
      ['evidence', `'changed'`],
      ['data_source', `'changed'`],
      ['expires_at', `now() + interval '30 days'`],
    ]
    for (const [column, value] of mutations) {
      await expect(db.query(
        `UPDATE public.change_requests SET ${column}=${value} WHERE id=$1`, [changeRequestId],
      )).rejects.toThrow(/change_request_approval_context_is_immutable/)
    }
  })

  it('does not let the service-role revive a preserved pre-v4 pending request', async () => {
    const response = await rest(
      'rpc/review_change_request_with_decision',
      SERVICE,
      SERVICE,
      {
        method: 'POST',
        body: JSON.stringify({
          p_change_request_id: changeRequestId,
          p_actor: 'owner@example.com',
          p_approve: true,
          p_reason: null,
        }),
      },
    )
    expect(response.status).toBeGreaterThanOrEqual(400)

    const stored = await db.query(
      `SELECT status, reason FROM public.change_requests WHERE id=$1`, [changeRequestId])
    expect(stored.rows[0]).toMatchObject({
      status: 'pending',
      reason: 'Original owner-reviewed reason.',
    })
  })

  it('atomically limits service requests and denies the RPC to authenticated JWTs', async () => {
    const payload = JSON.stringify({
      p_bucket: 'integration_security',
      p_actor_key: ACTOR,
      p_limit: 1,
      p_window_seconds: 300,
    })
    const first = await rest('rpc/consume_api_rate_limit', SERVICE, SERVICE, { method: 'POST', body: payload })
    const second = await rest('rpc/consume_api_rate_limit', SERVICE, SERVICE, { method: 'POST', body: payload })
    const firstBody = await first.json()
    const secondBody = await second.json()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstBody).toEqual([{ allowed: true, retry_after_seconds: 0 }])
    expect(secondBody).toEqual([
      expect.objectContaining({ allowed: false, retry_after_seconds: expect.any(Number) }),
    ])

    const denied = await rest(
      'rpc/consume_api_rate_limit', authenticatedJwt(), ANON, { method: 'POST', body: payload },
    )
    expect(denied.ok).toBe(false)
    expect([401, 403, 404]).toContain(denied.status)
  })
})
