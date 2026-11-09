import { activeAccountErrorCode, type ActiveAccountResolution } from '@/lib/accounts/active-account'
import type { AccountSpendWindowSummary } from '@/lib/economics/ad-spend-reader'
import { inclusiveAccountDates } from '@/lib/economics/account-date-window'

export type DashboardMetaSource = 'daily_reports' | 'daily_insights'

export type DashboardMetaReadHealth =
  | {
      status: 'available'
      source: DashboardMetaSource
      evidence_basis: 'meta_modelled'
      reason_code: null
      unavailable_reason: null
    }
  | {
      status: 'unavailable'
      source: DashboardMetaSource
      evidence_basis: 'meta_modelled'
      reason_code:
        | 'ACTIVE_ACCOUNT_NOT_FOUND'
        | 'ACTIVE_ACCOUNT_AMBIGUOUS'
        | 'ACTIVE_ACCOUNT_UNAVAILABLE'
        | 'DAILY_REPORTS_READ_FAILED'
        | 'DAILY_INSIGHTS_READ_FAILED'
        | 'META_INSIGHT_WINDOW_INCOMPLETE'
      unavailable_reason: string
    }

export type DashboardMetaOutcomeReadHealth =
  | {
      status: 'available'
      source: 'daily_reports'
      evidence_basis: 'meta_modelled_outcomes'
      reason_code: null
      unavailable_reason: null
    }
  | {
      status: 'unavailable'
      source: 'daily_reports'
      evidence_basis: 'meta_modelled_outcomes'
      reason_code:
        | 'META_OUTCOME_SOURCE_UNAVAILABLE'
        | 'META_OUTCOME_ROWS_MISSING'
        | 'META_OUTCOME_WINDOW_INCOMPLETE'
      unavailable_reason: string
    }

/** Read success and row cardinality are deliberately independent: an empty successful read is a real
 * zero-data result, while a failed/owner-ambiguous read is unavailable and must never become zero. */
export function resolveDashboardMetaReadHealth(
  account: ActiveAccountResolution,
  source: DashboardMetaSource,
  readError: unknown,
): DashboardMetaReadHealth {
  if (!account.ok) {
    const code = activeAccountErrorCode(account.reason)
    return {
      status: 'unavailable',
      source,
      evidence_basis: 'meta_modelled',
      reason_code: code,
      unavailable_reason: account.reason === 'ambiguous'
        ? 'More than one active ad account is configured.'
        : account.reason === 'not_found'
          ? 'No active ad account is configured.'
          : 'The active ad account could not be resolved.',
    }
  }
  if (readError) {
    return {
      status: 'unavailable',
      source,
      evidence_basis: 'meta_modelled',
      reason_code: source === 'daily_reports' ? 'DAILY_REPORTS_READ_FAILED' : 'DAILY_INSIGHTS_READ_FAILED',
      unavailable_reason: source === 'daily_reports'
        ? 'Committed Meta report data could not be read.'
        : 'Account-level Meta insight data could not be read.',
    }
  }
  return {
    status: 'available',
    source,
    evidence_basis: 'meta_modelled',
    reason_code: null,
    unavailable_reason: null,
  }
}

/** A successful query is still unavailable for a money-bearing window when one expected, closed
 * account day is absent or stale. This wraps the shared exact spend-window contract without
 * reimplementing date/freshness logic in the dashboard. */
export function applyMetaSpendWindowHealth(
  base: DashboardMetaReadHealth,
  window: AccountSpendWindowSummary,
): DashboardMetaReadHealth {
  if (base.status === 'unavailable' || window.status === 'available') return base
  return {
    status: 'unavailable',
    source: base.source,
    evidence_basis: 'meta_modelled',
    reason_code: 'META_INSIGHT_WINDOW_INCOMPLETE',
    unavailable_reason: `The Meta insight window is incomplete (${window.blockerCodes.join(', ')}).`,
  }
}

function isCompleteOutcomeValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function reportOutcomeWindowComplete(
  rows: ReadonlyArray<{ report_date?: unknown; total_leads: unknown; total_bookings: unknown }>,
  window?: { start: string; end: string },
): boolean {
  if (rows.length === 0) return false
  if (window) {
    const expectedDates = inclusiveAccountDates(window.start, window.end)
    const expected = new Set(expectedDates)
    const seen = new Set<string>()
    for (const row of rows) {
      if (typeof row.report_date !== 'string' || !expected.has(row.report_date) || seen.has(row.report_date)) {
        return false
      }
      seen.add(row.report_date)
    }
    if (expectedDates.some((date) => !seen.has(date))) return false
  }
  return rows.every((row) => (
    isCompleteOutcomeValue(row.total_leads) && isCompleteOutcomeValue(row.total_bookings)
  ))
}

export function dashboardReportOutcomesComplete(
  rows: ReadonlyArray<{ report_date?: unknown; total_leads: unknown; total_bookings: unknown }>,
  window?: { start: string; end: string },
): boolean {
  return reportOutcomeWindowComplete(rows, window)
}

/** Outcome health is independent of delivery health. One missing day invalidates the whole selected
 * outcome window so a partial sum can never be shown as the period total. */
export function resolveDashboardMetaOutcomeReadHealth(
  deliveryRead: DashboardMetaReadHealth,
  rows: ReadonlyArray<{ report_date?: unknown; total_leads: unknown; total_bookings: unknown }>,
  window?: { start: string; end: string },
): DashboardMetaOutcomeReadHealth {
  if (deliveryRead.status === 'unavailable') {
    return {
      status: 'unavailable',
      source: 'daily_reports',
      evidence_basis: 'meta_modelled_outcomes',
      reason_code: 'META_OUTCOME_SOURCE_UNAVAILABLE',
      unavailable_reason: deliveryRead.unavailable_reason,
    }
  }
  if (rows.length === 0) {
    return {
      status: 'unavailable',
      source: 'daily_reports',
      evidence_basis: 'meta_modelled_outcomes',
      reason_code: 'META_OUTCOME_ROWS_MISSING',
      unavailable_reason: 'No committed Meta outcome rows cover the selected window.',
    }
  }
  if (!reportOutcomeWindowComplete(rows, window)) {
    return {
      status: 'unavailable',
      source: 'daily_reports',
      evidence_basis: 'meta_modelled_outcomes',
      reason_code: 'META_OUTCOME_WINDOW_INCOMPLETE',
      unavailable_reason: 'One or more selected report days have unavailable Meta outcomes.',
    }
  }
  return {
    status: 'available',
    source: 'daily_reports',
    evidence_basis: 'meta_modelled_outcomes',
    reason_code: null,
    unavailable_reason: null,
  }
}
