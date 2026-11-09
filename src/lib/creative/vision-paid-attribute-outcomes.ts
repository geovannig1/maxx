import type {
  PaidCreativeDirection,
  PaidCreativeEvidence,
  PaidCreativeOutcomes,
} from './paid-outcomes'
import {
  VISION_ANALYSIS_PROMPT_VERSION,
  VISION_ANALYSIS_SCHEMA_VERSION,
  type VisionAnalysis,
  type VisionAnalysisIdentity,
} from './vision-analyzer'

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/
const ATTRIBUTE_KEYS = [
  'format',
  'has_text_overlay',
  'shows_price',
  'talent_type',
  'setting',
  'color_mood',
  'cta_visible',
] as const

type VisionAttribute = typeof ATTRIBUTE_KEYS[number]

export interface VersionedVisionObservation {
  id: string
  meta_creative_id: string
  analysis_schema_version: number
  prompt_version: string
  provider: string
  model: string
  source_asset_fingerprint: string
  prompt_fingerprint: string
  analysis_fingerprint: string
  analyzed_at: string
  analysis: VisionAnalysis
}

export interface VisionPaidAttributeGroup {
  attribute: VisionAttribute
  value: string
  creative_count: number
  sparse: boolean
  contributing_meta_creative_ids: string[]
  outcomes: {
    spend: number
    captured_touches: number
    value_bearing_bookings: number
    booked_value: number
  }
  lineage: {
    generation_id: string
    vision_analysis_version_ids: string[]
    source_asset_fingerprints: string[]
  }
}

export interface VisionPaidAttributeDirection {
  status: 'blocked' | 'available'
  generation_id: string
  cohort_kind: 'recent_scale' | 'matured_cut'
  window_start: string
  window_end: string
  as_of_date: string
  contract_version: number
  policy_version: number
  missing_versioned_vision_count: number
  blocker_codes: string[]
  groups: VisionPaidAttributeGroup[]
}

export interface VisionPaidAttributeOutcomes {
  status: 'not_published' | 'blocked' | 'available'
  evaluation_run_id: string | null
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
  non_additive: true
  note: string
  recent_scale: VisionPaidAttributeDirection | null
  matured_cut: VisionPaidAttributeDirection | null
}

interface GroupMember {
  creative: Extract<PaidCreativeEvidence, { status: 'available' }>
  observation: VersionedVisionObservation
}

const NOTE = 'Descriptive, non-additive governed paid-outcome distributions. A creative appears in one group for each attribute, so totals across attributes must not be summed.'

function validAnalysis(value: unknown): value is VisionAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const analysis = value as Record<string, unknown>
  return ['video', 'static', 'carousel'].includes(String(analysis.format))
    && typeof analysis.has_text_overlay === 'boolean'
    && (analysis.hook_text === null || typeof analysis.hook_text === 'string')
    && typeof analysis.shows_price === 'boolean'
    && ['solo', 'group', 'broll', 'none'].includes(String(analysis.talent_type))
    && ['studio', 'outdoor', 'other'].includes(String(analysis.setting))
    && ['bright', 'dark', 'warm', 'neutral'].includes(String(analysis.color_mood))
    && typeof analysis.cta_visible === 'boolean'
    && Number.isInteger(analysis.hook_strength_score)
    && Number(analysis.hook_strength_score) >= 1
    && Number(analysis.hook_strength_score) <= 5
    && (analysis.notes === null || typeof analysis.notes === 'string')
}

function validObservation(
  value: unknown,
  identity: VisionAnalysisIdentity,
): value is VersionedVisionObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const observation = value as Record<string, unknown>
  return typeof observation.id === 'string' && observation.id.length > 0
    && typeof observation.meta_creative_id === 'string'
    && /^\d{1,32}$/.test(observation.meta_creative_id)
    && observation.analysis_schema_version === VISION_ANALYSIS_SCHEMA_VERSION
    && observation.prompt_version === VISION_ANALYSIS_PROMPT_VERSION
    && observation.provider === identity.provider
    && observation.model === identity.model
    && typeof observation.source_asset_fingerprint === 'string'
    && FINGERPRINT_PATTERN.test(observation.source_asset_fingerprint)
    && typeof observation.prompt_fingerprint === 'string'
    && FINGERPRINT_PATTERN.test(observation.prompt_fingerprint)
    && typeof observation.analysis_fingerprint === 'string'
    && FINGERPRINT_PATTERN.test(observation.analysis_fingerprint)
    && typeof observation.analyzed_at === 'string'
    && Number.isFinite(Date.parse(observation.analyzed_at))
    && validAnalysis(observation.analysis)
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function addMoney(values: number[]): number {
  let minorUnits = BigInt(0)
  for (const value of values) {
    const units = Math.round(value * 100)
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(units) || units / 100 !== value) {
      throw new Error('Versioned vision distribution received malformed money evidence.')
    }
    minorUnits += BigInt(units)
    if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Versioned vision distribution money aggregate exceeds the safe range.')
    }
  }
  return Number(minorUnits) / 100
}

function addCounts(values: number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      throw new Error('Versioned vision distribution count aggregate exceeds the safe range.')
    }
    total += value
  }
  return total
}

function attributeValue(analysis: VisionAnalysis, attribute: VisionAttribute): string {
  return String(analysis[attribute])
}

function buildGroups(
  direction: PaidCreativeDirection,
  members: GroupMember[],
): VisionPaidAttributeGroup[] {
  const groups: VisionPaidAttributeGroup[] = []
  for (const attribute of ATTRIBUTE_KEYS) {
    const byValue = new Map<string, GroupMember[]>()
    for (const member of members) {
      const value = attributeValue(member.observation.analysis, attribute)
      byValue.set(value, [...(byValue.get(value) ?? []), member])
    }
    for (const value of [...byValue.keys()].sort((left, right) => left.localeCompare(right))) {
      const grouped = byValue.get(value) ?? []
      const bookings = addCounts(grouped.map(({ creative }) => (
        creative.outcomes.value_bearing_bookings
      )))
      const creativeIds = sortedUnique(grouped.map(({ creative }) => creative.meta_creative_id))
      groups.push({
        attribute,
        value,
        creative_count: creativeIds.length,
        sparse: creativeIds.length < 3 || bookings < 3,
        contributing_meta_creative_ids: creativeIds,
        outcomes: {
          spend: addMoney(grouped.map(({ creative }) => creative.outcomes.spend)),
          captured_touches: addCounts(grouped.map(({ creative }) => creative.outcomes.captured_touches)),
          value_bearing_bookings: bookings,
          booked_value: addMoney(grouped.map(({ creative }) => creative.outcomes.booked_value)),
        },
        lineage: {
          generation_id: direction.generation_id,
          vision_analysis_version_ids: sortedUnique(grouped.map(({ observation }) => observation.id)),
          source_asset_fingerprints: sortedUnique(
            grouped.map(({ observation }) => observation.source_asset_fingerprint),
          ),
        },
      })
    }
  }
  return groups
}

function projectDirection(
  direction: PaidCreativeDirection,
  observations: ReadonlyMap<string, VersionedVisionObservation>,
): VisionPaidAttributeDirection {
  const base = {
    generation_id: direction.generation_id,
    cohort_kind: direction.cohort_kind,
    window_start: direction.window_start,
    window_end: direction.window_end,
    as_of_date: direction.as_of_date,
    contract_version: direction.contract_version,
    policy_version: direction.policy_version,
  }
  if (direction.status === 'blocked') {
    return {
      ...base,
      status: 'blocked',
      missing_versioned_vision_count: 0,
      blocker_codes: sortedUnique(direction.blocker_codes),
      groups: [],
    }
  }

  const members: GroupMember[] = []
  let missing = 0
  for (const creative of direction.creatives) {
    if (creative.status !== 'available') continue
    const observation = observations.get(creative.meta_creative_id)
    if (!observation) {
      missing += 1
      continue
    }
    members.push({ creative, observation })
  }
  const groups = buildGroups(direction, members)
  const blockerCodes = sortedUnique([
    ...direction.blocker_codes,
    ...(missing > 0 ? ['versioned_vision_missing'] : []),
  ])
  return {
    ...base,
    status: groups.length > 0 ? 'available' : 'blocked',
    missing_versioned_vision_count: missing,
    blocker_codes: blockerCodes,
    groups,
  }
}

/**
 * `identity` is the analysis identity the current AI configuration produces. Only observations from
 * that one model are compared; with AI off (null) no observation is admitted.
 */
export function projectVisionPaidAttributeOutcomes(
  paidOutcomes: PaidCreativeOutcomes,
  rawObservations: unknown[],
  identity: VisionAnalysisIdentity | null,
): VisionPaidAttributeOutcomes {
  const common = {
    evaluation_run_id: paidOutcomes.evaluation_run_id,
    action_authority_tier: 'diagnostic_only' as const,
    prescriptions: [] as [],
    non_additive: true as const,
    note: NOTE,
  }
  if (
    paidOutcomes.status === 'not_published'
    || !paidOutcomes.recent_scale
    || !paidOutcomes.matured_cut
  ) {
    return {
      ...common,
      status: 'not_published',
      evaluation_run_id: null,
      recent_scale: null,
      matured_cut: null,
    }
  }

  const observations = new Map<string, VersionedVisionObservation>()
  const valid = rawObservations.filter((value): value is VersionedVisionObservation => (
    identity !== null && validObservation(value, identity)
  )).sort((left, right) => (
    right.analyzed_at.localeCompare(left.analyzed_at) || right.id.localeCompare(left.id)
  ))
  for (const observation of valid) {
    if (!observations.has(observation.meta_creative_id)) {
      observations.set(observation.meta_creative_id, observation)
    }
  }
  const recent = projectDirection(paidOutcomes.recent_scale, observations)
  const matured = projectDirection(paidOutcomes.matured_cut, observations)
  return {
    ...common,
    status: recent.status === 'available' || matured.status === 'available' ? 'available' : 'blocked',
    recent_scale: recent,
    matured_cut: matured,
  }
}
