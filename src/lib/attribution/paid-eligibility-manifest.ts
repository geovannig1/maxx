import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { PAID_COHORT_COMPLETENESS_MANIFEST_POLICY } from './paid-cohort-policy'

const uuid = z.string().uuid()
const iso = z.string().datetime({ offset: true })
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const manifestResultSchema = z.object({
  id: uuid,
  cohort_kind: z.enum(['recent_scale', 'matured_cut']),
  capture_complete: z.boolean(),
  linker_complete: z.boolean(),
  blocker_codes: z.array(z.string()),
}).passthrough()

export interface PaidEligibilityManifestProducerInput {
  adAccountId: string
  evaluationRunId: string
  sourceNotBefore: string
  windows: {
    recentScale: { start: string; end: string }
    maturedCut: { start: string; end: string }
  }
}

export interface PaidEligibilityManifestWindowProof {
  policyVersion: 3
  evaluationRunId: string
  manifestContractVersion: 1
  manifestPolicyVersion: 1
  window: { start: string; end: string }
  capture: { eligible: number; captured: number; complete: boolean }
  linker: { eligible: number; evaluated: number; linked: number; complete: boolean }
  blockerCodes: string[]
  sourceNotBefore: string
  synchronizedAt: string
}

const safeInteger = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/).transform((value, context) => {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      context.addIssue({ code: 'custom', message: 'integer exceeds safe range' })
      return z.NEVER
    }
    return parsed
  }),
])

const windowManifestRowSchema = z.object({
  evaluation_run_id: uuid,
  window_start: date,
  window_end: date,
  source_not_before: iso,
  capture_completed_at: iso,
  linker_completed_at: iso,
  contract_version: z.literal(1),
  policy_version: z.literal(1),
  capture_complete: z.boolean(),
  linker_complete: z.boolean(),
  capture_eligible_inputs: safeInteger,
  captured_touches: safeInteger,
  eligible_outcomes: safeInteger,
  evaluated_outcomes: safeInteger,
  linked_outcomes: safeInteger,
  blocker_codes: z.array(z.string().trim().min(1).max(128)),
  created_at: iso,
}).strict()

function deterministicManifestId(runId: string, kind: 'recent_scale' | 'matured_cut'): string {
  const bytes = createHash('sha256').update(`${runId}:paid-eligibility:${kind}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function producePaidCohortCompletenessManifests(
  db: SupabaseClient,
  input: PaidEligibilityManifestProducerInput,
): Promise<Array<z.infer<typeof manifestResultSchema>>> {
  const validated = z.object({
    adAccountId: uuid,
    evaluationRunId: uuid,
    sourceNotBefore: iso,
    windows: z.object({
      recentScale: z.object({ start: date, end: date }).strict(),
      maturedCut: z.object({ start: date, end: date }).strict(),
    }).strict(),
  }).strict().parse(input)

  const rows: Array<z.infer<typeof manifestResultSchema>> = []
  for (const [kind, window] of [
    ['recent_scale', validated.windows.recentScale],
    ['matured_cut', validated.windows.maturedCut],
  ] as const) {
    const { data, error } = await db.rpc('produce_paid_cohort_completeness_manifest', {
      p_manifest_id: deterministicManifestId(validated.evaluationRunId, kind),
      p_ad_account_id: validated.adAccountId,
      p_evaluation_run_id: validated.evaluationRunId,
      p_cohort_kind: kind,
      p_window_start: window.start,
      p_window_end: window.end,
      p_source_not_before: validated.sourceNotBefore,
      p_contract_version: PAID_COHORT_COMPLETENESS_MANIFEST_POLICY.contractVersion,
      p_policy_version: PAID_COHORT_COMPLETENESS_MANIFEST_POLICY.policyVersion,
    })
    if (error) throw new Error(`Paid eligibility manifest production failed: ${error.message}`)
    const parsed = manifestResultSchema.safeParse(Array.isArray(data) ? data[0] : data)
    if (!parsed.success || parsed.data.cohort_kind !== kind) {
      throw new Error('Paid eligibility manifest production returned an invalid result.')
    }
    rows.push(parsed.data)
  }
  return rows
}

/** Exact-window proof for cockpit/API consumers. No nearest-window or aggregate fallback exists. */
export async function readPaidEligibilityManifestForWindow(
  db: SupabaseClient,
  input: { adAccountId: string; evaluationRunId: string; start: string; end: string },
): Promise<PaidEligibilityManifestWindowProof | null> {
  const valid = z.object({ adAccountId: uuid, evaluationRunId: uuid, start: date, end: date }).strict().parse(input)
  const { data, error } = await db.from('paid_cohort_completeness_manifests')
    .select('evaluation_run_id,window_start,window_end,source_not_before,capture_completed_at,linker_completed_at,contract_version,policy_version,capture_complete,linker_complete,capture_eligible_inputs,captured_touches,eligible_outcomes,evaluated_outcomes,linked_outcomes,blocker_codes,created_at')
    .eq('ad_account_id', valid.adAccountId)
    .eq('evaluation_run_id', valid.evaluationRunId)
    .eq('window_start', valid.start)
    .eq('window_end', valid.end)
    .eq('contract_version', PAID_COHORT_COMPLETENESS_MANIFEST_POLICY.contractVersion)
    .eq('policy_version', PAID_COHORT_COMPLETENESS_MANIFEST_POLICY.policyVersion)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Paid eligibility manifest read failed: ${error.message}`)
  if (!data) return null
  const parsed = windowManifestRowSchema.safeParse(data)
  if (!parsed.success) throw new Error('Paid eligibility manifest read returned invalid data.')
  const row = parsed.data
  return {
    policyVersion: 3,
    evaluationRunId: row.evaluation_run_id,
    manifestContractVersion: row.contract_version,
    manifestPolicyVersion: row.policy_version,
    window: { start: row.window_start, end: row.window_end },
    capture: {
      eligible: row.capture_eligible_inputs,
      captured: row.captured_touches,
      complete: row.capture_complete,
    },
    linker: {
      eligible: row.eligible_outcomes,
      evaluated: row.evaluated_outcomes,
      linked: row.linked_outcomes,
      complete: row.linker_complete,
    },
    blockerCodes: [...new Set(row.blocker_codes)].sort(),
    sourceNotBefore: row.source_not_before,
    synchronizedAt: new Date(Math.max(
      new Date(row.capture_completed_at).getTime(),
      new Date(row.linker_completed_at).getTime(),
    )).toISOString(),
  }
}
