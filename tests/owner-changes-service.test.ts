import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { projectWriteSnapshot } from '@/lib/writes/meta-live-state'

// ADR-059 proposal service with the real gates: a fake database and a Meta double. Each refusal is
// checked to reach neither the RPC nor (where it is decided before) Meta.

interface Query { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> }
type Result = { data: unknown; error: { message: string } | null }

function database(handler: (q: Query) => Result, calls: Query[]) {
  return {
    from(table: string) {
      const q: Query = { table, op: 'select', filters: [] }
      calls.push(q)
      const b: Record<string, unknown> = {}
      b.select = () => b
      for (const op of ['eq', 'is', 'gt', 'gte', 'in']) b[op] = (c: string, v: unknown) => { q.filters.push([op, c, v]); return b }
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => handler(q)
      b.single = async () => handler(q)
      b.then = (resolve: (r: Result) => unknown) => Promise.resolve(handler(q)).then(resolve)
      return b
    },
    rpc(name: string, payload: unknown) {
      const q: Query = { table: name, op: 'rpc', payload, filters: [] }
      calls.push(q)
      return Promise.resolve(handler(q))
    },
  }
}

const now = new Date().toISOString()
const decision = (overrides: Record<string, unknown> = {}) => ({
  id: 'decision-1', ad_account_id: 'account-a', action_kind: 'budget_scale', target_level: 'adset', target_id: 'adset-1',
  authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR, approval_state: 'not_requested',
  proposed_mutation: null, causal_contribution_estimate_id: null, evaluated_at: now,
  owner_copy: 'FOR OWNER REVIEW. Website visitors convert well.', evidence_plane: 'meta_modelled', evidence_basis: 'meta_modelled_association',
  ...overrides,
})
const rawAdset = (minor: string) => ({ id: 'adset-1', account_id: 'act_12345', campaign_id: 'campaign-1', name: 'Website visitors', status: 'ACTIVE', daily_budget: minor })

interface Setup { decision?: Record<string, unknown>; currency?: string; otherBudgetMinor?: string; adsetMinor?: string; existing?: Record<string, unknown> | null; original?: Record<string, unknown> }

async function load(setup: Setup = {}) {
  const calls: Query[] = []
  vi.doMock('@/lib/supabase/admin', () => ({
    getAdminClient: () => database((q) => {
      if (q.table === 'action_decisions' && q.filters.some(([op]) => op === 'gt')) return { data: [], error: null }
      if (q.table === 'action_decisions') return { data: setup.decision ?? decision(), error: null }
      if (q.table === 'change_requests') return { data: setup.original ?? setup.existing ?? null, error: null }
      if (q.table === 'ad_accounts') return { data: { account_id: 'act_12345', is_active: true, currency: setup.currency ?? 'USD' }, error: null }
      if (q.table === 'adsets' || q.table === 'ads') return { data: { id: 'local-1' }, error: null }
      if (q.op === 'rpc') return { data: { id: 'change-new' }, error: null }
      throw new Error(`unexpected ${q.table}:${q.op}`)
    }, calls),
  }))
  const fetchSpy = vi.fn(async (input: unknown) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/adset-1')) return { ok: true, json: async () => rawAdset(setup.adsetMinor ?? '3500') }
    if (url.pathname.endsWith('/campaigns')) return { ok: true, json: async () => ({ data: [] }) }
    if (url.pathname.endsWith('/adsets')) {
      return { ok: true, json: async () => ({ data: [
        { id: 'adset-1', campaign_id: 'campaign-1', daily_budget: setup.adsetMinor ?? '3500' },
        { id: 'adset-2', campaign_id: 'campaign-2', daily_budget: setup.otherBudgetMinor ?? '2000' },
      ] }) }
    }
    throw new Error(`unexpected Meta URL ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchSpy)
  const service = await import('@/lib/writes/owner-changes')
  const rpc = () => calls.filter((q) => q.op === 'rpc')
  return { ...service, calls, rpc, fetchSpy }
}

const input = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  decisionId: 'decision-1', ownerUserId: 'owner-1', actor: 'owner@example.com', accountId: 'account-a', params, ...extra,
})

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('META_ACCESS_TOKEN', ['fake', 'meta', 'credential'].join('-'))
  vi.stubEnv('OWNER_USER_ID', '')
  vi.stubEnv('MAXX_DEMO', '')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock('@/lib/supabase/admin') })

describe('owner proposal service', () => {
  it('creates an owner request with a human preview, risk, rollback and evidence', async () => {
    const { proposeOwnerChange, rpc } = await load()
    const result = await proposeOwnerChange(input({ new_daily_budget: 40 }))
    expect(result).toMatchObject({ status: 'PENDING_APPROVAL', http: 201, change_request_id: 'change-new', risk_level: 'high' })
    expect(result.preview).toMatch(/^Raise ad set "Website visitors" daily budget \$35\.00 → \$40\.00 \(\+14\.3%\)\. Projected active account total: \$60\.00\/day/)
    const call = rpc()[0]
    expect(call.table).toBe('create_owner_change_request')
    expect(call.payload).toMatchObject({
      p_action_decision_id: 'decision-1', p_owner_user_id: 'owner-1',
      p_request: { action_type: 'adjust_budget', entity_level: 'adset', meta_entity_id: 'adset-1', params: { new_daily_budget: 40 }, step_override: false,
        rollback_plan: expect.any(String), evidence: expect.stringMatching(/you initiated this change/), before_state: projectWriteSnapshot('adjust_budget', 'adset-1', rawAdset('3500')) },
    })
  })

  it('refuses a currency mismatch before reading Meta or writing anything', async () => {
    const { proposeOwnerChange, rpc, fetchSpy } = await load({ currency: 'EUR' })
    expect(await proposeOwnerChange(input({ new_daily_budget: 40 }))).toMatchObject({ status: 'CURRENCY_MISMATCH', http: 409 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpc()).toEqual([])
  })

  it('stops a step above the per-change limit until the owner confirms the override', async () => {
    const first = await load()
    expect(await first.proposeOwnerChange(input({ new_daily_budget: 60 }))).toMatchObject({ status: 'STEP_LIMIT_EXCEEDED', step_percent: 71.43, max_step_percent: 50 })
    expect(first.rpc()).toEqual([])
    vi.resetModules()
    const second = await load()
    const result = await second.proposeOwnerChange(input({ new_daily_budget: 60 }, { confirmOverride: true }))
    expect(result).toMatchObject({ status: 'PENDING_APPROVAL', risk_level: 'high', preview: expect.stringMatching(/above the 50% per-change limit/) })
    expect(second.rpc()[0].payload).toMatchObject({ p_request: { step_override: true, risk_level: 'high' } })
  })

  it('treats a step from a zero budget as above any limit: it needs the override (security review L5)', async () => {
    const first = await load({ adsetMinor: '0' })
    expect(await first.proposeOwnerChange(input({ new_daily_budget: 30 }))).toMatchObject({ status: 'STEP_LIMIT_EXCEEDED', http: 409 })
    expect(first.rpc()).toEqual([])
    vi.resetModules()
    const second = await load({ adsetMinor: '0' })
    expect(await second.proposeOwnerChange(input({ new_daily_budget: 30 }, { confirmOverride: true }))).toMatchObject({ status: 'PENDING_APPROVAL', risk_level: 'high' })
    expect(second.rpc()[0].payload).toMatchObject({ p_request: { step_override: true, max_step_percent: 50 } })
  })

  it('honours a configured per-change limit', async () => {
    vi.stubEnv('MAX_BUDGET_CHANGE_PERCENT', '10')
    const { proposeOwnerChange } = await load()
    expect(await proposeOwnerChange(input({ new_daily_budget: 40 }))).toMatchObject({ status: 'STEP_LIMIT_EXCEEDED', max_step_percent: 10 })
  })

  it('refuses a change that would take the account above the budget ceiling', async () => {
    const { proposeOwnerChange, rpc } = await load({ otherBudgetMinor: '7000' })
    expect(await proposeOwnerChange(input({ new_daily_budget: 45 }))).toMatchObject({ status: 'BLOCKED', message: expect.stringMatching(/ceiling/) })
    expect(rpc()).toEqual([])
  })

  it('refuses a budget that moves against the decision direction', async () => {
    const { proposeOwnerChange, rpc } = await load()
    expect(await proposeOwnerChange(input({ new_daily_budget: 30 }))).toMatchObject({ status: 'INVALID_PARAMS', http: 400 })
    expect(rpc()).toEqual([])
  })

  it.each([
    ['diagnostic only', { authority_tier: 'diagnostic_only' }, 'DIAGNOSTIC_ONLY'],
    ['stale', { evaluated_at: new Date(Date.now() - 10 * 86_400_000).toISOString() }, 'STALE_DECISION'],
    ['unsupported', { action_kind: 'creative_refresh', target_level: 'ad' }, 'UNSUPPORTED_MUTATION'],
  ])('refuses a %s decision without touching Meta', async (_label, overrides, status) => {
    const { proposeOwnerChange, rpc, fetchSpy } = await load({ decision: decision(overrides) })
    expect(await proposeOwnerChange(input({ new_daily_budget: 40 }))).toMatchObject({ status, http: 409 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpc()).toEqual([])
  })

  it('returns the existing request on a second click instead of creating another', async () => {
    const { proposeOwnerChange, rpc, fetchSpy } = await load({
      decision: decision({ approval_state: 'pending' }), existing: { id: 'change-1', status: 'pending', preview: 'Raise …' },
    })
    expect(await proposeOwnerChange(input({ new_daily_budget: 40 }))).toMatchObject({ status: 'ALREADY_REQUESTED', change_request_id: 'change-1' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpc()).toEqual([])
  })

  it('refuses a caller whose id differs from the pinned owner', async () => {
    vi.stubEnv('OWNER_USER_ID', 'owner-pinned')
    const { proposeChangeFromDecision, calls } = await load()
    expect(await proposeChangeFromDecision('decision-1', 'someone-else', { params: { new_daily_budget: 40 } })).toMatchObject({ status: 'NOT_OWNER', http: 403 })
    expect(calls).toEqual([])
  })
})

describe('owner rollback proposals', () => {
  const executedBudget = {
    id: 'change-1', ad_account_id: 'account-a', action_decision_id: 'decision-1', action_type: 'adjust_budget', entity_level: 'adset',
    meta_entity_id: 'adset-1', params: { new_daily_budget: 40 }, before_state: projectWriteSnapshot('adjust_budget', 'adset-1', rawAdset('3000')),
    status: 'executed', rollback_of: null,
  }

  it('proposes the inverse budget, restoring the recorded before-state', async () => {
    const { proposeRollback, rpc } = await load({ original: executedBudget })
    const result = await proposeRollback({ changeRequestId: 'change-1', ownerUserId: 'owner-1', accountId: 'account-a' })
    expect(result).toMatchObject({ status: 'PENDING_APPROVAL', preview: expect.stringMatching(/^Rollback of an applied change: Lower ad set "Website visitors" daily budget \$35\.00 → \$30\.00/) })
    expect(rpc()[0].payload).toMatchObject({ p_action_decision_id: 'decision-1', p_request: { rollback_of: 'change-1', params: { new_daily_budget: 30 } } })
  })

  it('has no automatic rollback for a duplicated ad set, and none for a change that has not run', async () => {
    const duplicate = await load({ original: { ...executedBudget, action_type: 'duplicate_adset', params: { new_name: 'Copy', new_daily_budget: null } } })
    expect(await duplicate.proposeRollback({ changeRequestId: 'change-1', ownerUserId: 'owner-1', accountId: 'account-a' }))
      .toMatchObject({ status: 'NO_AUTOMATIC_ROLLBACK', message: expect.stringMatching(/delete the paused copy/) })
    vi.resetModules()
    const pending = await load({ original: { ...executedBudget, status: 'approved' } })
    expect(await pending.proposeRollback({ changeRequestId: 'change-1', ownerUserId: 'owner-1', accountId: 'account-a' }))
      .toMatchObject({ status: 'NOT_EXECUTED', http: 409 })
    expect(pending.rpc()).toEqual([])
  })
})
