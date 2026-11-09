import 'server-only'
import { z } from 'zod'
import {
  AiDisabledError, AiError, AiRefusalError, aiStatus, generateStructured,
} from '@/lib/ai'
import { copyBriefSchema, type CopyBrief, type CopyBriefInput } from './copy-brief'
import { loadCopyContext, type CopyContext } from './copy-context'
import { buildCopySystemPrompt, buildCopyUserPrompt, copyOutputFormat } from './copy-prompt'
import { COPY_ANGLES, type CopyAngle } from './copy-rules'
import { comparable, NEAR_DUPLICATE_AT, scoreCopySet, withFindings, type CopyFinding, type CopyScore } from './copy-scorer'
import { similarity } from './copy-text'

// Copy generation: one structured-output call through the AI gateway, then deterministic checks the
// model cannot talk its way past. The model's JSON is untrusted: each variant is validated on its own,
// angles and near-duplicates are enforced (Meta's delivery system groups near-identical ads), and every
// kept variant is scored. A variant with an unverified claim or a policy risk is returned BLOCKED, with
// the reason, and the bank refuses to save it. With AI off nothing is loaded and nothing is sent.

export const COPY_GENERATION_TIMEOUT_MS = 100_000
const COPY_GENERATION_MAX_TOKENS = 8_000
export const AI_OFF_MESSAGE = 'AI is off. Connect a provider in Settings to generate copy. Scoring still works on pasted or existing copy.'
export const AI_MISCONFIGURED_MESSAGE = 'The AI provider is not configured correctly, so copy generation is off. Run npm run doctor to see which setting to fix. Scoring still works.'

const modelVariantSchema = z.object({
  hook: z.string().trim().min(1).max(400),
  primary_text: z.string().trim().min(1).max(3000),
  headline: z.string().trim().min(1).max(400),
  description: z.string().trim().max(400),
  cta: z.string().trim().min(1).max(40),
  angle: z.enum(COPY_ANGLES),
  rationale: z.string().trim().max(800),
  unverified_claims: z.array(z.string().trim().max(200)).max(10).default([]),
})
type ModelVariant = z.infer<typeof modelVariantSchema>

export interface GeneratedCopyVariant {
  hook: string
  primary_text: string
  headline: string
  description: string
  cta: string
  angle: CopyAngle
  rationale: string
  score: CopyScore
  /** ready: publishable and scores well; review: publishable with fixes; blocked: must not run as written. */
  status: 'ready' | 'review' | 'blocked'
}

export interface RejectedCopyVariant {
  reason: 'invalid_shape' | 'angle_repeated' | 'near_duplicate' | 'social_proof_unverified' | 'over_count'
  detail: string
  hook: string | null
}

export interface CopyGrounding {
  verified_facts: number
  unverified_claims_listed: number
  proven_copy: number
  proven_copy_status: CopyContext['provenCopyStatus']
  hook_patterns: number
  social_proof_allowed: boolean
}

export type GenerateCopyResult =
  | { status: 'ok'; variants: GeneratedCopyVariant[]; rejected: RejectedCopyVariant[]; grounding: CopyGrounding; model: { provider: string; model: string } }
  | { status: 'ai_off' | 'ai_misconfigured' | 'refused' | 'failed' | 'invalid_input'; code: string; message: string }

function failure(error: unknown): GenerateCopyResult {
  if (error instanceof AiDisabledError) {
    return error.reason === 'off'
      ? { status: 'ai_off', code: 'AI_OFF', message: AI_OFF_MESSAGE }
      : { status: 'ai_misconfigured', code: 'AI_MISCONFIGURED', message: AI_MISCONFIGURED_MESSAGE }
  }
  if (error instanceof AiRefusalError) return { status: 'refused', code: 'AI_REFUSED', message: 'The model declined this brief. Rephrase the product or offer and try again.' }
  if (error instanceof AiError) {
    const timeout = error.code === 'timeout'
    return { status: 'failed', code: `AI_${error.code.toUpperCase()}`, message: timeout ? 'The AI provider did not answer in time. Try again.' : 'The model did not return usable copy. Try again.' }
  }
  throw error
}

/** Validate, de-duplicate and diversify the model's variants. PURE over its inputs. */
export function screenVariants(raw: unknown, brief: CopyBrief, context: CopyContext): { kept: ModelVariant[]; rejected: RejectedCopyVariant[] } {
  const items = Array.isArray((raw as { variants?: unknown })?.variants) ? (raw as { variants: unknown[] }).variants : []
  const kept: ModelVariant[] = []
  const rejected: RejectedCopyVariant[] = []
  const hookOf = (item: unknown) => (typeof (item as { hook?: unknown })?.hook === 'string' ? (item as { hook: string }).hook : null)
  for (const item of items) {
    const parsed = modelVariantSchema.safeParse(item)
    if (!parsed.success) {
      rejected.push({ reason: 'invalid_shape', detail: `Missing or invalid: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'variant'))].join(', ')}.`, hook: hookOf(item) })
      continue
    }
    const v = parsed.data
    if (kept.length >= brief.variants) { rejected.push({ reason: 'over_count', detail: 'More variants than requested.', hook: v.hook }); continue }
    if (v.angle === 'social_proof' && !context.socialProofVerified) {
      rejected.push({ reason: 'social_proof_unverified', detail: 'Social proof needs a verified review, rating or client fact in the business profile.', hook: v.hook }); continue
    }
    if (brief.angle && v.angle !== brief.angle) { rejected.push({ reason: 'angle_repeated', detail: `Asked for ${brief.angle}, got ${v.angle}.`, hook: v.hook }); continue }
    if (!brief.angle && kept.some((k) => k.angle === v.angle)) { rejected.push({ reason: 'angle_repeated', detail: `A variant already uses the ${v.angle} angle.`, hook: v.hook }); continue }
    const text = comparable(v)
    const twin = [...kept.map(comparable), ...brief.avoid].map((other) => similarity(text, other)).find((sim) => sim >= NEAR_DUPLICATE_AT)
    if (twin !== undefined) { rejected.push({ reason: 'near_duplicate', detail: `${Math.round(twin * 100)}% the same wording as another variant; Meta would group them.`, hook: v.hook }); continue }
    kept.push(v)
  }
  return { kept, rejected }
}

function finalize(kept: ModelVariant[], brief: CopyBrief, context: CopyContext): GeneratedCopyVariant[] {
  const scored = scoreCopySet(kept, { facts: context.facts, goal: brief.goal })
  return kept.map((v, i) => {
    const admitted: CopyFinding[] = v.unverified_claims.filter(Boolean).map((claim) => ({
      rule: 'unverified_claim', severity: 'blocker', field: 'variant',
      message: `The model reported an unverified claim: "${claim}".`, fix: 'Remove it, or verify it and add it to the business profile.',
    }))
    const score = withFindings(scored.variants[i], admitted)
    const status = !score.publishable ? 'blocked' : score.score >= 70 ? 'ready' : 'review'
    return { hook: v.hook, primary_text: v.primary_text, headline: v.headline, description: v.description, cta: v.cta, angle: v.angle, rationale: v.rationale, score, status }
  })
}

/** Generate scored Meta ad copy for a brief. Never throws for AI outcomes; returns a typed status. */
export async function generateCopy(input: CopyBriefInput): Promise<GenerateCopyResult> {
  const parsedBrief = copyBriefSchema.safeParse(input)
  if (!parsedBrief.success) return { status: 'invalid_input', code: 'INVALID_BRIEF', message: 'The brief is incomplete or too long.' }
  const brief = parsedBrief.data
  const ai = aiStatus()
  if (ai.state === 'off') return { status: 'ai_off', code: 'AI_OFF', message: AI_OFF_MESSAGE }
  if (ai.state === 'misconfigured') return { status: 'ai_misconfigured', code: 'AI_MISCONFIGURED', message: AI_MISCONFIGURED_MESSAGE }

  const context = await loadCopyContext()
  let answer: Awaited<ReturnType<typeof generateStructured>>
  try {
    answer = await generateStructured({
      feature: 'copy_generation',
      system: buildCopySystemPrompt(context),
      user: buildCopyUserPrompt(brief, context),
      format: copyOutputFormat(context, brief),
      maxTokens: COPY_GENERATION_MAX_TOKENS,
      timeoutMs: COPY_GENERATION_TIMEOUT_MS,
      effort: 'medium',
    })
  } catch (error) {
    return failure(error)
  }
  const { kept, rejected } = screenVariants(answer.value, brief, context)
  if (kept.length === 0) return { status: 'failed', code: 'AI_INVALID_OUTPUT', message: 'The model did not return usable copy. Try again.' }
  return {
    status: 'ok',
    variants: finalize(kept, brief, context),
    rejected,
    grounding: {
      verified_facts: context.facts.statements.length,
      unverified_claims_listed: context.facts.unverified.length,
      proven_copy: context.provenCopy.length,
      proven_copy_status: context.provenCopyStatus,
      hook_patterns: context.hookPatterns,
      social_proof_allowed: context.socialProofVerified,
    },
    model: { provider: answer.provider, model: answer.model },
  }
}
