import { getAdminClient } from '@/lib/supabase/admin'
import { resolvePrior, recencyWeight, type BenchmarkPrior } from '@/lib/learning/model'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

// Governed external-knowledge + track-record readers for the structured recommendation builder.
//
// External knowledge REUSES the LIVE expert_insights table (populated by runSignalsFetcher: RSS +
// Claude relevance-judging). It is NEVER a fact source — the builder attaches it as cited test-
// inspiration only, and the grounding gate demotes any external-basis action to a labeled hypothesis.
// Benchmark priors come from memory_entries (category='benchmark_prior') and are a weak, discounted,
// cross-niche prior (account ALWAYS wins). None are registered today ⇒ everything below defaults to
// exactly the prior behavior (neutral prior, no external citations).

export interface UsableInsight {
  id: string
  claim: string
  source: string
  confidence: string | null
  applicable_area: string | null
  caveat?: string | null
}

interface ExpertInsightRow {
  id: string
  summary: string | null
  title: string | null
  applies_to_account: boolean | null
  confidence: string | null
  applicable_area: string | null
  expires_at: string | null
  source_id: string | null
  review_status?: string | null
  what_not_to_assume: string | null
}

/** PURE: keep only insights that apply to Example Studio, haven't expired as of `today` (YYYY-MM-DD),
 *  AND the owner has APPROVED (`expert_insights.review_status` gate — "approved expert knowledge" literally).
 *  Fail-closed: a missing/pending/rejected review_status is never citable. */
export function filterUsableInsights<T extends { applies_to_account: boolean | null; expires_at: string | null; review_status?: string | null }>(
  rows: T[],
  today: string
): T[] {
  return rows.filter((r) => r.applies_to_account === true && r.review_status === 'approved' && (!r.expires_at || r.expires_at >= today))
}

/** Read the live expert_insights that are relevant + unexpired + owner-approved, mapped to cited
 *  inspiration items. Returns [] on any error or when nothing is ingested (the common case today) —
 *  including when `review_status` is unavailable (the select errors ⇒ fail-closed, nothing citable). */
export async function getExpertInsightsForRecommendations(
  adAccountDbId: string,
  today: string,
  limit = 5
): Promise<UsableInsight[]> {
  const db = getAdminClient()
  const { data, error } = await db
    .from('expert_insights')
    .select('id, summary, title, applies_to_account, confidence, applicable_area, expires_at, source_id, review_status, what_not_to_assume')
    .eq('ad_account_id', adAccountDbId)
    .order('published_at', { ascending: false })
    .limit(50)
  if (error) return []
  const usable = filterUsableInsights((data ?? []) as ExpertInsightRow[], today).slice(0, limit)
  if (usable.length === 0) return []

  // Best-effort source names for provenance (empty map is fine).
  const sourceIds = [...new Set(usable.map((r) => r.source_id).filter((s): s is string => !!s))]
  const names = new Map<string, string>()
  if (sourceIds.length) {
    const { data: srcs } = await db.from('expert_sources').select('id, name').in('id', sourceIds)
    for (const s of (srcs ?? []) as { id: string; name: string | null }[]) if (s.name) names.set(s.id, s.name)
  }
  return projectCitableInsights(usable, names, limit)
}

export function projectCitableInsights(
  rows: Array<Pick<ExpertInsightRow, 'id' | 'summary' | 'title' | 'confidence' | 'applicable_area' | 'source_id' | 'what_not_to_assume'>>,
  sourceNames: ReadonlyMap<string, string>,
  limit: number,
): UsableInsight[] {
  return rows
    .filter((row) => !!row.source_id && sourceNames.has(row.source_id))
    .slice(0, limit)
    .map((r) => ({
    id: r.id,
    claim: (r.summary ?? r.title ?? '').slice(0, 240),
    source: sourceNames.get(r.source_id!)!,
    confidence: r.confidence ?? null,
    applicable_area: r.applicable_area ?? null,
    caveat: r.what_not_to_assume ?? null,
  }))
}

export interface TrackRecordTally {
  wins: number
  decisive: number
}

interface OutcomeRow {
  flag_type: string | null
  metric_name?: string | null
  outcome: string | null
  outcome_note: string | null
  review_status?: string | null
  /** When the lesson was scored — powers recency weighting. Absent ⇒ weight 1 (back-compat). */
  evaluated_at?: string | null
}

/** PURE: tally worked / decisive (worked+failed) per flag_type. Gates: (1) the human REVIEW gate —
 *  only OWNER-APPROVED outcomes count (`review_status`); (2) estimate-only lessons excluded (mirrors
 *  patterns.ts). Recency: when `today` is given, each lesson is weighted by
 *  recencyWeight(age, half-life 17d) so a 6-month-old win no longer counts like last week's — wins and
 *  decisive become weighted sums (shrinkage downstream handles fractions fine). Without `today` the
 *  weights are 1 (exactly the prior behavior). */
export function tallyTrackRecord(rows: OutcomeRow[], today?: string): Record<string, TrackRecordTally> {
  const now = today ? new Date(today + 'T00:00:00Z').getTime() : null
  const out: Record<string, TrackRecordTally> = {}
  for (const r of rows) {
    if (!isCausalContributionMetric(r.metric_name)) continue
    if (r.review_status !== 'approved') continue
    if ((r.outcome_note ?? '').includes('estimate-only')) continue
    let w = 1
    if (now !== null && r.evaluated_at) {
      const evalTs = new Date(r.evaluated_at).getTime()
      if (Number.isFinite(evalTs)) w = recencyWeight(Math.max(0, (now - evalTs) / 86_400_000))
    }
    const t = r.flag_type ?? 'unknown'
    if (!out[t]) out[t] = { wins: 0, decisive: 0 }
    if (r.outcome === 'worked') { out[t].wins += w; out[t].decisive += w }
    else if (r.outcome === 'failed') { out[t].decisive += w }
  }
  return out
}

/** PURE: the account's overall win-rate across all decisive lessons (null if none) — the neutral point
 *  the track-record adjuster tempers against. */
export function overallWinRate(tally: Record<string, TrackRecordTally>): number | null {
  let wins = 0
  let decisive = 0
  for (const t of Object.values(tally)) { wins += t.wins; decisive += t.decisive }
  return decisive > 0 ? wins / decisive : null
}

/** Resolve the prior win-rate (+ pseudo-count k) for the adjuster: account history wins; a registered
 *  benchmark is a weak discounted fallback; else neutral 0.5. */
export function resolvePriorWinRate(
  accountWinRate: number | null,
  benchmark: BenchmarkPrior | null
): { priorWinRate: number; k: number } {
  const p = resolvePrior(accountWinRate, benchmark, 'winRate')
  return { priorWinRate: p.mean, k: p.k }
}

/** Read a registered cross-niche benchmark win-rate/CPA prior from memory_entries. None today ⇒ null ⇒
 *  the adjuster falls back to account history or a neutral prior. Account data ALWAYS wins over this. */
export async function getBenchmarkPrior(adAccountDbId: string): Promise<BenchmarkPrior | null> {
  void adAccountDbId
  // Legacy benchmark priors encode CPA/win-rate heuristics, not causal incremental contribution.
  // They stay quarantined until a governed causal-contribution benchmark contract exists.
  return null
}

/** Coarse map from a flag type to the expert_insights applicable_area used for relevance matching. */
export function areaForFlag(flagType: string): string | null {
  if (flagType === 'creative_refresh') return 'creative'
  if (flagType === 'scale_candidate') return 'budget'
  return null // winner/loser/etc. — match only area-agnostic insights
}
