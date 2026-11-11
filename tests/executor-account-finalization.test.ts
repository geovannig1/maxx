import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'

interface Query {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: Record<string, unknown>
  filters: Array<[string, unknown]>
}

function database(calls: Query[], options: { requestStillApproved?: boolean } = {}) {
  const result = (query: Query) => {
    if (query.table === 'change_requests' && query.op === 'select') {
      return {
        data: {
          id: 'change-1', ad_account_id: 'account-a', status: 'approved', action_decision_id: 'decision-1',
          action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: 'ad-1', params: {},
          before_state: {
            snapshot_contract_version: 1, entity_level: 'ad', id: 'ad-1', account_id: '12345',
            adset_id: 'adset-1', campaign_id: 'campaign-1', name: 'Control', status: 'ACTIVE',
          },
          idempotency_key: 'key-1', expires_at: '2099-01-01T00:00:00.000Z',
        },
        error: null,
      }
    }
    if (query.table === 'action_decisions' && query.op === 'select') {
      return {
        data: {
          id: 'decision-1', ad_account_id: 'account-a', action_kind: 'pause', target_level: 'ad',
          target_id: 'ad-1', authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR,
          approval_state: 'approved', proposed_mutation: { action_type: 'pause_ad', status: 'PAUSED' },
          causal_contribution_estimate_id: 'estimate-1',
        },
        error: null,
      }
    }
    if (query.table === 'ad_accounts' && query.op === 'select') {
      return { data: { account_id: 'act_12345', is_active: true, platform: 'meta' }, error: null }
    }
    if (query.table === 'ads' && query.op === 'select') {
      return { data: { id: 'local-ad-1' }, error: null }
    }
    if (query.table === 'action_log' && query.op === 'insert') {
      return { data: { id: 'log-1' }, error: null }
    }
    // Compare-and-set: a request that left 'approved' meanwhile matches no row.
    if (query.table === 'change_requests' && query.op === 'update' && options.requestStillApproved === false) return { data: [], error: null }
    if (query.op === 'update') return { data: [{ id: 'updated' }], error: null }
    throw new Error(`Unexpected query ${query.table}:${query.op}`)
  }

  return {
    from(table: string) {
      const query: Query = { table, op: 'select', filters: [] }
      calls.push(query)
      const builder = {
        select: () => builder,
        insert: (payload: Record<string, unknown>) => {
          query.op = 'insert'
          query.payload = payload
          return builder
        },
        update: (payload: Record<string, unknown>) => {
          query.op = 'update'
          query.payload = payload
          return builder
        },
        eq: (column: string, value: unknown) => {
          query.filters.push([column, value])
          return builder
        },
        single: async () => result(query),
        maybeSingle: async () => result(query),
        then: (
          resolve: (value: ReturnType<typeof result>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(result(query)).then(resolve, reject),
      }
      return builder
    },
  }
}

describe('executeApprovedChange account-scoped finalization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
    vi.stubEnv('META_ACCESS_TOKEN', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/supabase/admin')
    vi.doUnmock('@/lib/monitoring/alerts')
    vi.doUnmock('@sentry/nextjs')
  })

  it('binds the claim and both finalization writes to the expected account', async () => {
    const calls: Query[] = []
    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        id: 'ad-1', account_id: '12345', adset_id: 'adset-1', campaign_id: 'campaign-1',
        name: 'Control', status: 'ACTIVE',
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        id: 'ad-1', account_id: '12345', adset_id: 'adset-1', campaign_id: 'campaign-1',
        name: 'Control', status: 'PAUSED',
      }) }))
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => database(calls) }))
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))

    const { executeApprovedChange } = await import('@/lib/writes/executor')
    const response = await executeApprovedChange('change-1', 'owner', 'account-a') as { status: string }

    expect(response.status).toBe('EXECUTED_VERIFIED')
    const claim = calls.find((call) => call.table === 'action_log' && call.op === 'insert')
    expect(claim?.payload).toMatchObject({ ad_account_id: 'account-a' })

    for (const call of calls.filter((candidate) => candidate.op !== 'insert' && ['change_requests', 'action_decisions', 'action_log'].includes(candidate.table))) {
      expect(call.filters, `${call.table}:${call.op}`).toContainEqual(['ad_account_id', 'account-a'])
    }
  })

  it('finalizes the request only from approved: a request that changed meanwhile is never overwritten (security review L1)', async () => {
    const calls: Query[] = []
    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ad-1', account_id: '12345', adset_id: 'adset-1', campaign_id: 'campaign-1', name: 'Control', status: 'ACTIVE' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ad-1', account_id: '12345', adset_id: 'adset-1', campaign_id: 'campaign-1', name: 'Control', status: 'PAUSED' }) }))
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => database(calls, { requestStillApproved: false }) }))
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))

    const { executeApprovedChange } = await import('@/lib/writes/executor')
    const response = await executeApprovedChange('change-1', 'owner', 'account-a') as { status: string }

    expect(response.status).toBe('AUDIT_INCOMPLETE')
    const finalize = calls.find((call) => call.table === 'change_requests' && call.op === 'update')
    expect(finalize?.filters).toContainEqual(['status', 'approved'])
  })

  it('stores and returns Meta\'s answer trimmed and redacted, never a token-like string (security review L3)', async () => {
    const calls: Query[] = []
    // A token-like string (fake), assembled so it is not a literal credential in the source.
    const fakeMetaValue = ['EA', 'AB', 'fake', 'TOK', 'EN', '12345', '67890', 'abcde', 'fghij'].join('')
    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ad-1', account_id: '12345', adset_id: 'adset-1', campaign_id: 'campaign-1', name: 'Control', status: 'ACTIVE' }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({
        error: { message: `Error validating access token: access_token=${fakeMetaValue} Bearer ${fakeMetaValue}`, type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'AbCdEf' },
        debug: `https://graph.facebook.com/v1/ad-1?access_token=${fakeMetaValue}`,
      }) }))
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => database(calls) }))
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))

    const { executeApprovedChange } = await import('@/lib/writes/executor')
    const response = await executeApprovedChange('change-1', 'owner', 'account-a') as { status: string; response?: { error?: { meta_code?: number } } }

    expect(response.status).toBe('FAILED')
    expect(JSON.stringify(response)).not.toContain(fakeMetaValue)
    expect(response.response?.error?.meta_code).toBe(190)
    for (const update of calls.filter((call) => call.op === 'update')) {
      expect(JSON.stringify(update.payload), update.table).not.toContain(fakeMetaValue)
      expect(JSON.stringify(update.payload), update.table).not.toContain('fbtrace')
    }
  })
})
