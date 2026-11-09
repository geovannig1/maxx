import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ga4Resp, FAKE_GA4_SA_JSON } from './_support/ga4'

const { runReportMock } = vi.hoisted(() => ({ runReportMock: vi.fn() }))
vi.mock('@google-analytics/data', () => ({
  BetaAnalyticsDataClient: class { runReport = runReportMock },
}))

/**
 * The GA4 refusal paths, exercised through the real client rather than asserted against its source.
 *
 * `tests/ga4-retention-horizon.test.ts` pins these guards textually, which catches deletion but not
 * behaviour. These run the code. They exist because the shared mock previously omitted `rowCount` and
 * `metadata` — fields the real API always returns — so nine tests were green over responses production
 * cannot produce, and the guards they were supposed to cover had never executed at all.
 */

let getGa4ConfirmationTelemetryBySource: typeof import('@/lib/ga4/client').getGa4ConfirmationTelemetryBySource

beforeEach(async () => {
  vi.resetModules()
  runReportMock.mockReset()
  process.env.GA4_PROPERTY_ID = '123456789'
  process.env.GA4_SERVICE_ACCOUNT_JSON = FAKE_GA4_SA_JSON
  ;({ getGa4ConfirmationTelemetryBySource } = await import('@/lib/ga4/client'))
})

describe('GA4 responses that cannot be trusted are refused, not reported', () => {
  it('refuses a response with no rowCount instead of reading it as zero', async () => {
    // `Number(resp.rowCount ?? 0)` made a missing count satisfy the truncation guard forever, while
    // limit: 10000 could still have been capping.
    runReportMock.mockResolvedValueOnce(ga4Resp([{ dims: ['Paid Social'], metrics: [3, 300] }], { rowCount: null }))
    await expect(getGa4ConfirmationTelemetryBySource('2026-08-01', '2026-08-23'))
      .rejects.toThrow(/omitted rowCount/)
  })

  it('refuses an (other)-bucketed result even though its totals reconcile', async () => {
    // The silent one. GA4 preserves metric totals while destroying the dimension, so a per-campaign
    // split degrades into a bucket and nothing downstream looks wrong.
    runReportMock.mockResolvedValueOnce(
      ga4Resp([{ dims: ['Paid Social'], metrics: [3, 300] }], { dataLossFromOtherRow: true }),
    )
    await expect(getGa4ConfirmationTelemetryBySource('2026-08-01', '2026-08-23'))
      .rejects.toThrow(/\(other\)/)
  })

  it('refuses a page that returned fewer rows than GA4 says exist', async () => {
    runReportMock.mockResolvedValueOnce(ga4Resp([{ dims: ['Paid Social'], metrics: [3, 300] }], { rowCount: 5000 }))
    await expect(getGa4ConfirmationTelemetryBySource('2026-08-01', '2026-08-23'))
      .rejects.toThrow(/truncated/)
  })

  it('accepts a clean response, so the guards are not simply rejecting everything', async () => {
    // The opposite failure. A client that refuses every response also shows three green refusal tests.
    runReportMock.mockResolvedValueOnce(ga4Resp([
      { dims: ['Paid Social'], metrics: [3, 300] },
      { dims: ['Direct'], metrics: [7, 700] },
    ]))
    const result = await getGa4ConfirmationTelemetryBySource('2026-08-01', '2026-08-23')
    expect(result.available).toBe(true)
    expect(result.paid.confirmationEvents).toBe(3)
    expect(result.organic.confirmationEvents).toBe(7)
  })
})
