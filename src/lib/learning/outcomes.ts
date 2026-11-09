import { ATTRIBUTION_SETTLE_DAYS } from '@/lib/insights/settle-window'
import { getAdminClient } from '@/lib/supabase/admin'
import { getTargetRange, MIN_ATTRIBUTED_SHARE } from '@/lib/targets/target-ranges'
import { getGa4ConfirmationTelemetryByCampaign } from '@/lib/ga4/client'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { isActionConfirmed, type RecordedAction } from './action-confirmation'
import { decisiveCpaVsTarget } from './model'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
import { SPEND_FLOORS } from '@/config/spend-floors'

// Recommendation-outcome learning: score whether each flag/recommendation the system made
// actually worked after a window, then persist the lesson (so the agent learns from wins AND mistakes).
//
// GUARDRAILS — to stop FALSE learning:
//   - never mark worked/failed without enough post-window spend AND bookings → use 'inconclusive',
//   - a "pause/refresh" rec that kept spending materially is treated as NOT IMPLEMENTED (inconclusive),
//     not "failed" — you can't blame a recommendation that was never acted on,
//   - skip evaluation entirely during dormant account periods (no spend to learn from),
//   - tag each lesson with a category (creative/budget/performance) and a classification confidence.

// Override-aware (active range = defaults + Performance-Targets overrides). TARGET_CPA was unused here.
const maxCpa = () => getTargetRange('cpa').watch
const EVAL_WINDOW_DAYS = 7
/** AppointmentConfirmed conversions restate up to the 7d-click window AND back-days are only restated
 *  while inside the sync's rolling 7-day lookback — so a post-window scored the moment it closes is
 *  systematically undercounted (postBookings low ⇒ postCpa high ⇒ false 'failed' lessons). Score only
 *  once every post-window day has fully settled. (frozen-window scorer.) */
export { ATTRIBUTION_SETTLE_DAYS } from '@/lib/insights/settle-window'

/** Coverage assumed when GA4 is CONFIGURED but ERRORING: 0 ⇒ decisive lessons are downgraded to
 *  estimate-only (fail closed for learning). Not-configured stays `null` (no downgrade). */
export const GA4_ERROR_COVERAGE = 0

// Hard min-sample gates before any decisive (worked/failed) verdict.
const MIN_POST_SPEND_DECISIVE = REC_THRESHOLDS.MIN_SPEND_TO_JUDGE // $20
const MIN_POST_BOOKINGS_DECISIVE = 2
const stoppedSpend = () => SPEND_FLOORS.stoppedEntity // ≤ this post-spend (account currency) ⇒ effectively stopped (rec acted on)
// One-bad-day guard: a decisive verdict needs sustained delivery, not a single anomalous day in the
// window. Applied only when the caller supplies the active-day count (evaluateRecommendationOutcomes).
const MIN_ACTIVE_DAYS_DECISIVE = 3

export type ClassificationConfidence = 'high' | 'medium' | 'low'

/** Precision of a count-derived rate, not causal confidence. Poisson relative standard error is
 * 1/sqrt(n); active-day coverage prevents one burst day from receiving a stable-window label. */
export function classifyConfidence(postBookings: number, postActiveDays?: number): ClassificationConfidence {
  if (!Number.isFinite(postBookings) || postBookings <= 0) return 'low'
  const relativeStandardError = 1 / Math.sqrt(postBookings)
  if (relativeStandardError <= 0.25 && (postActiveDays === undefined || postActiveDays >= 7)) return 'high'
  if (relativeStandardError <= 0.5 && (postActiveDays === undefined || postActiveDays >= 3)) return 'medium'
  return 'low'
}

/** Lesson category so creative / budget / performance lessons stay separable downstream. */
export function lessonCategory(flagType: string): 'creative' | 'budget' | 'performance' {
  if (flagType === 'creative_refresh') return 'creative'
  if (flagType === 'scale_candidate') return 'budget'
  return 'performance'
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

type Outcome = 'worked' | 'failed' | 'inconclusive'

/** Hook% (p25-views ÷ impressions) and hold% (thruplays ÷ p25-views) from summed video counts over a
 *  window. Null when there's no video delivery. Percent scale (matches verdict.ts / the creative Lab). */
export function hookHoldPct(impressions: number, p25: number, thruplays: number): { hook: number | null; hold: number | null } {
  return {
    hook: impressions > 0 && p25 > 0 ? (p25 / impressions) * 100 : null,
    hold: p25 > 0 && thruplays > 0 ? (thruplays / p25) * 100 : null,
  }
}

/** For a creative_refresh outcome: a "hook X%→Y%, hold A%→B%" note comparing the pre-flag window to the
 *  post-flag window. Delivery context only: it cannot classify commercial success without a governed
 *  causal incremental-contribution outcome. */
export function creativeSignalNote(
  pre: { impressions: number; p25: number; thruplays: number },
  post: { impressions: number; p25: number; thruplays: number }
): string {
  const a = hookHoldPct(pre.impressions, pre.p25, pre.thruplays)
  const b = hookHoldPct(post.impressions, post.p25, post.thruplays)
  const parts: string[] = []
  if (a.hook !== null && b.hook !== null) parts.push(`hook ${a.hook.toFixed(1)}%→${b.hook.toFixed(1)}%`)
  if (a.hold !== null && b.hold !== null) parts.push(`hold ${a.hold.toFixed(1)}%→${b.hold.toFixed(1)}%`)
  return parts.length ? ` Creative signal (context, not the verdict): ${parts.join(', ')}.` : ''
}

function hypothesisFor(flagType: string): string {
  switch (flagType) {
    case 'loser': return 'Required counterfactual: the owner-confirmed intervention causes greater incremental contribution than the governed comparison.'
    case 'creative_refresh': return 'Required counterfactual: the creative replacement causes greater incremental contribution than the governed comparison; CTR is diagnostic only.'
    case 'winner': return 'Required counterfactual: unchanged delivery creates positive incremental contribution over the governed comparison.'
    case 'scale_candidate': return 'Required counterfactual: the owner-confirmed spend change causes more absolute incremental contribution dollars than the governed comparison.'
    default: return 'Required counterfactual: the owner-confirmed intervention causes more incremental contribution dollars than the governed comparison.'
  }
}

function scoreFlagBase(
  flagType: string,
  postSpend: number,
  postBookings: number,
  postCpa: number | null,
  postActiveDays?: number
): { outcome: Outcome; note: string; confidence: ClassificationConfidence } {
  const cpaStr = postCpa !== null ? `${formatMoney(postCpa)}` : 'n/a'
  const confidence = classifyConfidence(postBookings, postActiveDays)
  const enoughActiveDays = postActiveDays === undefined || postActiveDays >= MIN_ACTIVE_DAYS_DECISIVE

  if (flagType === 'creative_refresh') {
    // A creative refresh replaces the ad (new creative launched, old one paused). Scoring the OLD flagged
    // entity's post-window measures the wrong thing — the paused old ad going quiet says nothing about
    // whether the REPLACEMENT worked. Until compound replacement confirmation exists, a refresh outcome
    // is INCONCLUSIVE and never enters memory (gateOutcomeOnConfirmedAction forces learn:false).
    return { outcome: 'inconclusive', note: `Creative refresh cannot be scored from the old entity's window (replacement not linked); not decisive.`, confidence: 'low' }
  }

  if (flagType === 'loser') {
    // We recommended pausing. We can only credit it if it was ACTED ON.
    if (postSpend <= stoppedSpend()) {
      // Acted on: the pause was implemented. That is IMPLEMENTATION success — NOT proof it helped
      // (no counterfactual: we can't know the entity wouldn't have recovered on its own). Low confidence.
      return { outcome: 'worked', note: `Acted on — entity effectively stopped after the flag (post-spend ${formatMoney(postSpend)}). Implementation confirmed; effect not independently measured (no counterfactual).`, confidence: 'low' }
    }
    // Kept spending materially means the pause was not implemented or the recorded state conflicts
    // with delivery. A later point-CPA cannot validate a pause without a counterfactual.
    // Do NOT mark "failed" — you cannot blame a recommendation that was never acted on.
    if (postSpend >= MIN_POST_SPEND_DECISIVE) {
      return { outcome: 'inconclusive', note: `Kept spending ${formatMoney(postSpend)} after the flag — likely NOT implemented; cannot attribute an outcome to the recommendation.`, confidence: 'low' }
    }
    return { outcome: 'inconclusive', note: `Thin post-period data (${formatMoney(postSpend)}, ${postBookings} bookings) — not enough to judge.`, confidence: 'low' }
  }

  // winner / scale_candidate — we recommended keeping/scaling. Need real post-period volume to judge.
  if (postSpend < MIN_POST_SPEND_DECISIVE) {
    return { outcome: 'inconclusive', note: `Too little post-period spend (${formatMoney(postSpend)} < ${formatMoneyAmount(MIN_POST_SPEND_DECISIVE)}) to judge whether keeping/scaling held.`, confidence: 'low' }
  }
  if (postBookings < MIN_POST_BOOKINGS_DECISIVE) {
    return { outcome: 'inconclusive', note: `Only ${postBookings} post-period booking(s) on ${formatMoney(postSpend)} — below the ${MIN_POST_BOOKINGS_DECISIVE}-booking bar to call it worked or failed.`, confidence: 'low' }
  }
  // One-bad-day guard: don't let a single anomalous day carry a decisive verdict.
  if (!enoughActiveDays) {
    return { outcome: 'inconclusive', note: `Only ${postActiveDays} active delivering day(s) in the ${EVAL_WINDOW_DAYS}-day window — too few to rule out a one-day anomaly; not decisive.`, confidence: 'low' }
  }
  const ceiling = maxCpa()
  if (postCpa !== null && ceiling === null) {
    return { outcome: 'inconclusive', note: `${cpaStr} post-period CPA; no CPA target is set, so it is not judged.`, confidence: 'low' }
  }
  if (postCpa !== null && ceiling !== null) {
    const decisive = decisiveCpaVsTarget(postSpend, postBookings, ceiling)
    if (decisive === 'better') {
      return { outcome: 'worked', note: `The 90% count-uncertainty interval stays below the ${formatMoneyAmount(ceiling)} CPA ceiling (${cpaStr} point estimate; ${postBookings} bookings).`, confidence }
    }
    if (decisive === 'worse') {
      return { outcome: 'failed', note: `The 90% count-uncertainty interval stays above the ${formatMoneyAmount(ceiling)} CPA ceiling (${cpaStr} point estimate; ${postBookings} bookings).`, confidence }
    }
    return { outcome: 'inconclusive', note: `${cpaStr} is a point estimate whose 90% count-uncertainty interval crosses the ${formatMoneyAmount(ceiling)} CPA ceiling; not decisive.`, confidence }
  }
  return { outcome: 'inconclusive', note: 'Not enough post-period conversion data to judge.', confidence: 'low' }
}

/** Public legacy telemetry scorer. Every booking input here comes from Meta-modelled attribution.
 * It has neither settled contribution components nor a causal counterfactual, so it can describe what
 * happened in-platform but can never classify a commercial action as worked or failed. */
export function scoreFlag(
  flagType: string,
  _baseline: number | null,
  postSpend: number,
  postBookings: number,
  postCpa: number | null,
  attributionCoverage: number | null = null,
  postActiveDays?: number
): { outcome: Outcome; note: string; confidence: ClassificationConfidence; estimateOnly: boolean } {
  const base = scoreFlagBase(flagType, postSpend, postBookings, postCpa, postActiveDays)
  const coverage = attributionCoverage == null
    ? 'GA4 coverage unavailable'
    : `GA4 campaign-tag coverage ${(attributionCoverage * 100).toFixed(0)}%${attributionCoverage < MIN_ATTRIBUTED_SHARE ? ` < ${MIN_ATTRIBUTED_SHARE * 100}%` : ''}`
  return {
    outcome: 'inconclusive',
    note: `[diagnostic only — Meta-modelled bookings and CPA; ${coverage}. This evidence has no settled-cost reconciliation or causal counterfactual and cannot establish incremental contribution.] ${base.note}`,
    confidence: 'low',
    estimateOnly: true,
  }
}

/** Flag types whose recommendation is an ACTION someone must take (pause a loser, refresh creative, scale
 *  budget). A 'winner' recommends KEEPING — a no-op — so its outcome needs no recorded action to be real. */
export function requiresConfirmedAction(flagType: string): boolean {
  return flagType === 'loser' || flagType === 'creative_refresh' || flagType === 'scale_candidate'
}

/**
 * Gate a scored outcome on whether the recommended action was actually RECORDED (a Maxx-executed change, a
 * logged write, or an owner-confirmed setup-ledger action). Without that, a decisive worked/failed verdict
 * for an action-requiring flag is merely INFERRED from spend — e.g. "post-spend ≈ $0 ⇒ the pause worked",
 * or "held efficient ⇒ scaling worked" — which is the false learning this gate exists to stop. Such
 * verdicts are demoted to 'inconclusive' and kept OUT of agent_memory (`learn: false`), recorded only as
 * an unconfirmed hypothesis for visibility. Everything else (winners, thin/inconclusive data, or a
 * confirmed action) passes through unchanged and learns.
 */
export function gateOutcomeOnConfirmedAction(
  scored: { outcome: Outcome; note: string },
  flagType: string,
  actionConfirmed: boolean
): { outcome: Outcome; note: string; learn: boolean } {
  // Creative refresh cannot be validly scored from the old entity's window (no replacement linkage), so
  // it is NEVER a lesson — keep it out of memory regardless of outcome or confirmation. Note the
  // generic 'inconclusive' path below returns learn:true, so refresh needs its own explicit gate here.
  if (flagType === 'creative_refresh') {
    return { outcome: scored.outcome, note: scored.note, learn: false }
  }
  const decisive = scored.outcome === 'worked' || scored.outcome === 'failed'
  if (decisive && requiresConfirmedAction(flagType) && !actionConfirmed) {
    const missing = flagType === 'scale_candidate' ? 'budget change' : 'action'
    return {
      outcome: 'inconclusive',
      note: `[unconfirmed — no recorded ${missing}; treating as hypothesis, not a scored lesson] ${scored.note}`,
      learn: false,
    }
  }
  return { outcome: scored.outcome, note: scored.note, learn: true }
}

/**
 * Load every recorded action for the lookback as typed RecordedAction rows (see action-confirmation.ts
 * for the matching rules). All sources are ACCOUNT-scoped and success-filtered:
 *  • action_log: ONLY status='verified' AND verified=true — the single source of write-
 *    confirmation truth. change_requests.status='executed' is deliberately NOT read: it is set on
 *    applied.ok regardless of verification (and by the recovery repair path), so it would confirm an
 *    applied-but-unverified change,
 *  • recommendation_decisions: action_taken=true — the owner's "acted on" control; with write mode off
 *    this is the only source that ever fires,
 *  • ad_setup_decisions: action_taken=true budget-category rows only (matcher restricts them to scale).
 * Each source is fail-soft — an error contributes nothing, biasing toward NOT learning (the safe side).
 */
async function loadRecordedActions(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  sinceDate: string
): Promise<RecordedAction[]> {
  const out: RecordedAction[] = []
  const day = (ts: unknown): string => String(ts ?? '').slice(0, 10)
  try {
    const { data } = await db
      .from('action_log')
      .select('meta_entity_id, action_type, status, verified, created_at')
      .eq('ad_account_id', adAccountDbId)
      .eq('status', 'verified')
      .eq('verified', true)
      .gte('created_at', sinceDate)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      if (r.meta_entity_id && r.created_at) out.push({ kind: 'write', entityKey: String(r.meta_entity_id), actionType: String(r.action_type ?? ''), day: day(r.created_at) })
    }
  } catch { /* action_log absent */ }
  try {
    const { data } = await db
      .from('recommendation_decisions')
      .select('entity_key, recommendation_type, recommendation_id, action_taken_date, decision_date')
      .eq('ad_account_id', adAccountDbId)
      .eq('action_taken', true)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const when = r.action_taken_date ?? r.decision_date
      if (r.entity_key && when) out.push({ kind: 'decision', entityKey: String(r.entity_key), actionType: String(r.recommendation_type ?? ''), day: day(when), recommendationId: (r.recommendation_id as string | null) ?? null })
    }
  } catch { /* decisions table absent */ }
  try {
    const { data } = await db
      .from('ad_setup_decisions')
      .select('entity_key, setting_category, action_taken_date, created_at')
      .eq('ad_account_id', adAccountDbId)
      .eq('action_taken', true)
      .eq('setting_category', 'budget')
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const when = r.action_taken_date ?? r.created_at
      if (r.entity_key && when) out.push({ kind: 'ledger', entityKey: String(r.entity_key), actionType: 'budget', day: day(when) })
    }
  } catch { /* setup ledger absent */ }
  return out
}

/**
 * Evaluate flags that are old enough to judge (flag_date between ~3 weeks ago and EVAL_WINDOW_DAYS ago)
 * and haven't been scored yet. Records each outcome for owner review; it does not enter model-facing
 * learning or agent memory unless an approved reader explicitly admits it later.
 */
export async function evaluateRecommendationOutcomes(
  adAccountDbId: string,
  today: string
): Promise<{ evaluated: number; worked: number; failed: number; inconclusive: number; skipped?: string }> {
  const db = getAdminClient()
  const stats: { evaluated: number; worked: number; failed: number; inconclusive: number; skipped?: string } = { evaluated: 0, worked: 0, failed: 0, inconclusive: 0 }

  // Flag must be old enough that its ENTIRE post-window has attribution-settled (window + settle), not
  // merely closed — scoring at window-close reads undercounted rows and mints false 'failed' lessons.
  const evalCutoff = addDays(today, -(EVAL_WINDOW_DAYS + ATTRIBUTION_SETTLE_DAYS))
  const lookbackStart = addDays(today, -(EVAL_WINDOW_DAYS + ATTRIBUTION_SETTLE_DAYS + 21)) // don't reach back forever

  // Dormancy guard: do NOT learn from dormant account periods. If the account barely spent
  // across the whole lookback, there is no real signal — scoring it would manufacture false lessons.
  let accountSpend = 0
  const { data: acctRows } = await db
    .from('daily_insights')
    .select('spend')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'account')
    .gte('date_start', lookbackStart)
    .lte('date_start', today)
  for (const r of acctRows ?? []) accountSpend += Number(r.spend ?? 0)
  if (accountSpend < REC_THRESHOLDS.DORMANT_SPEND_30D) {
    return { ...stats, skipped: `dormant period — only ${formatMoney(accountSpend)} account spend over the lookback; not learning from it.` }
  }

  // Account-level GA4 attribution coverage for the lookback. Low coverage ⇒ Meta-based outcome
  // lessons are estimate-only (we cannot GA4-confirm them). FAIL-CLOSED SPLIT (intelligence-next):
  // `available:false` = GA4 NOT CONFIGURED ⇒ null (no downgrade — prior behavior); a THROW = GA4 is
  // configured but ERRORING ⇒ coverage 0, so decisive lessons scored during a GA4 outage become
  // estimate-only instead of silently minting full-confidence learning without attribution validation.
  let attributionCoverage: number | null = null
  try {
    const ga = await getGa4ConfirmationTelemetryByCampaign(lookbackStart, today)
    attributionCoverage = ga.available ? ga.attributedShare : null
  } catch {
    attributionCoverage = GA4_ERROR_COVERAGE
  }

  // Flags already scored (avoid duplicates)
  const { data: doneRows } = await db
    .from('recommendation_outcomes')
    .select('source_id')
    .eq('ad_account_id', adAccountDbId)
    .eq('source', 'flag')
  const doneIds = new Set((doneRows ?? []).map((r) => r.source_id as string).filter(Boolean))

  // Best-effort outcomes↔recs link: map each originating flag to the structured recommendation it drove
  // (recommendations.source_flag_id). Null when no structured rec was generated for it.
  const recIdByFlag = new Map<string, string>()
  {
    const { data: recRows } = await db
      .from('recommendations')
      .select('id, source_flag_id')
      .eq('ad_account_id', adAccountDbId)
      .not('source_flag_id', 'is', null)
    for (const r of (recRows ?? []) as { id: string; source_flag_id: string | null }[]) {
      if (r.source_flag_id && !recIdByFlag.has(r.source_flag_id)) recIdByFlag.set(r.source_flag_id, r.id)
    }
  }

  // Recorded actions (item 4): only score a decisive worked/failed LESSON for an action-requiring flag
  // when the action was actually recorded — right entity, right action type, right window; never
  // inferred from spend. Loaded once for the lookback; matched per-flag below.
  const recordedActions = await loadRecordedActions(db, adAccountDbId, lookbackStart)

  const { data: flags } = await db
    .from('flags')
    .select('id, flag_type, entity_level, ad_id, adset_id, campaign_id, meta_ad_id, meta_adset_id, meta_campaign_id, audience_type, recommended_action, cpa_in_window, flag_date')
    .eq('ad_account_id', adAccountDbId)
    .lte('flag_date', evalCutoff)
    .gte('flag_date', lookbackStart)
    .in('flag_type', ['winner', 'loser', 'scale_candidate', 'creative_refresh'])
    .limit(200)

  for (const f of flags ?? []) {
    const flagId = f.id as string
    if (doneIds.has(flagId)) continue

    const entityLevel = (f.entity_level as string) ?? 'ad'
    const metaEntityId = (f.meta_ad_id ?? f.meta_adset_id ?? f.meta_campaign_id) as string | null
    const baseline = f.cpa_in_window != null ? Number(f.cpa_in_window) : null
    const flagDate = f.flag_date as string
    const flagType = f.flag_type as string

    let postSpend = 0
    let postBookings = 0
    const activeDays = new Set<string>()
    const idCol = entityLevel === 'ad' ? 'meta_ad_id' : entityLevel === 'adset' ? 'meta_adset_id' : 'meta_campaign_id'
    if (metaEntityId) {
      const { data: postRows } = await db
        .from('daily_insights')
        .select('spend, bookings, date_start')
        .eq('ad_account_id', adAccountDbId)
        .eq(idCol, metaEntityId)
        .gte('date_start', addDays(flagDate, 1))
        .lte('date_start', addDays(flagDate, EVAL_WINDOW_DAYS))
      for (const r of postRows ?? []) {
        const daySpend = Number(r.spend ?? 0)
        postSpend += daySpend
        postBookings += Number(r.bookings ?? 0)
        if (daySpend > 0) activeDays.add(String(r.date_start))
      }
    }
    const postCpa = postBookings > 0 ? postSpend / postBookings : null
    const postActiveDays = activeDays.size

    // The creative_refresh hook/hold "signal" that used to be appended here read the OLD (now
    // paused) entity's post-window, so it was degenerate (~0 impressions) — removed. Refresh outcomes are
    // inconclusive and unlearned until compound replacement confirmation exists. (hookHoldPct /
    // creativeSignalNote remain exported for the Creative Lab, which compares LIVE creatives.)
    const scored = scoreFlag(flagType, baseline, postSpend, postBookings, postCpa, attributionCoverage, postActiveDays)
    // Item 4: an action-requiring flag (pause/refresh/scale) may only mint a decisive lesson when the
    // MATCHING action was recorded — right entity, right action type, inside the scored post-window
    // (see action-confirmation.ts). Otherwise the worked/failed call is inferred from spend.
    const actionConfirmed = requiresConfirmedAction(flagType)
      ? isActionConfirmed(recordedActions, {
          flagType,
          flagDate,
          metaEntityId,
          dbEntityKey: ((f.ad_id ?? f.adset_id ?? f.campaign_id) as string | null) ?? null,
          recommendationId: recIdByFlag.get(flagId) ?? null,
        }, EVAL_WINDOW_DAYS)
      : true
    const gated = gateOutcomeOnConfirmedAction(scored, flagType, actionConfirmed)
    const { outcome, note } = gated
    const { confidence, estimateOnly } = scored
    const category = lessonCategory(flagType)
    // Why-classified + classification confidence travel WITH the lesson (no schema change needed).
    const enrichedNote = `[category: ${category} | confidence: ${confidence}] ${note}`

    const { error } = await db.from('recommendation_outcomes').insert({
      ad_account_id: adAccountDbId,
      source: 'flag',
      source_id: flagId,
      recommendation_id: recIdByFlag.get(flagId) ?? null,
      flag_type: flagType,
      entity_level: entityLevel,
      meta_entity_id: metaEntityId,
      audience_type: f.audience_type ?? null,
      // Raw flag prose is a legacy observation artifact, not a governed action. Learning keeps the
      // structured flag identity and hypothesis; it never republishes the stored instruction string.
      recommendation: `${flagType} diagnostic observation`,
      hypothesis: hypothesisFor(flagType),
      metric_name: 'meta_modelled_cpa_diagnostic',
      baseline_value: baseline,
      observed_value: postCpa,
      outcome,
      outcome_note: enrichedNote,
      // Structured columns — previously only embedded in outcome_note prose.
      category,
      confidence,
      estimate_only: estimateOnly,
      active_days: postActiveDays,
      recommended_on: flagDate,
      evaluate_after: evalCutoff,
      evaluated_at: new Date().toISOString(),
    })
    if (error) {
      // Likely the migration isn't applied yet — skip silently so the cron never breaks.
      console.warn('[learning] recommendation_outcomes insert failed:', error.message)
      continue
    }

    // Outcome rows default to pending owner review. Do not mirror them into agent_memory here:
    // model-facing memory admits recommendation outcomes only through its approval-lineage read gate.

    stats.evaluated++
    stats[outcome]++
  }

  return stats
}
