// Pure Meta insight validation and outcome normalization, split out of upsert-insights.ts so client
// reporting code can reconcile outcome hierarchies without pulling the service-role writer into the
// browser bundle. upsert-insights.ts re-exports this module's public surface for server callers.
import type { MetaInsightRow } from '@/types/meta-api'
import {
  COUNT_TOLERANCE,
  normalizedActionSum,
  readOutcomeEventResult,
  readBookingValue,
  readBookingValueViewThrough,
} from './insight-outcome-readers'

// The action/result/value readers moved to ./insight-outcome-readers; this path keeps exporting them.
export {
  findActionValue,
  findActionValueOrNull,
  findOutcomeEventResults,
  findOutcomeEventViewThrough,
  readOutcomeEventResult,
  readBookingValue,
  readBookingValueViewThrough,
} from './insight-outcome-readers'
export type { OutcomeEventResultRead } from './insight-outcome-readers'

export type InsightLevel = 'account' | 'campaign' | 'adset' | 'ad'

const MONEY_TOLERANCE = 0.01

export function requiredDeliveryNumber(
  row: MetaInsightRow,
  field: 'spend' | 'impressions' | 'reach' | 'clicks',
  integer: boolean,
): number {
  const raw = row[field]
  const parsed = raw === undefined || raw === null || raw === '' ? Number.NaN : Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(
      `Meta required delivery field ${field} is missing or malformed for ${row.date_start || 'unknown date'}`,
    )
  }
  return parsed
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
}

/** Validate delivery facts before any database write. Required scalar fields are never defaulted to zero;
 * only an explicit successful account-level sparse-date completion may create a zero delivery row. */
export function validateMetaInsightDeliveryRows(
  level: InsightLevel,
  rows: MetaInsightRow[],
  since: string,
  until: string,
): void {
  if (!validIsoDate(since) || !validIsoDate(until) || since > until) {
    throw new Error(`Meta required delivery window is invalid: ${since}..${until}`)
  }

  const seen = new Set<string>()
  for (const row of rows) {
    if (
      !validIsoDate(row.date_start) ||
      !validIsoDate(row.date_stop) ||
      row.date_start !== row.date_stop ||
      row.date_start < since ||
      row.date_start > until
    ) {
      throw new Error(`Meta required delivery date is missing or outside ${since}..${until}`)
    }

    requiredDeliveryNumber(row, 'spend', false)
    requiredDeliveryNumber(row, 'impressions', true)
    requiredDeliveryNumber(row, 'reach', true)
    requiredDeliveryNumber(row, 'clicks', true)

    const entityId = level === 'account'
      ? 'account'
      : level === 'campaign'
        ? row.campaign_id
        : level === 'adset'
          ? row.adset_id
          : row.ad_id
    if (!entityId) {
      throw new Error(`Meta required delivery ${level} identifier is missing for ${row.date_start}`)
    }
    const key = `${entityId}:${row.date_start}`
    if (seen.has(key)) {
      throw new Error(`Meta required delivery row is duplicated for ${level} ${key}`)
    }
    seen.add(key)
  }
}

type OutcomeTotals = {
  leads: number
  bookings: number
  value: number
  clickBookings: number
  viewBookings: number
}

type NormalizedOutcome = OutcomeTotals & {
  actionsPresent: boolean
  resultsPresent: boolean
  valuePresent: boolean
  valid: boolean
  splitComplete: boolean
}

export function normalizeOutcome(row: MetaInsightRow): NormalizedOutcome {
  const actionsPresent = Array.isArray(row.actions)
  const leads = normalizedActionSum(
    row.actions,
    (type) => type === 'lead' || type === 'offsite_conversion.fb_pixel_lead',
  )
  const result = readOutcomeEventResult(row.results)
  const bookings = result.value

  const bookingValue = readBookingValue(row.action_values, undefined, row.conversion_values)
  // Read here ONLY for its validity. A malformed `1d_view` previously returned {value:null,
  // valid:false} and the writer stored null — which db.ts and the `daily_insights` column comments both DEFINE as "no
  // breakdown reported (unknown)". The reader reported the fault and nothing consumed the verdict, so
  // corrupt money was laundered into a legitimate unknown one layer further out than before.
  // `valid` below is consumed (`meta_outcome_${level}_payload_invalid`), so folding it in fail-stops.
  const bookingValueViewThrough = readBookingValueViewThrough(row.action_values, undefined, row.conversion_values)
  // Presence must track EITHER source, or the gate and the writer disagree.
  //
  // This predicate read `Array.isArray(row.action_values)` alone. Once `readBookingValue` began
  // preferring `conversion_values`, a payload naming the event there while omitting `action_values`
  // — the terminal state of the Meta deprecation this ledger works around — made the writer store a
  // real value while the gate emitted `meta_outcome_ad_value_unavailable`. `reconcileAccountOutcomes`
  // then NULLed the account rollup, producing populated ad rows under a NULL account row: the
  // ad-vs-campaign mismatch class this function's own docblock exists to prevent, in the inverse
  // direction. A genuine gap — neither array present — still freezes the plane.
  const valueArrayPresent = Array.isArray(row.action_values) || Array.isArray(row.conversion_values)
  const valuePresent = bookings === 0 || (valueArrayPresent && bookingValue.matched)

  return {
    leads: leads.value,
    bookings,
    value: bookingValue.value,
    clickBookings: bookings === 0 ? 0 : result.clickBookings,
    viewBookings: bookings === 0 ? 0 : result.viewBookings,
    actionsPresent,
    resultsPresent: result.matched,
    valuePresent,
    splitComplete: bookings === 0 || result.splitComplete,
    valid: leads.valid && result.valid && bookingValue.valid && bookingValueViewThrough.valid,
  }
}

function zeroOutcomeTotals(): OutcomeTotals {
  return { leads: 0, bookings: 0, value: 0, clickBookings: 0, viewBookings: 0 }
}

function aggregateOutcomeByDate(rows: MetaInsightRow[]): {
  totals: Map<string, OutcomeTotals>
  normalized: Map<string, NormalizedOutcome[]>
} {
  const totals = new Map<string, OutcomeTotals>()
  const normalized = new Map<string, NormalizedOutcome[]>()
  for (const row of rows) {
    const outcome = normalizeOutcome(row)
    const current = totals.get(row.date_start) ?? zeroOutcomeTotals()
    totals.set(row.date_start, {
      leads: current.leads + outcome.leads,
      bookings: current.bookings + outcome.bookings,
      value: current.value + outcome.value,
      clickBookings: current.clickBookings + outcome.clickBookings,
      viewBookings: current.viewBookings + outcome.viewBookings,
    })
    normalized.set(row.date_start, [...(normalized.get(row.date_start) ?? []), outcome])
  }
  return { totals, normalized }
}

/**
 * Which outcome-plane blockers gate decisions, and which are merely recorded.
 *
 * Versioned because this changes the meaning of a stored readiness flag — the 117/118 pattern. Evidence
 * written under an earlier version keeps that version's meaning; nothing is reinterpreted in place.
 *
 * See `the "Meta value does not gate decisions" rule` (accepted 2026-08-19).
 *
 * v1: `value_unavailable` moves to COVERAGE. The architecture refuses Meta-reported value any money
 * authority in six separate places — the grounding gate scores leaning on it a hard `fail`, migration
 * 118 caps its basis at owner_review by construction — and yet its ABSENCE was freezing flags and
 * recommendations account-wide. A measure that cannot back a claim cannot be a precondition for making
 * one. Everything else keeps gating: a corrupt, self-inconsistent or unreadable response taints the
 * counts too, and absence is a different claim from disagreement.
 */
export const META_OUTCOME_PLANE_POLICY = {
  version: 1,
  /** Blocker reasons recorded as coverage. Matched against the `<reason>` in
   *  `meta_outcome_<level>_<reason>[:date]`. */
  coverageReasons: ['value_unavailable'] as const,
} as const

const COVERAGE_REASON_SUFFIXES = META_OUTCOME_PLANE_POLICY.coverageReasons.map((r) => `_${r}`)

/** True when a blocker code records an absent non-authoritative measure rather than a broken response. */
export function isCoverageBlockerCode(code: string): boolean {
  const body = code.split(':')[0]
  return COVERAGE_REASON_SUFFIXES.some((suffix) => body.endsWith(suffix))
}

export interface MetaOutcomePlaneReadiness {
  /** Integrity only. False means the response cannot be trusted, so decisions must not be made on it. */
  complete: boolean
  /** Integrity blockers. These, and only these, decide `complete`. */
  blockerCodes: string[]
  /** Coverage gaps. Recorded, surfaced, and carried into evidence — never gating. */
  coverageBlockerCodes: string[]
  /** The policy version `complete` was computed under. */
  policyVersion: number
}

/** Campaign rows are the conversion authority; ad-set and ad rows must reconcile to that same raw
 * response. Meta may omit list fields on true-zero rows, so omission is accepted only when all three
 * levels agree on zero. Any positive result requires an explicit value and click/view partition. */
export function reconcileMetaOutcomeHierarchy(input: {
  campaign: MetaInsightRow[]
  adset: MetaInsightRow[]
  ad: MetaInsightRow[]
  since: string
  until: string
}): MetaOutcomePlaneReadiness {
  const blockers = new Set<string>()
  const levels = {
    campaign: aggregateOutcomeByDate(input.campaign),
    adset: aggregateOutcomeByDate(input.adset),
    ad: aggregateOutcomeByDate(input.ad),
  }

  const dates = new Set<string>()
  for (const date of [
    ...levels.campaign.totals.keys(),
    ...levels.adset.totals.keys(),
    ...levels.ad.totals.keys(),
  ]) dates.add(date)

  for (const [level, aggregate] of Object.entries(levels) as Array<
    ['campaign' | 'adset' | 'ad', ReturnType<typeof aggregateOutcomeByDate>]
  >) {
    for (const [date, rows] of aggregate.normalized) {
      if (rows.some((row) => !row.valid)) blockers.add(`meta_outcome_${level}_payload_invalid:${date}`)
      if (rows.some((row) => !row.resultsPresent)) {
        blockers.add(`meta_outcome_${level}_appointment_results_unavailable:${date}`)
      }
      if (rows.some((row) => row.bookings > 0 && !row.valuePresent)) {
        blockers.add(`meta_outcome_${level}_value_unavailable:${date}`)
      }
      if (rows.some((row) => row.bookings > 0 && !row.splitComplete)) {
        blockers.add(`meta_outcome_${level}_attribution_split_unavailable:${date}`)
      }
    }
  }

  for (const date of dates) {
    if (date < input.since || date > input.until) continue
    const campaign = levels.campaign.totals.get(date) ?? zeroOutcomeTotals()
    const campaignRows = levels.campaign.normalized.get(date) ?? []
    const lowerRows = [
      ...(levels.adset.normalized.get(date) ?? []),
      ...(levels.ad.normalized.get(date) ?? []),
    ]
    if (
      campaign.bookings === 0 &&
      campaignRows.every((row) => !row.resultsPresent && row.bookings === 0) &&
      lowerRows.some((row) => row.bookings > 0)
    ) {
      blockers.add('meta_outcome_campaign_appointment_results_unavailable')
    }
    if (
      campaign.leads === 0 &&
      campaignRows.every((row) => !row.actionsPresent && row.leads === 0) &&
      lowerRows.some((row) => row.leads > 0)
    ) {
      blockers.add('meta_outcome_campaign_leads_unavailable')
    }

    for (const level of ['adset', 'ad'] as const) {
      const candidate = levels[level].totals.get(date) ?? zeroOutcomeTotals()
      const comparisons: Array<[keyof OutcomeTotals, string, number]> = [
        ['leads', 'leads', COUNT_TOLERANCE],
        ['bookings', 'bookings', COUNT_TOLERANCE],
        ['value', 'value', MONEY_TOLERANCE],
        ['clickBookings', 'click_bookings', COUNT_TOLERANCE],
        ['viewBookings', 'view_bookings', COUNT_TOLERANCE],
      ]
      for (const [key, code, tolerance] of comparisons) {
        if (Math.abs(candidate[key] - campaign[key]) > tolerance) {
          blockers.add(`meta_outcome_${level}_${code}_mismatch:${date}`)
        }
      }
    }
  }

  const all = [...blockers].sort()
  const coverageBlockerCodes = all.filter(isCoverageBlockerCode)
  const blockerCodes = all.filter((code) => !isCoverageBlockerCode(code))
  return {
    complete: blockerCodes.length === 0,
    blockerCodes,
    coverageBlockerCodes,
    policyVersion: META_OUTCOME_PLANE_POLICY.version,
  }
}
