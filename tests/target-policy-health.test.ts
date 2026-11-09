import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTargetOverrides, getTargetRange, METRIC_RANGES } from '@/lib/targets/target-ranges'

const state = vi.hoisted(() => ({
  activeResolution: {
    ok: true as boolean,
    account: { id: 'account-1', accountName: 'Example Studio' },
  } as
    | { ok: true; account: { id: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  setting: { data: null as Record<string, unknown> | null, error: null as { message: string } | null },
  settingsReads: 0,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.activeResolution),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'app_settings') throw new Error(`unexpected table ${table}`)
      state.settingsReads += 1
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => state.setting,
      }
      return chain
    },
  }),
}))

describe('performance-target policy health', () => {
  beforeEach(() => {
    state.activeResolution = { ok: true, account: { id: 'account-1', accountName: 'Example Studio' } }
    state.setting = { data: null, error: null }
    state.settingsReads = 0
    applyTargetOverrides(null)
  })

  afterEach(() => {
    applyTargetOverrides(null)
    vi.clearAllMocks()
  })

  it.each([
    ['not_found', 'account_not_found'],
    ['ambiguous', 'account_ambiguous'],
    ['unavailable', 'account_unavailable'],
  ] as const)('fails closed when active-account resolution is %s', async (reason, reasonCode) => {
    state.activeResolution = { ok: false, reason }
    applyTargetOverrides({ cpa: { healthy: 999, watch: 1000 } })
    const { hydrateTargetOverrides } = await import('@/lib/targets/store')

    const result = await hydrateTargetOverrides()

    expect(result).toMatchObject({
      status: 'unavailable', authorityEligible: false, reasonCode, overrides: null,
    })
    expect(state.settingsReads).toBe(0)
    expect(getTargetRange('cpa').healthy).toBe(METRIC_RANGES.cpa.healthy)
  })

  it('distinguishes a settings read failure from a configured zero/default policy and clears stale state', async () => {
    state.setting = { data: null, error: { message: 'database unavailable' } }
    applyTargetOverrides({ cpa: { healthy: 999, watch: 1000 } })
    const { hydrateTargetOverrides } = await import('@/lib/targets/store')

    await expect(hydrateTargetOverrides()).resolves.toMatchObject({
      status: 'unavailable', authorityEligible: false, reasonCode: 'settings_read_failed', overrides: null,
    })
    expect(getTargetRange('cpa').healthy).toBe(METRIC_RANGES.cpa.healthy)
  })

  it('distinguishes missing, malformed JSON, invalid values, and inverted bands', async () => {
    const { loadTargetOverrides } = await import('@/lib/targets/store')

    await expect(loadTargetOverrides()).resolves.toMatchObject({
      status: 'missing', authorityEligible: false, reasonCode: 'not_configured', overrides: null,
    })

    state.setting = { data: { value: '{bad json' }, error: null }
    await expect(loadTargetOverrides()).resolves.toMatchObject({
      status: 'invalid', authorityEligible: false, reasonCode: 'invalid_json', overrides: null,
    })

    state.setting = { data: { value: JSON.stringify({ cpa: { healthy: '64' } }) }, error: null }
    await expect(loadTargetOverrides()).resolves.toMatchObject({
      status: 'invalid', authorityEligible: false, reasonCode: 'invalid_values', overrides: null,
    })

    state.setting = { data: { value: JSON.stringify({ cpa: { healthy: 128, watch: 98 } }) }, error: null }
    await expect(loadTargetOverrides()).resolves.toMatchObject({
      status: 'invalid', authorityEligible: false, reasonCode: 'invalid_values', overrides: null,
    })
  })

  it('uses a valid legacy row for diagnostic display but never calls it authority-eligible', async () => {
    state.setting = {
      data: {
        value: JSON.stringify({ cpa: { healthy: 100, watch: 200 } }),
        updated_at: '2026-07-30T12:00:00Z',
      },
      error: null,
    }
    const { hydrateTargetOverrides } = await import('@/lib/targets/store')

    const result = await hydrateTargetOverrides()

    expect(result).toMatchObject({
      status: 'unversioned', authorityEligible: false, reasonCode: 'unversioned_app_setting',
      overrides: { cpa: { healthy: 100, watch: 200 } },
      provenance: {
        source: 'app_settings.performance_targets',
        ownerApprovalRecorded: false,
        versionRecorded: false,
      },
    })
    expect(getTargetRange('cpa').healthy).toBe(100)
    expect(getTargetRange('cpa').watch).toBe(200)
  })
})
