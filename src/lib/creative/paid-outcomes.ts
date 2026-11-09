import type {
  PaidCohortDirectionArtifact,
  PaidCohortEvaluationArtifact,
} from '@/lib/attribution/paid-cohort-store'
import type { CreativeAssignmentResolution } from './assignment-stability'
import { currencyFractionDigits } from '@/lib/utils/format-currency'

export interface PaidCreativeNumericOutcomes {
  spend: number
  landing_page_views: number
  captured_touches: number
  value_bearing_bookings: number
  booked_value: number
  zero_value_bookings: number
  canceled_links: number
}

export interface PaidCreativeOutcomes {
  status: 'not_published' | 'blocked' | 'available'
  evaluation_run_id: string | null
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
  note: string
  recent_scale: PaidCreativeDirection | null
  matured_cut: PaidCreativeDirection | null
}

export interface PaidCreativeDirection {
  status: 'blocked' | 'available'
  generation_id: string
  cohort_kind: 'recent_scale' | 'matured_cut'
  window_start: string
  window_end: string
  as_of_date: string
  contract_version: number
  policy_version: number
  blocker_codes: string[]
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
  creatives: PaidCreativeEvidence[]
}

interface PaidCreativeEvidenceBase {
  evaluation_run_id: string
  generation_id: string
  meta_creative_id: string
  creative_name: string | null
  thumbnail_url: string | null
  contributing_meta_ad_ids: string[]
  assignment_observation_ids: string[]
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
}

export type PaidCreativeEvidence =
  | PaidCreativeEvidenceBase & {
    status: 'available'
    complete: true
    blocker_codes: []
    outcomes: PaidCreativeNumericOutcomes
  }
  | PaidCreativeEvidenceBase & {
    status: 'blocked'
    complete: false
    blocker_codes: string[]
    outcomes: null
  }

export interface PaidCreativeDisplayMetadata {
  creative_name: string | null
  thumbnail_url: string | null
}

type DirectionAssignments = ReadonlyMap<string, CreativeAssignmentResolution>

export interface PaidCreativeAssignmentsByDirection {
  recent_scale: DirectionAssignments
  matured_cut: DirectionAssignments
}

interface GroupedUnit {
  unit: PaidCohortDirectionArtifact['adUnits'][number]
  observationIds: [string, string]
}

const NOTE = 'Paid creative outcomes are associated via governed last-paid-touch; booked value is the charged appointment price for non-canceled, positive-value appointments.'
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

export type PaidCreativeProjectionErrorCode =
  | 'MONETARY_SCALE_INVALID'
  | 'NUMERIC_INPUT_INVALID'
  | 'NUMERIC_AGGREGATE_OVERFLOW'

export class PaidCreativeProjectionError extends Error {
  constructor(
    public readonly code: PaidCreativeProjectionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PaidCreativeProjectionError'
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function monetaryMinorUnits(value: number, field: string, scale: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new PaidCreativeProjectionError(
      'MONETARY_SCALE_INVALID',
      `${field} must be a finite nonnegative monetary value in whole minor units of the account currency.`,
    )
  }
  const normalized = Object.is(value, -0) ? 0 : value
  const minorUnits = Math.round(normalized * scale)
  if (!Number.isSafeInteger(minorUnits)) {
    throw new PaidCreativeProjectionError(
      'NUMERIC_AGGREGATE_OVERFLOW',
      `${field} exceeds the safe numeric output range.`,
    )
  }
  if (minorUnits / scale !== normalized) {
    throw new PaidCreativeProjectionError(
      'MONETARY_SCALE_INVALID',
      `${field} must be representable in integer minor units.`,
    )
  }
  return BigInt(minorUnits)
}

function checkedMoneySum(
  members: GroupedUnit[],
  field: string,
  valueOf: (unit: GroupedUnit['unit']) => number,
): number {
  // The account currency's minor unit: cents for USD, yen for JPY, fils for KWD.
  const scale = 10 ** currencyFractionDigits()
  let minorUnits = BigInt(0)
  for (const { unit } of members) {
    const value = monetaryMinorUnits(valueOf(unit), field, scale)
    if (minorUnits > MAX_SAFE_INTEGER_BIGINT - value) {
      throw new PaidCreativeProjectionError(
        'NUMERIC_AGGREGATE_OVERFLOW',
        `${field} aggregate exceeds the safe numeric output range.`,
      )
    }
    minorUnits += value
  }
  const publicValue = Number(minorUnits) / scale
  const roundTripMinorUnits = Math.round(publicValue * scale)
  if (
    !Number.isSafeInteger(roundTripMinorUnits)
    || BigInt(roundTripMinorUnits) !== minorUnits
  ) {
    throw new PaidCreativeProjectionError(
      'NUMERIC_AGGREGATE_OVERFLOW',
      `${field} aggregate cannot be represented exactly in the public numeric contract.`,
    )
  }
  return publicValue
}

function checkedCountSum(
  members: GroupedUnit[],
  field: string,
  valueOf: (unit: GroupedUnit['unit']) => number,
): number {
  let total = 0
  for (const { unit } of members) {
    const value = valueOf(unit)
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PaidCreativeProjectionError(
        'NUMERIC_INPUT_INVALID',
        `${field} must be a safe nonnegative integer.`,
      )
    }
    if (total > Number.MAX_SAFE_INTEGER - value) {
      throw new PaidCreativeProjectionError(
        'NUMERIC_AGGREGATE_OVERFLOW',
        `${field} aggregate exceeds the safe numeric output range.`,
      )
    }
    total += value
  }
  return total
}

function numericOutcomes(members: GroupedUnit[]): PaidCreativeNumericOutcomes {
  return {
    spend: checkedMoneySum(members, 'spend', (unit) => unit.spend as number),
    landing_page_views: checkedCountSum(
      members, 'landing_page_views', (unit) => unit.landingPageViews as number,
    ),
    captured_touches: checkedCountSum(members, 'captured_touches', (unit) => unit.capturedTouches),
    value_bearing_bookings: checkedCountSum(
      members, 'value_bearing_bookings', (unit) => unit.bookings,
    ),
    booked_value: checkedMoneySum(members, 'booked_value', (unit) => unit.bookedValue),
    zero_value_bookings: checkedCountSum(
      members, 'zero_value_bookings', (unit) => unit.zeroValueBookings,
    ),
    canceled_links: checkedCountSum(members, 'canceled_links', (unit) => unit.canceledLinks),
  }
}

function commonDirection(
  direction: PaidCohortDirectionArtifact,
  blockerCodes: string[],
): Omit<PaidCreativeDirection, 'status' | 'creatives'> {
  return {
    generation_id: direction.generation.generationId,
    cohort_kind: direction.generation.cohortKind,
    window_start: direction.generation.windowStart,
    window_end: direction.generation.windowEnd,
    as_of_date: direction.generation.asOfDate,
    contract_version: direction.generation.contractVersion,
    policy_version: direction.generation.policyVersion,
    blocker_codes: blockerCodes,
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
  }
}

function projectDirection(
  evaluationRunId: string,
  direction: PaidCohortDirectionArtifact,
  assignments: DirectionAssignments,
  metadata: ReadonlyMap<string, PaidCreativeDisplayMetadata>,
): PaidCreativeDirection {
  const sourceBlockers = direction.adUnits.flatMap((unit) => unit.blockerCodes)
  const globalBlockers = [...direction.generation.blockerCodes]
  const resolved = new Map<string, Extract<CreativeAssignmentResolution, { state: 'observed_stable' }>>()

  for (const unit of direction.adUnits) {
    const assignment = assignments.get(unit.metaAdId)
    if (!assignment) {
      globalBlockers.push('assignment_history_missing')
    } else if (assignment.state === 'blocked') {
      globalBlockers.push(assignment.blockerCode)
    } else {
      resolved.set(unit.metaAdId, assignment)
    }
  }

  if (globalBlockers.some((code) => code.startsWith('assignment_') || code === 'ad_mutation_ambiguous')) {
    const blockerCodes = sorted([...globalBlockers, ...sourceBlockers])
    return { ...commonDirection(direction, blockerCodes), status: 'blocked', creatives: [] }
  }

  const grouped = new Map<string, GroupedUnit[]>()
  for (const unit of direction.adUnits) {
    const assignment = resolved.get(unit.metaAdId)
    if (!assignment) continue
    const members = grouped.get(assignment.metaCreativeId) ?? []
    members.push({ unit, observationIds: assignment.boundaryObservationIds })
    grouped.set(assignment.metaCreativeId, members)
  }

  const creatives: PaidCreativeEvidence[] = []
  for (const metaCreativeId of sorted(grouped.keys())) {
    const members = grouped.get(metaCreativeId) ?? []
    const contributingMetaAdIds = sorted(members.map(({ unit }) => unit.metaAdId))
    const assignmentObservationIds = sorted(members.flatMap(({ observationIds }) => observationIds))
    const blockerCodes = sorted(members.flatMap(({ unit }) => unit.blockerCodes))
    const numericFieldsPresent = members.every(({ unit }) =>
      unit.spend !== null && unit.landingPageViews !== null
    )
    const complete = members.length > 0
      && members.every(({ unit }) => unit.complete)
      && numericFieldsPresent
    const display = metadata.get(metaCreativeId)
    const common: PaidCreativeEvidenceBase = {
      evaluation_run_id: evaluationRunId,
      generation_id: direction.generation.generationId,
      meta_creative_id: metaCreativeId,
      creative_name: display?.creative_name ?? null,
      thumbnail_url: display?.thumbnail_url ?? null,
      contributing_meta_ad_ids: contributingMetaAdIds,
      assignment_observation_ids: assignmentObservationIds,
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
    }

    if (!complete) {
      creatives.push({
        ...common,
        status: 'blocked',
        complete: false,
        blocker_codes: blockerCodes.length > 0 ? blockerCodes : ['paid_unit_metric_unavailable'],
        outcomes: null,
      })
      continue
    }

    creatives.push({
      ...common,
      status: 'available',
      complete: true,
      blocker_codes: [],
      outcomes: numericOutcomes(members),
    })
  }

  const hasAvailable = creatives.some((creative) => creative.status === 'available')
  const blockerCodes = sorted([
    ...globalBlockers,
    ...creatives.flatMap((creative) => creative.blocker_codes),
  ])
  return {
    ...commonDirection(direction, blockerCodes),
    status: hasAvailable ? 'available' : 'blocked',
    creatives,
  }
}

export function projectPaidCreativeOutcomes(
  artifact: PaidCohortEvaluationArtifact | null,
  assignmentsByDirection: PaidCreativeAssignmentsByDirection,
  creativeMetadata: ReadonlyMap<string, PaidCreativeDisplayMetadata>,
): PaidCreativeOutcomes {
  if (!artifact) {
    return {
      status: 'not_published',
      evaluation_run_id: null,
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      note: NOTE,
      recent_scale: null,
      matured_cut: null,
    }
  }

  const recent = projectDirection(
    artifact.evaluationRunId,
    artifact.recentScale,
    assignmentsByDirection.recent_scale,
    creativeMetadata,
  )
  const matured = projectDirection(
    artifact.evaluationRunId,
    artifact.maturedCut,
    assignmentsByDirection.matured_cut,
    creativeMetadata,
  )
  return {
    status: recent.status === 'available' || matured.status === 'available' ? 'available' : 'blocked',
    evaluation_run_id: artifact.evaluationRunId,
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    note: NOTE,
    recent_scale: recent,
    matured_cut: matured,
  }
}
