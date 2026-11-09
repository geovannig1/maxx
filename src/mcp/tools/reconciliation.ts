import { ToolInputError, logToolError } from '@/lib/security/api-error'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { resolveClosedDateRange } from '@/lib/dashboard/closed-date-range'
import { buildReconciliationReport } from '@/lib/diagnostics/reconciliation-report'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

// MCP tool: the "prove the numbers" view — Meta-internal spend integrity, plus a PLANE CONFLICT between
// Meta modelled counts and GA confirmation-event telemetry (neither is business truth),
// money truth, UTM coverage + booking linkage, and best-effort CAPI/Event-Match-Quality signal health.
// This is the source for the results-reconciliation preamble: state Meta modelled vs GA telemetry (and any
// discrepancy) BEFORE narrating performance. Read-only; shares the gatherer with
// /api/diagnostics/reconciliation.

export interface ReconciliationArgs {
  window_days?: number
  start_date?: string
  end_date?: string
}

export async function getReconciliation(args: ReconciliationArgs): Promise<object> {
  const hasStart = args?.start_date !== undefined
  const hasEnd = args?.end_date !== undefined
  if (hasStart !== hasEnd) throw new ToolInputError('Reconciliation start_date and end_date must be provided together.')
  if (hasStart && args.window_days !== undefined) {
    throw new ToolInputError('Reconciliation accepts either an explicit date range or window_days, not both.')
  }
  const windowDays = Math.min(Math.max(args?.window_days ?? 30, 1), 90)
  const range = hasStart && hasEnd
    ? resolveClosedDateRange(args.start_date, args.end_date)
    : { start: nyDaysAgo(windowDays), end: nyDaysAgo(1) }
  try {
    const activeAccount = await resolveOnlyActiveAccount()
    if (!activeAccount.ok) return { available: false, reason: `active account ${activeAccount.reason}` }
    return await buildReconciliationReport({
      from: range.start,
      to: range.end,
      adAccountId: activeAccount.account.id,
    })
  } catch (e) {
    return { available: false, error_code: 'RECONCILIATION_FAILED', reason: logToolError('get_reconciliation', 'RECONCILIATION_FAILED', e) }
  }
}
