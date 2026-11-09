import { z } from 'zod'
import { ClaimWindowSchema } from '@/lib/cockpit/contracts'
import type { MetricClaim } from '@/lib/cockpit/contracts'

/**
 * A time series carried with claim-grade provenance.
 *
 * WHY THIS IS A SIBLING AND NOT `PerformanceCockpitData` v4: that contract is an MCP tool surface
 * (`get_performance_cockpit`, "the primary numeric source for Maxx answers") and is version-pinned
 * by tests. Bumping it to add a chart would change what the assistant answers with. This contract
 * is additive, independently versioned, and consumed only by the owner page.
 *
 * WHY THE ENVELOPE IS STATED ONCE: a 127-point series does not need 127 copies of
 * the account timezone. Provenance describes the SERIES; only what genuinely varies
 * per day lives on the point.
 */
export const SERIES_CONTRACT_VERSION = 1 as const

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const isoTimestamp = z.string().datetime({ offset: true })
const blockerCodes = z.array(z.string().trim().min(1).max(160)).superRefine((codes, context) => {
  if (new Set(codes).size !== codes.length) {
    context.addIssue({ code: 'custom', message: 'blocker codes must be unique' })
  }
})

/**
 * What a single day in the window actually is.
 *
 * The critical distinction is between the two absences. Meta returns no insight row for a day with
 * no delivery AND for a day that was never fetched — identical silence, opposite meanings. Charting
 * either as `0` invents spend that never happened; charting both as "unknown" hides real dormancy.
 *
 * On a small account a large share of calendar days (40% is plausible) can have no row, yet
 * successful syncs cover the whole span, so those days are PROVEN no-delivery, not unfetched. The proof is sync
 * coverage (`api_sync_logs.date_range_start/end`), never absence itself.
 *
 * Names keep the lineage of the existing `meta_spend_day_missing` blocker
 * (`src/lib/economics/ad-spend-reader.ts`) rather than inventing a competing vocabulary.
 */
export const WindowDayStateSchema = z.enum([
  'measured',
  'missing_no_delivery',
  'missing_not_synced',
])
export type WindowDayState = z.infer<typeof WindowDayStateSchema>

export const SeriesPointSchema = z.object({
  date: dateOnly,
  value: z.number().finite().nullable(),
  state: WindowDayStateSchema,
}).strict().superRefine((point, context) => {
  if (point.state === 'measured' && point.value === null) {
    context.addIssue({ code: 'custom', message: 'a measured day requires a value', path: ['value'] })
  }
  if (point.state !== 'measured' && point.value !== null) {
    context.addIssue({
      code: 'custom',
      message: 'an absent day cannot carry a value — that is how a gap becomes a fabricated zero',
      path: ['value'],
    })
  }
})

/** Kept in sync with MetricClaim at compile time; see the assertions at the foot of this file. */
const sourceSystem = z.enum(['meta', 'outcomes', 'first_party_attribution', 'ga4', 'capi', 'maxx'])
const measurementKind = z.enum([
  'measured', 'modelled', 'derived', 'operational', 'telemetry',
  'associated_noncausal', 'causal_estimate',
])
const evidencePlane = z.enum([
  'meta_delivery', 'outcome_business', 'paid_association', 'ga4_telemetry',
  'capi_delivery', 'decision',
])

export const ClaimedSeriesSchema = z.object({
  seriesId: z.string().trim().min(1).max(240),
  metricKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  unit: z.enum(['money', 'count', 'ratio', 'percent']),
  granularity: z.enum(['day', 'week']),
  source: z.object({
    system: sourceSystem,
    head: z.string().trim().min(1).max(160).nullable(),
    evidencePlane,
  }).strict(),
  entity: z.object({
    level: z.enum(['account', 'campaign', 'adset', 'ad', 'business']),
    id: z.string().trim().min(1).max(160),
  }).strict(),
  window: ClaimWindowSchema,
  asOf: isoTimestamp,
  measurementKind,
  availability: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), blockerCodes: z.tuple([]) }).strict(),
    z.object({ state: z.literal('unavailable'), blockerCodes: blockerCodes.min(1) }).strict(),
  ]),
  /** Day accounting for the whole series. `measuredDays + noDeliveryDays + notSyncedDays === totalDays`. */
  coverage: z.object({
    totalDays: z.number().int().nonnegative(),
    measuredDays: z.number().int().nonnegative(),
    noDeliveryDays: z.number().int().nonnegative(),
    notSyncedDays: z.number().int().nonnegative(),
  }).strict(),
  points: z.array(SeriesPointSchema),
}).strict().superRefine((series, context) => {
  const { totalDays, measuredDays, noDeliveryDays, notSyncedDays } = series.coverage
  if (measuredDays + noDeliveryDays + notSyncedDays !== totalDays) {
    context.addIssue({ code: 'custom', message: 'coverage day counts must sum to totalDays', path: ['coverage'] })
  }
  if (series.points.length !== totalDays) {
    context.addIssue({ code: 'custom', message: 'points must cover every day in the window', path: ['points'] })
  }
  const tally = { measured: 0, missing_no_delivery: 0, missing_not_synced: 0 }
  const seen = new Set<string>()
  for (const point of series.points) {
    if (seen.has(point.date)) {
      context.addIssue({ code: 'custom', message: `duplicate day in series: ${point.date}`, path: ['points'] })
    }
    seen.add(point.date)
    if (point.date < series.window.start || point.date > series.window.end) {
      context.addIssue({ code: 'custom', message: `point falls outside the window: ${point.date}`, path: ['points'] })
    }
    tally[point.state] += 1
  }
  if (tally.measured !== measuredDays || tally.missing_no_delivery !== noDeliveryDays
      || tally.missing_not_synced !== notSyncedDays) {
    context.addIssue({ code: 'custom', message: 'coverage counts must match the points they summarise', path: ['coverage'] })
  }
  if (series.availability.state === 'unavailable' && series.points.length > 0) {
    context.addIssue({ code: 'custom', message: 'an unavailable series cannot carry points', path: ['points'] })
  }
})

export type ClaimedSeries = z.output<typeof ClaimedSeriesSchema>
export type ClaimedSeriesInput = z.input<typeof ClaimedSeriesSchema>

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** The only supported constructor: validates the complete series, then freezes it recursively. */
export function createClaimedSeries(input: ClaimedSeriesInput): ClaimedSeries {
  return deepFreeze(ClaimedSeriesSchema.parse(input))
}

// Compile-time drift guards: if MetricClaim's unions change, these stop compiling rather than
// silently letting the series contract describe provenance the claim contract no longer uses.
type _SystemInSync = ClaimedSeries['source']['system'] extends MetricClaim['source']['system'] ? true : never
type _KindInSync = ClaimedSeries['measurementKind'] extends MetricClaim['measurementKind'] ? true : never
type _PlaneInSync = ClaimedSeries['source']['evidencePlane'] extends MetricClaim['source']['evidencePlane'] ? true : never
type _EntityInSync = ClaimedSeries['entity']['level'] extends MetricClaim['entity']['level'] ? true : never
const _driftGuards: [_SystemInSync, _KindInSync, _PlaneInSync, _EntityInSync] = [true, true, true, true]
void _driftGuards
