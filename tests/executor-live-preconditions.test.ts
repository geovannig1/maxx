import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'

interface Query {
  table: string
  op: 'select' | 'insert' | 'update' | 'rpc'
  payload?: unknown
  filters: Array<[string, unknown]>
}

type Result = { data: unknown; error: { message: string } | null }

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

const decision = {
  id: 'decision-1', ad_account_id: 'account-a', action_kind: 'pause', target_level: 'ad',
  target_id: 'ad-1', authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR,
  approval_state: 'approved', proposed_mutation: { action_type: 'pause_ad', status: 'PAUSED' },
  causal_contribution_estimate_id: 'estimate-1',
}

const approvedSnapshot = {
  snapshot_contract_version: 1,
  entity_level: 'ad',
  id: 'ad-1',
  account_id: '12345',
  adset_id: 'adset-1',
  campaign_id: 'campaign-1',
  name: 'Control',
  status: 'ACTIVE',
}

const approvedChange = {
  id: 'change-1', ad_account_id: 'account-a', status: 'approved', action_decision_id: 'decision-1',
  action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: 'ad-1', params: {},
  before_state: approvedSnapshot, idempotency_key: 'key-1',
  expires_at: '2099-01-01T00:00:00.000Z',
}

describe('write executor live preconditions', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
    vi.stubEnv('META_ACCESS_TOKEN', 'super-secret-token')
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

  it('rejects an expired approved row before a claim or any Meta request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { executeApprovedChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return {
        data: { ...approvedChange, expires_at: '2020-01-01T00:00:00.000Z' }, error: null,
      }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(executeApprovedChange('change-1', 'owner', 'account-a'))
      .resolves.toMatchObject({ status: 'EXPIRED' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls.some((query) => query.table === 'action_log')).toBe(false)
  })

  it('rejects a locally cross-account entity before claiming or calling Meta', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { executeApprovedChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return { data: approvedChange, error: null }
      if (query.table === 'action_decisions') return { data: decision, error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta' }, error: null }
      if (query.table === 'ads') return { data: null, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(executeApprovedChange('change-1', 'owner', 'account-a'))
      .resolves.toMatchObject({ status: 'OWNERSHIP_UNVERIFIED' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls.some((query) => query.table === 'action_log')).toBe(false)
  })

  it('retires a legacy/null approved snapshot before claiming or calling Meta', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { executeApprovedChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return {
        data: { ...approvedChange, before_state: null }, error: null,
      }
      if (query.table === 'action_decisions') return { data: decision, error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta' }, error: null }
      if (query.table === 'ads') return { data: { id: 'local-ad-1' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(executeApprovedChange('change-1', 'owner', 'account-a'))
      .resolves.toMatchObject({ status: 'STALE_APPROVAL' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls.some((query) => query.table === 'action_log')).toBe(false)
  })

  it('after claiming, rejects drift from the owner-approved state without a Meta POST', async () => {
    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      void input
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer super-secret-token' })
      return {
        ok: true,
        json: async () => ({
          id: 'ad-1', account_id: '12345', adset_id: 'adset-1', campaign_id: 'campaign-1',
          name: 'Control', status: 'PAUSED',
        }),
      }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { executeApprovedChange, calls } = await load((query) => {
      if (query.table === 'change_requests' && query.op === 'select') return { data: approvedChange, error: null }
      if (query.table === 'action_decisions') return { data: decision, error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta' }, error: null }
      if (query.table === 'ads') return { data: { id: 'local-ad-1' }, error: null }
      if (query.table === 'action_log' && query.op === 'insert') return { data: { id: 'log-1' }, error: null }
      if (query.op === 'update') return { data: [{ id: 'updated' }], error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(executeApprovedChange('change-1', 'owner', 'account-a'))
      .resolves.toMatchObject({ status: 'STALE_APPROVAL' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][1]).not.toMatchObject({ method: 'POST' })
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('access_token')
    expect(calls.find((query) => query.table === 'action_log' && query.op === 'update')?.payload)
      .toMatchObject({ status: 'failed', verified: false })
    expect(calls.find((query) => query.table === 'change_requests' && query.op === 'update')?.payload)
      .toMatchObject({ status: 'failed' })
  })

  it('blocks proposal creation when the current Meta snapshot cannot be captured', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, json: async () => ({ error: { message: 'denied' } }) }))
    vi.stubGlobal('fetch', fetchSpy)
    const { proposeChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return { data: null, error: null }
      if (query.table === 'action_decisions') return { data: { ...decision, approval_state: 'not_requested' }, error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta' }, error: null }
      if (query.table === 'ads') return { data: { id: 'local-ad-1' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-1', actionType: 'pause_ad',
      entityLevel: 'ad', metaEntityId: 'ad-1', params: {},
    })).resolves.toMatchObject({ status: 'SNAPSHOT_UNAVAILABLE' })
    expect(calls.some((query) => query.op === 'rpc')).toBe(false)
  })

  it('creates a proposal only with the exact account-owned Meta snapshot in its immutable payload', async () => {
    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      void input
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer super-secret-token' })
      return { ok: true, json: async () => ({
        id: 'ad-1', account_id: 'act_12345', adset_id: 'adset-1', campaign_id: 'campaign-1',
        name: 'Control', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED',
      }) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { proposeChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return { data: null, error: null }
      if (query.table === 'action_decisions') return { data: { ...decision, approval_state: 'not_requested' }, error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta' }, error: null }
      if (query.table === 'ads') return { data: { id: 'local-ad-1' }, error: null }
      if (query.table === 'create_change_request_from_decision') return { data: { id: 'change-1' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-1', actionType: 'pause_ad',
      entityLevel: 'ad', metaEntityId: 'ad-1', params: {},
    })).resolves.toMatchObject({ status: 'PENDING_APPROVAL', change_request_id: 'change-1' })
    const rpc = calls.find((query) => query.table === 'create_change_request_from_decision')
    expect(rpc?.payload).toMatchObject({
      p_action_decision_id: 'decision-1',
      p_request: { before_state: approvedSnapshot, ad_account_id: 'account-a' },
    })
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('access_token')
  })

  it('blocks an individually valid ad-set budget when the active account total would exceed the ceiling', async () => {
    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer super-secret-token' })
      const url = new URL(String(input))
      if (url.pathname.endsWith('/adset-1')) {
        return { ok: true, json: async () => ({
          id: 'adset-1', account_id: 'act_12345', campaign_id: 'campaign-1',
          name: 'Target', status: 'ACTIVE', daily_budget: '5000',
        }) }
      }
      if (url.pathname.endsWith('/campaigns')) return { ok: true, json: async () => ({ data: [] }) }
      if (url.pathname.endsWith('/adsets')) return { ok: true, json: async () => ({ data: [
        { id: 'adset-1', campaign_id: 'campaign-1', daily_budget: '5000' },
        { id: 'adset-2', campaign_id: 'campaign-1', daily_budget: '4000' },
      ] }) }
      throw new Error(`unexpected Meta URL ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchSpy)
    const budgetDecision = {
      id: 'decision-budget', ad_account_id: 'account-a', action_kind: 'budget_scale',
      target_level: 'adset', target_id: 'adset-1', authority_tier: 'execution_eligible',
      policy_version: ACTION_DECISION_POLICY_FLOOR, approval_state: 'not_requested',
      proposed_mutation: { action_type: 'adjust_budget', new_daily_budget_usd: 70 },
      causal_contribution_estimate_id: 'estimate-budget',
    }
    const { proposeChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return { data: null, error: null }
      if (query.table === 'action_decisions') return { data: budgetDecision, error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta', currency: 'USD' }, error: null }
      if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-budget', actionType: 'adjust_budget',
      entityLevel: 'adset', metaEntityId: 'adset-1', params: { new_daily_budget_usd: 70 },
    })).resolves.toMatchObject({ status: 'BLOCKED', message: expect.stringMatching(/\$110\.00.*\$100/) })
    expect(calls.some((query) => query.op === 'rpc')).toBe(false)
    for (const call of fetchSpy.mock.calls) expect(call[1]).not.toMatchObject({ method: 'POST' })
  })

  it('blocks a budget proposal when an active lifetime budget makes daily account exposure unknown', async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/adset-1')) {
        return { ok: true, json: async () => ({
          id: 'adset-1', account_id: 'act_12345', campaign_id: 'campaign-1',
          name: 'Target', status: 'ACTIVE', daily_budget: '5000',
        }) }
      }
      if (url.pathname.endsWith('/campaigns')) return { ok: true, json: async () => ({ data: [
        { id: 'campaign-1', lifetime_budget: '100000' },
      ] }) }
      if (url.pathname.endsWith('/adsets')) return { ok: true, json: async () => ({ data: [] }) }
      throw new Error(`unexpected Meta URL ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchSpy)
    const budgetDecision = {
      id: 'decision-budget', ad_account_id: 'account-a', action_kind: 'budget_scale',
      target_level: 'adset', target_id: 'adset-1', authority_tier: 'execution_eligible',
      policy_version: ACTION_DECISION_POLICY_FLOOR, approval_state: 'not_requested',
      proposed_mutation: { action_type: 'adjust_budget', new_daily_budget_usd: 40 },
      causal_contribution_estimate_id: 'estimate-budget',
    }
    const { proposeChange, calls } = await load((query) => {
      if (query.table === 'change_requests') return { data: null, error: null }
      if (query.table === 'action_decisions') return { data: budgetDecision, error: null }
      if (query.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta', currency: 'USD' }, error: null }
      if (query.table === 'adsets') return { data: { id: 'local-adset-1' }, error: null }
      throw new Error(`unexpected query ${query.table}:${query.op}`)
    })

    await expect(proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-budget', actionType: 'adjust_budget',
      entityLevel: 'adset', metaEntityId: 'adset-1', params: { new_daily_budget_usd: 40 },
    })).resolves.toMatchObject({ status: 'PRECONDITION_UNAVAILABLE', message: expect.stringMatching(/account-budget total.*proven/i) })
    expect(calls.some((query) => query.op === 'rpc')).toBe(false)
  })

  it('uses Authorization headers and form bodies; the token never appears in a Meta URL', async () => {
    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      void input
      void init
      return { ok: true, json: async () => ({ success: true }) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { applyChange } = await load(() => { throw new Error('database not expected') })

    await expect(applyChange('adjust_budget', 'adset-1', { new_daily_budget_usd: 60 }))
      .resolves.toMatchObject({ ok: true })
    const call = fetchSpy.mock.calls[0]
    expect(call).toBeDefined()
    const input = call?.[0]
    const init = call?.[1] as RequestInit | undefined
    expect(String(input)).toContain('/adset-1')
    expect(String(input)).not.toContain('access_token')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer super-secret-token' })
    expect(String(init?.body)).toContain('daily_budget=6000')
  })

  it('rejects path/query-shaped Meta ids before any network request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { applyChange } = await load(() => { throw new Error('database not expected') })

    await expect(applyChange('pause_ad', '../ad-1?access_token=attacker', {}))
      .resolves.toMatchObject({ ok: false, response: { error: expect.stringContaining('invalid') } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails closed without a Meta credential and never sends an unauthenticated write', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', '')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { applyChange } = await load(() => { throw new Error('database not expected') })

    await expect(applyChange('pause_ad', 'ad-1', {}))
      .resolves.toMatchObject({ ok: false, response: { error: expect.stringContaining('credentials') } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
