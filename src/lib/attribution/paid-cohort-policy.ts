const DAY_MS = 86_400_000

/**
 * The activation is an immutable fact about when capture became trustworthy. Its version does not
 * advance when the downstream cohort evidence rules change.
 */
export const PAID_MEASUREMENT_ACTIVATION_POLICY = Object.freeze({
  contractVersion: 1 as const,
  policyVersion: 1 as const,
})

export const PAID_COHORT_COMPLETENESS_MANIFEST_POLICY = Object.freeze({
  contractVersion: 1 as const,
  policyVersion: 1 as const,
})

export const PAID_COHORT_POLICY = Object.freeze({
  contractVersion: 1 as const,
  // v1 could mark identity-incomplete evidence complete. v2 still lacked an exhaustive,
  // current-run capture/linker proof and could therefore manufacture an exact zero.
  //
  // FROZEN AT v2 until the four paid-eligibility ledger surfaces have been deployed, controlled-journey
  // activated, and a whole closed window is independently covered. The paid-eligibility ledger supplies the
  // missing denominator but deliberately does not manufacture history or activate policy v3.
  policyVersion: 2 as const,
  recentScaleDays: 14,
  maturedCutDays: 14,
  maturityLagDays: 14,
  maturityBasis: 'provisional_owner_approved_assumption' as const,
})

export interface PaidCohortWindows {
  recentScale: { start: string; end: string }
  maturedCut: { start: string; end: string }
}

function strictDateMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Paid cohort as-of date must use YYYY-MM-DD.')
  }
  const ms = new Date(`${value}T00:00:00.000Z`).getTime()
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error('Paid cohort as-of date is not a real calendar date.')
  }
  return ms
}

function dateAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Policy v3 evaluates only completed account-calendar days. The recent and matured windows are
 * adjacent but never overlap; the mature window therefore ends 15 calendar days before as-of and
 * satisfies the declared 14-day minimum lag without mixing any recent-scale day into cut evidence.
 */
export function resolvePaidCohortWindows(asOfDate: string): PaidCohortWindows {
  const asOfMs = strictDateMs(asOfDate)
  const recentEndMs = asOfMs - DAY_MS
  const recentStartMs = recentEndMs - (PAID_COHORT_POLICY.recentScaleDays - 1) * DAY_MS
  const maturedEndMs = recentStartMs - DAY_MS
  const maturedStartMs = maturedEndMs - (PAID_COHORT_POLICY.maturedCutDays - 1) * DAY_MS
  return {
    recentScale: { start: dateAt(recentStartMs), end: dateAt(recentEndMs) },
    maturedCut: { start: dateAt(maturedStartMs), end: dateAt(maturedEndMs) },
  }
}

/**
 * Activation-aware window resolution. When a recent account-calendar activation is present and the
 * computed recent window starts on or before that activation, the recent window is trimmed to begin
 * on the first full day AFTER activation. The matured window is NOT pushed forward with it; this
 * deliberately leaves the matured cut window in its computed calendar position, which keeps the two
 * windows non-overlapping and lets scale recommendations evaluate only post-activation spend. Cut
 * recommendations remain blocked until a fully post-activation matured window exists by calendar.
 */
export function resolvePaidCohortWindowsFromActivation(
  asOfDate: string,
  activationDate: string | null | undefined,
): PaidCohortWindows {
  const windows = resolvePaidCohortWindows(asOfDate)
  if (!activationDate) return windows
  const trimmedRecentStart = dateAt(new Date(activationDate).getTime() + DAY_MS)
  if (trimmedRecentStart <= windows.recentScale.start) return windows
  return {
    recentScale: { start: trimmedRecentStart, end: windows.recentScale.end },
    maturedCut: windows.maturedCut,
  }
}
