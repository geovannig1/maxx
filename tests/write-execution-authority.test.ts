import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'

interface Query { table: string; op: string; filters: Array<[string, unknown]> }

function database(rows: Record<string, unknown>, decision: Record<string, unknown> | null, calls: Query[]) {
  return {
    from(table: string) {
      const query: Query = { table, op: 'select', filters: [] }
      calls.push(query)
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.insert = () => { query.op = 'insert'; return chain }
      chain.update = () => { query.op = 'update'; return chain }
      chain.eq = (column: string, value: unknown) => { query.filters.push([column, value]); return chain }
      const result = () => {
        if (table === 'change_requests' && query.op === 'select') return { data: rows, error: null }
        if (table === 'action_decisions' && query.op === 'select') return { data: decision, error: null }
        throw new Error(`unexpected query ${table}:${query.op}`)
      }
      chain.single = async () => result()
      chain.maybeSingle = async () => result()
      return chain
    },
  }
}

describe('executor revalidates ActionDecision authority before the atomic claim', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
  })
  afterEach(() => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    vi.doUnmock('@/lib/supabase/admin'); vi.doUnmock('@/lib/monitoring/alerts'); vi.doUnmock('@sentry/nextjs')
  })

  async function run(
    change: Record<string, unknown>,
    decision: Record<string, unknown> | null,
    expectedAdAccountId = 'acct-1',
  ) {
    const calls: Query[] = []
    const fetchSpy = vi.fn(() => { throw new Error('Meta must not be called without write authority') })
    vi.stubGlobal('fetch', fetchSpy)
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => database(change, decision, calls) }))
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
    const { executeApprovedChange } = await import('@/lib/writes/executor')
    const result = await executeApprovedChange('CR-1', 'owner', expectedAdAccountId) as { status: string; message?: string }
    return { result, calls, fetchSpy }
  }

  const baseChange = {
    id: 'CR-1', status: 'approved', action_type: 'pause_ad', entity_level: 'ad',
    meta_entity_id: 'ad-9', params: {}, idempotency_key: 'KEY-1', ad_account_id: 'acct-1',
    before_state: null, expires_at: '2099-01-01T00:00:00.000Z',
  }
  const baseDecision = {
    id: 'DEC-1', ad_account_id: 'acct-1', action_kind: 'pause', target_level: 'ad',
    target_id: 'ad-9', authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR,
    approval_state: 'approved', proposed_mutation: { action_type: 'pause_ad', status: 'PAUSED' },
    causal_contribution_estimate_id: 'estimate-1',
  }

  it('blocks a legacy approved request with no decision lineage', async () => {
    const { result, calls, fetchSpy } = await run(baseChange, null)
    expect(result).toMatchObject({ status: 'AUTHORITY_REQUIRED', message: expect.stringContaining('legacy') })
    expect(calls.some((query) => query.table === 'action_log')).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('blocks a linked request whose decision no longer matches the exact mutation', async () => {
    const { result, calls, fetchSpy } = await run(
      { ...baseChange, action_decision_id: 'DEC-1' },
      { ...baseDecision, proposed_mutation: { action_type: 'pause_ad', status: 'ACTIVE' } },
    )
    expect(result).toMatchObject({ status: 'AUTHORITY_REQUIRED' })
    expect(calls.some((query) => query.table === 'action_log')).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('blocks owner-review evidence even if a bad row claims it was approved', async () => {
    const { result, fetchSpy } = await run(
      { ...baseChange, action_decision_id: 'DEC-1' },
      { ...baseDecision, authority_tier: 'owner_review' },
    )
    expect(result).toMatchObject({ status: 'AUTHORITY_REQUIRED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not load or execute an approved request owned by a different account', async () => {
    const { result, calls, fetchSpy } = await run(
      { ...baseChange, ad_account_id: 'acct-b', action_decision_id: 'DEC-1' },
      { ...baseDecision, ad_account_id: 'acct-b' },
      'acct-a',
    )

    expect(result).toMatchObject({ status: 'NOT_FOUND' })
    expect(calls.find((query) => query.table === 'change_requests')?.filters)
      .toContainEqual(['ad_account_id', 'acct-a'])
    expect(calls.some((query) => query.table === 'action_log')).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
