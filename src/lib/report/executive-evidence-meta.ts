import type {
  ExecutiveEvidenceSourceStateV1,
  ExecutiveMetaColdWarmEvidenceV1,
  ExecutiveMetaColdWarmUnitV1,
  ExecutiveMetaPlacementEvidenceV1,
  ExecutiveSetupChangeProjectionV1,
} from './executive-evidence.types'
import { dateInTimezone, isExecutiveEvidenceDateV1 } from './executive-evidence-windows'
import { deriveExitedLearning } from '@/lib/recommendations/trend'

export interface ExecutiveNormalizedReadV1<T> {
  state: ExecutiveEvidenceSourceStateV1
  data: T | null
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nullableNonnegative(value: unknown): boolean {
  return value === null || nonnegative(value)
}

function validOutcomePlane(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    ['complete', 'incomplete'].includes(String(value.status)) &&
    Array.isArray(value.blockerCodes) &&
    value.blockerCodes.every((item) => typeof item === 'string') &&
    (value.sourceNotBefore === null || typeof value.sourceNotBefore === 'string') &&
    Array.isArray(value.checkedLevels) &&
    value.checkedLevels.every((item) => ['campaign', 'adset', 'ad'].includes(String(item)))
  )
}

function validUnit(value: unknown): value is ExecutiveMetaColdWarmUnitV1 {
  if (!isRecord(value)) return false
  return (
    ['campaign', 'adset'].includes(String(value.entityLevel)) &&
    typeof value.entityId === 'string' &&
    value.entityId.length > 0 &&
    (value.parentCampaignId === null || typeof value.parentCampaignId === 'string') &&
    typeof value.name === 'string' &&
    [null, 'cold', 'warm', 'other'].includes(value.comparisonRole as null | string) &&
    [value.spendAmount, value.impressions, value.reach].every(nonnegative) &&
    [
      value.linkClicks,
      value.landingPageViews,
      value.leads,
      value.modeledBookings,
      value.modeledBookingValue,
      value.modeledClickBookings,
      value.modeledViewBookings,
      value.modeledUnknownBookings,
    ].every(nullableNonnegative) &&
    validOutcomePlane(value.outcomePlane)
  )
}

function partial<T>(read: ExecutiveNormalizedReadV1<T>, blockers: string[], data: T): ExecutiveNormalizedReadV1<T> {
  const blockerCodes = unique([...read.state.blockerCodes, ...blockers])
  return {
    state: {
      ...read.state,
      availability: blockerCodes.length === 0 && read.state.availability === 'available' ? 'available' : 'partial',
      blockerCodes,
    },
    data,
  }
}

function invalid<T>(read: ExecutiveNormalizedReadV1<unknown>, blocker: string): ExecutiveNormalizedReadV1<T> {
  return {
    state: {
      availability: 'unavailable',
      head: read.state.head,
      blockerCodes: unique([...read.state.blockerCodes, blocker]),
    },
    data: null,
  }
}

/**
 * A structurally clean split is not automatically a comparable one. The Cold/Warm rollup covers a date
 * window, so it is only comparable when that window holds ONE delivery regime. Mixed pre/post-change
 * data is insufficient evidence, never a clean comparison — the governed post-change window is the only
 * lineage-proven substrate for reading a change's effect.
 *
 * Setup evidence is point-in-time and cannot see the window, so these temporal checks belong here.
 */
function comparisonWindowBlockers(
  data: ExecutiveMetaColdWarmEvidenceV1,
  setup: ExecutiveSetupChangeProjectionV1 | null,
  timezone: string,
): string[] {
  if (!setup) return []
  const blockers: string[] = []
  // Boundary is inclusive on both ends: the change day itself carries pre- and post-change hours.
  const landsInWindow = (timestamp: string | null): boolean => {
    if (!timestamp) return false
    const date = dateInTimezone(timestamp, timezone)
    return date !== null && date >= data.windowStart && date <= data.windowEnd
  }

  const change = setup.latest_material_change
  // 'unknown' already blocks upstream via latest_material_change_reason_unknown; a KNOWN, approved
  // change is the gap — being governed does not make the window it splits comparable.
  if (change.status === 'known' && landsInWindow(change.occurredAt)) {
    blockers.push('comparison_window_spans_material_change')
  }

  const comparedIds = [
    setup.cold_warm_comparison.cold_meta_adset_id,
    setup.cold_warm_comparison.warm_meta_adset_id,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)
  for (const id of comparedIds) {
    const adset = setup.adsets.find((row) => row.meta_adset_id === id)
    if (!adset) {
      // Named as a comparison cell but absent from setup evidence: unverifiable, so never clean.
      blockers.push('comparison_cell_learning_unknown')
      continue
    }
    // A significant edit resets Meta's learning for that cell, splitting its own delivery regime.
    if (landsInWindow(adset.latest_significant_edit_at)) blockers.push('comparison_cell_edited_in_window')
    const exited = deriveExitedLearning(adset.learning_stage)
    if (exited === false) blockers.push('comparison_cell_learning')
    else if (exited === null) blockers.push('comparison_cell_learning_unknown')
  }
  return blockers
}

export function normalizeMetaColdWarmEvidenceV1(
  read: ExecutiveNormalizedReadV1<ExecutiveMetaColdWarmEvidenceV1>,
  setup: ExecutiveSetupChangeProjectionV1 | null,
  timezone: string,
): ExecutiveNormalizedReadV1<ExecutiveMetaColdWarmEvidenceV1> {
  if (!read.data) return read
  const data = read.data
  if (
    !isRecord(data) ||
    !isExecutiveEvidenceDateV1(String(data.windowStart)) ||
    !isExecutiveEvidenceDateV1(String(data.windowEnd)) ||
    !['clean', 'blocked'].includes(String(data.comparisonStatus)) ||
    !Array.isArray(data.blockerCodes) ||
    !Array.isArray(data.units) ||
    !data.units.every(validUnit)
  ) {
    return invalid(read, 'meta_cold_warm_source_data_invalid')
  }
  const setupComparison = setup?.cold_warm_comparison
  const setupBlockers =
    setupComparison?.status === 'clean'
      ? []
      : setupComparison?.blocker_codes.length
        ? setupComparison.blocker_codes.map((code) => `setup:${code}`)
        : ['setup:cold_warm_comparison_unavailable']
  const blockers = unique([
    ...data.blockerCodes,
    ...setupBlockers,
    ...comparisonWindowBlockers(data, setup, timezone),
  ])
  const comparisonStatus = blockers.length === 0 && setupComparison?.status === 'clean' ? 'clean' : 'blocked'
  return partial(read, blockers, {
    ...data,
    comparisonStatus,
    blockerCodes: blockers,
    units: data.units.map((unit) => ({ ...unit })),
  })
}

export function normalizeMetaPlacementEvidenceV1(
  read: ExecutiveNormalizedReadV1<ExecutiveMetaPlacementEvidenceV1>,
): ExecutiveNormalizedReadV1<ExecutiveMetaPlacementEvidenceV1> {
  if (!read.data) return read
  const data = read.data
  const rowsValid =
    Array.isArray(data.rows) &&
    data.rows.every(
      (row) =>
        isRecord(row) &&
        ['publisher_platform', 'platform_position'].includes(String(row.dimension)) &&
        typeof row.value === 'string' &&
        row.value.length > 0 &&
        [row.spendAmount, row.impressions, row.clicks].every(nonnegative) &&
        [row.leads, row.modeledBookings].every(nullableNonnegative) &&
        validOutcomePlane(row.outcomePlane),
    )
  if (
    !isRecord(data) ||
    !isExecutiveEvidenceDateV1(String(data.windowStart)) ||
    !isExecutiveEvidenceDateV1(String(data.windowEnd)) ||
    !Array.isArray(data.blockerCodes) ||
    !rowsValid
  ) {
    return invalid(read, 'meta_placements_source_data_invalid')
  }
  const blockers = data.blockerCodes.filter((code): code is string => typeof code === 'string')
  return partial(read, blockers, {
    ...data,
    blockerCodes: unique(blockers),
    rows: data.rows.map((row) => ({ ...row })),
  })
}
