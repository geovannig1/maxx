import type {
  ExecutiveMetaOutcomePlaneV1,
  ExecutiveMetaPlacementRowV1,
} from './executive-evidence.types'

export interface ExecutivePlacementOutcomeAuthorityV1 {
  leads: number | null
  modeledBookings: number | null
}

type PlacementOutcomeRow = Record<string, unknown>
const PLACEMENT_SOURCE_MAX_AGE_MS = 36 * 60 * 60 * 1_000

function numberOrNull(value: unknown): number | null {
  if (value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function validateExecutivePlacementSourceHeadV1(
  raw: unknown,
  expected: {
    windowStart: string
    windowEnd: string
    asOf: string
    rowCount: number
    sourceNotBefore?: string
  },
): { valid: boolean; head: string | null; blockerCodes: string[] } {
  const health = record(raw)
  const head = typeof health?.completed_at === 'string' ? health.completed_at : null
  if (!health || health.complete !== true || !head || !Number.isFinite(Date.parse(head))) {
    return { valid: false, head, blockerCodes: ['meta_placement_source_head_unavailable'] }
  }
  const blockers: string[] = []
  if (health.window_start !== expected.windowStart || health.window_end !== expected.windowEnd) {
    blockers.push('meta_placement_source_window_mismatch')
  }
  const dimensions = Array.isArray(health.dimensions) ? [...health.dimensions].sort() : []
  if (dimensions.length !== 2 || dimensions[0] !== 'platform_position' || dimensions[1] !== 'publisher_platform') {
    blockers.push('meta_placement_source_dimensions_incomplete')
  }
  if (Number(health.row_count) !== expected.rowCount) blockers.push('meta_placement_source_row_count_mismatch')
  const asOfMs = Date.parse(expected.asOf)
  const headMs = Date.parse(head)
  if (!Number.isFinite(asOfMs) || headMs > asOfMs) blockers.push('meta_placement_source_head_after_as_of')
  else if (asOfMs - headMs > PLACEMENT_SOURCE_MAX_AGE_MS) blockers.push('meta_placement_source_head_stale')
  if (expected.sourceNotBefore !== undefined) {
    const boundary = Date.parse(expected.sourceNotBefore)
    if (!Number.isFinite(boundary)) blockers.push('meta_placement_source_boundary_invalid')
    else if (headMs < boundary) blockers.push('meta_placement_source_head_before_current_run')
  }
  return { valid: blockers.length === 0, head, blockerCodes: unique(blockers) }
}

export function reconcileExecutivePlacementSpendV1(
  rows: PlacementOutcomeRow[],
  authoritativeSpend: number | null,
): string[] {
  if (authoritativeSpend === null) return ['meta_placement_account_spend_unavailable']
  const blockers: string[] = []
  for (const dimension of ['publisher_platform', 'platform_position'] as const) {
    const spend = rows.filter((row) => row.breakdown_type === dimension)
      .reduce((total, row) => total + Number(row.spend), 0)
    if (Math.abs(spend - authoritativeSpend) > 0.01) {
      blockers.push(`meta_placement_spend_reconciliation_failed:${dimension}`)
    }
  }
  return blockers
}

/** Each placement dimension is a different partition of the same campaign-authority outcomes.
 * Missing/mixed row outcomes or a partition mismatch makes the entire placement outcome plane
 * unavailable while leaving placement delivery usable. */
export function reconcileExecutivePlacementOutcomesV1(
  rows: PlacementOutcomeRow[],
  authority: ExecutivePlacementOutcomeAuthorityV1,
): string[] {
  if (authority.leads === null || authority.modeledBookings === null) {
    return ['meta_placement_outcome_authority_unavailable']
  }
  if (rows.some((row) => (row.leads === null) !== (row.bookings === null))) {
    return ['meta_placement_outcome_shape_invalid']
  }
  if (rows.some((row) => numberOrNull(row.leads) === null || numberOrNull(row.bookings) === null)) {
    return ['meta_placement_outcomes_unavailable']
  }

  const blockers: string[] = []
  for (const dimension of ['publisher_platform', 'platform_position'] as const) {
    const dimensionRows = rows.filter((row) => row.breakdown_type === dimension)
    const leads = dimensionRows.reduce((total, row) => total + numberOrNull(row.leads)!, 0)
    const bookings = dimensionRows.reduce((total, row) => total + numberOrNull(row.bookings)!, 0)
    if (Math.abs(leads - authority.leads) > 0.5) {
      blockers.push(`meta_placement_leads_reconciliation_failed:${dimension}`)
    }
    if (Math.abs(bookings - authority.modeledBookings) > 0.5) {
      blockers.push(`meta_placement_bookings_reconciliation_failed:${dimension}`)
    }
  }
  return unique(blockers)
}

export function projectExecutivePlacementRowsV1(
  rows: PlacementOutcomeRow[],
  outcomePlane: ExecutiveMetaOutcomePlaneV1,
  authority: ExecutivePlacementOutcomeAuthorityV1,
): { blockerCodes: string[]; rows: ExecutiveMetaPlacementRowV1[] } {
  const blockers = outcomePlane.status === 'incomplete'
    ? [
        'meta_outcome_plane_incomplete:placements',
        ...outcomePlane.blockerCodes.map((code) => `meta_outcome_plane:placements:${code}`),
      ]
    : reconcileExecutivePlacementOutcomesV1(rows, authority)
  const outcomesComplete = blockers.length === 0
  const grouped = new Map<string, ExecutiveMetaPlacementRowV1>()
  for (const row of rows) {
    const dimension = row.breakdown_type as ExecutiveMetaPlacementRowV1['dimension']
    const value = String(row.breakdown_value)
    const key = `${dimension}:${value}`
    const current = grouped.get(key) ?? {
      dimension, value, spendAmount: 0, impressions: 0, clicks: 0,
      leads: outcomesComplete ? 0 : null,
      modeledBookings: outcomesComplete ? 0 : null,
      outcomePlane,
    }
    grouped.set(key, {
      ...current,
      spendAmount: current.spendAmount + Number(row.spend),
      impressions: current.impressions + Number(row.impressions),
      clicks: current.clicks + Number(row.clicks),
      leads: outcomesComplete ? (current.leads ?? 0) + Number(row.leads) : null,
      modeledBookings: outcomesComplete
        ? (current.modeledBookings ?? 0) + Number(row.bookings) : null,
    })
  }
  return {
    blockerCodes: unique(blockers),
    rows: [...grouped.values()].sort((left, right) => right.spendAmount - left.spendAmount),
  }
}
