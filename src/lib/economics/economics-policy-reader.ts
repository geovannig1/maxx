import type { SupabaseClient } from '@supabase/supabase-js'
import { accountCurrency, isIsoCurrency } from '@/config/business-config'
import { z } from 'zod'

const iso = z.string().datetime({ offset: true })
const codeArray = z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).min(1).max(32)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'codes must be unique' })
    }
    if (values.some((value, index) => index > 0 && values[index - 1].localeCompare(value) > 0)) {
      context.addIssue({ code: 'custom', message: 'codes must be sorted' })
    }
  })

const approvalSchema = z.object({
  id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  artifact_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  decision: z.enum(['approved', 'withdrawn']),
  revision: z.number().int().positive(),
  effective_from: iso.nullable(),
  review_due_at: iso.nullable(),
  created_at: iso,
}).strict().superRefine((row, context) => {
  const approvedShape = row.decision === 'approved'
    && row.effective_from !== null && row.review_due_at !== null
  const withdrawnShape = row.decision === 'withdrawn'
    && row.effective_from === null && row.review_due_at === null
  if (!approvedShape && !withdrawnShape) {
    context.addIssue({ code: 'custom', message: 'approval decision timestamps contradict decision' })
  }
})

const artifactSchema = z.object({
  id: z.string().uuid(),
  schema_version: z.literal(1),
  objective: z.literal('maximize_incremental_contribution_from_ad_attributed_collected_revenue'),
  currency: z.string().refine((code) => isIsoCurrency(code) && code === accountCurrency(), 'currency must be the account currency'),
  processor: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  processor_account_ref: z.string().min(1).max(256)
    .refine((value) => value.trim().length > 0),
  realization_horizon_days: z.number().int().min(1).max(365),
  variable_cost_basis: z.literal('outcome_actual_entries'),
  required_cost_sources: codeArray,
  allowed_variable_cost_categories: codeArray,
  variable_cost_category_sources: z.record(
    z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  ),
  fixed_overhead_treatment: z.literal('excluded_from_contribution'),
  content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  captured_at: iso,
}).strict()

type Approval = z.infer<typeof approvalSchema>
type Artifact = z.infer<typeof artifactSchema>

export type EconomicsPolicyAuthority =
  | {
      status: 'available'
      approvalId: string
      policyId: string
      policyHash: string
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue'
      currency: string
      effectiveFrom: string
      reviewDueAt: string
      realizationHorizonDays: number
      settlementSource: { processor: string; processorAccountRef: string }
      variableCostBasis: 'outcome_actual_entries'
      requiredCostSources: string[]
      allowedVariableCostCategories: string[]
      variableCostCategorySources: Record<string, string>
      fixedOverheadTreatment: 'excluded_from_contribution'
    }
  | {
      status: 'unavailable'
      blockerCodes: Array<
        | 'economics_policy_missing'
        | 'economics_policy_withdrawn'
        | 'economics_policy_not_effective'
        | 'economics_policy_review_expired'
        | 'economics_policy_artifact_missing'
      >
    }

function timestamp(value: string, label: string): number {
  const parsed = iso.safeParse(value)
  if (!parsed.success) throw new Error(`Invalid ${label} timestamp.`)
  return new Date(parsed.data).getTime()
}

function parseApproval(value: unknown): Approval {
  try {
    return approvalSchema.parse(value)
  } catch (error) {
    throw new Error(`Malformed economics policy approval row: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseArtifact(value: unknown): Artifact {
  try {
    return artifactSchema.parse(value)
  } catch (error) {
    throw new Error(`Malformed economics policy row: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function resolveEconomicsPolicyRows(input: {
  approval: unknown | null
  artifact: unknown | null
  windowStart: string
  asOf: string
}): EconomicsPolicyAuthority {
  const windowStart = timestamp(input.windowStart, 'economics window start')
  const asOf = timestamp(input.asOf, 'economics as-of')
  if (asOf < windowStart) throw new Error('Economics as-of precedes the evaluation window.')
  if (input.approval === null) {
    return { status: 'unavailable', blockerCodes: ['economics_policy_missing'] }
  }
  const approval = parseApproval(input.approval)
  if (timestamp(approval.created_at, 'economics approval created_at') > asOf) {
    throw new Error('Economics policy approval was created after the as-of cut.')
  }
  if (approval.decision === 'withdrawn') {
    return { status: 'unavailable', blockerCodes: ['economics_policy_withdrawn'] }
  }
  if (input.artifact === null) {
    return { status: 'unavailable', blockerCodes: ['economics_policy_artifact_missing'] }
  }
  const artifact = parseArtifact(input.artifact)
  if (artifact.id !== approval.artifact_id || artifact.content_hash !== approval.artifact_hash) {
    throw new Error('Economics policy approval/artifact hash mismatch.')
  }
  const mappedCategories = Object.keys(artifact.variable_cost_category_sources).sort()
  const mappedSources = [...new Set(Object.values(artifact.variable_cost_category_sources))].sort()
  if (mappedCategories.join('\u0000') !== artifact.allowed_variable_cost_categories.join('\u0000')
      || mappedSources.join('\u0000') !== artifact.required_cost_sources.join('\u0000')) {
    throw new Error('Economics policy category/source ownership is contradictory.')
  }
  if (timestamp(artifact.captured_at, 'economics policy captured_at')
      > timestamp(approval.created_at, 'economics approval created_at')) {
    throw new Error('Economics policy artifact was captured after its approval.')
  }
  if (timestamp(approval.effective_from!, 'economics policy effective_from') > windowStart) {
    return { status: 'unavailable', blockerCodes: ['economics_policy_not_effective'] }
  }
  if (timestamp(approval.review_due_at!, 'economics policy review_due_at') <= asOf) {
    return { status: 'unavailable', blockerCodes: ['economics_policy_review_expired'] }
  }
  return {
    status: 'available',
    approvalId: approval.id,
    policyId: artifact.id,
    policyHash: artifact.content_hash,
    objective: artifact.objective,
    currency: artifact.currency,
    effectiveFrom: approval.effective_from!,
    reviewDueAt: approval.review_due_at!,
    realizationHorizonDays: artifact.realization_horizon_days,
    settlementSource: {
      processor: artifact.processor,
      processorAccountRef: artifact.processor_account_ref,
    },
    variableCostBasis: artifact.variable_cost_basis,
    requiredCostSources: [...artifact.required_cost_sources],
    allowedVariableCostCategories: [...artifact.allowed_variable_cost_categories],
    variableCostCategorySources: { ...artifact.variable_cost_category_sources },
    fixedOverheadTreatment: artifact.fixed_overhead_treatment,
  }
}

export async function readGovernedEconomicsPolicy(
  db: SupabaseClient,
  adAccountId: string,
  windowStart: string,
  asOf: string,
): Promise<EconomicsPolicyAuthority> {
  if (!z.string().uuid().safeParse(adAccountId).success) {
    throw new Error('Economics policy account ID must be a UUID.')
  }
  timestamp(windowStart, 'economics window start'); timestamp(asOf, 'economics as-of')
  const approvals = await db.from('economics_policy_approvals')
    .select('id,artifact_id,artifact_hash,decision,revision,effective_from,review_due_at,created_at')
    .eq('ad_account_id', adAccountId)
    .lte('created_at', asOf)
    .order('revision', { ascending: false })
    .limit(1)
  if (approvals.error) throw new Error(`Economics policy approval read failed: ${approvals.error.message}`)
  if (!Array.isArray(approvals.data) || approvals.data.length === 0) {
    return resolveEconomicsPolicyRows({ approval: null, artifact: null, windowStart, asOf })
  }
  const approval = parseApproval(approvals.data[0])
  if (approval.decision === 'withdrawn') {
    return resolveEconomicsPolicyRows({ approval, artifact: null, windowStart, asOf })
  }
  const artifacts = await db.from('economics_policy_versions')
    .select('id,schema_version,objective,currency,processor,processor_account_ref,realization_horizon_days,variable_cost_basis,required_cost_sources,allowed_variable_cost_categories,variable_cost_category_sources,fixed_overhead_treatment,content_hash,captured_at')
    .eq('ad_account_id', adAccountId)
    .eq('id', approval.artifact_id)
    .limit(1)
  if (artifacts.error) throw new Error(`Economics policy artifact read failed: ${artifacts.error.message}`)
  const artifact = Array.isArray(artifacts.data) && artifacts.data.length === 1
    ? artifacts.data[0]
    : null
  return resolveEconomicsPolicyRows({ approval, artifact, windowStart, asOf })
}
