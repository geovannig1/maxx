import { getAdminClient } from '@/lib/supabase/admin'
import { getTargetRange, MIN_ATTRIBUTED_SHARE } from '@/lib/targets/target-ranges'
import { getGa4ConfirmationTelemetryByCampaign } from '@/lib/ga4/client'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { GA4_ERROR_COVERAGE, ATTRIBUTION_SETTLE_DAYS, type ClassificationConfidence } from './outcomes'
import { currentValueOf, classifyLedgerOutcome } from '@/lib/recommendations/setup-ledger'
import { formatMoney } from '@/lib/utils/format-currency'

// Ledger outcome scoring (intelligence-next — closes the designed-but-unscheduled half of the Ad
// Decision Ledger): setup decisions / manual actions whose follow-up date has arrived are scored against
// REAL post-action delivery, then land on the existing outcome REVIEW BOARD as `pending` — the same
// human gate every other lesson goes through. Nothing here is trusted learning by itself: only an
// owner-approved outcome feeds win-rates/track record (patterns.ts / knowledge.ts, unchanged).
//
// Guardrails mirror the flag scorer (outcomes.ts): dormancy guard, $20/2-booking/3-active-day minimums
// (below them ⇒ inconclusive, never decisive), and the estimate-only downgrade when GA4 attribution
// coverage is low — organic/unattributed revenue can never validate a paid setup decision.

const EVAL_WINDOW_DAYS = 7
const MIN_POST_SPEND_DECISIVE = REC_THRESHOLDS.MIN_SPEND_TO_JUDGE // $20
const MIN_POST_BOOKINGS_DECISIVE = 2
const MIN_ACTIVE_DAYS_DECISIVE = 3

type Outcome = 'worked' | 'failed' | 'inconclusive'

export interface SetupScoreInput {
  postSpend: number
  postBookings: number
  postCpa: number | null
  activeDays: number
  attributionCoverage: number | null
  /** CPA watch ceiling (getTargetRange('cpa').watch) — passed in so the scorer stays pure. null until set. */
  maxCpa: number | null
}

export interface SetupScore {
  outcome: Outcome
  note: string
  confidence: ClassificationConfidence
  estimateOnly: boolean
  dataSufficient: boolean
}

/** PURE: summarize post-action Meta telemetry. This source has no settled contribution components or
 * causal counterfactual, so it cannot classify the commercial impact of a setup decision. */
export function scoreSetupDecisionWindow(i: SetupScoreInput): SetupScore {
  const dataSufficient =
    i.postSpend >= MIN_POST_SPEND_DECISIVE &&
    i.postBookings >= MIN_POST_BOOKINGS_DECISIVE &&
    i.activeDays >= MIN_ACTIVE_DAYS_DECISIVE

  const cpaStr = i.postCpa !== null ? `${formatMoney(i.postCpa)}` : 'n/a'
  const coverage = i.attributionCoverage == null
    ? 'GA4 coverage unavailable'
    : `GA4 campaign-tag coverage ${(i.attributionCoverage * 100).toFixed(0)}%${i.attributionCoverage < MIN_ATTRIBUTED_SHARE ? ` < ${MIN_ATTRIBUTED_SHARE * 100}%` : ''}`
  return {
    outcome: 'inconclusive',
    note: `[diagnostic only — Meta-modelled bookings and CPA; ${coverage}. No settled-cost reconciliation or causal counterfactual exists, so this cannot establish incremental contribution.] Post-action ${EVAL_WINDOW_DAYS}d: ${cpaStr} across ${i.postBookings} modelled booking(s).`,
    confidence: 'low',
    estimateOnly: true,
    dataSufficient,
  }
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

interface DueLedgerRow {
  id: string
  entity_type: string
  entity_key: string
  entity_name: string | null
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  setting_category: string
  setting_name: string
  proposed_value: string | null
  final_value: string | null
  actual_launched_value: string | null
  reason: string | null
  decision_date: string | null
  action_taken_date: string | null
  follow_up_date: string | null
  created_at: string
}

function ledgerLessonCategory(settingCategory: string): 'creative' | 'budget' | 'performance' {
  if (settingCategory === 'creative' || settingCategory === 'copy') return 'creative'
  if (settingCategory === 'budget' || settingCategory === 'bid_strategy') return 'budget'
  return 'performance'
}

/** PURE: resolve the entity a ledger decision should be scored against. Prefers the level-specific
 *  columns; falls back to a NUMERIC entity_key (entity_key = coalesce(Meta id, planned-name slug,
 *  'account') — a numeric key IS a Meta id) mapped via entity_type. Null ⇒ score at account level. */
export function resolveLedgerEntityRef(row: {
  entity_type: string
  entity_key: string
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
}): { idCol: 'meta_ad_id' | 'meta_adset_id' | 'meta_campaign_id'; metaEntityId: string } | null {
  const direct = row.ad_id ? { idCol: 'meta_ad_id' as const, metaEntityId: row.ad_id }
    : row.adset_id ? { idCol: 'meta_adset_id' as const, metaEntityId: row.adset_id }
    : row.campaign_id ? { idCol: 'meta_campaign_id' as const, metaEntityId: row.campaign_id }
    : null
  if (direct) return direct
  if (/^\d+$/.test(row.entity_key)) {
    if (row.entity_type === 'ad') return { idCol: 'meta_ad_id', metaEntityId: row.entity_key }
    if (row.entity_type === 'adset') return { idCol: 'meta_adset_id', metaEntityId: row.entity_key }
    if (row.entity_type === 'campaign') return { idCol: 'meta_campaign_id', metaEntityId: row.entity_key }
  }
  return null
}

/**
 * Score ledger decisions whose follow-up date has arrived (Step 14b of the daily sync).
 * For each due row (acted on, not retired, not yet scored): read the post-action delivery window for the
 * linked entity (account-level fallback when the decision has no Meta entity id), score it, insert a
 * `recommendation_outcomes` row (source='setup_decision' — idempotent via the existing UNIQUE(source,
 * source_id)) as PENDING review, and link it back via ad_setup_decisions.outcome_id. Non-fatal + guarded:
 * returns counts and never throws past the caller's try/catch.
 */
export async function evaluateLedgerOutcomes(
  adAccountDbId: string,
  today: string
): Promise<{ evaluated: number; pending_review: number; inconclusive: number; skipped?: string }> {
  const db = getAdminClient()
  const stats = { evaluated: 0, pending_review: 0, inconclusive: 0 } as { evaluated: number; pending_review: number; inconclusive: number; skipped?: string }

  // Dormancy guard — same rule as the flag scorer: no learning from a dormant account.
  const lookbackStart = addDays(today, -(EVAL_WINDOW_DAYS + 21))
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
    return { ...stats, skipped: `dormant period — only ${formatMoney(accountSpend)} account spend over the lookback; not scoring setup decisions.` }
  }

  // Due, acted-on, active, unscored decisions.
  const { data: dueRows, error: dueErr } = await db
    .from('ad_setup_decisions')
    .select('id, entity_type, entity_key, entity_name, campaign_id, adset_id, ad_id, setting_category, setting_name, proposed_value, final_value, actual_launched_value, reason, decision_date, action_taken_date, follow_up_date, created_at')
    .eq('ad_account_id', adAccountDbId)
    .eq('action_taken', true)
    .eq('prior_deprecated', false)
    .is('outcome_id', null)
    .not('follow_up_date', 'is', null)
    .lte('follow_up_date', today)
    .limit(50)
  if (dueErr || !dueRows || dueRows.length === 0) return stats

  // GA4 attribution coverage (account-level) — low coverage ⇒ estimate-only lessons. Same fail-closed
  // split as the flag scorer: not-configured ⇒ null (no downgrade); configured-but-erroring ⇒ 0
  // (decisive lessons become estimate-only rather than full-confidence during a GA4 outage).
  let attributionCoverage: number | null = null
  try {
    const ga = await getGa4ConfirmationTelemetryByCampaign(lookbackStart, today)
    attributionCoverage = ga.available ? ga.attributedShare : null
  } catch {
    attributionCoverage = GA4_ERROR_COVERAGE
  }

  const maxCpa = getTargetRange('cpa').watch

  for (const row of (dueRows as DueLedgerRow[])) {
    // Post-action window: from the day after the action (fallback: decision/created date).
    const anchor = (row.action_taken_date ?? row.decision_date ?? row.created_at).slice(0, 10)
    const windowStart = addDays(anchor, 1)
    const windowEnd = addDays(anchor, EVAL_WINDOW_DAYS)
    // Complete AND attribution-settled: conversions restate up to 7d-click and back-days only restate
    // inside the sync's rolling lookback — scoring at window-close undercounts (mirrors outcomes.ts).
    if (addDays(windowEnd, ATTRIBUTION_SETTLE_DAYS) > today) continue // score on a later run

    // Entity linkage: level-specific columns, else a numeric entity_key (a real Meta id); otherwise
    // judge at account level (a setup decision without an entity id still shaped the account's
    // delivery) — the scope is labeled in the note either way.
    const ref = resolveLedgerEntityRef(row)

    let q = db
      .from('daily_insights')
      .select('spend, bookings, date_start')
      .eq('ad_account_id', adAccountDbId)
      .gte('date_start', windowStart)
      .lte('date_start', windowEnd)
    q = ref ? q.eq(ref.idCol, ref.metaEntityId) : q.eq('entity_level', 'account')
    const { data: post } = await q

    let postSpend = 0
    let postBookings = 0
    const activeDays = new Set<string>()
    for (const r of post ?? []) {
      const daySpend = Number(r.spend ?? 0)
      postSpend += daySpend
      postBookings += Number(r.bookings ?? 0)
      if (daySpend > 0) activeDays.add(String(r.date_start))
    }
    const postCpa = postBookings > 0 ? postSpend / postBookings : null

    const score = scoreSetupDecisionWindow({ postSpend, postBookings, postCpa, activeDays: activeDays.size, attributionCoverage, maxCpa })
    const scopeNote = ref
      ? ''
      : ' [ACCOUNT-LEVEL window — this decision has no linked Meta entity id, so the verdict reflects account-wide delivery, not this entity in isolation]'
    const state = classifyLedgerOutcome({
      dataSufficient: score.dataSufficient,
      estimateOnly: score.estimateOnly,
      attributedShare: attributionCoverage,
      decisiveResult: score.outcome !== 'inconclusive',
    })
    const category = ledgerLessonCategory(row.setting_category)
    const value = currentValueOf(row) ?? '—'

    const { data: inserted, error: insErr } = await db
      .from('recommendation_outcomes')
      .insert({
        ad_account_id: adAccountDbId,
        source: 'setup_decision', // UNIQUE(source, source_id) makes this idempotent per ledger row
        source_id: row.id,
        flag_type: row.setting_category,
        entity_level: row.entity_type,
        meta_entity_id: ref?.metaEntityId ?? null,
        recommendation: `${row.setting_name}: ${value}`,
        hypothesis: row.reason ?? 'This setup decision may improve causal incremental contribution dollars.',
        metric_name: 'meta_modelled_cpa_diagnostic',
        baseline_value: null,
        observed_value: postCpa,
        outcome: score.outcome,
        outcome_note: `[category: ${category} | confidence: ${score.confidence}]${scopeNote} ${score.note}`,
        category,
        confidence: score.confidence,
        estimate_only: score.estimateOnly,
        active_days: activeDays.size,
        recommended_on: anchor,
        evaluate_after: row.follow_up_date,
        evaluated_at: new Date().toISOString(),
        // review_status defaults to 'pending' — the owner review gate; never auto-approved.
      })
      .select('id')
      .single()

    // Link the lesson back to the decision. 'pending'/'needs_review' both await the human gate.
    const reviewState = state === 'inconclusive' ? 'inconclusive' : 'pending'
    let outcomeId = (inserted as { id: string } | null)?.id ?? null
    if (insErr) {
      // Most likely UNIQUE(source, source_id): the outcome was inserted on a previous run whose
      // back-link update failed. REPAIR the link instead of skipping forever (self-healing).
      const { data: existing } = await db
        .from('recommendation_outcomes')
        .select('id')
        .eq('source', 'setup_decision')
        .eq('source_id', row.id)
        .maybeSingle()
      outcomeId = (existing as { id: string } | null)?.id ?? null
      if (!outcomeId) {
        console.warn('[ledger-outcomes] insert failed (no existing row to repair-link):', insErr.message)
        continue
      }
    }
    const { error: linkErr } = await db
      .from('ad_setup_decisions')
      .update({ outcome_id: outcomeId, outcome_review_status: reviewState, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (linkErr) {
      // The outcome row exists; the next run re-selects this decision and takes the repair path above.
      console.warn('[ledger-outcomes] back-link update failed (will repair next run):', linkErr.message)
      continue
    }

    if (!insErr) {
      stats.evaluated++
      if (reviewState === 'pending') stats.pending_review++
      else stats.inconclusive++
    }
  }

  return stats
}
