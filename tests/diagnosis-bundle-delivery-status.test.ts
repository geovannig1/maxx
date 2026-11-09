import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  diagnoseLaunchPerformance: vi.fn(),
  buildQualityReport: vi.fn(),
  buildAnomalyReport: vi.fn(),
  buildReconciliationReport: vi.fn(),
  getEconomics: vi.fn(),
  getCreativeInsights: vi.fn(),
  fetchMetaRecommendations: vi.fn(),
  getApprovedVerticalBenchmarks: vi.fn(),
  latestDeliveryQuery: {
    select: vi.fn(),
    eq: vi.fn(),
    lte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: vi.fn(() => mocks.latestDeliveryQuery),
  }),
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => ({
    ok: true,
    account: { id: 'account-1', accountName: 'Studio' },
  })),
}))
vi.mock('@/lib/diagnostics/launch-performance', () => ({
  diagnoseLaunchPerformance: mocks.diagnoseLaunchPerformance,
}))
vi.mock('@/lib/diagnostics/quality-report', () => ({ buildQualityReport: mocks.buildQualityReport }))
vi.mock('@/lib/diagnostics/anomaly-report', () => ({ buildAnomalyReport: mocks.buildAnomalyReport }))
vi.mock('@/lib/diagnostics/reconciliation-report', () => ({
  buildReconciliationReport: mocks.buildReconciliationReport,
}))
vi.mock('@/lib/targets/vertical-benchmarks', () => ({
  getApprovedVerticalBenchmarks: mocks.getApprovedVerticalBenchmarks,
}))
vi.mock('@/lib/platforms/meta/fetch-meta-recommendations', () => ({
  fetchMetaRecommendations: mocks.fetchMetaRecommendations,
}))
vi.mock('@/mcp/tools/economics', () => ({ getEconomics: mocks.getEconomics }))
vi.mock('@/mcp/tools/creative-insights', () => ({ getCreativeInsights: mocks.getCreativeInsights }))

import { getDiagnosisBundle } from '@/mcp/tools/diagnosis-bundle'
import { getLaunchPerformanceDiagnosis } from '@/mcp/tools/diagnose-performance'
import { getAuctionDiagnostics } from '@/mcp/tools/auction-diagnostics'
import { getMetricAnomalies } from '@/mcp/tools/metric-anomalies'

describe('diagnosis bundle delivery sub-status evidence', () => {
  const paidOutcomes = {
    status: 'available',
    evaluation_run_id: 'fd3c2331-300d-4744-ab77-88c9c010dd2b',
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    note: 'Associated via governed last-paid-touch with booked value.',
    recent_scale: null,
    matured_cut: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T16:00:00.000Z'))
    mocks.latestDeliveryQuery.select.mockReturnValue(mocks.latestDeliveryQuery)
    mocks.latestDeliveryQuery.eq.mockReturnValue(mocks.latestDeliveryQuery)
    mocks.latestDeliveryQuery.lte.mockReturnValue(mocks.latestDeliveryQuery)
    mocks.latestDeliveryQuery.order.mockReturnValue(mocks.latestDeliveryQuery)
    mocks.latestDeliveryQuery.limit.mockResolvedValue({
      data: [{ date_start: '2026-08-22' }],
      error: null,
    })
    mocks.diagnoseLaunchPerformance.mockResolvedValue({
      adsets_detail: [{
        name: 'Cold',
        delivery_sub_status: {
          read_available: true,
          payload: { status: 'warning', substatuses: ['budget_limited_learning_fail'] },
          synced_at: '2026-08-01T20:00:00.000Z',
        },
      }],
    })
    mocks.buildQualityReport.mockResolvedValue({ status: 'available' })
    mocks.buildAnomalyReport.mockResolvedValue({ status: 'available' })
    mocks.buildReconciliationReport.mockResolvedValue({ status: 'available' })
    mocks.getEconomics.mockResolvedValue({ status: 'available' })
    mocks.getCreativeInsights.mockResolvedValue({
      status: 'available',
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      ad_delivery_sub_statuses: [{
        ad_id: 'meta-ad-1',
        delivery_sub_status: { read_available: true, payload: null, synced_at: '2026-08-01T20:01:00.000Z' },
      }],
      paid_outcomes: paidOutcomes,
    })
    mocks.fetchMetaRecommendations.mockResolvedValue({
      available: false,
      reason: 'not configured',
      paging: null,
    })
    mocks.getApprovedVerticalBenchmarks.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('anchors every section to the latest closed warehouse day', async () => {
    const result = await getDiagnosisBundle({ window_days: 30 }) as Record<string, unknown>
    const range = { start_date: '2026-07-24', end_date: '2026-08-22' }

    expect(mocks.latestDeliveryQuery.lte).toHaveBeenCalledWith('date_start', '2026-08-23')
    expect(mocks.diagnoseLaunchPerformance).toHaveBeenCalledWith({
      adAccountDbId: 'account-1',
      window: { from: range.start_date, to: range.end_date },
      includeLiveEnrichment: false,
    })
    expect(mocks.buildQualityReport).toHaveBeenCalledWith({ from: range.start_date, to: range.end_date })
    expect(mocks.buildAnomalyReport).toHaveBeenCalledWith({
      from: range.start_date,
      to: range.end_date,
      adAccountId: 'account-1',
    })
    expect(mocks.buildReconciliationReport).toHaveBeenCalledWith({
      from: range.start_date,
      to: range.end_date,
      adAccountId: 'account-1',
    })
    expect(mocks.getEconomics).toHaveBeenCalledWith(range)
    expect(mocks.getCreativeInsights).toHaveBeenCalledWith(range)
    expect(result.window).toEqual({ from: range.start_date, to: range.end_date, days: 30 })
  })

  it('anchors the standalone diagnosis tool to the same closed warehouse day', async () => {
    await getLaunchPerformanceDiagnosis({ window_days: 30 })

    expect(mocks.diagnoseLaunchPerformance).toHaveBeenCalledWith({
      adAccountDbId: 'account-1',
      window: { from: '2026-07-24', to: '2026-08-22' },
      includeLiveEnrichment: false,
    })
  })

  it('anchors standalone auction and anomaly diagnostics to the same closed warehouse day', async () => {
    await getAuctionDiagnostics({ window_days: 30 })
    await getMetricAnomalies({ window_days: 7 })

    expect(mocks.buildQualityReport).toHaveBeenCalledWith({
      from: '2026-07-24',
      to: '2026-08-22',
    })
    expect(mocks.buildAnomalyReport).toHaveBeenCalledWith({
      from: '2026-08-16',
      to: '2026-08-22',
      adAccountId: 'account-1',
    })
  })

  it('keeps ad-set and per-ad states in their diagnostic-only sections', async () => {
    const result = await getDiagnosisBundle({ window_days: 30 }) as Record<string, unknown>

    expect(result).toMatchObject({
      diagnosis: {
        adsets_detail: [{
          delivery_sub_status: {
            read_available: true,
            payload: { status: 'warning', substatuses: ['budget_limited_learning_fail'] },
          },
        }],
      },
      creative: {
        action_authority_tier: 'diagnostic_only',
        prescriptions: [],
        paid_outcomes: paidOutcomes,
        ad_delivery_sub_statuses: [{
          ad_id: 'meta-ad-1',
          delivery_sub_status: { read_available: true, payload: null },
        }],
      },
      action_authority: { tier: 'diagnostic_only', prescriptions: [] },
    })
    expect(result.note).toEqual(expect.stringMatching(/delivery sub-status/i))
    expect(result.note).toEqual(expect.stringMatching(/associated via governed last-paid-touch/i))
    expect(result.note).toEqual(expect.stringMatching(/booked value/i))
    expect((result.creative as Record<string, unknown>).paid_outcomes).toEqual(paidOutcomes)
  })

  it('degrades a failed creative-status section without losing the rest of the bundle', async () => {
    mocks.getCreativeInsights.mockRejectedValueOnce(new Error('creative status read offline'))

    const result = await getDiagnosisBundle({ window_days: 30 }) as Record<string, unknown>

    expect(result).toMatchObject({
      diagnosis: { adsets_detail: expect.any(Array) },
      // The section is named; the source error text stays server-side (security review fix 1).
      creative: { available: false, reason: 'creative insights failed: The data could not be read. The details were logged on the server.' },
      action_authority: { tier: 'diagnostic_only', prescriptions: [] },
    })
    expect(JSON.stringify(result)).not.toContain('creative status read offline')
  })
})
