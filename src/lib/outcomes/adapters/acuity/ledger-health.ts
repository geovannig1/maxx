import type { SupabaseClient } from '@supabase/supabase-js'
import type { AcuityReconcileResult } from './reconcile'
import { reconciliationCoversWindow } from '@/lib/outcomes/reconciliation'
import { ACUITY_LEDGER_HEALTH_KEY } from './ledger-health-key'

export { ACUITY_LEDGER_HEALTH_KEY }

/** Daily reconciliation plus twelve hours of scheduling/queue slack. */
export const ACUITY_LEDGER_MAX_AGE_MS = 36 * 60 * 60 * 1000

export interface AcuityLedgerHealthStatus {
  available: boolean
  reason: string | null
  lastReconciledAt: string | null
  windowBasis: 'booking_date_et' | null
  windowStartDate: string | null
  windowEndDate: string | null
  truncated: boolean | null
}

/** PURE. Same-run gate for durable evidence publication (src/lib/outcomes/reconciliation.ts). */
export function reconciliationCoversAcuityWindow(
  reconcile: AcuityReconcileResult | null | undefined,
  requestedStartDate: string,
  requestedEndDate: string,
): boolean {
  return reconciliationCoversWindow(reconcile, requestedStartDate, requestedEndDate)
}

type StoredAcuityLedgerHealth = {
  last_reconciled_at?: unknown
  window_basis?: unknown
  window_start_date?: unknown
  window_end_date?: unknown
  truncated?: unknown
}

const unavailable = (reason: string): AcuityLedgerHealthStatus => ({
  available: false,
  reason,
  lastReconciledAt: null,
  windowBasis: null,
  windowStartDate: null,
  windowEndDate: null,
  truncated: null,
})

function parseStoredHealth(value: unknown): StoredAcuityLedgerHealth | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed !== null && typeof parsed === 'object' ? parsed as StoredAcuityLedgerHealth : null
    } catch {
      return null
    }
  }
  return typeof value === 'object' ? value as StoredAcuityLedgerHealth : null
}

/** PURE. A ledger is authoritative only for dates a recent, complete source pull covered. */
export function evaluateAcuityLedgerHealth(
  value: unknown,
  requestedStartDate: string,
  requestedEndDate: string,
  nowMs: number = Date.now(),
): AcuityLedgerHealthStatus {
  const raw = parseStoredHealth(value)
  if (!raw) return unavailable('outcome_ledger_health_missing')

  const lastReconciledAt = typeof raw.last_reconciled_at === 'string'
    ? raw.last_reconciled_at
    : null
  const reconciledMs = lastReconciledAt === null ? Number.NaN : Date.parse(lastReconciledAt)
  if (!Number.isFinite(reconciledMs)) return unavailable('outcome_ledger_health_invalid')

  const ageMs = nowMs - reconciledMs
  if (ageMs < -5 * 60 * 1000) return unavailable('outcome_ledger_health_invalid_future_timestamp')
  if (ageMs > ACUITY_LEDGER_MAX_AGE_MS) return unavailable('outcome_ledger_health_stale')
  if (raw.truncated === true) return unavailable('outcome_ledger_health_truncated')
  if (raw.truncated !== false) return unavailable('outcome_ledger_health_truncation_unknown')
  if (raw.window_basis !== 'booking_date_et') {
    return unavailable('outcome_booking_date_coverage_unproven')
  }

  const windowStartDate = typeof raw.window_start_date === 'string' ? raw.window_start_date : null
  const windowEndDate = typeof raw.window_end_date === 'string' ? raw.window_end_date : null
  if (!windowStartDate || !windowEndDate) return unavailable('outcome_ledger_health_window_unknown')
  if (requestedStartDate > requestedEndDate) return unavailable('outcome_ledger_request_window_invalid')
  if (requestedStartDate < windowStartDate || requestedEndDate > windowEndDate) {
    return unavailable(
      `outcome_ledger_window_not_covered:${requestedStartDate}..${requestedEndDate}`
      + ` outside ${windowStartDate}..${windowEndDate}`,
    )
  }

  return {
    available: true,
    reason: null,
    lastReconciledAt,
    windowBasis: 'booking_date_et',
    windowStartDate,
    windowEndDate,
    truncated: false,
  }
}

/** Account-scoped authority gate shared by every production Acuity ledger reader. */
export async function requireAcuityLedgerHealth(
  supabase: SupabaseClient,
  adAccountDbId: string,
  startDate: string,
  endDate: string,
  nowMs: number = Date.now(),
): Promise<AcuityLedgerHealthStatus> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('ad_account_id', adAccountDbId)
    .eq('key', ACUITY_LEDGER_HEALTH_KEY)
    .maybeSingle()
  if (error) throw new Error(`outcome_ledger_health_read_failed: ${error.message}`)
  const status = evaluateAcuityLedgerHealth(data?.value ?? null, startDate, endDate, nowMs)
  if (!status.available) throw new Error(status.reason ?? 'outcome_ledger_health_unavailable')
  return status
}
