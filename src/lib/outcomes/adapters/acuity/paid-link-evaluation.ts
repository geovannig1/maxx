import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { getAdminClient } from '@/lib/supabase/admin'
import type { AcuityAppointmentRaw } from '@/lib/outcomes/adapters/acuity/client'
import {
  extractPaidTouchToken,
  type AcuityPaidTouchLinkWithFallbackOutcome,
} from '@/lib/outcomes/adapters/acuity/paid-touch-link'
import { extractAttribution, parseMoney } from '@/lib/outcomes/adapters/acuity/ledger'
import { findAcuityOutcomeId } from '@/lib/outcomes/adapters/acuity/outcome-source'
import { verifyPaidTouchToken } from '@/lib/attribution/paid-touch-contract'
import {
  recordPaidAppointmentEligibilityInput,
  recordPaidAppointmentLinkEvaluation,
} from '@/lib/attribution/paid-eligibility-ledger'

const linkRowSchema = z.object({
  id: z.string().uuid(),
  token_id: z.string().uuid().nullable(),
  last_touch_id: z.string().uuid(),
  last_interaction_at: z.string().datetime({ offset: true }),
}).strict()

/** Acuity emits numeric offsets without a colon (for example `-0500`). Canonicalize the
 * signed external timestamp once so fingerprints, RPCs, and equality checks share one instant. */
function canonicalAcuityInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  if (!z.string().datetime({ offset: true }).safeParse(normalized).success) return null
  const timestamp = new Date(normalized)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null
}

function paidSocialEvidence(appointment: AcuityAppointmentRaw): boolean {
  const attribution = extractAttribution(appointment.forms)
  return Boolean(
    attribution.fbclid
    && attribution.utm_medium?.toLowerCase() === 'paid_social'
    && ['meta', 'facebook', 'instagram'].includes(attribution.utm_source?.toLowerCase() ?? ''),
  )
}

export interface SignedAcuityEligibilityInput {
  inputId: string
  /** The outcome uuid the input was recorded against (the outcome-source appointment's `outcomes` row). */
  outcomeId: string
  appointmentId: number
  appointmentCreatedAt: string
  paidEvidencePresent: boolean
  tokenId: string | null
  amountPaid: number | null
  canceled: boolean
}

function appointmentFacts(
  appointment: AcuityAppointmentRaw,
  config: { fieldId: number; tokenSecret: string } | null,
) {
  const appointmentId = Number(appointment.id)
  const appointmentCreatedAt = canonicalAcuityInstant(appointment.datetimeCreated)
  if (!Number.isSafeInteger(appointmentId) || appointmentId <= 0
      || appointmentCreatedAt === null) {
    throw new Error('Signed Acuity link evaluation has an invalid appointment identity.')
  }
  const token = config ? extractPaidTouchToken(appointment.forms, config.fieldId) : null
  const verifiedToken = token?.ok && token.token
    ? verifyPaidTouchToken(token.token, config!.tokenSecret)
    : null
  return {
    appointmentId,
    appointmentCreatedAt,
    paidEvidencePresent: Boolean(token?.ok && token.token) || paidSocialEvidence(appointment),
    tokenId: verifiedToken?.ok ? verifiedToken.tokenId : null,
    amountPaid: parseMoney(appointment.amountPaid),
    canceled: appointment.canceled === true,
  }
}

/** Independent signed-webhook input. This must commit before any linker is called. */
export async function recordSignedAcuityEligibilityInput(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  appointment: AcuityAppointmentRaw,
  config: { fieldId: number; tokenSecret: string } | null,
): Promise<SignedAcuityEligibilityInput> {
  const facts = appointmentFacts(appointment, config)
  // The fingerprint hashes the appointment-shaped facts exactly as before the generic outcomes model.
  const canonical = JSON.stringify({ ...facts, linkerConfigured: config !== null })
  const outcomeId = await findAcuityOutcomeId(db, facts.appointmentId, adAccountId)
  if (!outcomeId) {
    throw new Error('Signed Acuity eligibility input has no recorded outcome for the appointment.')
  }
  const stored = await recordPaidAppointmentEligibilityInput(db, {
    adAccountId,
    inputId: randomUUID(),
    inputFingerprint: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
    outcomeId,
    outcomeCreatedAt: facts.appointmentCreatedAt,
    linkerConfigured: config !== null,
    paidEvidencePresent: facts.paidEvidencePresent,
    tokenId: facts.tokenId,
    amountPaid: facts.amountPaid,
    canceled: facts.canceled,
  })
  return { inputId: stored.inputId, outcomeId, ...facts }
}

export async function recordSignedAcuityLinkEvaluation(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  appointment: AcuityAppointmentRaw,
  outcome: AcuityPaidTouchLinkWithFallbackOutcome
    | { status: 'not_configured' }
    | { status: 'error'; reason: 'link_exception' },
  config: { fieldId: number; tokenSecret: string } | null,
  eligibility: SignedAcuityEligibilityInput,
): Promise<void> {
  const facts = appointmentFacts(appointment, config)
  if (facts.appointmentId !== eligibility.appointmentId
      || facts.appointmentCreatedAt !== eligibility.appointmentCreatedAt
      || facts.paidEvidencePresent !== eligibility.paidEvidencePresent
      || facts.tokenId !== eligibility.tokenId
      || facts.amountPaid !== eligibility.amountPaid
      || facts.canceled !== eligibility.canceled) {
    throw new Error('Signed Acuity eligibility input no longer matches the evaluated appointment.')
  }
  const { appointmentId, appointmentCreatedAt, paidEvidencePresent, amountPaid, canceled } = facts
  let tokenId = eligibility.tokenId
  let linkId: string | null = null
  let lastTouchId: string | null = null
  let lastInteractionAt: string | null = null
  if (outcome.status === 'linked') {
    const { data, error } = await db.from('outcome_touch_links')
      .select('id,token_id,last_touch_id,last_interaction_at')
      .eq('ad_account_id', adAccountId)
      .eq('outcome_id', eligibility.outcomeId)
      .maybeSingle()
    if (error) throw new Error(`Paid link lineage read failed: ${error.message}`)
    const parsed = linkRowSchema.safeParse(data)
    if (!parsed.success) throw new Error('Paid link lineage read returned invalid data.')
    linkId = parsed.data.id
    tokenId = parsed.data.token_id
    lastTouchId = parsed.data.last_touch_id
    lastInteractionAt = parsed.data.last_interaction_at
  }

  const status = outcome.status
  const reasonCode = status === 'linked'
    ? null
    : status === 'absent' ? 'no_paid_evidence'
      : status === 'not_configured' ? 'linker_not_configured'
        : outcome.reason
  const canonical = JSON.stringify({
    eligibilityInputId: eligibility.inputId,
    appointmentId,
    appointmentCreatedAt,
    paidEvidencePresent,
    tokenId,
    linkId,
    lastTouchId,
    lastInteractionAt,
    status,
    reasonCode,
    amountPaid,
    canceled,
  })
  await recordPaidAppointmentLinkEvaluation(db, {
    adAccountId,
    evaluationId: randomUUID(),
    evaluationFingerprint: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
    eligibilityInputId: eligibility.inputId,
    outcomeId: eligibility.outcomeId,
    outcomeCreatedAt: appointmentCreatedAt,
    paidEvidencePresent,
    tokenId,
    linkId,
    lastTouchId,
    lastInteractionAt,
    status,
    reasonCode,
    amountPaid,
    canceled,
  })
}
