import 'server-only'
import { z } from 'zod'
import type { getAdminClient } from '@/lib/supabase/admin'
import { hashPaidTouchToken, verifyPaidTouchToken } from '@/lib/attribution/paid-touch-contract'
import { extractAttribution } from './ledger'
import { findAcuityOutcomeId } from './outcome-source'
import type { AcuityAppointmentRaw, AcuityForm } from './client'

const PAID_TOUCH_POLICY_VERSION = 1

const linkResultSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  outcome_id: z.string().uuid(),
  token_id: z.string().uuid().nullable(),
  first_touch_id: z.string().uuid(),
  last_touch_id: z.string().uuid(),
  first_interaction_at: z.string().datetime({ offset: true }),
  last_interaction_at: z.string().datetime({ offset: true }),
  outcome_created_at: z.string().datetime({ offset: true }),
  last_fbclid: z.string().min(1).max(1024).nullable(),
  policy_version: z.literal(PAID_TOUCH_POLICY_VERSION),
  linked_at: z.string().datetime({ offset: true }),
}).strict()

/** The outcome uuid recorded for this Acuity appointment under the account, or null when none is
 *  recorded or the lookup failed — both are a link rejection, exactly as the RPC rejected a missing
 *  appointment before the generic outcomes model. */
async function resolveOutcomeId(
  db: ReturnType<typeof getAdminClient>,
  appointmentId: number,
  adAccountId: string,
): Promise<string | null> {
  try {
    return await findAcuityOutcomeId(db, appointmentId, adAccountId)
  } catch {
    return null
  }
}

export type PaidTouchTokenExtraction =
  | { ok: true; token: string | null }
  | { ok: false; reason: 'invalid_field_id' | 'invalid_value' | 'ambiguous' }

export interface LinkedPaidTouchForCapi {
  fbclid: string
  observedAt: string
}

export type AcuityPaidTouchLinkOutcome =
  | { status: 'absent' }
  | { status: 'linked'; paidTouch: LinkedPaidTouchForCapi | null }
  | { status: 'rejected'; reason: 'ambiguous_field' | 'invalid_token' | 'invalid_appointment_id' | 'link_rejected' }
  | { status: 'error'; reason: 'invalid_rpc_response' }

export function extractPaidTouchToken(
  forms: AcuityForm[] | null | undefined,
  fieldId: number,
): PaidTouchTokenExtraction {
  if (!Number.isSafeInteger(fieldId) || fieldId <= 0) {
    return { ok: false, reason: 'invalid_field_id' }
  }
  if (!Array.isArray(forms)) return { ok: true, token: null }

  const values = new Set<string>()
  for (const form of forms) {
    if (!Array.isArray(form.values)) continue
    for (const value of form.values) {
      if (value.fieldID !== fieldId) continue
      const token = typeof value.value === 'string' ? value.value.trim() : ''
      if (!token) continue
      if (token.length > 512) return { ok: false, reason: 'invalid_value' }
      values.add(token)
    }
  }
  if (values.size === 0) return { ok: true, token: null }
  if (values.size !== 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, token: [...values][0] }
}

export async function linkAcuityPaidTouch(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  appointment: AcuityAppointmentRaw,
  config: { fieldId: number; tokenSecret: string },
): Promise<AcuityPaidTouchLinkOutcome> {
  const extracted = extractPaidTouchToken(appointment.forms, config.fieldId)
  if (!extracted.ok) return { status: 'rejected', reason: 'ambiguous_field' }
  if (!extracted.token) return { status: 'absent' }

  const verified = verifyPaidTouchToken(extracted.token, config.tokenSecret)
  if (!verified.ok) return { status: 'rejected', reason: 'invalid_token' }
  const appointmentId = Number(appointment.id)
  if (!Number.isSafeInteger(appointmentId) || appointmentId <= 0) {
    return { status: 'rejected', reason: 'invalid_appointment_id' }
  }
  const outcomeId = await resolveOutcomeId(db, appointmentId, adAccountId)
  if (!outcomeId) return { status: 'rejected', reason: 'link_rejected' }

  const { data, error } = await db.rpc('link_outcome_paid_touch', {
    p_ad_account_id: adAccountId,
    p_outcome_id: outcomeId,
    p_token_id: verified.tokenId,
    p_token_hash: hashPaidTouchToken(extracted.token),
    p_policy_version: PAID_TOUCH_POLICY_VERSION,
  })
  if (error) return { status: 'rejected', reason: 'link_rejected' }

  const parsed = linkResultSchema.safeParse(Array.isArray(data) ? data[0] : data)
  if (
    !parsed.success
    || parsed.data.ad_account_id !== adAccountId
    || parsed.data.outcome_id !== outcomeId
    || parsed.data.token_id !== verified.tokenId
  ) return { status: 'error', reason: 'invalid_rpc_response' }

  return {
    status: 'linked',
    paidTouch: parsed.data.last_fbclid
      ? { fbclid: parsed.data.last_fbclid, observedAt: parsed.data.last_interaction_at }
      : null,
  }
}

const PAID_SOCIAL_SOURCES = new Set(['meta', 'facebook', 'instagram', 'paid_social'])

export type AcuityPaidTouchFallbackOutcome =
  | { status: 'absent' }
  | { status: 'linked'; paidTouch: LinkedPaidTouchForCapi | null }
  | { status: 'rejected'; reason: 'no_fbclid' | 'not_paid_social' | 'link_rejected' }
  | { status: 'error'; reason: 'invalid_rpc_response' }

export async function linkAcuityPaidTouchFbclidFallback(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  appointment: AcuityAppointmentRaw,
): Promise<AcuityPaidTouchFallbackOutcome> {
  const attribution = extractAttribution(appointment.forms)
  if (!attribution.fbclid) return { status: 'absent' }
  if (!attribution.utm_source || !PAID_SOCIAL_SOURCES.has(attribution.utm_source.toLowerCase())) {
    return { status: 'rejected', reason: 'not_paid_social' }
  }
  const appointmentId = Number(appointment.id)
  if (!Number.isSafeInteger(appointmentId) || appointmentId <= 0) {
    return { status: 'rejected', reason: 'link_rejected' }
  }
  const outcomeId = await resolveOutcomeId(db, appointmentId, adAccountId)
  if (!outcomeId) return { status: 'rejected', reason: 'link_rejected' }

  const { data, error } = await db.rpc('link_outcome_paid_touch_fbclid_fallback', {
    p_ad_account_id: adAccountId,
    p_outcome_id: outcomeId,
    p_fbclid: attribution.fbclid,
    p_policy_version: PAID_TOUCH_POLICY_VERSION,
  })
  if (error) return { status: 'rejected', reason: 'link_rejected' }

  const parsed = linkResultSchema.safeParse(Array.isArray(data) ? data[0] : data)
  if (
    !parsed.success
    || parsed.data.ad_account_id !== adAccountId
    || parsed.data.outcome_id !== outcomeId
    || parsed.data.token_id !== null
  ) return { status: 'error', reason: 'invalid_rpc_response' }

  return {
    status: 'linked',
    paidTouch: parsed.data.last_fbclid
      ? { fbclid: parsed.data.last_fbclid, observedAt: parsed.data.last_interaction_at }
      : null,
  }
}

export type AcuityPaidTouchLinkWithFallbackOutcome =
  | { status: 'absent' }
  | { status: 'linked'; paidTouch: LinkedPaidTouchForCapi | null }
  | { status: 'rejected'; reason: 'ambiguous_field' | 'invalid_token' | 'invalid_appointment_id' | 'link_rejected' }
  | { status: 'error'; reason: 'invalid_rpc_response' }

export async function linkAcuityPaidTouchWithFallback(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  appointment: AcuityAppointmentRaw,
  config: { fieldId: number; tokenSecret: string },
): Promise<AcuityPaidTouchLinkWithFallbackOutcome> {
  const primary = await linkAcuityPaidTouch(db, adAccountId, appointment, config)
  if (primary.status === 'linked') return primary
  if (primary.status === 'rejected') {
    // Absent token is the only primary rejection we can recover from via fbclid.
    // Invalid/ambiguous tokens and RPC rejects are intentionally terminal.
    return primary
  }
  if (primary.status === 'error') return primary

  const fallback = await linkAcuityPaidTouchFbclidFallback(db, adAccountId, appointment)
  if (fallback.status === 'linked') return fallback
  if (fallback.status === 'absent') return { status: 'absent' }
  if (fallback.status === 'rejected') return { status: 'rejected', reason: 'link_rejected' }
  return fallback
}

export function paidTouchLinkConfig(
  env: Record<string, string | undefined> = process.env,
): { fieldId: number; tokenSecret: string } | null {
  const fieldId = Number(env.ACUITY_PAID_TOUCH_FIELD_ID)
  const tokenSecret = env.PAID_TOUCH_TOKEN_SECRET ?? ''
  if (!Number.isSafeInteger(fieldId) || fieldId <= 0 || Buffer.byteLength(tokenSecret, 'utf8') < 32) {
    return null
  }
  return { fieldId, tokenSecret }
}

