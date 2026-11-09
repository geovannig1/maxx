import { getAdminClient } from '@/lib/supabase/admin'

// Durable generations — the app-side interface to the durable-generation RPCs. Every write to
// the flag/recommendation/report decision state goes through ONE of these, so publication is atomic
// (insert + supersede + stale-close in one locked transaction), CAS-guarded against stale concurrent
// commits, and cross-stage-lineage checked. The RPC bodies (and their verification) live in
// supabase/migrations/0001_baseline.sql + tests/db/.

type Db = ReturnType<typeof getAdminClient>

/** {entity_level, entity_id, window_days} — an entity+window judged this run. */
export interface EvaluatedScope { entity_level: string; entity_id: string; window_days: number }
/** …+ flag_type — a type re-proven this run. */
export interface ProvenKey extends EvaluatedScope { flag_type: string }
/** Budget-decision flags in these scopes are frozen (not created, not closed). The freshness boundary
 *  gates the RPC's structural unit closure: campaign metadata counts only when
 *  campaigns.last_synced_at >= it; null disables structural judgment (fail closed). */
export interface FrozenScopes { global: boolean; campaign_ids: string[]; campaign_metadata_not_before?: string | null }

export interface FlagGenerationResult {
  generation_id: string
  /** Rows WRITTEN this commit (upserted) — NOT the active count; the active set is active_flags. */
  row_count: number
  /** Budget flags closed because commit-time metadata proved them on the wrong optimization unit. */
  structural_closures: number
  /** Flags closed because their target entity was deleted (required FK null). */
  orphan_closures: number
  /** ACTIVE budget flags whose campaign metadata was missing/stale (preserved, never judged). */
  unknown_metadata_flags: number
  /** True when this generation was committed under a global budget freeze. */
  budget_decisions_frozen: boolean
  /** Engine-side (merged by runFlagEngine): referenced campaigns whose CBO state could not be resolved
   *  this sync — STALE row or MISSING row alike (neither may report a green run). */
  unresolved_referenced_campaigns?: number
  active_flags: Record<string, unknown>[]
}

/** The current committed generation id for (account, kind), or null when none exists yet. */
export async function readCurrentGeneration(supabase: Db, adAccountId: string, kind: 'flag' | 'recommendation'): Promise<string | null> {
  const { data } = await supabase
    .from('decision_generations')
    .select('id')
    .eq('ad_account_id', adAccountId)
    .eq('kind', kind)
    .eq('is_current', true)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/** Five-state, so "unable to verify" is NEVER presented as "current" and a deliberate rollback is never
 *  disguised as ordinary staleness:
 *   • current              — the report's rec generation is still lineage-current for its date.
 *   • last_known_complete  — a NEWER flag generation committed FOR THE SAME DATE after the rec's source
 *                            (a same-date rec recompute failed); the recs are preserved but stale.
 *   • rolled_back          — the pinned rec generation was explicitly ROLLED BACK. The report is
 *                            left standing (prior-report doctrine) but its recommendations are historical
 *                            decision state that must not be acted on — and must never be described as
 *                            "a newer run superseded this" (the truth is the opposite direction).
 *   • no_snapshot          — no rec generation is pinned (I1 / null-generation report).
 *   • unknown              — could not verify (DB error, missing/mismatched manifest, no flag gen for the
 *                            date). Surfaces MUST show this honestly, never silently as current. */
export type RecLineageState = 'current' | 'last_known_complete' | 'rolled_back' | 'no_snapshot' | 'unknown'
export interface RecLineageStatus { state: RecLineageState; committedAt: string | null; parentFlagGeneration: string | null }

/** Report lineage, evaluated at READ time so it applies to a PRESERVED report too. DATE-SCOPED: the
 *  comparison is against the latest flag generation FOR THE REC GENERATION'S OWN reference_date — NOT the
 *  global current flag head (which advances every new day and would falsely mark every historical report
 *  stale). Manifest reads are account+kind scoped. Shared by the generator, report page + API, and MCP so
 *  all agree. Never fabricates staleness: any read it cannot complete resolves to 'unknown', not 'current'. */
export async function getRecLineageStatus(supabase: Db, adAccountId: string, recGenerationId: string | null): Promise<RecLineageStatus> {
  if (!recGenerationId) return { state: 'no_snapshot', committedAt: null, parentFlagGeneration: null }
  const { data: recGen, error: recErr } = await supabase
    .from('decision_generations')
    .select('parent_generation_id, committed_at, reference_date, rolled_back_at')
    .eq('id', recGenerationId)
    .eq('ad_account_id', adAccountId)
    .eq('kind', 'recommendation')
    .maybeSingle()
  const committedAt = (recGen?.committed_at as string | undefined) ?? null
  const parent = (recGen?.parent_generation_id as string | undefined) ?? null
  const refDate = (recGen?.reference_date as string | undefined) ?? null
  // A report pinned to a ROLLED-BACK generation gets its own honest state — comparing its (also
  // rolled-back) parent against the restored flag lineage would misread the situation as
  // last_known_complete ("a newer run committed") when the truth is the opposite: the system was
  // deliberately restored to an OLDER state. Checked BEFORE any parent comparison.
  if (recGen && recGen.rolled_back_at != null) { // loose null-check: a row missing the key must NOT read as rolled back
    return { state: 'rolled_back', committedAt, parentFlagGeneration: parent }
  }
  // Could not verify: read error, missing/mismatched manifest, or a rec generation with no source flag gen.
  if (recErr || !recGen || !parent || !refDate) return { state: 'unknown', committedAt, parentFlagGeneration: parent }
  // The latest flag generation FOR THAT DATE (not the global head). If a newer one committed for the date
  // than the rec's source, the recs are last-known-complete; if it still equals the source, they're current.
  const { data: latestFlag, error: flagErr } = await supabase
    .from('decision_generations')
    .select('id')
    .eq('ad_account_id', adAccountId)
    .eq('kind', 'flag')
    .eq('reference_date', refDate)
    .is('rolled_back_at', null) // A rolled-back generation is never the date's authority
    .order('committed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (flagErr || !latestFlag) return { state: 'unknown', committedAt, parentFlagGeneration: parent }
  return { state: (latestFlag.id as string) === parent ? 'current' : 'last_known_complete', committedAt, parentFlagGeneration: parent }
}

/** The single source of the "last-known-complete" copy — shared by the report narrative label, the
 *  report page banner, and the MCP daily-report note so all three read identically. */
export function staleLineageBanner(committedAt: string | null): string {
  const asOf = committedAt ? ` (as of ${committedAt})` : ''
  return `Last-known-complete recommendations${asOf}. A newer flag run has since committed for this date; these were the latest completed recommendation set.`
}

/** The deterministic I1 copy — SINGLE source shared by the generator's narrative input, the page's
 *  no-snapshot banner, and the API/MCP notice, so no consumer relies on LLM prose to convey absence. */
export const NO_SNAPSHOT_NOTICE = 'No committed recommendation snapshot is available for this date.'

/** The presentation notice for a lineage state, or null for 'current' (absence of a caveat — consumers
 *  still receive state='current' explicitly). 'unknown' is shown honestly as unverified, never as
 *  current. Shared by the report page + API + MCP + generator so all surfaces read identically. */
export function lineageNotice(status: RecLineageStatus): string | null {
  if (status.state === 'last_known_complete') return staleLineageBanner(status.committedAt)
  if (status.state === 'rolled_back') return 'This report references a recommendation generation that was rolled back. Treat its recommendations as historical and do not act on them.'
  if (status.state === 'unknown') return 'Recommendation lineage could not be verified for this report.'
  if (status.state === 'no_snapshot') return NO_SNAPSHOT_NOTICE
  return null
}

/** Atomically publish a flag generation. Throws (typed message: stale_expected_generation /
 *  cross_account_entity / …) on any RPC error, so the caller's fail-stop sequencing can react. */
export async function replaceFlagGeneration(
  supabase: Db,
  p: { adAccountId: string; generationId: string; expectedPrev: string | null; referenceDate: string;
       newRows: Record<string, unknown>[]; evaluatedScopes: EvaluatedScope[]; provenKeys: ProvenKey[]; frozen: FrozenScopes }
): Promise<FlagGenerationResult> {
  const { data, error } = await supabase.rpc('replace_flag_generation', {
    p_account: p.adAccountId, p_generation_id: p.generationId, p_expected_prev: p.expectedPrev,
    p_reference_date: p.referenceDate, p_new_rows: p.newRows, p_evaluated_scopes: p.evaluatedScopes,
    p_proven_keys: p.provenKeys, p_frozen: p.frozen,
  })
  if (error) throw new Error(`replace_flag_generation: ${error.message}`)
  return data as FlagGenerationResult
}

export interface ReportCommitResult { committed: boolean; reason: 'committed' | 'stale_generation' | 'invalid_generation'; current_generation_id: string | null; report_id?: string | null }

export class RecommendationGenerationReadError extends Error {
  readonly code = 'RECOMMENDATION_GENERATION_READ_UNAVAILABLE'

  constructor() {
    super('Recommendation generation state could not be read')
    this.name = 'RecommendationGenerationReadError'
  }
}

/** The latest committed recommendation generation for (account, reference_date), or null when none — used
 *  by the on-demand report route and historical syncs to pin a report to the right generation for a date
 *  (vs. the current head, which is for the newest date). A read failure throws so it can never be
 *  mistaken for a healthy no-snapshot result. */
export async function latestRecGenerationForDate(supabase: Db, adAccountId: string, referenceDate: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('decision_generations')
    .select('id')
    .eq('ad_account_id', adAccountId)
    .eq('kind', 'recommendation')
    .eq('reference_date', referenceDate)
    .is('rolled_back_at', null) // Rolled-back generations are excluded from date authority
    .order('committed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new RecommendationGenerationReadError()
  return (data?.id as string | undefined) ?? null
}

/** Persist a daily report ONLY if its recommendation generation is still the latest for that date
 *  (p_rec_generation null = the on-demand no-recommendations path). Returns a typed result; a
 *  non-committed outcome is a logged SKIP, never an error. */
export async function commitDailyReportGeneration(
  supabase: Db,
  p: { adAccountId: string; reportDate: string; recGeneration: string | null; payload: Record<string, unknown>;
       /** Lineage-race guard: the flag generation the narrative was computed against (rec gen's
        *  parent when lineage read 'current'). Rejected as stale if a newer flag gen has since committed
        *  for the date. Null/omitted skips the check (no-lineage / unknown-lineage paths). */
       expectedFlagGeneration?: string | null }
): Promise<ReportCommitResult> {
  const { data, error } = await supabase.rpc('commit_daily_report_generation', {
    p_account: p.adAccountId, p_report_date: p.reportDate, p_rec_generation: p.recGeneration, p_payload: p.payload,
    p_expected_flag_generation: p.expectedFlagGeneration ?? null,
  })
  if (error) throw new Error(`commit_daily_report_generation: ${error.message}`)
  return data as ReportCommitResult
}
