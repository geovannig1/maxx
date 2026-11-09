import { z } from 'zod'
import type { PaidCreativeOutcomes } from '@/lib/creative/paid-outcomes'

const META_ID_PATTERN = /^\d{1,32}$/
const BLOCKER_PATTERN = /^[a-z][a-z0-9_]{0,127}$/
const MAX_SOURCE_ROWS = 100_000
const MAX_ASSIGNMENT_LINEAGE_ROWS = MAX_SOURCE_ROWS * 2

const emptyArraySchema = z.array(z.never()).length(0)
const uuidSchema = z.string().uuid()
const metaIdSchema = z.string().regex(META_ID_PATTERN)
const blockerCodesSchema = z.array(z.string().regex(BLOCKER_PATTERN)).max(MAX_SOURCE_ROWS)
  .refine((values) => new Set(values).size === values.length)
const nonEmptyBlockerCodesSchema = z.array(z.string().regex(BLOCKER_PATTERN)).min(1).max(MAX_SOURCE_ROWS)
  .refine((values) => new Set(values).size === values.length)
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const moneySchema = z.number().finite().nonnegative().refine((value) => {
  const minorUnits = Math.round(value * 100)
  return Number.isSafeInteger(minorUnits) && minorUnits / 100 === value
})
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const instant = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(instant.valueOf()) && instant.toISOString().slice(0, 10) === value
})

const outcomesSchema = z.object({
  spend: moneySchema,
  landing_page_views: countSchema,
  captured_touches: countSchema,
  value_bearing_bookings: countSchema,
  booked_value: moneySchema,
  zero_value_bookings: countSchema,
  canceled_links: countSchema,
}).strict()

const evidenceBase = {
  evaluation_run_id: uuidSchema,
  generation_id: uuidSchema,
  meta_creative_id: metaIdSchema,
  creative_name: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
  contributing_meta_ad_ids: z.array(metaIdSchema).min(1).max(MAX_SOURCE_ROWS)
    .refine((values) => new Set(values).size === values.length),
  assignment_observation_ids: z.array(uuidSchema).min(1).max(MAX_ASSIGNMENT_LINEAGE_ROWS)
    .refine((values) => new Set(values).size === values.length),
  action_authority_tier: z.literal('diagnostic_only'),
  prescriptions: emptyArraySchema,
}

const evidenceSchema = z.discriminatedUnion('status', [
  z.object({
    ...evidenceBase,
    status: z.literal('available'),
    complete: z.literal(true),
    blocker_codes: emptyArraySchema,
    outcomes: outcomesSchema,
  }).strict(),
  z.object({
    ...evidenceBase,
    status: z.literal('blocked'),
    complete: z.literal(false),
    blocker_codes: nonEmptyBlockerCodesSchema,
    outcomes: z.null(),
  }).strict(),
])

function directionSchema(cohortKind: 'recent_scale' | 'matured_cut') {
  return z.object({
    status: z.enum(['blocked', 'available']),
    generation_id: uuidSchema,
    cohort_kind: z.literal(cohortKind),
    window_start: dateSchema,
    window_end: dateSchema,
    as_of_date: dateSchema,
    contract_version: countSchema.min(1),
    policy_version: countSchema.min(1),
    blocker_codes: blockerCodesSchema,
    action_authority_tier: z.literal('diagnostic_only'),
    prescriptions: emptyArraySchema,
    creatives: z.array(evidenceSchema).max(MAX_SOURCE_ROWS),
  }).strict().superRefine((direction, context) => {
    if (direction.window_start > direction.window_end || direction.window_end > direction.as_of_date) {
      context.addIssue({ code: 'custom', message: 'Paid cohort window is incoherent.' })
    }
    const availableCount = direction.creatives.filter((creative) => creative.status === 'available').length
    if ((direction.status === 'available') !== (availableCount > 0)) {
      context.addIssue({ code: 'custom', message: 'Paid direction status is incoherent.' })
    }
    const creativeIds = direction.creatives.map((creative) => creative.meta_creative_id)
    const contributingAdIds = direction.creatives.flatMap(
      (creative) => creative.contributing_meta_ad_ids,
    )
    const observationIds = direction.creatives.flatMap(
      (creative) => creative.assignment_observation_ids,
    )
    if (
      new Set(creativeIds).size !== creativeIds.length
      || new Set(contributingAdIds).size !== contributingAdIds.length
      || new Set(observationIds).size !== observationIds.length
    ) {
      context.addIssue({ code: 'custom', message: 'Paid direction lineage contains duplicates.' })
    }
    for (const creative of direction.creatives) {
      if (creative.generation_id !== direction.generation_id) {
        context.addIssue({ code: 'custom', message: 'Creative generation lineage is incoherent.' })
      }
    }
  })
}

const paidOutcomesSchema = z.object({
  status: z.enum(['not_published', 'blocked', 'available']),
  evaluation_run_id: uuidSchema.nullable(),
  action_authority_tier: z.literal('diagnostic_only'),
  prescriptions: emptyArraySchema,
  note: z.string().min(1).max(2000)
    .refine((value) => value.includes('associated via governed last-paid-touch'))
    .refine((value) => value.includes('booked value'))
    .refine((value) => !/\b(?:revenue|causal|causality|caused|winner|loser|ranking|ranked|scale|cut|pause|production direction|action direction|cash|cpa|roas|fatigue)\b/i.test(value)),
  recent_scale: directionSchema('recent_scale').nullable(),
  matured_cut: directionSchema('matured_cut').nullable(),
}).strict().superRefine((outcomes, context) => {
  if (outcomes.status === 'not_published') {
    if (
      outcomes.evaluation_run_id !== null
      || outcomes.recent_scale !== null
      || outcomes.matured_cut !== null
    ) {
      context.addIssue({ code: 'custom', message: 'Not-published paid outcomes cannot carry lineage.' })
    }
    return
  }

  if (!outcomes.evaluation_run_id || !outcomes.recent_scale || !outcomes.matured_cut) {
    context.addIssue({ code: 'custom', message: 'Published paid outcomes require complete lineage.' })
    return
  }
  const directions = [outcomes.recent_scale, outcomes.matured_cut]
  const hasAvailable = directions.some((direction) => direction.status === 'available')
  if ((outcomes.status === 'available') !== hasAvailable) {
    context.addIssue({ code: 'custom', message: 'Paid outcome status is incoherent.' })
  }
  if (
    outcomes.recent_scale.as_of_date !== outcomes.matured_cut.as_of_date
    || outcomes.recent_scale.contract_version !== outcomes.matured_cut.contract_version
    || outcomes.recent_scale.policy_version !== outcomes.matured_cut.policy_version
    || outcomes.recent_scale.generation_id === outcomes.matured_cut.generation_id
  ) {
    context.addIssue({ code: 'custom', message: 'Paid direction lineage is incoherent.' })
  }
  for (const direction of directions) {
    for (const creative of direction.creatives) {
      if (creative.evaluation_run_id !== outcomes.evaluation_run_id) {
        context.addIssue({ code: 'custom', message: 'Creative evaluation lineage is incoherent.' })
      }
      if (
        creative.assignment_observation_ids.length
        !== creative.contributing_meta_ad_ids.length * 2
      ) {
        context.addIssue({ code: 'custom', message: 'Creative assignment lineage is incomplete.' })
      }
    }
  }
})

const paidSectionSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), data: paidOutcomesSchema }).strict(),
  z.object({ available: z.literal(false), reason: z.string() }).strict(),
])

export const LEGACY_PAID_CREATIVE_SECTION = {
  available: false,
  reason: 'not_captured_in_legacy_snapshot',
} as const

export function normalizeAbsentPaidCreativeSection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (Object.hasOwn(value, 'creative_paid_outcomes')) return value
  return { ...value, creative_paid_outcomes: LEGACY_PAID_CREATIVE_SECTION }
}

export function isPaidCreativeOutcomesSection(
  value: unknown,
): value is { available: true; data: PaidCreativeOutcomes } | { available: false; reason: string } {
  return paidSectionSchema.safeParse(value).success
}
