import type { SupabaseClient } from '@supabase/supabase-js'
import { accountTimezone } from '@/config/business-config'

export const COCKPIT_TIMEZONE: string = accountTimezone()

export interface CockpitRange {
  start: string
  end: string
  basis: 'closed_account_days'
  timezone: typeof COCKPIT_TIMEZONE
}

export interface SourceEvidenceBase {
  available: boolean
  synchronizedAt: string | null
  blockerCodes: string[]
}

export interface MetaDeliveryEvidence extends SourceEvidenceBase {
  spendAvailable: boolean
  resultsAvailable: boolean
  purchaseAvailable: boolean
  leadAvailable: boolean
  linkCtrAvailable: boolean
  cpmAvailable: boolean
  frequencyAvailable: boolean
  spend: number | null
  results: number | null
  purchaseValue: number | null
  purchaseCount: number | null
  leads: number | null
  linkClicks: number | null
  impressions: number | null
  nativeFrequency: number | null
  /** Meta's all-days selected-period reach. Optional while no cockpit claim consumes it. */
  nativeReach?: number | null
  dailyBudget: number | null
  /**
   * Expected days that have an account-level row — the honest denominator for SPEND.
   *
   * `coveredDays` below is a JOINT flag (`spendAvailable && resultsAvailable ? expectedDays : 0`),
   * not a day count: when campaign reconciliation fails it reports 0 even though every spend day is
   * present. Spend needs its own count, or its coverage is a statement about a different metric.
   */
  spendCoveredDays: number
  coveredDays: number
  expectedDays: number
}

export interface BookingCreatedEtWindow {
  start: string
  end: string
  basis: 'booking_created_date_et'
  timezone: typeof COCKPIT_TIMEZONE
}

export interface BusinessEvidence extends SourceEvidenceBase {
  window: BookingCreatedEtWindow
  valueBearingBookings: number | null
  recordedRevenue: number | null
  recordedAmountPaidLowerBound: number | null
  bookedValue: number | null
  amountPaidCoverage: { withRecordedAmount: number; total: number } | null
}

export interface PaidAssociationEvidence extends SourceEvidenceBase {
  evaluationRunId: string | null
  window: { start: string; end: string } | null
  spend: number | null
  recordedRevenue: number | null
  coverage: { numerator: number; denominator: number } | null
  completenessProof: {
    policyVersion: 3
    evaluationRunId: string
    captureComplete: boolean
    linkerComplete: boolean
    captureEligibleInputs: number
    capturedTouches: number
    eligibleAppointments: number
    evaluatedAppointments: number
    linkedAppointments: number
    blockerCodes: string[]
  } | null
}

export interface PartialTodayEvidence extends SourceEvidenceBase {
  date: string
  spend: number | null
  dailyBudget: number | null
}

/**
 * Delivery readings for the windows a trend needs, keyed by `${start}:${end}`.
 *
 * WHY A MAP AND NOT NAMED FIELDS. The comparable window is derived from each CLAIM's own maturity —
 * `meta.spend` is stamped `settled` and compares over the whole request, while conversion claims run
 * the settle classifier and compare only the settled part. If the loader named the windows
 * ("priorFull", "priorSettled") it would have to re-derive which claim gets which, duplicating the
 * builder's maturity logic in a second place where the two can silently drift.
 *
 * So the loader supplies whatever windows it managed to read, and the builder LOOKS UP the pair each
 * claim actually needs. A window the loader did not read is simply absent, and the trend for that
 * claim is unavailable with a named blocker — never guessed from a window that was read. Fail-closed
 * by construction rather than by remembering to check.
 */
export interface ComparisonEvidence {
  deliveryByWindow: Record<string, MetaDeliveryEvidence>
  /** Why a trend may be unavailable account-wide (the reads failed, or none was attempted). */
  blockerCodes: string[]
}

/** The lookup key for `ComparisonEvidence.deliveryByWindow`. One place, so it cannot drift. */
export function comparisonWindowKey(window: { start: string; end: string }): string {
  return `${window.start}:${window.end}`
}

/**
 * Ledger G. What one non-Meta plane reported when a reader asked it.
 *
 * `synchronizedAt` bounds the AGE of the plane's data and may be null when the plane answered but
 * carried no timestamp. It is never a "last attempted" stamp: an attempt that returned nothing must
 * leave this alone and raise a blocker, or the page will call stale data fresh.
 */
export interface PlaneHealthEvidence {
  /**
   * Named by the CALLER, never by the builder.
   *
   * `tests/ga4-money-boundary.test.ts` forbids `lib/cockpit/builder.ts` from containing the string
   * "ga4" at all — a deliberately blunt boundary keeping GA telemetry out of the Meta claim path. An
   * earlier draft of Ledger G enumerated the non-Meta planes inside the builder and tripped it. The
   * guard was right and the draft was wrong: the builder has no business knowing which non-Meta
   * planes exist. It appends what it is given and computes `consumedByToday`; the loader owns the
   * plane names.
   */
  plane: 'outcome_business' | 'ga4_telemetry'
  state: 'available' | 'unavailable' | 'partial' | 'stale'
  synchronizedAt: string | null
  blockerCodes: string[]
}

export interface CockpitEvidence {
  account: { id: string; metaAccountId: string; name: string | null }
  range: CockpitRange
  asOf: string
  delivery: MetaDeliveryEvidence
  /**
   * Absent on callers that predate trends. The builder must treat absence as "no trend available",
   * with a blocker naming it — never as "no change".
   */
  comparison?: ComparisonEvidence
  /**
   * Ledger G. Health for the NON-Meta evidence planes, when a reader actually established it.
   *
   * `undefined` and a value are not the same thing and the builder must not merge them: `undefined`
   * means this caller has no reader for that plane, so it is omitted from `sourceHealth` entirely and
   * Today says nothing about it; a value means the plane was interrogated and this is what it said.
   * There is deliberately no way to express "assume healthy" — every state here traces to a read.
   */
  planeHealth?: readonly PlaneHealthEvidence[]
  partialToday: PartialTodayEvidence
  synchronizedAt: string | null
  decisionIds: string[]
  primaryDecisionId: string | null
  primaryDecision: {
    id: string
    title: string
    summary: string
    bucket: 'needs_review' | 'tracking_repair' | 'monitoring' | 'awaiting_implementation' | 'outcome_review' | 'snoozed'
    lifecycle: string
    authority: 'execution_eligible' | 'owner_review' | 'diagnostic_only'
    reviewDate: string | null
  } | null
}

export interface LoadPerformanceCockpitOptions {
  range: { from: string; to: string }
  now?: Date
  db?: SupabaseClient
}
