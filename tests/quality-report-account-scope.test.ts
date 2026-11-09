import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeResolution: { ok: true, account: { id: 'account-db-1', accountName: 'Studio' } } as
    | { ok: true; account: { id: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  calls: [] as Array<{ table: string; column: string; value: unknown }>,
  errors: {} as Record<string, { message: string } | null>,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.activeResolution),
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const response = () => ({
        data: table === 'ad_accounts' ? { last_synced_at: new Date().toISOString() } : [],
        error: state.errors[table] ?? null,
      })
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          state.calls.push({ table, column, value })
          return builder
        },
        gte: () => builder,
        lte: () => builder,
        maybeSingle: async () => response(),
        then: (resolve: (value: ReturnType<typeof response>) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(response()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('buildQualityReport account/read health', () => {
  beforeEach(() => {
    state.activeResolution = { ok: true, account: { id: 'account-db-1', accountName: 'Studio' } }
    state.calls = []
    state.errors = {}
  })

  it('scopes every entity and insight read to the exact active account', async () => {
    const { buildQualityReport } = await import('@/lib/diagnostics/quality-report')
    await expect(buildQualityReport({ from: '2026-07-01', to: '2026-07-07' }))
      .rejects.toThrow(/QUALITY_REPORT_UNAVAILABLE.*quality_window_missing/i)

    for (const table of ['ads', 'adsets', 'daily_insights']) {
      expect(state.calls).toContainEqual({ table, column: 'ad_account_id', value: 'account-db-1' })
    }
    expect(state.calls).toContainEqual({ table: 'ad_accounts', column: 'id', value: 'account-db-1' })
  })

  it('fails explicitly when a scoped read fails instead of returning an empty report', async () => {
    state.errors.ads = { message: 'database unavailable' }
    const { buildQualityReport } = await import('@/lib/diagnostics/quality-report')

    await expect(buildQualityReport({ from: '2026-07-01', to: '2026-07-07' }))
      .rejects.toThrow(/QUALITY_REPORT_UNAVAILABLE.*ads_read_failed/i)
  })

  it('fails explicitly when active-account ownership is ambiguous', async () => {
    state.activeResolution = { ok: false, reason: 'ambiguous' }
    const { buildQualityReport } = await import('@/lib/diagnostics/quality-report')

    await expect(buildQualityReport({ from: '2026-07-01', to: '2026-07-07' }))
      .rejects.toThrow(/QUALITY_REPORT_UNAVAILABLE.*ACTIVE_ACCOUNT_AMBIGUOUS/i)
    expect(state.calls).toEqual([])
  })
})
