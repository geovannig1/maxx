import { getAdminClient } from '@/lib/supabase/admin'
import { randomUUID } from 'node:crypto'
import { buildRecommendation, type BuildRecommendationInput } from './builder'
import { recToRow } from './store'
import {
  gatherAccountEvidence, gateRecommendation, frozenEvidence, MONEY_MOVING_TYPES, type AccountEvidence,
} from './evidence-gate'
import type { ScopedOutcomeEvidence } from './decision-policy'
import { readCurrentGeneration } from '@/lib/flags/generations'
import {
  buildRecommendationMetricClaimBindings,
  replaceRecommendationGenerationWithMetricClaims,
  type MetricClaimSnapshotCommit,
} from './metric-claim-binding'
import {
  getExpertInsightsForRecommendations,
  getBenchmarkPrior,
  tallyTrackRecord,
  overallWinRate,
  resolvePriorWinRate,
  areaForFlag,
  type UsableInsight,
} from './knowledge'
import { getDecisionsForAccount, decisionMapKey, entityKeyFor, applyDecisionMemory } from './decisions'
import { getLedgerForAccount, settingDecisionContext, historyForEntity, type LedgerRow } from './setup-ledger'
import { emitAlert } from '@/lib/monitoring/alerts'
import { computeTrendStable, daysSinceChange, deriveExitedLearning, type DailyPoint } from './trend'
import type { RecommendationType, MetricValue, TargetEntityType } from './types'
import type { MetricKey } from '@/lib/targets/target-ranges'
import type { FlagType } from '@/types/db'
import { resolveAccountObjective } from '@/lib/modes/objective'
import type { ActionKind } from '@/lib/authority/action-authority'
import type { AuthorityBasis } from '@/lib/modes/operating-mode'
import {
  actionKindForRecommendation, applyRecommendationAuthority, arbitrateRecommendationPublications,
  decideRecommendationAuthority, recommendationDecisionCommit,
  type RecommendationAuthorityPublication,
} from '@/lib/authority/recommendation-authority'
import type { ActionDecisionCommit } from '@/lib/authority/action-decision-store'
import {
  paidCohortUnitKey,
  readLatestPaidCohortPairs,
  type PaidCohortPairEvidence,
  type PaidCohortUnitRef,
} from '@/lib/attribution/paid-cohort-store'
import { PaidCohortStoreError } from '@/lib/attribution/paid-cohort-reader'
import {
  resolvePaidCohortActionEvidence,
  toInteractionCohortPairSignal,
} from '@/lib/authority/paid-cohort-direction'
import { getTargetRange } from '@/lib/targets/target-ranges'
import { hydrateTargetOverrides } from '@/lib/targets/store'
import { proveStructuralContinuity } from '@/lib/modes/structural-continuity'
import {
  buildPragmaticProfitInputFromCohortPair,
  computeActiveAccountDailyBudget,
  readMediaBuyerRecommendationsEnabled,
} from '@/lib/economics/pragmatic-profit-evidence'
import {
  readModelledPerformance,
  readLinkageCoverage,
  buildModelledDirectionalEvidence,
  MODELLED_WINDOW_DAYS,
  modelledWindowBounds,
} from '@/lib/economics/modelled-performance'
import { isMoneyKind } from '@/lib/authority/action-authority'
import { enrichPragmaticMediaBuyerRecommendation } from './pragmatic-media-buyer'

// Bridge: turn the flag engine's output into grounded, range-aware Recommendation rows. EVERY flag is
// routed through buildRecommendation, so the grounding gate + no-oscillation + target-range evaluation
// apply uniformly — a flag never becomes a confident, actionable recommendation unless its evidence
// supports it (otherwise the gate downgrades it to 'hold'/'investigate'). On a dormant account this
// writes nothing (no flags); when ads run it populates /recommendations automatically.
//
// DECISION MEMORY (intelligence-next): after building, each rec is passed through applyDecisionMemory —
// a standing human decision on the same (entity, type) is respected (rejected/snoozed ⇒ held + cited,
// never silently regenerated as fresh actionable) — and setting-class recs cite the ledger's active
// recorded decision for the setting they propose to change.

/** Evidence blob stored on each flag (see flags engine). */
interface FlagEvidence {
  spend?: number | null
  bookings?: number | null
  leads?: number | null
  cpa?: number | null
  ctr?: number | null
  frequency?: number | null
  impressions?: number | null
  roas?: number | null
  window_days?: number | null
}

export interface FlagRow {
  id: string
  entity_level: 'ad' | 'adset' | 'campaign'
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  /** Meta entity identifiers are the paid-cohort unit keys. Older fixtures may omit them; omission
   * fails money authority closed instead of substituting a database UUID. */
  meta_campaign_id?: string | null
  meta_adset_id?: string | null
  meta_ad_id?: string | null
  flag_type: FlagType
  reason: string
  recommended_action: string | null
  watch_next: string | null
  window_days: number
  evidence: FlagEvidence | null
}

const FLAG_TO_REC: Record<FlagType, RecommendationType> = {
  winner: 'keep', // it's working — leave it running (don't auto-scale without a scale signal)
  scale_candidate: 'scale',
  loser: 'pause',
  watchlist: 'investigate',
  too_early: 'hold',
  creative_refresh: 'refresh_creative',
}

// These reverse cleanly, so the no-oscillation guard treats them as reversal-class but reversible.
const REVERSIBLE: ReadonlySet<RecommendationType> = new Set<RecommendationType>(['scale', 'pause', 'refresh_creative', 'reduce_budget', 'activate'])

function nativePeriodFrequency(ev: FlagEvidence, windowDays: number): number | null {
  // Historic flags may still contain a legacy multi-day frequency derived from summed daily reach.
  // Do not revive that value through a recommendation: only one-day warehouse evidence is native.
  return windowDays === 1 ? ev.frequency ?? null : null
}

function primaryMetric(flagType: FlagType, ev: FlagEvidence, windowDays: number): { metric: MetricKey; value: number | null } {
  if (flagType === 'creative_refresh') return { metric: 'frequency', value: nativePeriodFrequency(ev, windowDays) }
  return { metric: 'cpa', value: ev.cpa ?? null } // booking cost is the headline metric for perf flags
}

function metricValues(ev: FlagEvidence, windowDays: number): MetricValue[] {
  const out: MetricValue[] = []
  if (ev.cpa != null) out.push({ name: 'CPA', value: ev.cpa, unit: '$', source: 'meta_api' })
  if (ev.ctr != null) out.push({ name: 'CTR', value: ev.ctr, unit: '%', source: 'meta_api' })
  const frequency = nativePeriodFrequency(ev, windowDays)
  if (frequency != null) out.push({ name: 'Frequency', value: frequency, unit: '', source: 'meta_api' })
  if (ev.spend != null) out.push({ name: 'Spend', value: ev.spend, unit: '$', source: 'meta_api' })
  if (ev.bookings != null) out.push({ name: 'Bookings', value: ev.bookings, unit: 'count', source: 'meta_api' })
  return out
}

function subDaysStr(today: string, n: number): string {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** PURE: map one flag to the builder input (no I/O — unit-tested). */
/** The flag's REQUIRED target id, resolved strictly by its entity_level. Coalescing all three
 *  ids is WRONG for orphan detection: a deleted AD keeps its parent adset/campaign ids, so the coalesce
 *  silently retargets the recommendation at the parent instead of surfacing the orphan. */
export function flagTargetId(flag: Pick<FlagRow, 'entity_level' | 'ad_id' | 'adset_id' | 'campaign_id'>): string | null {
  return flag.entity_level === 'ad' ? flag.ad_id
    : flag.entity_level === 'adset' ? flag.adset_id
    : flag.campaign_id
}

export function paidCohortRefForFlag(
  flag: Pick<FlagRow, 'entity_level' | 'meta_campaign_id' | 'meta_adset_id' | 'meta_ad_id'>,
): { entityLevel: FlagRow['entity_level']; entityId: string } | null {
  const entityId = flag.entity_level === 'ad' ? flag.meta_ad_id
    : flag.entity_level === 'adset' ? flag.meta_adset_id
    : flag.meta_campaign_id
  return typeof entityId === 'string' && entityId.trim()
    ? { entityLevel: flag.entity_level, entityId }
    : null
}

/** PURE: choose the paid outcome from the immutable window that authorizes this direction. */
export function paidCohortOutcomeForAction(
  pair: PaidCohortPairEvidence | null,
  ref: PaidCohortUnitRef,
  kind: ActionKind,
  basis: AuthorityBasis,
): ScopedOutcomeEvidence | null {
  if (!pair || basis !== 'interaction_cohort_complete') return null
  const signal = kind === 'budget_scale' || kind === 'activate'
    ? pair.recentScale
    : kind === 'budget_cut' || kind === 'pause'
      ? pair.maturedCut
      : null
  if (!signal?.complete || signal.bookings === null) return null
  return {
    value: signal.bookings,
    scope: ref.entityLevel,
    provenance:
      `paid cohort ${signal.cohortKind} generation ${signal.generationId}; ` +
      `evaluation run ${pair.evaluationRunId}; interaction window ${signal.windowStart}..${signal.windowEnd}; ` +
      `unit ${ref.entityLevel}:${ref.entityId}`,
  }
}

export function flagToRecommendationInput(flag: FlagRow, entityName: string | null, today: string): BuildRecommendationInput {
  const ev = flag.evidence ?? {}
  const recType = FLAG_TO_REC[flag.flag_type] ?? 'investigate'
  const window = ev.window_days ?? flag.window_days ?? 7
  const primary = primaryMetric(flag.flag_type, ev, window)
  return {
    recommendation_type: recType,
    target_entity_type: flag.entity_level as TargetEntityType,
    target_entity_id: flagTargetId(flag),
    target_entity_name: entityName,
    observed_fact: flag.reason,
    // Stored flag prose is historical context, never authority. The final authority layer below renders
    // the only owner-facing action projection after every evidence/preflight gate has run.
    reason_for_action: 'Evaluate this observation through the structured evidence and authority gates.',
    basis: 'observed_performance',
    metric_values: metricValues(ev, window),
    date_range: { start: subDaysStr(today, Math.max(0, window - 1)), end: today },
    spend: ev.spend ?? 0,
    bookings: ev.bookings ?? null,
    window_days: window,
    // N8: the estimate warning belongs only on claims that REST on Meta-estimated bookings/revenue
    // (CPA-based). A frequency/fatigue claim (creative_refresh) doesn't — so it no longer eats the
    // estimate confidence cap, restoring the warning's signal on the recs that actually rely on it.
    uses_meta_estimate_as_revenue: primary.metric === 'cpa',
    attributed_share: null,
    account_dormant: false, // a flag implies the entity delivered; per-entity gates do the real gating
    reversible: REVERSIBLE.has(recType),
    primary_metric: primary,
    today,
  }
}

async function fetchEntityNames(
  db: ReturnType<typeof getAdminClient>,
  flags: FlagRow[]
): Promise<{ ad: Map<string, string>; adset: Map<string, string>; campaign: Map<string, string> }> {
  const adIds = [...new Set(flags.filter((f) => f.entity_level === 'ad' && f.ad_id).map((f) => f.ad_id!))]
  const adsetIds = [...new Set(flags.filter((f) => f.entity_level === 'adset' && f.adset_id).map((f) => f.adset_id!))]
  const campaignIds = [...new Set(flags.filter((f) => f.entity_level === 'campaign' && f.campaign_id).map((f) => f.campaign_id!))]
  const ad = new Map<string, string>()
  const adset = new Map<string, string>()
  const campaign = new Map<string, string>()
  if (adIds.length) {
    const { data } = await db.from('ads').select('id, ad_name').in('id', adIds)
    for (const r of (data ?? []) as { id: string; ad_name: string | null }[]) if (r.ad_name) ad.set(r.id, r.ad_name)
  }
  if (adsetIds.length) {
    const { data } = await db.from('adsets').select('id, adset_name').in('id', adsetIds)
    for (const r of (data ?? []) as { id: string; adset_name: string | null }[]) if (r.adset_name) adset.set(r.id, r.adset_name)
  }
  if (campaignIds.length) {
    const { data } = await db.from('campaigns').select('id, campaign_name').in('id', campaignIds)
    for (const r of (data ?? []) as { id: string; campaign_name: string | null }[]) if (r.campaign_name) campaign.set(r.id, r.campaign_name)
  }
  return { ad, adset, campaign }
}

/** One entity's daily spend/CPA point, with the date so callers can slice to a flag's own window. */
interface SeriesPoint extends DailyPoint {
  date: string
  syncedAt: string | null
}

/** Freshness belongs to the exact entity insight feed behind a flag. Use the newest valid warehouse
 * sync stamp (matching the dashboard's "last refreshed" semantics); no valid stamp fails closed. */
export function latestDataAgeHours(
  syncedAts: ReadonlyArray<string | null | undefined>,
  nowMs: number = Date.now(),
): number | null {
  let latestMs: number | null = null
  for (const value of syncedAts) {
    if (!value) continue
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) continue
    if (latestMs === null || parsed > latestMs) latestMs = parsed
  }
  return latestMs === null ? null : Math.max(0, (nowMs - latestMs) / 3_600_000)
}

export function insightWindowDataAgeHours(
  series: ReadonlyArray<{ date: string; syncedAt: string | null }>,
  sinceDate: string,
  nowMs: number = Date.now(),
): number | null {
  return latestDataAgeHours(
    series.filter((point) => point.date >= sinceDate).map((point) => point.syncedAt),
    nowMs,
  )
}

/** Latest source sync for the exact entity/window. No window data means no source-backed claim. */
export function insightWindowSyncedAt(
  series: ReadonlyArray<{ date: string; syncedAt: string | null }>,
  sinceDate: string,
): string | null {
  let latest: { timestamp: number; value: string } | null = null
  for (const point of series) {
    if (point.date < sinceDate || !point.syncedAt) continue
    const timestamp = Date.parse(point.syncedAt)
    if (!Number.isFinite(timestamp) || (latest !== null && timestamp <= latest.timestamp)) continue
    latest = { timestamp, value: new Date(timestamp).toISOString() }
  }
  return latest?.value ?? null
}

/**
 * Batch-fetch the reversal-class (N1) grounding inputs for all chosen flags in a handful of queries:
 *  • adsets.learning_stage for every referenced ad set (→ exited_learning),
 *  • daily_insights spend + cost_per_booking series per ad / ad set over the widest window (→ trend_stable).
 * All degrade to empty maps on any error (e.g. a column missing or unreadable), so a null grounding
 * field simply keeps the gate blocking — generation never breaks on them.
 */
async function fetchReversalGroundingData(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  chosen: FlagRow[],
  today: string
): Promise<{
  learningStage: Map<string, string | null>
  adSeries: Map<string, SeriesPoint[]>
  adsetSeries: Map<string, SeriesPoint[]>
  campaignSeries: Map<string, SeriesPoint[]>
}> {
  const learningStage = new Map<string, string | null>()
  const adSeries = new Map<string, SeriesPoint[]>()
  const adsetSeries = new Map<string, SeriesPoint[]>()
  const campaignSeries = new Map<string, SeriesPoint[]>()

  const adsetDbIds = [...new Set(chosen.map((f) => f.adset_id).filter((v): v is string => !!v))]
  const adIds = [...new Set(chosen.filter((f) => f.entity_level === 'ad').map((f) => f.ad_id).filter((v): v is string => !!v))]
  const adsetEntityIds = [...new Set(chosen.filter((f) => f.entity_level === 'adset').map((f) => f.adset_id).filter((v): v is string => !!v))]
  const campaignEntityIds = [...new Set(chosen.filter((f) => f.entity_level === 'campaign').map((f) => f.campaign_id).filter((v): v is string => !!v))]

  if (adsetDbIds.length) {
    const { data } = await db.from('adsets').select('id, learning_stage').in('id', adsetDbIds)
    for (const r of (data ?? []) as { id: string; learning_stage: string | null }[]) learningStage.set(r.id, r.learning_stage)
  }

  const maxWindow = chosen.reduce((m, f) => Math.max(m, f.evidence?.window_days ?? f.window_days ?? 7), 7)
  const sinceMax = subDaysStr(today, Math.max(0, maxWindow - 1))

  const loadSeries = async (level: 'ad' | 'adset' | 'campaign', keyCol: 'ad_id' | 'adset_id' | 'campaign_id', ids: string[], target: Map<string, SeriesPoint[]>) => {
    if (!ids.length) return
    const { data } = await db
      .from('daily_insights')
      .select(`${keyCol}, date_start, spend, cost_per_booking, synced_at`)
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', level)
      .gte('date_start', sinceMax)
      .lte('date_start', today)
      .in(keyCol, ids)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const id = r[keyCol] as string | null
      if (!id) continue
      const arr = target.get(id) ?? []
      arr.push({
        date: String(r.date_start),
        spend: Number(r.spend ?? 0),
        cpa: r.cost_per_booking == null ? null : Number(r.cost_per_booking),
        syncedAt: typeof r.synced_at === 'string' ? r.synced_at : null,
      })
      target.set(id, arr)
    }
  }

  await loadSeries('ad', 'ad_id', adIds, adSeries)
  await loadSeries('adset', 'adset_id', adsetEntityIds, adsetSeries)
  await loadSeries('campaign', 'campaign_id', campaignEntityIds, campaignSeries)

  return { learningStage, adSeries, adsetSeries, campaignSeries }
}

/**
 * Consume the flag generation's active snapshot → dedupe to one per (entity, flag_type) preferring the
 * widest window → route each through the grounded builder → publish the complete recommendation set ONCE
 * via replace_recommendation_generation: supersede-open + insert + head rotation in one
 * locked, CAS-guarded transaction, with cross-stage lineage to the source flag generation. Consumes the
 * snapshot the flag RPC returned (no re-query), so a concurrent flag run can't swap the set mid-build.
 * Throws (typed RPC message) on any publication failure, so the orchestrator's fail-stop halts the tick.
 */
export async function generateRecommendationsFromFlags(
  adAccountDbId: string,
  today: string,
  flagSnapshot: FlagRow[],
  flagGenerationId: string,
): Promise<{ generation_id: string; row_count: number }> {
  const db = getAdminClient()
  const claimAsOf = new Date().toISOString()
  // Publish the full rec set atomically: CAS on the current rec head + cross-stage lineage to the flag
  // generation these recs came from (the RPC rejects if that flag generation is no longer the flag head).
  const recHead = await readCurrentGeneration(db, adAccountDbId, 'recommendation')
  const publish = (
    rows: Record<string, unknown>[],
    decisions: ActionDecisionCommit[],
    metricClaims: MetricClaimSnapshotCommit[],
  ) =>
    replaceRecommendationGenerationWithMetricClaims(db, {
      adAccountId: adAccountDbId, generationId: randomUUID(), expectedPrev: recHead,
      sourceFlagGeneration: flagGenerationId, referenceDate: today, newRows: rows, decisions, metricClaims,
    })

  // Data-integrity guard: a flag whose LEVEL-REQUIRED target id is null points at a DELETED
  // entity — the RPC's orphan closure should have retired it, so one surviving into an ACTIVE snapshot
  // is a bug. Resolved strictly by entity_level (a deleted ad keeps its PARENT ids, so a coalesce would
  // miss exactly this survivor). Never build a rec with a wrong/null target; reject + alert loudly.
  const orphaned = flagSnapshot.filter((f) => flagTargetId(f) == null)
  if (orphaned.length > 0) {
    emitAlert({
      area: 'sync', severity: 'critical',
      message: `DATA INTEGRITY: ${orphaned.length} active flag(s) with a NULL level-required target survived orphan closure and were excluded from recommendation generation (flag ids: ${orphaned.map((f) => f.id).join(', ')}). Investigate replace_flag_generation orphan closure.`,
      dedupeKey: `orphan-flags:${adAccountDbId}`,
    })
  }
  const flags = flagSnapshot.filter((f) => flagTargetId(f) != null)
  // No active flags → publish an EMPTY generation. The RPC supersedes the open set (so the dashboard
  // reflects reality) and advances the rec head so the report can pin to a real, empty generation.
  if (flags.length === 0) return publish([], [], [])

  // One recommendation per (entity, flag_type) — keep the widest window (most evidence). Keyed by the
  // LEVEL-REQUIRED target id, matching the rec's actual target.
  const best = new Map<string, FlagRow>()
  for (const f of flags) {
    const key = `${f.entity_level}:${flagTargetId(f)}:${f.flag_type}`
    const cur = best.get(key)
    if (!cur || (f.window_days ?? 0) > (cur.window_days ?? 0)) best.set(key, f)
  }
  const chosen = [...best.values()]

  const names = await fetchEntityNames(db, chosen)
  const cohortRefs = [...new Map(chosen.flatMap((flag) => {
    const ref = paidCohortRefForFlag(flag)
    return ref ? [[paidCohortUnitKey(ref), ref] as const] : []
  })).values()]
  // This was the ONE unguarded read in the function, and a single Zod rejection on a single field of a
  // single stored row (`metrics.revenue_roas`, a ratio checked by a money validator) aborted
  // recommendation generation for EVERY flag in the account until the row was fixed.
  //
  // AVAILABILITY and INTEGRITY failures are NOT the same thing here, and conflating them inverts the
  // safety direction. An empty map is indistinguishable from "this account has no cohort rows", and
  // since the meta-modelled fallback is built from `readModelledPerformance` — which does not consult
  // these rows at all — degrading to empty would let a CORRUPTED stored row promote money actions from
  // the calendar-period basis (diagnostic_only) up to the modelled plane (owner_review). A data
  // integrity failure must never raise the tier.
  //
  // So: an unreadable source degrades to empty and the run continues, but a source that is readable
  // and WRONG additionally suppresses the modelled fallback for this run — because a corrupt
  // deterministic plane is a plane we cannot confirm would have agreed with the estimate.
  let cohortPairs: Map<string, PaidCohortPairEvidence> = new Map()
  let cohortEvidenceCorrupt = false
  if (cohortRefs.length > 0) {
    try {
      cohortPairs = (await readLatestPaidCohortPairs(db, adAccountDbId, cohortRefs)) ?? new Map()
    } catch (err) {
      const integrity = err instanceof PaidCohortStoreError
        && (err.code === 'SOURCE_DATA_INVALID' || err.code === 'SOURCE_PAGE_LIMIT_EXCEEDED')
      cohortEvidenceCorrupt = integrity
      const detail = err instanceof Error ? err.message : String(err)
      // Not a console.warn. Before this try/catch existed the same failure wrote itself into
      // api_sync_logs.error_message and held the sync at `partial`; swallowing it here without a
      // persisted trace would trade a total outage for a silent one, and a corrupt deterministic plane
      // going dark is exactly what must not happen twice.
      emitAlert({
        area: 'sync',
        severity: integrity ? 'critical' : 'warning',
        message: integrity
          ? `DATA INTEGRITY: the stored paid-cohort plane is unreadable (${detail}). Recommendations were generated WITHOUT it and the meta-modelled fallback was suppressed for this run, so money actions stay diagnostic-only. Investigate the writer, not the reader.`
          : `Paid cohort evidence was unavailable this run (${detail}). Recommendations were generated without deterministic cohort evidence.`,
        dedupeKey: `paid-cohort-read:${adAccountDbId}`,
      })
    }
  }
  // Hydration is repeated here intentionally: this function is also an integration-tested entry
  // point, not only an orchestrator child. A warm process or direct invocation must not inherit stale
  // targets from another request.
  const targetPolicy = await hydrateTargetOverrides()
  const cpaTarget = getTargetRange('cpa')
  const mediaBuyerRecommendationsEnabled = await readMediaBuyerRecommendationsEnabled(db, adAccountDbId)
  const currentAccountDailyBudget = mediaBuyerRecommendationsEnabled
    ? await computeActiveAccountDailyBudget(db, adAccountDbId)
    : null

  // META-MODELLED FALLBACK CONTEXT. Read once per run, not per flag.
  // linkageCoverage is the guard that stops a near-zero exact-join cohort being read as a loss:
  // when it sits far under the 0.60 bar, cohort zeros describe the tracking rather than the ads.
  const modelledLinkageCoverage = mediaBuyerRecommendationsEnabled
    ? await readLinkageCoverage(
        db, adAccountDbId, subDaysStr(today, MODELLED_WINDOW_DAYS * 2), subDaysStr(today, 1),
      )
    : null

  // Learning + governed-external-knowledge context (all degrade gracefully to prior behavior):
  //  • track record: this account's own win-rate per flag_type (adjuster in the gate),
  //  • prior: account win-rate wins; a registered cross-niche benchmark is a weak fallback; else neutral,
  //  • external knowledge: live expert_insights attached as cited test-inspiration (never a fact source).
  const { data: outcomeRows } = await db
    .from('recommendation_outcomes')
    .select('flag_type, metric_name, outcome, outcome_note, review_status, evaluated_at')
    .eq('ad_account_id', adAccountDbId)
    .not('outcome', 'is', null)
  // tallyTrackRecord applies the human review gate (approved-only) + the estimate-only exclusion, and
  // recency-weights lessons by evaluated_at so old lessons fade.
  const tally = tallyTrackRecord(
    (outcomeRows ?? []) as { flag_type: string | null; metric_name: string | null; outcome: string | null; outcome_note: string | null; review_status: string | null; evaluated_at: string | null }[],
    today,
  )
  const benchmark = await getBenchmarkPrior(adAccountDbId)
  const prior = resolvePriorWinRate(overallWinRate(tally), benchmark)
  const insights = await getExpertInsightsForRecommendations(adAccountDbId, today)
  // Decision memory: standing human decisions (stable-keyed) + the setup ledger. Both degrade to empty
  // on any error, so generation never breaks on them.
  const decisions = await getDecisionsForAccount(adAccountDbId)
  const ledgerRows: LedgerRow[] = await getLedgerForAccount(adAccountDbId)

  // ── N1: reversal-class grounding inputs, batched once for all chosen flags (no N+1) ──
  //  • learning_stage per ad set → exited_learning
  //  • daily spend/CPA series per entity → trend_stable
  //  • days_since_last_change comes from the ledger already fetched above.
  const { learningStage, adSeries, adsetSeries, campaignSeries } = await fetchReversalGroundingData(db, adAccountDbId, chosen, today)

  // ── The EVIDENCE GATE. Previously decideRecommendation had no production caller at all, so
  // money-moving recommendations were emitted on exactly the evidence the policy exists to reject.
  // Gathering degrades to FROZEN on any read failure, never to permissive defaults.
  const metaAccountId = await resolveMetaAccountId(db, adAccountDbId)
  let evidence: AccountEvidence
  try {
    evidence = await gatherAccountEvidence(db, adAccountDbId, metaAccountId, { today, windowDays: 30 })
  } catch (err) {
    evidence = frozenEvidence(30, `evidence gathering failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  for (const w of evidence.gatherWarnings) console.warn(`[Recs] evidence: ${w}`)
  const objective = await resolveAccountObjective(adAccountDbId, db)
  const representativePair = cohortPairs.values().next().value as PaidCohortPairEvidence | undefined
  const structuralContinuity = representativePair
    ? await proveStructuralContinuity(db, adAccountDbId, [
        { start: representativePair.maturedCut.windowStart, end: representativePair.maturedCut.windowEnd },
        { start: representativePair.recentScale.windowStart, end: representativePair.recentScale.windowEnd },
      ])
    : null

  // The modelled basis is a strict FALLBACK — evaluateDirection consults it only when no contribution
  // evidence of any kind exists, i.e. exactly when `representativePair` is undefined and the continuity
  // above is therefore null. Gating it on cohort-derived continuity gated the fallback on the very
  // thing it is a fallback for, so every modelled money candidate died at "Setup continuity is not
  // explicitly proven" — most money candidates did, all carrying the
  // correct (plane, basis) pair the money-quarantine CHECK admits, with the toggle on. That is the same
  // shape the CHECK's own history diagnosed in the earlier escape hatch: "the hatch was wired back into the quarantine it was meant to escape".
  //
  // Continuity is a real computation over daily_insights, not a token — it just has to be run over the
  // periods the modelled rules actually judge. Same function, same rigour, correct windows.
  const modelledWindows = modelledWindowBounds(today)
  const modelledContinuity = mediaBuyerRecommendationsEnabled
    ? await proveStructuralContinuity(db, adAccountDbId, [
        { start: modelledWindows.priorStart, end: modelledWindows.priorEnd },
        { start: modelledWindows.recentStart, end: modelledWindows.recentEnd },
      ])
    : null
  // `??` and not `||`: a PROVEN material change (false) must never be replaced by the modelled read.
  // Only an unprovable cohort continuity (null) defers to the windows the modelled basis is judged on.
  const effectiveContinuity = structuralContinuity ?? modelledContinuity

  const publications: RecommendationAuthorityPublication[] = []
  const metricClaimSnapshots: MetricClaimSnapshotCommit[] = []
  for (const f of chosen) {
    const name =
      f.entity_level === 'ad' ? names.ad.get(f.ad_id ?? '') ?? null
      : f.entity_level === 'adset' ? names.adset.get(f.adset_id ?? '') ?? null
      : names.campaign.get(f.campaign_id ?? '') ?? null
    const recInput = flagToRecommendationInput(f, name, today)

    // N1: thread the reversal-class grounding fields so a well-grounded scale/pause keeps its type
    // instead of collapsing to hold. Each stays null (⇒ gate keeps blocking) when data is thin.
    const entityKey = entityKeyFor(recInput.target_entity_id ?? null)
    const sinceStr = subDaysStr(today, Math.max(0, recInput.window_days - 1))
    const series = (
      f.entity_level === 'ad' ? adSeries.get(f.ad_id ?? '')
      : f.entity_level === 'adset' ? adsetSeries.get(f.adset_id ?? '')
      : campaignSeries.get(f.campaign_id ?? '')
    ) ?? []
    const windowSeries = series.filter((p) => p.date >= sinceStr)
    recInput.data_age_hours = insightWindowDataAgeHours(series, sinceStr)
    recInput.trend_stable = computeTrendStable(
      windowSeries.map((p): DailyPoint => ({ spend: p.spend, cpa: p.cpa }))
    )
    recInput.exited_learning = deriveExitedLearning(f.adset_id ? learningStage.get(f.adset_id) ?? null : null)
    const lastChange = historyForEntity(ledgerRows, entityKey, name, f.entity_level).find((r) => r.action_taken)
    recInput.days_since_last_change = daysSinceChange(lastChange?.created_at ?? null, today)

    const tr = tally[f.flag_type]
    if (tr && tr.decisive > 0) recInput.track_record = { wins: tr.wins, decisive: tr.decisive, priorWinRate: prior.priorWinRate, k: prior.k }

    const area = areaForFlag(f.flag_type)
    const relevant: UsableInsight[] = insights.filter((i) => i.applicable_area === null || i.applicable_area === area)
    if (relevant.length) recInput.external_knowledge = relevant.map((i) => ({ id: i.id, claim: i.claim, source: i.source, confidence: i.confidence }))

    let rec = buildRecommendation(recInput)

    // Respect the standing human decision on this (entity, type) — a rejected/snoozed rec is held +
    // cited, never re-pushed as fresh actionable. (entityKey computed above for N1 grounding.)
    const decision = decisions.get(decisionMapKey(entityKey, rec.recommendation_type)) ?? null
    rec = applyDecisionMemory(rec, decision, today).rec

    // Setting-class recs cite the ledger's active recorded decision for the setting they'd change.
    const ledgerNote = settingDecisionContext(ledgerRows, { entityKey, entityName: name, entityType: f.entity_level }, rec.recommendation_type)
    if (ledgerNote) {
      rec = {
        ...rec,
        what_could_make_this_wrong: [...rec.what_could_make_this_wrong, ledgerNote],
        grounding: { ...rec.grounding, reasons: [...rec.grounding.reasons, ledgerNote] },
      }
    }

    // ── Gate on the recommendation's INTENT, not its post-grounding type ──────────────────
    // The existing grounding gate may already have collapsed a money move to 'hold'. Gating the
    // collapsed type would mean the evidence policy never ran at all on exactly the cases it exists
    // for — and would silently pass whenever the grounding gate happened to approve. So the intended
    // type (FLAG_TO_REC for this flag) is what gets gated, and the verdict is recorded either way.
    const intendedType = FLAG_TO_REC[f.flag_type] ?? rec.recommendation_type
    const actionKind = actionKindForRecommendation(intendedType)
    const cohortRef = paidCohortRefForFlag(f)
    const storedPair = cohortRef ? cohortPairs.get(paidCohortUnitKey(cohortRef)) ?? null : null
    const interactionCohorts = toInteractionCohortPairSignal(storedPair)
    const pragmaticProfit = mediaBuyerRecommendationsEnabled && interactionCohorts
      ? buildPragmaticProfitInputFromCohortPair(interactionCohorts, currentAccountDailyBudget)
      : undefined
    // Modelled fallback is read only for MONEY kinds on a resolvable entity — non-money actions
    // never consult it, and it is ignored downstream whenever contribution evidence exists.
    // `!cohortEvidenceCorrupt`: see the read above. A corrupt deterministic plane must not be silently
    // upgraded into a modelled one — the modelled numbers are independent of it, so nothing here would
    // otherwise notice that the plane meant to check them is broken.
    const modelledEvidence = mediaBuyerRecommendationsEnabled && !cohortEvidenceCorrupt
      && cohortRef && isMoneyKind(actionKind)
      ? buildModelledDirectionalEvidence({
          ...(await readModelledPerformance(
            db, adAccountDbId, cohortRef.entityLevel, cohortRef.entityId, today,
          )),
          targetCpa: cpaTarget.healthy,
          watchCpa: cpaTarget.watch,
          linkageCoverage: modelledLinkageCoverage,
          blendedRoas: null,
        })
      : null
    const cohortAuthority = resolvePaidCohortActionEvidence({
      modelled: modelledEvidence,
      cohorts: interactionCohorts,
      kind: actionKind,
      fallbackPlane: f.flag_type === 'creative_refresh' ? 'structural' : 'meta_modelled',
      objective,
      structuralContinuity: effectiveContinuity,
      targetCpa: cpaTarget.healthy,
      maxCpa: cpaTarget.watch,
      targetPolicyStatus: targetPolicy.status,
      profit: pragmaticProfit,
    })
    const paidCohortOutcomes = cohortRef
      ? paidCohortOutcomeForAction(storedPair, cohortRef, actionKind, cohortAuthority.basis)
      : null
    // An AD flag carries its PARENT adset_id, and throwing it away meant every
    // ad-level decision resolved against a frozen placeholder audience instead of its real ad set.
    // A CAMPAIGN flag supplies its member ad sets so campaign context rolls up conservatively.
    const adsetDbId = f.adset_id ?? null
    const memberAudiences =
      f.entity_level === 'campaign' && f.campaign_id
        ? (evidence.adsetIdsByCampaign.get(f.campaign_id) ?? [])
            .map((id) => evidence.audienceByAdset.get(id))
            .filter((a): a is NonNullable<typeof a> => a !== undefined)
        : null
    const gated = gateRecommendation(intendedType, {
      adsetDbId,
      // A CAMPAIGN flag has no adset_id by design; without its campaign id the decision context
      // could only ever resolve to unknown + frozen.
      campaignDbId: f.campaign_id ?? null,
      entityLevel: f.entity_level,
      evidence,
      // The scale proposal is derived inside the gate from the verified current budget.
      proposedBudget: null,
      memberAudiences,
      // Identity for matching experiment control/challenger references — without it, causal evidence
      // and running conflicts cannot be scoped to this entity and fail closed.
      entityKey,
      entityName: name,
      paidCohortOutcomes,
    })
    if (gated) {
      const d = gated.decision
      // Persist the preflight trace whether it clears or blocks. Otherwise a structurally valid
      // candidate jumps from legacy grounding straight to final authority with no durable proof that
      // optimization unit, targeting and experiment conflicts were actually checked.
      const stillMoneyMoving = MONEY_MOVING_TYPES.has(rec.recommendation_type)
      const gateNote =
        `DECISION GATE: verdict ${d.verdict} at the ${d.optimizationUnit} unit — blocked by ` +
        `${d.blockedBy.join(', ') || 'none'}. ${d.summary}`
      rec = {
        ...rec,
        recommendation_type: gated.downgradeTo !== null && stillMoneyMoving
          ? gated.downgradeTo
          : rec.recommendation_type,
        what_could_make_this_wrong: [...rec.what_could_make_this_wrong, d.counterfactualRisk],
        grounding: {
          ...rec.grounding,
          reasons: [
            ...rec.grounding.reasons,
            gateNote,
            `Business truth: ${d.evidence.businessTruth}`,
            `Web-attributed: ${d.evidence.webAttributed}`,
            `Meta modelled: ${d.evidence.metaModeled}`,
            `View/click mix: ${d.evidence.viewClickMix}`,
            `Creative diversity: ${d.evidence.creativeDiversity}`,
            `Threshold: ${d.decisionThreshold}`,
          ],
        },
      }
    }

    // FINAL authority is separate from, and downstream of, the structural/evidence preflight. Resolve
    // the exact Meta unit from the flag's immutable ids, then read its two directions from ONE stored
    // evaluation run. Missing ids, missing units, blocked generations and read failures never borrow an
    // account aggregate or a different entity's result.
    const authority = decideRecommendationAuthority({
      recommendation: rec,
      intendedType,
      basis: cohortAuthority.basis,
      plane: cohortAuthority.plane,
      evidence: cohortAuthority.evidence,
      preflight: gated?.decision ?? null,
      pragmaticMediaBuyerEnabled: mediaBuyerRecommendationsEnabled,
    })
    rec = enrichPragmaticMediaBuyerRecommendation(rec, {
      enabled: mediaBuyerRecommendationsEnabled,
      authorityTier: authority.tier,
      pair: interactionCohorts,
      currentAccountDailyBudget,
      targetCpa: cpaTarget.healthy,
      maxCpa: cpaTarget.watch,
    })
    // ActionAuthority is intentionally the LAST writer of type, copy and approval posture. Optional
    // booked-value enrichment cannot overwrite a diagnostic downgrade or impersonate owner review.
    rec = applyRecommendationAuthority(rec, intendedType, authority)
    const metricClaims = buildRecommendationMetricClaimBindings({
      sourceFlagId: f.id,
      sourceFlagGenerationId: flagGenerationId,
      target: { level: f.entity_level, id: rec.target_entity_id ?? '' },
      window: rec.date_range ?? { start: today, end: today },
      metrics: rec.metric_values,
      sourceObservedAt: insightWindowSyncedAt(series, sinceStr),
      asOf: claimAsOf,
    })
    // Empty lineage is intentional: the recommendation stays diagnostic and the downstream owner
    // decision boundary quarantines it rather than manufacturing an identifier from the rec row.
    rec = { ...rec, metric_claim_ids: metricClaims.claimIds }
    metricClaimSnapshots.push(...metricClaims.snapshots)
    const row = recToRow(rec, f.id)
    const sourceId = String(row.id)
    publications.push({
      row,
      decision: authority,
      commit: recommendationDecisionCommit({
        sourceId, recommendation: rec, intendedType, decision: authority,
        evidence: cohortAuthority.evidence,
        paidCohortLineage: cohortAuthority.basis === 'interaction_cohort_complete' && storedPair
          ? {
              recentGenerationId: storedPair.recentScale.generationId,
              maturedGenerationId: storedPair.maturedCut.generationId,
            }
          : null,
      }),
    })
  }

  const arbitrated = arbitrateRecommendationPublications(adAccountDbId, publications)
  return publish(
    arbitrated.map((p) => p.row),
    arbitrated.map((p) => p.commit),
    metricClaimSnapshots,
  )
}

/** The account's REAL Meta account id — the resolver's cross-account fail-closed check needs it. */
async function resolveMetaAccountId(db: ReturnType<typeof getAdminClient>, adAccountDbId: string): Promise<string> {
  try {
    const { data } = await db.from('ad_accounts').select('account_id').eq('id', adAccountDbId).maybeSingle()
    const id = (data?.account_id as string | undefined) ?? null
    // An unknown account id must NOT match any audience's owning account, so every audience fails
    // closed rather than being silently treated as same-account.
    return id ?? '__unresolved_account__'
  } catch {
    return '__unresolved_account__'
  }
}
