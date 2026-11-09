import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUDGET_PARAM, LEGACY_BUDGET_PARAM, budgetFromToolArgs, budgetParamValue, withBudgetKey } from '@/lib/writes/budget-param'
import { expectedMutation, validateWriteAuthority, type GovernedWriteRequest, type WriteAuthorityDecision } from '@/lib/writes/write-authority'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { applyChange } from '@/lib/writes/executor'
import { TOOL_DEFINITIONS as MCP_TOOLS } from '@/mcp/tools'

// the MCP write parameter is new_daily_budget (an amount in the account currency). The old name
// new_daily_budget_usd stays accepted as a deprecated alias for one release; giving both is refused.

const jsonRes = (ok: boolean, body: unknown) => ({ ok, json: () => Promise.resolve(body) })

function decisionFor(request: GovernedWriteRequest): WriteAuthorityDecision {
  return {
    id: 'decision-1', ad_account_id: 'acct-1', action_kind: 'budget_scale', target_level: 'adset', target_id: 'adset-1',
    authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR, approval_state: 'not_requested',
    proposed_mutation: expectedMutation(request), causal_contribution_estimate_id: 'estimate-1',
  }
}
const budgetRequest = (params: Record<string, unknown>): GovernedWriteRequest =>
  ({ adAccountDbId: 'acct-1', actionType: 'adjust_budget', entityLevel: 'adset', metaEntityId: 'adset-1', params })

describe('budget parameter name', () => {
  it('names the current parameter and the deprecated alias', () => {
    expect(BUDGET_PARAM).toBe('new_daily_budget')
    expect(LEGACY_BUDGET_PARAM).toBe('new_daily_budget_usd')
  })

  it('reads the amount under either name', () => {
    expect(budgetParamValue({ new_daily_budget: 40 })).toBe(40)
    expect(budgetParamValue({ new_daily_budget_usd: 41 })).toBe(41)
    expect(budgetParamValue({ new_name: 'x' })).toBeUndefined()
  })

  it('accepts either tool argument, prefers neither, and refuses both (control)', () => {
    expect(budgetFromToolArgs({ new_daily_budget: 40 })).toEqual({ ok: true, value: 40 })
    expect(budgetFromToolArgs({ new_daily_budget_usd: 41 })).toEqual({ ok: true, value: 41 })
    expect(budgetFromToolArgs({})).toEqual({ ok: true, value: undefined })
    expect(budgetFromToolArgs({ new_daily_budget: 40, new_daily_budget_usd: 40 })).toMatchObject({ ok: false })
  })

  it('moves the amount to one key and drops the other', () => {
    expect(withBudgetKey({ new_daily_budget_usd: 5, new_name: 'n' }, BUDGET_PARAM)).toEqual({ new_daily_budget: 5, new_name: 'n' })
    expect(withBudgetKey({ new_daily_budget: 5 }, LEGACY_BUDGET_PARAM)).toEqual({ new_daily_budget_usd: 5 })
  })

  it('authorises a request under the key its decision was written with, under either name', () => {
    const current = budgetRequest({ new_daily_budget: 60 })
    const legacy = budgetRequest({ new_daily_budget_usd: 60 })
    expect(expectedMutation(current)).toEqual({ action_type: 'adjust_budget', new_daily_budget: 60 })
    expect(validateWriteAuthority(decisionFor(current), current, 'not_requested').allowed).toBe(true)
    expect(validateWriteAuthority(decisionFor(legacy), legacy, 'not_requested').allowed).toBe(true)
    // A decision authorised under one name is not satisfied by a request carrying both (control).
    expect(validateWriteAuthority(decisionFor(current), budgetRequest({ new_daily_budget: 60, new_daily_budget_usd: 60 }), 'not_requested').allowed).toBe(false)
  })

  it('advertises new_daily_budget in the account currency and keeps the alias, deprecated', () => {
    for (const name of ['adjust_budget', 'duplicate_adset']) {
      const tool = MCP_TOOLS.find((t) => t.name === name)!
      const props = (tool.inputSchema as unknown as { properties: Record<string, { description: string }> }).properties
      expect(props[BUDGET_PARAM].description).toMatch(/account currency/)
      expect(props[LEGACY_BUDGET_PARAM].description).toMatch(/deprecated/i)
      expect(JSON.stringify(tool)).not.toMatch(/\bUSD\b|\$\d/)
    }
    const adjust = MCP_TOOLS.find((t) => t.name === 'adjust_budget')!
    expect((adjust.inputSchema as unknown as { required: string[] }).required).not.toContain(LEGACY_BUDGET_PARAM)
  })
})

describe('applyChange accepts both budget names', () => {
  beforeEach(() => vi.stubEnv('META_ACCESS_TOKEN', 'test-token'))
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each([[BUDGET_PARAM], [LEGACY_BUDGET_PARAM]])('sets the Meta daily budget in minor units from %s', async (key) => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(jsonRes(true, { success: true }))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await applyChange('adjust_budget', 'adset-1', { [key]: 60 })
    expect(r.ok).toBe(true)
    expect(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).toContain('daily_budget=6000')
  })

  it('refuses an out-of-bounds amount under the new name before any Meta call (control)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await applyChange('adjust_budget', 'adset-1', { [BUDGET_PARAM]: 0 })
    expect(r.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
