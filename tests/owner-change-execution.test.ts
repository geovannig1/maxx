import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { projectWriteSnapshot } from '@/lib/writes/meta-live-state'

// ADR-059: the executor checks an OWNER request with the owner validator (no causal-estimate
// requirement on an owner_review decision) and an AGENT request exactly as before. Same claim, same
// live re-read, same verification.

interface Query { table: string; op: 'select' | 'insert' | 'update' | 'rpc'; payload?: unknown; filters: Array<[string, unknown]> }
type Result = { data: unknown; error: { message: string; code?: string } | null }

function database(handler: (query: Query) => Result, calls: Query[]) {
  return {
    from(table: string) {
      const query: Query = { table, op: 'select', filters: [] }
      calls.push(query)
      const builder: Record<string, unknown> = {}
      builder.select = () => builder
      builder.insert = (payload: unknown) => { query.op = 'insert'; query.payload = payload; return builder }
      builder.update = (payload: unknown) => { query.op = 'update'; query.payload = payload; return builder }
      builder.eq = (column: string, value: unknown) => { query.filters.push([column, value]); return builder }
      builder.single = async () => handler(query)
      builder.maybeSingle = async () => handler(query)
      builder.then = (resolve: (result: Result) => unknown) => Promise.resolve(handler(query)).then(resolve)
      return builder
    },
    rpc(name: string, payload: unknown) {
      const query: Query = { table: name, op: 'rpc', payload, filters: [] }
      calls.push(query)
      return Promise.resolve(handler(query))
    },
  }
}

const rawAdset = (dailyBudget: string) => ({
  id: 'adset-1', account_id: 'act_12345', campaign_id: 'campaign-1', name: 'Target', status: 'ACTIVE', daily_budget: dailyBudget,
})

const ownerReviewDecision = {
  id: 'decision-owner', ad_account_id: 'account-a', action_kind: 'budget_scale', target_level: 'adset',
  target_id: 'adset-1', authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR,
  approval_state: 'approved', proposed_mutation: null, causal_contribution_estimate_id: null,
}

const approvedChange = (initiatedBy: 'owner' | 'agent') => ({
  id: 'change-1', ad_account_id: 'account-a', status: 'approved', action_decision_id: 'decision-owner',
  action_type: 'adjust_budget', entity_level: 'adset', meta_entity_id: 'adset-1', params: { new_daily_budget: 40 },
  before_state: projectWriteSnapshot('adjust_budget', 'adset-1', rawAdset('3500')), idempotency_key: 'key-1',
  expires_at: '2099-01-01T00:00:00.000Z', initiated_by: initiatedBy, rollback_of: null,
})

function metaDouble() {
  let posted = false
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') { posted = true; return { ok: true, json: async () => ({ success: true }) } }
    if (url.pathname.endsWith('/adset-1')) return { ok: true, json: async () => rawAdset(posted ? '4000' : '3500') }
    if (url.pathname.endsWith('/campaigns')) return { ok: true, json: async () => ({ data: [] }) }
    if (url.pathname.endsWith('/adsets')) return { ok: true, json: async () => ({ data: [{ id: 'adset-1', campaign_id: 'campaign-1', daily_budget: '3500' }] }) }
    throw new Error(`unexpected Meta URL ${url.pathname}`)
  })
}

describe('executor: owner-initiated requests', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
    vi.stubEnv('META_ACCESS_TOKEN', ['fake', 'meta', 'credential'].join('-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    vi.doUnmock('@/lib/supabase/admin'); vi.doUnmock('@/lib/monitoring/alerts'); vi.doUnmock('@sentry/nextjs')
  })

  async function run(initiatedBy: 'owner' | 'agent') {
    const calls: Query[] = []
    vi.doMock('@/lib/supabase/admin', () => ({
      getAdminClient: () => database((query) => {
        if (query.table === 'change_requests' && query.op === 'select') return { data: approvedChange(initiatedBy), error: null }
        if (query.table === 'change_requests' && query.op === 'update') return { data: [{ id: 'change-1' }], error: null }
        if (query.table === 'action_decisions') return { data: ownerReviewDecision, error: null }
        if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta', currency: 'USD' }, error: null }
        if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
        if (query.table === 'action_log' && query.op === 'insert') return { data: { id: 'claim-1' }, error: null }
        if (query.table === 'action_log' && query.op === 'update') return { data: [{ id: 'claim-1' }], error: null }
        throw new Error(`unexpected query ${query.table}:${query.op}`)
      }, calls),
    }))
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
    const fetchSpy = metaDouble()
    vi.stubGlobal('fetch', fetchSpy)
    const { executeApprovedChange } = await import('@/lib/writes/executor')
    const result = await executeApprovedChange('change-1', 'owner@example.com', 'account-a') as { status: string; verified?: boolean }
    return { result, calls, fetchSpy }
  }

  it('executes and verifies an approved owner request on an owner_review decision', async () => {
    const { result, calls, fetchSpy } = await run('owner')
    expect(result).toMatchObject({ status: 'EXECUTED_VERIFIED', verified: true })
    expect(fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true)
    expect(calls.some((q) => q.table === 'action_log' && q.op === 'insert')).toBe(true)
  })

  it('refuses the same request when an agent initiated it (control: agent bar unchanged)', async () => {
    const { result, calls, fetchSpy } = await run('agent')
    expect(result.status).toBe('AUTHORITY_REQUIRED')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls.some((q) => q.table === 'action_log')).toBe(false)
  })
})
