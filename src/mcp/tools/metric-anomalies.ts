import { logToolError } from '@/lib/security/api-error'
import { buildAnomalyReport } from '@/lib/diagnostics/anomaly-report'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readLatestClosedAccountDeliveryDate } from '@/lib/accounts/closed-delivery-date'

// MCP tool: which efficiency metrics worsened vs the prior equal-length window, decomposed into the
// arithmetic driver (numerator vs denominator) and the campaign that drove it — each with a trust
// score. Read-only; shares the gatherer with /api/diagnostics/anomalies.

export async function getMetricAnomalies(args: { window_days?: number }): Promise<object> {
  const windowDays = Math.min(Math.max(args?.window_days ?? 7, 1), 90)
  try {
    const activeAccount = await resolveOnlyActiveAccount()
    if (!activeAccount.ok) return { available: false, reason: `active account ${activeAccount.reason}` }
    const to = await readLatestClosedAccountDeliveryDate(activeAccount.account.id)
    if (to === null) {
      return { available: false, reason: 'latest closed account delivery day unavailable' }
    }
    const fromDate = new Date(`${to}T00:00:00Z`)
    fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1))
    const from = fromDate.toISOString().slice(0, 10)
    return await buildAnomalyReport({
      from,
      to,
      adAccountId: activeAccount.account.id,
    })
  } catch (e) {
    return { available: false, error_code: 'ANOMALY_REPORT_FAILED', reason: logToolError('get_metric_anomalies', 'ANOMALY_REPORT_FAILED', e) }
  }
}
