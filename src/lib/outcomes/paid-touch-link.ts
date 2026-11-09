import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedOutcome } from './adapter'
import { hashPaidTouchToken, verifyPaidTouchToken } from '@/lib/attribution/paid-touch-contract'
import {
  recordPaidAppointmentEligibilityInput,
  recordPaidAppointmentLinkEvaluation,
} from '@/lib/attribution/paid-eligibility-ledger'

/**
 * Generic paid-touch linking for pushed outcomes (ADR-058: the core, not adapters, owns touch linking).
 * A delivery may carry the signed token /api/attribution/paid-touch gave the website for an ad click.
 *
 *   1. The token is verified with PAID_TOUCH_TOKEN_SECRET, then `link_outcome_paid_touch` links the
 *      outcome to the token's touches. The RPC enforces everything else: the token belongs to this
 *      account and was not expired when the outcome occurred, the touch precedes the outcome, the
 *      origin is the website, and an outcome is linked once (the same token again is a no-op; another
 *      token is refused).
 *   2. Every evaluated delivery records the independent eligibility input and link evaluation, the
 *      linker side of the paid completeness manifest. A delivery without a token counts as NOT linked
 *      (never left out of the denominator), and one with paid-click evidence it cannot link keeps the
 *      linker incomplete.
 *
 * A rejected token never fails the delivery: the outcome is already stored. The reason is recorded in
 * paid_outcome_link_evaluations.reason_code; the sender sees only the status. The token itself is never
 * stored or logged (the link keeps its hash).
 */

const POLICY_VERSION = 1
const TOKEN_SECRET_MIN_BYTES = 32
const PAID_SOCIAL_SOURCES = new Set(['meta', 'facebook', 'instagram'])

export type OutcomePaidTouchStatus = 'linked' | 'absent' | 'rejected' | 'not_configured' | 'error'

export interface OutcomePaidTouchResult {
  status: OutcomePaidTouchStatus
  /** Recorded in the link evaluation; never returned to the sender. */
  reason: string | null
  /** False when the eligibility input or evaluation could not be written (the manifest then shows the gap). */
  recorded: boolean
}

const linkRowSchema = z.object({
  id: z.string().uuid(),
  token_id: z.string().uuid().nullable(),
  last_touch_id: z.string().uuid(),
  last_interaction_at: z.string(),
}).passthrough()

type LinkRow = z.infer<typeof linkRowSchema>

const sha256 = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`

function tokenSecret(env: Record<string, string | undefined>): string | null {
  const secret = env.PAID_TOUCH_TOKEN_SECRET ?? ''
  return Buffer.byteLength(secret, 'utf8') >= TOKEN_SECRET_MIN_BYTES ? secret : null
}

/** An fbclid with paid-social UTMs: evidence of a paid click even without a token. */
function paidClickEvidence(outcome: NormalizedOutcome): boolean {
  const a = outcome.attribution
  return Boolean(a.fbclid && a.utmMedium?.toLowerCase() === 'paid_social'
    && PAID_SOCIAL_SOURCES.has(a.utmSource?.toLowerCase() ?? ''))
}

async function readLink(db: SupabaseClient, adAccountId: string, outcomeId: string): Promise<LinkRow | null> {
  const { data, error } = await db.from('outcome_touch_links')
    .select('id,token_id,last_touch_id,last_interaction_at')
    .eq('ad_account_id', adAccountId).eq('outcome_id', outcomeId).maybeSingle()
  if (error) throw new Error('paid link read failed')
  if (!data) return null
  const parsed = linkRowSchema.safeParse(data)
  if (!parsed.success) throw new Error('paid link read returned invalid data')
  return parsed.data
}

type Decision =
  | { status: 'linked'; link: LinkRow }
  | { status: 'absent' | 'rejected' | 'not_configured' | 'error'; reason: string }

async function decide(
  db: SupabaseClient,
  input: { adAccountId: string; outcomeId: string; token: string | null; secret: string | null },
): Promise<Decision> {
  if (!input.token) {
    // Links are immutable: a later delivery that does not repeat the token (a refund from another
    // system, say) keeps the outcome linked by the token that was verified before.
    const existing = await readLink(db, input.adAccountId, input.outcomeId)
    if (existing) return { status: 'linked', link: existing }
    return input.secret ? { status: 'absent', reason: 'no_paid_evidence' } : { status: 'not_configured', reason: 'linker_not_configured' }
  }
  if (!input.secret) return { status: 'not_configured', reason: 'linker_not_configured' }
  const verified = verifyPaidTouchToken(input.token, input.secret)
  if (!verified.ok) return { status: 'rejected', reason: 'invalid_token' }
  const { error } = await db.rpc('link_outcome_paid_touch', {
    p_ad_account_id: input.adAccountId,
    p_outcome_id: input.outcomeId,
    p_token_id: verified.tokenId,
    p_token_hash: hashPaidTouchToken(input.token),
    p_policy_version: POLICY_VERSION,
  })
  if (error) return { status: 'rejected', reason: 'link_rejected' }
  const link = await readLink(db, input.adAccountId, input.outcomeId)
  if (!link || link.token_id !== verified.tokenId) return { status: 'error', reason: 'invalid_rpc_response' }
  return { status: 'linked', link }
}

/**
 * Link one applied webhook outcome to its paid touch and record the evaluation. Never throws: a
 * failure is a status, and the delivery that stored the outcome stands.
 */
export async function linkOutcomePaidTouch(
  db: SupabaseClient,
  input: { adAccountId: string; outcomeId: string; outcome: NormalizedOutcome; token: string | null },
  env: Record<string, string | undefined> = process.env,
): Promise<OutcomePaidTouchResult> {
  const secret = tokenSecret(env)
  let decision: Decision
  try {
    decision = await decide(db, { adAccountId: input.adAccountId, outcomeId: input.outcomeId, token: input.token, secret })
  } catch {
    decision = { status: 'error', reason: 'link_exception' }
  }
  const paidEvidencePresent = input.token !== null || decision.status === 'linked' || paidClickEvidence(input.outcome)
  // Paid-click evidence without a token cannot be linked here: eligible, evaluated, not linked.
  if (decision.status === 'absent' && paidEvidencePresent) decision = { status: 'absent', reason: 'no_paid_touch_token' }
  const reason = decision.status === 'linked' ? null : decision.reason
  const recorded = await recordEvaluation(db, input, {
    linkerConfigured: secret !== null, paidEvidencePresent, decision,
  }).then(() => true, () => false)
  return { status: decision.status, reason, recorded }
}

async function recordEvaluation(
  db: SupabaseClient,
  input: { adAccountId: string; outcomeId: string; outcome: NormalizedOutcome },
  facts: { linkerConfigured: boolean; paidEvidencePresent: boolean; decision: Decision },
): Promise<void> {
  const link = facts.decision.status === 'linked' ? facts.decision.link : null
  const state = {
    outcomeId: input.outcomeId,
    // As sent and stored: the ledger RPCs compare instants exactly, so no re-rounding to milliseconds.
    outcomeCreatedAt: input.outcome.occurredAt,
    paidEvidencePresent: facts.paidEvidencePresent,
    tokenId: link?.token_id ?? null,
    // The exact decimal string as sent and stored: a JS number would lose digits beyond double precision
    // and fail the ledger RPCs' exact comparison with the stored outcome.
    amountPaid: input.outcome.collectedValue,
    canceled: input.outcome.status === 'cancelled',
  }
  const eligibility = await recordPaidAppointmentEligibilityInput(db, {
    adAccountId: input.adAccountId,
    inputId: randomUUID(),
    inputFingerprint: sha256(JSON.stringify({ ...state, linkerConfigured: facts.linkerConfigured })),
    linkerConfigured: facts.linkerConfigured,
    ...state,
  })
  const evaluation = {
    linkId: link?.id ?? null,
    lastTouchId: link?.last_touch_id ?? null,
    lastInteractionAt: link?.last_interaction_at ?? null,
    status: facts.decision.status,
    reasonCode: facts.decision.status === 'linked' ? null : facts.decision.reason,
  }
  await recordPaidAppointmentLinkEvaluation(db, {
    adAccountId: input.adAccountId,
    evaluationId: randomUUID(),
    evaluationFingerprint: sha256(JSON.stringify({ eligibilityInputId: eligibility.inputId, ...state, ...evaluation })),
    eligibilityInputId: eligibility.inputId,
    ...state,
    ...evaluation,
  })
}
