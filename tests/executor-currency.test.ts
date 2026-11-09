import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { projectWriteSnapshot } from '@/lib/writes/meta-live-state'

// Re-audit (money): budget limits are configured in NEXT_PUBLIC_ACCOUNT_CURRENCY, so a budget write
// is refused when the Meta ad account's own currency differs; Meta budget fields use Meta's offset table
// (TWD is whole dollars there but cents under ISO; BHD is hundredths there but thousandths under ISO); and two executions on one account are serialized.

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

const budgetDecision = (approval: string, amount: number) => ({
  id: 'decision-budget', ad_account_id: 'account-a', action_kind: 'budget_scale', target_level: 'adset',
  target_id: 'adset-1', authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR,
  approval_state: approval, proposed_mutation: { action_type: 'adjust_budget', new_daily_budget: amount },
  causal_contribution_estimate_id: 'estimate-budget',
})

const approvedBudgetChange = (amount: number, beforeMinor: string) => ({
  id: 'change-1', ad_account_id: 'account-a', status: 'approved', action_decision_id: 'decision-budget',
  action_type: 'adjust_budget', entity_level: 'adset', meta_entity_id: 'adset-1', params: { new_daily_budget: amount },
  before_state: projectWriteSnapshot('adjust_budget', 'adset-1', rawAdset(beforeMinor)), idempotency_key: 'key-1',
  expires_at: '2099-01-01T00:00:00.000Z',
})

/** Meta double: GET adset-1 returns `before` until a POST, then `after`; budget lists hold adset-1 only. */
function metaDouble(before: string, after: string) {
  let posted = false
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') { posted = true; return { ok: true, json: async () => ({ success: true }) } }
    if (url.pathname.endsWith('/adset-1')) return { ok: true, json: async () => rawAdset(posted ? after : before) }
    if (url.pathname.endsWith('/campaigns')) return { ok: true, json: async () => ({ data: [] }) }
    if (url.pathname.endsWith('/adsets')) return { ok: true, json: async () => ({ data: [{ id: 'adset-1', campaign_id: 'campaign-1', daily_budget: before }] }) }
    throw new Error(`unexpected Meta URL ${url.pathname}`)
  })
}

describe('write executor currency and serialization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
    vi.stubEnv('META_ACCESS_TOKEN', ['fake', 'meta', 'credential'].join('-'))
  })

  afterEach(() => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    vi.doUnmock('@/lib/supabase/admin'); vi.doUnmock('@/lib/monitoring/alerts'); vi.doUnmock('@sentry/nextjs')
  })

  async function load(handler: (query: Query) => Result) {
    const calls: Query[] = []
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => database(handler, calls) }))
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
    const executor = await import('@/lib/writes/executor')
    return { ...executor, calls }
  }

  it('refuses a budget proposal when the Meta account currency differs from the configured currency', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { proposeChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return { data: null, error: null }
      if (query.table === 'action_decisions') return { data: budgetDecision('not_requested', 40), error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, currency: 'JPY' }, error: null }
      if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-budget', actionType: 'adjust_budget',
      entityLevel: 'adset', metaEntityId: 'adset-1', params: { new_daily_budget: 40 },
    })).resolves.toMatchObject({ status: 'CURRENCY_MISMATCH', message: expect.stringMatching(/JPY.*USD/) })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls.some((query) => query.op === 'rpc')).toBe(false)
  })

  it('refuses an approved budget execution on a currency mismatch before any claim or Meta call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { executeApprovedChange, httpStatusForExecuteResult, calls } = await load((query) => {
      if (query.table === 'change_requests') return { data: approvedBudgetChange(40, '3500'), error: null }
      if (query.table === 'action_decisions') return { data: budgetDecision('approved', 40), error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, currency: 'EUR' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    const result = await executeApprovedChange('change-1', 'owner', 'account-a') as { status: string }
    expect(result.status).toBe('CURRENCY_MISMATCH')
    expect(httpStatusForExecuteResult(result.status)).toBe(409)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls.some((query) => query.table === 'action_log')).toBe(false)
  })

  it('sends a TWD budget in whole units (Meta offset 1), not ISO hundredths', async () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'TWD')
    vi.stubEnv('DAILY_BUDGET_CEILING', '100000')
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }))
    vi.stubGlobal('fetch', fetchSpy)
    const { applyChange } = await load(() => { throw new Error('database not expected') })

    await expect(applyChange('adjust_budget', 'adset-1', { new_daily_budget: 5000 })).resolves.toMatchObject({ ok: true })
    const body = String((fetchSpy.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)
    expect(body).toContain('daily_budget=5000')
    expect(body).not.toContain('daily_budget=500000')
  })

  it('sends a BHD budget in hundredths (Meta offset 100), not ISO thousandths', async () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'BHD')
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }))
    vi.stubGlobal('fetch', fetchSpy)
    const { applyChange } = await load(() => { throw new Error('database not expected') })

    await expect(applyChange('adjust_budget', 'adset-1', { new_daily_budget: 12.5 })).resolves.toMatchObject({ ok: true })
    const body = String((fetchSpy.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)
    expect(body).toContain('daily_budget=1250')
    expect(body).not.toContain('daily_budget=12500')
  })

  it('previews, ceiling-checks and verifies a TWD budget on Meta offsets end to end', async () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'TWD')
    vi.stubEnv('DAILY_BUDGET_CEILING', '6000')
    const fetchSpy = metaDouble('4000', '5000')
    vi.stubGlobal('fetch', fetchSpy)
    const { proposeChange, executeApprovedChange, calls } = await load((query) => {
      if (query.table === 'change_requests' && query.op === 'select' && query.filters.some(([c]) => c === 'idempotency_key')) return { data: null, error: null }
      if (query.table === 'change_requests' && query.op === 'select') return { data: approvedBudgetChange(5000, '4000'), error: null }
      if (query.table === 'action_decisions') {
        const approved = calls.some((q) => q.table === 'change_requests' && q.filters.some(([c]) => c === 'id'))
        return { data: budgetDecision(approved ? 'approved' : 'not_requested', 5000), error: null }
      }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, currency: 'TWD' }, error: null }
      if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
      if (query.table === 'create_change_request_from_decision') return { data: { id: 'change-1' }, error: null }
      if (query.table === 'action_log' && query.op === 'insert') return { data: { id: 'log-1' }, error: null }
      if (query.op === 'update') return { data: [{ id: 'updated' }], error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    // Meta's daily_budget "4000" is 4,000 TWD; ISO digits would have read it as 40 TWD.
    const proposal = await proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-budget', actionType: 'adjust_budget',
      entityLevel: 'adset', metaEntityId: 'adset-1', params: { new_daily_budget: 5000 },
    }) as { status: string; preview: string }
    expect(proposal.status).toBe('PENDING_APPROVAL')
    expect(proposal.preview).toMatch(/4,000/)
    expect(proposal.preview).not.toMatch(/\$40\.00/)

    await expect(executeApprovedChange('change-1', 'owner', 'account-a')).resolves.toMatchObject({ status: 'EXECUTED_VERIFIED' })
    const post = fetchSpy.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(String((post![1] as RequestInit).body)).toContain('daily_budget=5000')
  })

  it('a TWD read-back in ISO hundredths does not verify (the check is not self-consistent with a wrong table)', async () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'TWD')
    vi.stubEnv('DAILY_BUDGET_CEILING', '6000')
    vi.stubGlobal('fetch', metaDouble('4000', '500000'))
    const { executeApprovedChange } = await load((query) => {
      if (query.table === 'change_requests' && query.op === 'select') return { data: approvedBudgetChange(5000, '4000'), error: null }
      if (query.table === 'action_decisions') return { data: budgetDecision('approved', 5000), error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, currency: 'TWD' }, error: null }
      if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
      if (query.table === 'action_log' && query.op === 'insert') return { data: { id: 'log-1' }, error: null }
      if (query.op === 'update') return { data: [{ id: 'updated' }], error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })
    await expect(executeApprovedChange('change-1', 'owner', 'account-a')).resolves.toMatchObject({ status: 'EXECUTED_UNVERIFIED' })
  })

  it('counts budgets in every spend-capable effective status, not only ACTIVE', async () => {
    const fetchSpy = metaDouble('3500', '3500')
    vi.stubGlobal('fetch', fetchSpy)
    const { proposeChange } = await load((query) => {
      if (query.table === 'change_requests') return { data: null, error: null }
      if (query.table === 'action_decisions') return { data: budgetDecision('not_requested', 40), error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, currency: 'USD' }, error: null }
      if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
      if (query.table === 'create_change_request_from_decision') return { data: { id: 'change-1' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })
    await proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-budget', actionType: 'adjust_budget',
      entityLevel: 'adset', metaEntityId: 'adset-1', params: { new_daily_budget: 40 },
    })
    const listUrls = fetchSpy.mock.calls.map((call) => new URL(String(call[0])))
      .filter((url) => url.pathname.endsWith('/campaigns') || url.pathname.endsWith('/adsets'))
    expect(listUrls).toHaveLength(2)
    for (const url of listUrls) {
      const statuses = JSON.parse(url.searchParams.get('effective_status') ?? '[]') as string[]
      for (const status of ['ACTIVE', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES']) {
        expect(statuses).toContain(status)
      }
      for (const status of ['PAUSED', 'ARCHIVED', 'DELETED', 'DISAPPROVED']) expect(statuses).not.toContain(status)
    }
  })

  it('serializes executions per account: a held account lock aborts before any Meta call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { executeApprovedChange, httpStatusForExecuteResult } = await load((query) => {
      if (query.table === 'change_requests') return { data: approvedBudgetChange(40, '3500'), error: null }
      if (query.table === 'action_decisions') return { data: budgetDecision('approved', 40), error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, currency: 'USD' }, error: null }
      if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
      if (query.table === 'action_log' && query.op === 'insert') {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_action_log_one_executing_per_account"' } }
      }
      if (query.table === 'action_log') return { data: null, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })
    const result = await executeApprovedChange('change-1', 'owner', 'account-a') as { status: string }
    expect(result).toMatchObject({ status: 'ACCOUNT_WRITE_IN_PROGRESS' })
    expect(JSON.stringify(result)).not.toContain('duplicate key')
    expect(httpStatusForExecuteResult(result.status)).toBe(409)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
