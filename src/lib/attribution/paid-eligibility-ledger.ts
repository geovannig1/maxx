import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

export const PAID_ELIGIBILITY_LEDGER_CONTRACT_VERSION = 1 as const

const uuid = z.string().uuid()
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const iso = z.string().datetime({ offset: true })
const nullableUuid = uuid.nullable()
// Money reaches the ledger RPCs either as a JS number (the reference adapter's parsed prices) or as the
// exact decimal string a source sent (webhook outcomes). A string is passed to the numeric parameter
// unchanged, so a value beyond double precision (15 integer and 6 fraction digits) still compares
// exactly with the stored outcome.
const EXACT_DECIMAL = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/
const optionalMoney = z.union([z.number().finite().nonnegative(), z.string().regex(EXACT_DECIMAL)]).nullable()

const captureAttemptResultSchema = z.object({
  attempt_id: uuid,
  received_at: iso,
}).strict()

const eventResultSchema = z.object({ event_id: uuid }).strict()
const eligibilityInputResultSchema = z.object({ input_id: uuid, received_at: iso }).strict()

export type PaidCaptureOutcome =
  | 'rejected_invalid'
  | 'rejected_previous_token'
  | 'capture_conflict'
  | 'storage_failed'
  | 'touch_persisted'
  | 'token_response_issued'

export type PaidAppointmentLinkEvaluationStatus =
  | 'linked'
  | 'absent'
  | 'rejected'
  | 'error'
  | 'not_configured'

export class PaidEligibilityLedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaidEligibilityLedgerError'
  }
}

function parseRpcResult<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(Array.isArray(data) ? data[0] : data)
  if (!parsed.success) throw new PaidEligibilityLedgerError(`${label} returned an invalid result.`)
  return parsed.data
}

function requireValid<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new PaidEligibilityLedgerError(`${label} is invalid.`)
  return parsed.data
}

export async function recordPaidCaptureAttempt(
  db: SupabaseClient,
  input: {
    adAccountId: string
    attemptId: string
    browserCaptureId: string | null
    requestFingerprint: string
  },
): Promise<{ attemptId: string; receivedAt: string }> {
  const valid = requireValid(z.object({
    adAccountId: uuid,
    attemptId: uuid,
    browserCaptureId: nullableUuid,
    requestFingerprint: sha256,
  }).strict(), input, 'Paid capture attempt')
  const { data, error } = await db.rpc('record_paid_capture_attempt', {
    p_ad_account_id: valid.adAccountId,
    p_attempt_id: valid.attemptId,
    p_browser_capture_id: valid.browserCaptureId,
    p_request_fingerprint: valid.requestFingerprint,
    p_contract_version: PAID_ELIGIBILITY_LEDGER_CONTRACT_VERSION,
  })
  if (error) throw new PaidEligibilityLedgerError(`Paid capture attempt write failed: ${error.message}`)
  const row = parseRpcResult(captureAttemptResultSchema, data, 'Paid capture attempt write')
  return { attemptId: row.attempt_id, receivedAt: row.received_at }
}

export async function recordPaidCaptureOutcome(
  db: SupabaseClient,
  input: {
    adAccountId: string
    attemptId: string
    eventId: string
    outcome: PaidCaptureOutcome
    reasonCode: string | null
    touchId: string | null
    tokenId: string | null
  },
): Promise<string> {
  const valid = requireValid(z.object({
    adAccountId: uuid,
    attemptId: uuid,
    eventId: uuid,
    outcome: z.enum([
      'rejected_invalid', 'rejected_previous_token', 'capture_conflict',
      'storage_failed', 'touch_persisted', 'token_response_issued',
    ]),
    reasonCode: z.string().trim().min(1).max(128).nullable(),
    touchId: nullableUuid,
    tokenId: nullableUuid,
  }).strict(), input, 'Paid capture outcome')
  const { data, error } = await db.rpc('record_paid_capture_outcome', {
    p_ad_account_id: valid.adAccountId,
    p_attempt_id: valid.attemptId,
    p_event_id: valid.eventId,
    p_outcome: valid.outcome,
    p_reason_code: valid.reasonCode,
    p_touch_id: valid.touchId,
    p_token_id: valid.tokenId,
    p_contract_version: PAID_ELIGIBILITY_LEDGER_CONTRACT_VERSION,
  })
  if (error) throw new PaidEligibilityLedgerError(`Paid capture outcome write failed: ${error.message}`)
  return parseRpcResult(eventResultSchema, data, 'Paid capture outcome write').event_id
}

export async function recordSchedulerTokenDelivery(
  db: SupabaseClient,
  input: {
    adAccountId: string
    eventId: string
    browserCaptureId: string
    tokenId: string
    tokenHash: string
    deliveryStatus: 'scheduler_decorated'
  },
): Promise<string> {
  const valid = requireValid(z.object({
    adAccountId: uuid,
    eventId: uuid,
    browserCaptureId: uuid,
    tokenId: uuid,
    tokenHash: sha256,
    deliveryStatus: z.literal('scheduler_decorated'),
  }).strict(), input, 'Scheduler token delivery')
  const { data, error } = await db.rpc('record_paid_destination_token_delivery', {
    p_ad_account_id: valid.adAccountId,
    p_event_id: valid.eventId,
    p_browser_capture_id: valid.browserCaptureId,
    p_token_id: valid.tokenId,
    p_token_hash: valid.tokenHash,
    p_delivery_status: valid.deliveryStatus,
    p_contract_version: PAID_ELIGIBILITY_LEDGER_CONTRACT_VERSION,
  })
  if (error) throw new PaidEligibilityLedgerError(`Scheduler token delivery write failed: ${error.message}`)
  return parseRpcResult(eventResultSchema, data, 'Scheduler token delivery write').event_id
}

export async function recordPaidAppointmentEligibilityInput(
  db: SupabaseClient,
  input: {
    adAccountId: string
    inputId: string
    inputFingerprint: string
    outcomeId: string
    outcomeCreatedAt: string
    linkerConfigured: boolean
    paidEvidencePresent: boolean
    tokenId: string | null
    /** A number, or the exact decimal string the source sent. */
    amountPaid: number | string | null
    canceled: boolean
  },
): Promise<{ inputId: string; receivedAt: string }> {
  const valid = requireValid(z.object({
    adAccountId: uuid,
    inputId: uuid,
    inputFingerprint: sha256,
    outcomeId: uuid,
    outcomeCreatedAt: iso,
    linkerConfigured: z.boolean(),
    paidEvidencePresent: z.boolean(),
    tokenId: nullableUuid,
    amountPaid: optionalMoney,
    canceled: z.boolean(),
  }).strict(), input, 'Paid appointment eligibility input')
  const { data, error } = await db.rpc('record_paid_outcome_eligibility_input', {
    p_ad_account_id: valid.adAccountId,
    p_input_id: valid.inputId,
    p_input_fingerprint: valid.inputFingerprint,
    p_outcome_id: valid.outcomeId,
    p_outcome_created_at: valid.outcomeCreatedAt,
    p_linker_configured: valid.linkerConfigured,
    p_paid_evidence_present: valid.paidEvidencePresent,
    p_token_id: valid.tokenId,
    p_collected_value: valid.amountPaid,
    p_cancelled: valid.canceled,
    p_contract_version: PAID_ELIGIBILITY_LEDGER_CONTRACT_VERSION,
  })
  if (error) throw new PaidEligibilityLedgerError(`Paid appointment input write failed: ${error.message}`)
  const row = parseRpcResult(eligibilityInputResultSchema, data, 'Paid appointment input write')
  return { inputId: row.input_id, receivedAt: row.received_at }
}

export async function recordPaidAppointmentLinkEvaluation(
  db: SupabaseClient,
  input: {
    adAccountId: string
    evaluationId: string
    evaluationFingerprint: string
    eligibilityInputId: string
    outcomeId: string
    outcomeCreatedAt: string
    paidEvidencePresent: boolean
    tokenId: string | null
    linkId: string | null
    lastTouchId: string | null
    lastInteractionAt: string | null
    status: PaidAppointmentLinkEvaluationStatus
    reasonCode: string | null
    /** A number, or the exact decimal string the source sent. */
    amountPaid: number | string | null
    canceled: boolean
  },
): Promise<string> {
  const valid = requireValid(z.object({
    adAccountId: uuid,
    evaluationId: uuid,
    evaluationFingerprint: sha256,
    eligibilityInputId: uuid,
    outcomeId: uuid,
    outcomeCreatedAt: iso,
    paidEvidencePresent: z.boolean(),
    tokenId: nullableUuid,
    linkId: nullableUuid,
    lastTouchId: nullableUuid,
    lastInteractionAt: iso.nullable(),
    status: z.enum(['linked', 'absent', 'rejected', 'error', 'not_configured']),
    reasonCode: z.string().trim().min(1).max(128).nullable(),
    amountPaid: optionalMoney,
    canceled: z.boolean(),
  }).strict(), input, 'Paid appointment link evaluation')
  const { data, error } = await db.rpc('record_paid_outcome_link_evaluation', {
    p_ad_account_id: valid.adAccountId,
    p_evaluation_id: valid.evaluationId,
    p_evaluation_fingerprint: valid.evaluationFingerprint,
    p_eligibility_input_id: valid.eligibilityInputId,
    p_outcome_id: valid.outcomeId,
    p_outcome_created_at: valid.outcomeCreatedAt,
    p_paid_evidence_present: valid.paidEvidencePresent,
    p_token_id: valid.tokenId,
    p_link_id: valid.linkId,
    p_last_touch_id: valid.lastTouchId,
    p_last_interaction_at: valid.lastInteractionAt,
    p_status: valid.status,
    p_reason_code: valid.reasonCode,
    p_collected_value: valid.amountPaid,
    p_cancelled: valid.canceled,
    p_contract_version: PAID_ELIGIBILITY_LEDGER_CONTRACT_VERSION,
  })
  if (error) throw new PaidEligibilityLedgerError(`Paid appointment evaluation write failed: ${error.message}`)
  const parsed = z.object({ evaluation_id: uuid }).strict()
  return parseRpcResult(parsed, data, 'Paid appointment evaluation write').evaluation_id
}
