import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'

// the duplicate-claim recovery path. action_log status is AUTHORITATIVE; the change-request
// repair must be CONFIRMED (its error AND affected rows), and an applied-but-unverified prior execution
// must preserve its warning rather than read as clean ALREADY_EXECUTED.

interface Q { table: string; op: string; filters: Array<[string, unknown]> }
type Handler = (q: Q) => { data?: unknown; error?: { message: string } | null }

const beforeState = {
  snapshot_contract_version: 1, entity_level: 'ad', id: 'ad-9', account_id: '12345',
  adset_id: 'adset-1', campaign_id: 'campaign-1', name: 'Control', status: 'ACTIVE',
}

function makeDb(handler: Handler) {
  return {
    from(table: string) {
      const q: Q = { table, op: 'select', filters: [] }
      const chain: Record<string, unknown> = {}
      const self = (op?: string) => { if (op) q.op = op; return chain }
      for (const m of ['select', 'insert', 'update']) chain[m] = () => self(m === 'select' && q.op !== 'select' ? q.op : m)
      for (const m of ['eq', 'is', 'in', 'gte', 'lte', 'not', 'order', 'limit']) chain[m] = (c: string, v?: unknown) => { q.filters.push([`${m}:${c}`, v]); return chain }
      chain.single = () => Promise.resolve(handler(q))
      chain.maybeSingle = () => Promise.resolve(handler(q))
      chain.then = (r: (v: unknown) => unknown) => Promise.resolve(handler(q)).then(r)
      return chain
    },
  }
}

interface Opts { updateData?: unknown; updateError?: { message: string } | null; crRereadStatus?: string }

async function run(claimStatus: string, opts: Opts = {}) {
  vi.stubEnv('WRITE_MODE_ENABLED', 'true')
  const fetchSpy = vi.fn(() => { throw new Error('a duplicate-claim recovery must make no Meta call') })
  vi.stubGlobal('fetch', fetchSpy)
  let crSelects = 0
  const handler: Handler = (q) => {
    if (q.table === 'change_requests' && q.op === 'select') {
      crSelects++
      // First select = the initial CR load (approved); a later select = the post-repair re-read.
      return crSelects === 1
        ? { data: { id: 'CR-1', status: 'approved', action_decision_id: 'DEC-1', action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: 'ad-9', params: {}, idempotency_key: 'KEY-1', ad_account_id: 'acct-1', before_state: beforeState, expires_at: '2099-01-01T00:00:00.000Z' }, error: null }
        : { data: { status: opts.crRereadStatus ?? 'executed' }, error: null }
    }
    if (q.table === 'action_decisions' && q.op === 'select') {
      return { data: { id: 'DEC-1', ad_account_id: 'acct-1', action_kind: 'pause', target_level: 'ad', target_id: 'ad-9', authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR, approval_state: 'approved', proposed_mutation: { action_type: 'pause_ad', status: 'PAUSED' }, causal_contribution_estimate_id: 'estimate-1' }, error: null }
    }
    if (q.table === 'ad_accounts' && q.op === 'select') return { data: { account_id: 'act_12345', is_active: true }, error: null }
    if (q.table === 'ads' && q.op === 'select') return { data: { id: 'local-ad-9' }, error: null }
    if (q.table === 'action_log' && q.op === 'insert') return { data: null, error: { message: 'duplicate key value violates unique constraint' } }
    if (q.table === 'action_log' && q.op === 'select') return { data: { id: 'LOG-1', status: claimStatus }, error: null }
    if (q.table === 'change_requests' && q.op === 'update') return { data: opts.updateData ?? [{ id: 'CR-1' }], error: opts.updateError ?? null }
    throw new Error(`unexpected query: ${q.table} ${q.op}`)
  }
  vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
  vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => makeDb(handler) }))
  vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
  const mod = await import('@/lib/writes/executor')
  const res = (await mod.executeApprovedChange('CR-1', 'tester', 'acct-1')) as { status: string; verified?: boolean }
  return { res, fetchSpy }
}

describe('executeApprovedChange — recovery precedence', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    vi.doUnmock('@/lib/monitoring/alerts'); vi.doUnmock('@/lib/supabase/admin'); vi.doUnmock('@sentry/nextjs')
  })

  it('prior verified + confirmed repair → ALREADY_EXECUTED, zero Meta calls', async () => {
    const { res, fetchSpy } = await run('verified')
    expect(res.status).toBe('ALREADY_EXECUTED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('prior applied_unverified → ALREADY_APPLIED_UNVERIFIED, preserves the unverified warning', async () => {
    const { res } = await run('applied_unverified')
    expect(res.status).toBe('ALREADY_APPLIED_UNVERIFIED')
    expect(res.verified).toBe(false)
  })

  it('zero-row repair + CR still approved → AUDIT_INCOMPLETE', async () => {
    const { res } = await run('verified', { updateData: [], crRereadStatus: 'approved' })
    expect(res.status).toBe('AUDIT_INCOMPLETE')
  })

  it('zero-row repair but CR already executed → ALREADY_EXECUTED (the normal legit retry)', async () => {
    const { res } = await run('verified', { updateData: [], crRereadStatus: 'executed' })
    expect(res.status).toBe('ALREADY_EXECUTED')
  })

  it('repair update error → AUDIT_INCOMPLETE', async () => {
    const { res } = await run('verified', { updateError: { message: 'db down' } })
    expect(res.status).toBe('AUDIT_INCOMPLETE')
  })
})
