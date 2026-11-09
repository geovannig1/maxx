import { z } from 'zod'

import type { VisionPaidAttributeOutcomes } from '@/lib/creative/vision-paid-attribute-outcomes'

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const META_ID_PATTERN = /^\d{1,32}$/
const BLOCKER_PATTERN = /^[a-z][a-z0-9_]{0,127}$/
const emptyArraySchema = z.array(z.never()).length(0)
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const moneySchema = z.number().finite().nonnegative().refine((value) => {
  const minorUnits = Math.round(value * 100)
  return Number.isSafeInteger(minorUnits) && minorUnits / 100 === value
})
const uniqueStrings = <T extends z.ZodTypeAny>(item: T, maximum = 100_000) => (
  z.array(item).max(maximum).refine((values) => new Set(values).size === values.length)
)

const groupSchema = z.object({
  attribute: z.enum([
    'format', 'has_text_overlay', 'shows_price', 'talent_type',
    'setting', 'color_mood', 'cta_visible',
  ]),
  value: z.string().min(1).max(64),
  creative_count: countSchema.min(1),
  sparse: z.boolean(),
  contributing_meta_creative_ids: uniqueStrings(z.string().regex(META_ID_PATTERN)).min(1),
  outcomes: z.object({
    spend: moneySchema,
    captured_touches: countSchema,
    value_bearing_bookings: countSchema,
    booked_value: moneySchema,
  }).strict(),
  lineage: z.object({
    generation_id: z.string().uuid(),
    vision_analysis_version_ids: uniqueStrings(z.string().uuid()).min(1),
    source_asset_fingerprints: uniqueStrings(z.string().regex(HASH_PATTERN)).min(1),
  }).strict(),
}).strict().superRefine((group, context) => {
  if (group.creative_count !== group.contributing_meta_creative_ids.length) {
    context.addIssue({ code: 'custom', message: 'Attribute group creative count is incoherent.' })
  }
})

function directionSchema(kind: 'recent_scale' | 'matured_cut') {
  return z.object({
    status: z.enum(['blocked', 'available']),
    generation_id: z.string().uuid(),
    cohort_kind: z.literal(kind),
    window_start: z.string().date(),
    window_end: z.string().date(),
    as_of_date: z.string().date(),
    contract_version: countSchema.min(1),
    policy_version: countSchema.min(1),
    missing_versioned_vision_count: countSchema,
    blocker_codes: uniqueStrings(z.string().regex(BLOCKER_PATTERN)),
    groups: z.array(groupSchema).max(700_000),
  }).strict().superRefine((direction, context) => {
    if (direction.window_start > direction.window_end || direction.window_end > direction.as_of_date) {
      context.addIssue({ code: 'custom', message: 'Attribute distribution window is incoherent.' })
    }
    if ((direction.status === 'available') !== (direction.groups.length > 0)) {
      context.addIssue({ code: 'custom', message: 'Attribute distribution status is incoherent.' })
    }
    for (const group of direction.groups) {
      if (group.lineage.generation_id !== direction.generation_id) {
        context.addIssue({ code: 'custom', message: 'Attribute distribution lineage is incoherent.' })
      }
    }
  })
}

const outcomeSchema = z.object({
  status: z.enum(['not_published', 'blocked', 'available']),
  evaluation_run_id: z.string().uuid().nullable(),
  action_authority_tier: z.literal('diagnostic_only'),
  prescriptions: emptyArraySchema,
  non_additive: z.literal(true),
  note: z.string().min(1).max(2_000)
    .refine((value) => /non-additive/i.test(value))
    .refine((value) => !/\b(?:cpa|roas|causal|caused|ranking|ranked|winner|loser|budget|scale|cut|pause)\b/i.test(value)),
  recent_scale: directionSchema('recent_scale').nullable(),
  matured_cut: directionSchema('matured_cut').nullable(),
}).strict().superRefine((outcomes, context) => {
  if (outcomes.status === 'not_published') {
    if (outcomes.evaluation_run_id || outcomes.recent_scale || outcomes.matured_cut) {
      context.addIssue({ code: 'custom', message: 'Unpublished attribute evidence cannot carry lineage.' })
    }
    return
  }
  if (!outcomes.evaluation_run_id || !outcomes.recent_scale || !outcomes.matured_cut) {
    context.addIssue({ code: 'custom', message: 'Published attribute evidence requires lineage.' })
    return
  }
  const available = outcomes.recent_scale.status === 'available'
    || outcomes.matured_cut.status === 'available'
  if ((outcomes.status === 'available') !== available) {
    context.addIssue({ code: 'custom', message: 'Attribute evidence status is incoherent.' })
  }
})

const sectionSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), data: outcomeSchema }).strict(),
  z.object({ available: z.literal(false), reason: z.string() }).strict(),
])

export const LEGACY_PAID_ATTRIBUTE_SECTION = {
  available: false,
  reason: 'not_captured_in_legacy_snapshot',
} as const

export function normalizeAbsentPaidAttributeSection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (Object.hasOwn(value, 'creative_paid_attribute_distributions')) return value
  return {
    ...value,
    creative_paid_attribute_distributions: LEGACY_PAID_ATTRIBUTE_SECTION,
  }
}

export function isPaidAttributeDistributionSection(
  value: unknown,
): value is
  | { available: true; data: VisionPaidAttributeOutcomes }
  | { available: false; reason: string } {
  return sectionSchema.safeParse(value).success
}
