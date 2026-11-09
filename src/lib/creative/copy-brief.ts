// The Copy studio's input contracts, shared by the API routes, the server functions and the form.
// Client-safe. Every string is bounded so a request can never carry an unbounded prompt.

import { z } from 'zod'
import { AUDIENCE_TEMPERATURES, COPY_ANGLES, COPY_GOALS, COPY_PLACEMENTS } from './copy-rules'

export const MAX_VARIANTS = 6
export const BRIEF_LIMITS = { product: 200, offer: 300, audience: 300, tone: 80, constraints: 500, avoid: 400, avoidItems: 6 } as const

const text = (max: number) => z.string().trim().max(max)

export const copyBriefSchema = z.object({
  goal: z.enum(COPY_GOALS),
  product: z.string().trim().min(2).max(BRIEF_LIMITS.product),
  offer: text(BRIEF_LIMITS.offer).default(''),
  audience: z.object({
    temperature: z.enum(AUDIENCE_TEMPERATURES),
    description: text(BRIEF_LIMITS.audience).default(''),
  }).strict(),
  tone: text(BRIEF_LIMITS.tone).default(''),
  constraints: text(BRIEF_LIMITS.constraints).default(''),
  variants: z.number().int().min(1).max(MAX_VARIANTS).default(4),
  placements: z.array(z.enum(COPY_PLACEMENTS)).min(1).max(COPY_PLACEMENTS.length).default(['feed']),
  /** Regenerate on one angle: every returned variant uses it. */
  angle: z.enum(COPY_ANGLES).optional(),
  /** Copy the new variants must not repeat (e.g. the variant being regenerated). */
  avoid: z.array(z.string().trim().min(1).max(BRIEF_LIMITS.avoid)).max(BRIEF_LIMITS.avoidItems).default([]),
}).strict()

export type CopyBrief = z.infer<typeof copyBriefSchema>
export type CopyBriefInput = z.input<typeof copyBriefSchema>

const field = (max: number) => z.string().trim().max(max).nullable().optional()

/** One variant as submitted for scoring or saving. Bounded above Meta's hard caps so over-long copy is scored, not refused. */
export const copyVariantSchema = z.object({
  hook: field(400),
  primary_text: field(3000),
  headline: field(400),
  description: field(400),
  cta: z.string().trim().max(40).nullable().optional(),
  angle: z.enum(COPY_ANGLES).nullable().optional(),
}).strict()

export type CopyVariantPayload = z.infer<typeof copyVariantSchema>

export const MAX_SCORE_ITEMS = 12

export const scoreRequestSchema = z.union([
  z.object({ text: z.string().trim().min(1).max(3000), goal: z.enum(COPY_GOALS).optional() }).strict(),
  z.object({ variants: z.array(copyVariantSchema).min(1).max(MAX_SCORE_ITEMS), goal: z.enum(COPY_GOALS).optional() }).strict(),
])

export const saveRequestSchema = z.object({
  variant: copyVariantSchema.extend({ angle: z.enum(COPY_ANGLES) }),
  goal: z.enum(COPY_GOALS),
  temperature: z.enum(AUDIENCE_TEMPERATURES),
}).strict()

export type SaveCopyRequest = z.infer<typeof saveRequestSchema>
