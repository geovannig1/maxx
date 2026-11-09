import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { applyChange, validateBudgetAmount } from '@/lib/writes/executor'

// duplicate_adset partial-success truthfulness (review finding): a successful copy followed by a failed
// name/budget update leaves a LIVE paused copy in Meta — recording that as "failed" is an audit lie.
// applyChange must report ok:true with the copied id + the update error attached (the verification step
// then lands it applied_unverified). Budget bounds are also re-checked before any Meta call.

const jsonRes = (ok: boolean, body: unknown) => ({ ok, json: () => Promise.resolve(body) })

beforeEach(() => vi.stubEnv('META_ACCESS_TOKEN', 'test-token'))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('applyChange — duplicate_adset', () => {
  it('copy ok + update FAILS → ok:true (live change happened), copied id + update_error preserved', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(true, { copied_adset_id: '999' }))
      .mockResolvedValueOnce(jsonRes(false, { error: { message: 'name update rejected' } }))
    vi.stubGlobal('fetch', fetchSpy)

    const r = await applyChange('duplicate_adset', 'adset-1', { new_name: 'Copy A', new_daily_budget_usd: 50 })
    expect(r.ok).toBe(true)
    expect(r.newEntityId).toBe('999')
    expect(r.response).toMatchObject({ copy: { copied_adset_id: '999' }, update_error: { error: { message: 'name update rejected' } } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // The follow-up update targets the COPY, applying the requested name + budget (in cents).
    const updateUrl = String(fetchSpy.mock.calls[1][0])
    const updateInit = fetchSpy.mock.calls[1][1] as RequestInit
    expect(updateUrl).toContain('/999')
    expect(updateUrl).not.toContain('access_token')
    expect(String(updateInit.body)).toContain('name=Copy+A')
    expect(String(updateInit.body)).toContain('daily_budget=5000')
    expect(updateInit.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('access_token')
      expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' })
    }
  })

  it('copy ok + update ok → ok:true with the copied id', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(true, { copied_adset_id: '888' }))
      .mockResolvedValueOnce(jsonRes(true, { success: true }))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await applyChange('duplicate_adset', 'adset-1', { new_name: 'Copy B', new_daily_budget_usd: null })
    expect(r).toMatchObject({ ok: true, newEntityId: '888' })
  })

  it('out-of-bounds budget override → refused BEFORE any Meta call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const bad of [99999, 0, NaN]) {
      const r = await applyChange('duplicate_adset', 'adset-1', { new_daily_budget_usd: bad })
      expect(r.ok).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('copy fails → ok:false with Meta response, no follow-up update attempted', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(jsonRes(false, { error: { message: 'no permission' } }))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await applyChange('duplicate_adset', 'adset-1', { new_name: 'X' })
    expect(r.ok).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('applyChange — adjust_budget execution-time cap', () => {
  it('out-of-bounds budget → refused BEFORE any Meta call (the gap: was only checked for duplicate)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const bad of [99999, 0, NaN, -5]) {
      const r = await applyChange('adjust_budget', 'adset-1', { new_daily_budget_usd: bad })
      expect(r.ok).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('budget within the owner ceiling → reaches Meta with daily_budget in cents', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(jsonRes(true, { success: true }))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await applyChange('adjust_budget', 'adset-1', { new_daily_budget_usd: 60 })
    expect(r.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).toContain('daily_budget=6000')
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('access_token')
  })
})

describe('validateBudgetAmount', () => {
  it('accepts only individual budgets within the owner account ceiling', () => {
    expect(validateBudgetAmount(1)).toBeNull()
    expect(validateBudgetAmount(MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling)).toBeNull()
    expect(validateBudgetAmount(MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling + 1)).not.toBeNull()
    expect(validateBudgetAmount(0)).not.toBeNull()
    expect(validateBudgetAmount(2000)).not.toBeNull()
    expect(validateBudgetAmount(NaN)).not.toBeNull()
    expect(validateBudgetAmount(undefined)).not.toBeNull()
  })

  it('takes its minimum from the configured spend floor, in the account currency', () => {
    // Control: at the USD default the minimum is 1, as before.
    expect(validateBudgetAmount(0.99)).not.toBeNull()
    expect(validateBudgetAmount(1)).toBeNull()
    // A smaller configured floor (10 -> minimum 0.5) lowers it; nothing in the executor is fixed to USD.
    vi.stubEnv('NEXT_PUBLIC_MIN_SPEND_TO_JUDGE', '10')
    try {
      expect(validateBudgetAmount(0.5)).toBeNull()
      expect(validateBudgetAmount(0.49)).toMatch(/budget out of bounds/)
    } finally {
      vi.unstubAllEnvs()
      vi.stubEnv('META_ACCESS_TOKEN', 'test-token')
    }
  })

  it('projects an account-total replacement instead of treating one ad-set budget in isolation', async () => {
    const { proposedAccountBudgetTotal } = await import('@/lib/writes/executor')
    expect(proposedAccountBudgetTotal({ currentAccountTotal: 90, targetCurrentBudget: 50, targetProposedBudget: 55 })).toBe(95)
    expect(proposedAccountBudgetTotal({ currentAccountTotal: 90, targetCurrentBudget: 50, targetProposedBudget: 40 })).toBe(80)
  })
})
