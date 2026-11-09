import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  eqCalls: [] as Array<{ table: string; column: string; value: unknown }>,
  failTable: null as string | null,
  rows: {} as Record<string, Record<string, unknown>[]>,
}))

function query(table: string) {
  const data = state.rows[table] ?? (table === 'ad_accounts'
    ? [{ id: 'account-a', amount_spent: 0, spend_cap: null, last_synced_at: null }]
    : [])
  const response = () => ({
    data,
    error: state.failTable === table ? { message: `${table} unavailable` } : null,
  })
  const builder: Record<string, unknown> = {}
  builder.select = () => builder
  builder.eq = (column: string, value: unknown) => {
    state.eqCalls.push({ table, column, value })
    return builder
  }
  builder.gte = () => builder
  builder.lte = () => builder
  builder.maybeSingle = async () => {
    const result = response()
    return { data: result.data[0] ?? null, error: result.error }
  }
  builder.then = (
    resolve: (value: ReturnType<typeof response>) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(response()).then(resolve, reject)
  return builder
}

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: (table: string) => query(table) }),
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-a', accountName: 'Example Studio' } }),
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))

vi.mock('@/lib/ga4/client', () => ({
  getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({
    available: false,
    paid: { confirmationEvents: 0, eventValue: 0 },
    organic: { confirmationEvents: 0, eventValue: 0 },
    metaPaid: { confirmationEvents: 0, eventValue: 0 },
    byChannel: [],
  })),
  getGa4ConfirmationTelemetryByCampaign: vi.fn(async () => ({
    available: false,
    rows: [],
    totals: { confirmationEvents: 0, eventValue: 0 },
    attributedShare: null,
  })),
}))

vi.mock('@/lib/tracking/utm-coverage', () => ({
  computeUtmCoverage: vi.fn(async () => null),
  splitUtmOffenders: vi.fn(() => ({ active: [], historicalCount: 0 })),
}))

vi.mock('@/lib/platforms/meta/fetch-dataset-quality', () => ({
  fetchDatasetQuality: vi.fn(async () => ({
    available: false,
    reason: 'not configured',
    datasetId: null,
  })),
}))

describe('diagnostic gatherer account boundaries', () => {
  beforeEach(() => {
    state.eqCalls = []
    state.failTable = null
    state.rows = {}
  })

  it('scopes every anomaly-report table to the supplied account', async () => {
    state.rows.daily_insights = [
      { ad_account_id: 'account-a', entity_level: 'account', date_start: '2026-07-01', spend: 100, impressions: 1000, clicks: 50 },
    ]
    const { buildAnomalyReport } = await import('@/lib/diagnostics/anomaly-report')
    await buildAnomalyReport({ from: '2026-07-01', to: '2026-07-07', adAccountId: 'account-a' })

    expect(state.eqCalls.filter((call) => call.table === 'daily_insights' && call.column === 'ad_account_id')).toHaveLength(2)
    expect(state.eqCalls).toContainEqual({ table: 'campaigns', column: 'ad_account_id', value: 'account-a' })
    expect(state.eqCalls).toContainEqual({ table: 'ad_accounts', column: 'id', value: 'account-a' })
  })

  it('fails the anomaly report when a scoped database read fails', async () => {
    state.failTable = 'campaigns'
    const { buildAnomalyReport } = await import('@/lib/diagnostics/anomaly-report')

    await expect(buildAnomalyReport({
      from: '2026-07-01',
      to: '2026-07-07',
      adAccountId: 'account-a',
    })).rejects.toThrow('Anomaly report read failed: campaigns unavailable')
  })

  it('fails anomaly report when the current window has no account rows instead of emitting no anomalies as a measured result', async () => {
    const { buildAnomalyReport } = await import('@/lib/diagnostics/anomaly-report')

    await expect(buildAnomalyReport({
      from: '2026-07-01',
      to: '2026-07-07',
      adAccountId: 'account-a',
    })).rejects.toThrow('current_account_window_missing')
  })

  it('fails quality report when the window has no ad or ad-set insight rows instead of returning 0/0 coverage', async () => {
    const { buildQualityReport } = await import('@/lib/diagnostics/quality-report')

    await expect(buildQualityReport({
      from: '2026-07-01',
      to: '2026-07-07',
    })).rejects.toMatchObject({ reason: 'quality_window_missing' })
  })

  it('scopes all reconciliation spend/report reads to the supplied account', async () => {
    const { buildReconciliationReport } = await import('@/lib/diagnostics/reconciliation-report')
    await buildReconciliationReport({ from: '2026-07-01', to: '2026-07-07', adAccountId: 'account-a' })

    expect(state.eqCalls.filter((call) => call.table === 'daily_insights' && call.column === 'ad_account_id')).toHaveLength(3)
    expect(state.eqCalls).toContainEqual({ table: 'daily_reports', column: 'ad_account_id', value: 'account-a' })
    expect(state.eqCalls).toContainEqual({ table: 'ad_accounts', column: 'id', value: 'account-a' })
  })

  it('treats a window with no stored daily report as absent, not as $0 of report spend', async () => {
    state.rows.daily_insights = [{ ad_account_id: 'account-a', entity_level: 'account', date_start: '2026-07-01', date_stop: '2026-07-01', spend: 100 }]
    state.rows.daily_reports = []
    const { buildReconciliationReport } = await import('@/lib/diagnostics/reconciliation-report')
    const report = await buildReconciliationReport({ from: '2026-07-01', to: '2026-07-07', adAccountId: 'account-a' })

    expect(report.integrity.reportSpend).toBeNull()
    expect(report.integrity.status).toBe('aligned')
    expect(report.integrity.note).toBe('Account insights and campaign-level rows agree — spend is internally consistent.')
  })

  it('fails reconciliation instead of replacing a database error with zero', async () => {
    state.failTable = 'daily_reports'
    const { buildReconciliationReport } = await import('@/lib/diagnostics/reconciliation-report')

    await expect(buildReconciliationReport({
      from: '2026-07-01',
      to: '2026-07-07',
      adAccountId: 'account-a',
    })).rejects.toThrow('Reconciliation read failed: daily_reports unavailable')
  })
})
