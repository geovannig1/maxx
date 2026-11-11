import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'

// Atomic-claim contract (review finding: read-then-act race → double execution): the executor inserts
// the action_log row FIRST under the UNIQUE idempotency_key. When that insert conflicts, the loser must
// abort BEFORE any Meta call and report the true state (IN_PROGRESS / PREVIOUSLY_FAILED /
// ALREADY_EXECUTED) — these tests drive executeApprovedChange with a scripted db and a fetch tripwire.

interface Q { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }
type Handler = (q: Q) => { data?: unknown; error?: { message: string } | null }

const beforeState = {
  snapshot_contract_version: 1, entity_level: 'ad', id: 'ad-9', account_id: '12345',
  adset_id: 'adset-1', campaign_id: 'campaign-1', name: 'Control', status: 'ACTIVE',
}

function makeDb(handler: Handler, calls: Q[]) {
  function builder(table: string) {
    const q: Q = { table, op: 'select', filters: [] }
    calls.push(q)
    const chain: Record<string, unknown> = {}
    const self = (op?: string, payload?: unknown) => {
      if (op) { q.op = op; q.payload = payload }
      return chain
    }
    for (const m of ['select', 'insert', 'update']) chain[m] = (payload?: unknown) => self(m === 'select' && q.op !== 'select' ? q.op : m, m === 'select' ? q.payload : payload)
    for (const m of ['eq', 'is', 'in', 'gte', 'lte', 'not', 'order', 'limit']) chain[m] = (col: string, val?: unknown) => { q.filters.push([`${m}:${col}`, val]); return chain }
    chain.single = () => Promise.resolve(handler(q))
    chain.maybeSingle = () => Promise.resolve(handler(q))
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(handler(q)).then(resolve)
    return chain
  }
  return { from: builder }
}

describe('executeApprovedChange — atomic claim conflicts', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/monitoring/alerts')
    vi.doUnmock('@/lib/supabase/admin')
    vi.doUnmock('@sentry/nextjs')
  })

  async function load(existingClaimStatus: string) {
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
    const fetchSpy = vi.fn(() => {
      throw new Error('META CALL ATTEMPTED — a losing claim must abort before any live write')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const calls: Q[] = []
    const handler: Handler = (q) => {
      if (q.table === 'change_requests' && q.op === 'select') {
        return { data: { id: 'CR-1', status: 'approved', action_decision_id: 'DEC-1', action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: 'ad-9', params: {}, idempotency_key: 'KEY-1', ad_account_id: 'acct-1', before_state: beforeState, expires_at: '2099-01-01T00:00:00.000Z' }, error: null }
      }
      if (q.table === 'action_decisions' && q.op === 'select') {
        return { data: { id: 'DEC-1', ad_account_id: 'acct-1', action_kind: 'pause', target_level: 'ad', target_id: 'ad-9', authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR, approval_state: 'approved', proposed_mutation: { action_type: 'pause_ad', status: 'PAUSED' }, causal_contribution_estimate_id: 'estimate-1' }, error: null }
      }
      if (q.table === 'ad_accounts' && q.op === 'select') return { data: { account_id: 'act_12345', is_active: true, platform: 'meta' }, error: null }
      if (q.table === 'ads' && q.op === 'select') return { data: { id: 'local-ad-9' }, error: null }
      if (q.table === 'action_log' && q.op === 'insert') {
        return { data: null, error: { message: 'duplicate key value violates unique constraint "idx_action_log_idempotency"' } }
      }
      if (q.table === 'action_log' && q.op === 'select') {
        return { data: { id: 'LOG-1', status: existingClaimStatus }, error: null }
      }
      if (q.table === 'change_requests' && q.op === 'update') {
        // Repair flips approved → executed and reports one affected row.
        return { data: [{ id: 'CR-1' }], error: null }
      }
      throw new Error(`unexpected query: ${q.table} ${q.op}`)
    }
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => makeDb(handler, calls) }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
    const mod = await import('@/lib/writes/executor')
    return { exec: mod.executeApprovedChange, fetchSpy, calls }
  }

  it('concurrent claim already executing → IN_PROGRESS, zero Meta calls', async () => {
    const { exec, fetchSpy } = await load('executing')
    const res = (await exec('CR-1', 'tester', 'acct-1')) as { status: string }
    expect(res.status).toBe('IN_PROGRESS')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('prior failed claim → PREVIOUSLY_FAILED, no auto-retry, zero Meta calls', async () => {
    const { exec, fetchSpy } = await load('failed')
    const res = (await exec('CR-1', 'tester', 'acct-1')) as { status: string }
    expect(res.status).toBe('PREVIOUSLY_FAILED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('prior verified claim → ALREADY_EXECUTED and the change request is finalized, zero Meta calls', async () => {
    const { exec, fetchSpy, calls } = await load('verified')
    const res = (await exec('CR-1', 'tester', 'acct-1')) as { status: string }
    expect(res.status).toBe('ALREADY_EXECUTED')
    expect(fetchSpy).not.toHaveBeenCalled()
    const crUpdate = calls.find((q) => q.table === 'change_requests' && q.op === 'update')
    expect(crUpdate).toBeTruthy()
    // Finalization is still guarded on the approved state (no clobbering of a concurrent transition).
    expect(crUpdate!.filters).toContainEqual(['eq:status', 'approved'])
    for (const call of calls) {
      if (!['change_requests', 'action_decisions', 'action_log'].includes(call.table)) continue
      if (call.op === 'insert') {
        expect(call.payload).toMatchObject({ ad_account_id: 'acct-1' })
      } else {
        expect(call.filters, `${call.table}:${call.op}`).toContainEqual(['eq:ad_account_id', 'acct-1'])
      }
    }
  })
})
