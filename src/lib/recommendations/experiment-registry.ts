import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import type { TestBrief } from './decision-policy'

// EXPERIMENT REGISTRY ACCESS: durable registry + state-transition API + test-brief creation.
//
// SCOPE, stated honestly (verified by AST call-graph): this is NOT a production
// experiment runtime. These registry helpers have NO production caller. A failed evidence gate no
// longer calls createTestBrief because it cannot own CampaignPlan variables, owner ceilings,
// measurement maturity, or success/stop rules. Nothing collects observations or completes a run.
// Evaluation and lifecycle transitions remain DEFERRED. tests/call-graph-proof.test.ts pins these
// facts so this comment and the code cannot drift.
//
// Every transition goes through the experiment transition RPCs (start/stop/complete_experiment) so the state machine cannot be bypassed by an
// ad-hoc UPDATE.

export interface ExperimentRow {
  id: string
  ad_account_id: string
  hypothesis: string
  entity_level: string | null
  entity_ref: string | null
  changed_variable: string
  control_ref: string
  challenger_ref: string
  primary_metric: string
  min_sample: number
  min_spend: number
  success_contract: string
  status: string
  outcome: string | null
  started_at: string | null
  ended_at: string | null
  owner_decision: string | null
}

/** Create a DRAFT brief, unless an open one already covers the same variable + control. */
export async function createTestBrief(
  adAccountDbId: string,
  brief: TestBrief,
  provenance: Record<string, unknown>,
  supabase?: SupabaseClient,
): Promise<{ created: boolean; id: string | null; reason?: string }> {
  const db = supabase ?? getAdminClient()
  // DEDUP ON EXACT IDENTITY. Keying on (changed_variable, control_ref) collapsed two DIFFERENT ad
  // sets that happened to share a budget into one brief, because control_ref held budget state.
  const { data: existing, error: lookupErr } = await db
    .from('experiments')
    .select('id')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', brief.entityLevel)
    .eq('entity_ref', brief.entityRef)
    .eq('changed_variable', brief.changedVariable)
    .in('status', ['draft', 'proposed', 'running'])
    .limit(1)
  if (lookupErr) return { created: false, id: null, reason: `lookup failed: ${lookupErr.message}` }
  if ((existing ?? []).length > 0) return { created: false, id: (existing![0] as { id: string }).id, reason: 'an open brief already covers this entity and variable' }

  const { data, error } = await db
    .from('experiments')
    .insert({
      ad_account_id: adAccountDbId,
      hypothesis: brief.hypothesis,
      entity_level: brief.entityLevel,
      entity_ref: brief.entityRef,
      changed_variable: brief.changedVariable,
      control_ref: brief.controlRef,
      challenger_ref: brief.challengerRef,
      invariants: brief.invariants,
      primary_metric: brief.primaryMetric,
      guardrails: brief.guardrails,
      min_sample: brief.minSample,
      min_spend: brief.minSpend,
      success_contract: brief.successContract,
      status: 'draft',
      result_provenance: provenance,
    })
    .select('id')
    .single()
  if (error) return { created: false, id: null, reason: error.message }
  return { created: true, id: (data as { id: string }).id }
}

/** changed_variable values with a RUNNING experiment — the conflict set the decision gate consumes. */
export async function runningExperimentConflicts(
  adAccountDbId: string,
  supabase?: SupabaseClient,
): Promise<{ variables: string[]; readFailed: boolean }> {
  const db = supabase ?? getAdminClient()
  const { data, error } = await db
    .from('experiments')
    .select('changed_variable')
    .eq('ad_account_id', adAccountDbId)
    .eq('status', 'running')
  // A failed read means conflicts are UNKNOWN. The caller must not treat that as "no conflicts".
  if (error) return { variables: [], readFailed: true }
  return { variables: ((data ?? []) as Array<{ changed_variable: string }>).map((r) => r.changed_variable), readFailed: false }
}

export interface ExperimentEvaluation {
  outcome: 'success' | 'failure' | 'inconclusive'
  reason: string
  belowFloor: boolean
}

/**
 * PURE: apply the PRE-COMMITTED success contract. Below either floor the result is INCONCLUSIVE by
 * definition — that is what makes the floor meaningful, and it is decided here rather than by
 * whoever reads the numbers afterwards.
 */
export function evaluateExperiment(
  e: Pick<ExperimentRow, 'min_sample' | 'min_spend'>,
  observed: { controlSample: number; challengerSample: number; controlSpend: number; challengerSpend: number; controlMetric: number | null; challengerMetric: number | null },
  opts: { guardrailBreached?: boolean } = {},
): ExperimentEvaluation {
  if (opts.guardrailBreached) {
    return { outcome: 'inconclusive', reason: 'a guardrail aborted the run', belowFloor: false }
  }
  const belowSample = observed.controlSample < e.min_sample || observed.challengerSample < e.min_sample
  const belowSpend = observed.controlSpend < e.min_spend || observed.challengerSpend < e.min_spend
  if (belowSample || belowSpend) {
    return {
      outcome: 'inconclusive',
      reason: `below the pre-committed ${belowSample ? 'sample' : 'spend'} floor — inconclusive by definition, not a winner`,
      belowFloor: true,
    }
  }
  if (observed.controlMetric === null || observed.challengerMetric === null) {
    return { outcome: 'inconclusive', reason: 'the primary metric is unavailable for one arm', belowFloor: false }
  }
  if (observed.challengerMetric > observed.controlMetric) {
    return { outcome: 'success', reason: `challenger ${observed.challengerMetric} > control ${observed.controlMetric} on the primary metric, both arms above the floors`, belowFloor: false }
  }
  if (observed.challengerMetric < observed.controlMetric) {
    return { outcome: 'failure', reason: `challenger ${observed.challengerMetric} < control ${observed.controlMetric} on the primary metric`, belowFloor: false }
  }
  return { outcome: 'inconclusive', reason: 'the arms tied on the primary metric', belowFloor: false }
}

const rpc = async (db: SupabaseClient, fn: string, args: Record<string, unknown>) => {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as Record<string, unknown>
}

export const startExperiment = (id: string, db?: SupabaseClient) =>
  rpc(db ?? getAdminClient(), 'start_experiment', { p_id: id })

export const completeExperiment = (id: string, outcome: string, provenance?: Record<string, unknown>, db?: SupabaseClient) =>
  rpc(db ?? getAdminClient(), 'complete_experiment', { p_id: id, p_outcome: outcome, p_result_provenance: provenance ?? null })

export const stopExperiment = (id: string, reason: string, db?: SupabaseClient) =>
  rpc(db ?? getAdminClient(), 'stop_experiment', { p_id: id, p_stop_reason: reason })

export const recordOwnerDecision = (id: string, decision: string, db?: SupabaseClient) =>
  rpc(db ?? getAdminClient(), 'record_experiment_owner_decision', { p_id: id, p_decision: decision })
