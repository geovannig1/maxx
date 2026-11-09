import { logToolError } from '@/lib/security/api-error'
import { buildRecommendation, formatRecommendation, type BuildRecommendationInput } from '@/lib/recommendations/builder'
import type { RecommendationType, TargetEntityType, EvidenceBasis, MetricValue } from '@/lib/recommendations/types'
import { nyToday } from '@/lib/utils/date-utils'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveAdAccountId } from '@/lib/outcomes/ledger-account'
import { readLatestClosedAccountDeliveryDate } from '@/lib/accounts/closed-delivery-date'
import { inclusiveAccountDates } from '@/lib/economics/account-date-window'
import { getOperatingModeSignalsBasis } from './operating-mode'
import {
  actionKindForRecommendation, applyRecommendationAuthority, decideRecommendationAuthority,
} from '@/lib/authority/recommendation-authority'
import { isMoneyKind, type ActionAuthorityDecision } from '@/lib/authority/action-authority'

function nonnegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

type ResolvedMetricValues =
  | {
      available: false
      metrics: []
      spend: null
      modelledBookings: null
      dataAgeHours: null
      window: null
      note: string
    }
  | {
      available: true
      metrics: MetricValue[]
      spend: number
      modelledBookings: number
      dataAgeHours: number | null
      window: { start: string; end: string }
      note: string
    }

function unresolvedMetricValues(note: string): ResolvedMetricValues {
  return {
    available: false,
    metrics: [],
    spend: null,
    modelledBookings: null,
    dataAgeHours: null,
    window: null,
    note,
  }
}

/**
 * SERVER-RESOLVED evidence for the grounding gate.
 *
 * A review found this tool permanently blocked: it never supplied `metric_values`, so
 * `data_sources_count` was always 0 and check 3 ("is the metric source valid?") could never pass — an
 * otherwise fully grounded pause request returned gate_passed=false. Its public schema cannot accept
 * evidence objects, and it must not trust LLM-supplied counts either. So the tool now RESOLVES the
 * evidence itself, from the same warehouse rows every other surface reads.
 *
 * Anything that cannot be resolved is simply absent — an unresolvable metric is never fabricated, and
 * an empty result legitimately leaves the gate unsourced.
 */
async function resolveMetricValues(
  windowDays: number,
  targetEntityType: TargetEntityType,
  targetEntityId: string | null,
): Promise<ResolvedMetricValues> {
  try {
    const acct = await resolveAdAccountId()
    if (!acct) return unresolvedMetricValues('No active ad account could be resolved; evidence is unsourced.')
    const db = getAdminClient()
    const level = targetEntityType === 'campaign' ? 'campaign'
      : targetEntityType === 'adset' ? 'adset'
      : targetEntityType === 'ad' ? 'ad'
      : targetEntityType === 'account' || targetEntityType === 'none' ? 'account'
      : null
    if (level === null) {
      return unresolvedMetricValues(
        `${targetEntityType} evidence has no direct daily_insights unit; an account aggregate was not substituted for the requested target.`,
      )
    }
    const to = await readLatestClosedAccountDeliveryDate(acct, db)
    if (to === null) {
      return unresolvedMetricValues('The latest closed account delivery day is unavailable; evidence is unsourced.')
    }
    const fromDate = new Date(`${to}T00:00:00Z`)
    fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1))
    const from = fromDate.toISOString().slice(0, 10)
    const expectedDates = inclusiveAccountDates(from, to)
    const expectedDateSet = new Set(expectedDates)
    const coverageRead = await db.from('daily_insights')
      .select('date_start,date_stop,spend')
      .eq('ad_account_id', acct)
      .eq('entity_level', 'account')
      .gte('date_start', from)
      .lte('date_start', to)
      .order('date_start', { ascending: true })
      .limit(expectedDates.length + 1)
    if (coverageRead.error || !Array.isArray(coverageRead.data)) {
      return unresolvedMetricValues(
        `The closed account delivery window ${from}..${to} could not be read; evidence is unsourced.`,
      )
    }
    const coveredDates = new Set<string>()
    const coverageValid = coverageRead.data.length === expectedDates.length
      && coverageRead.data.every((raw) => {
        const row = raw as Record<string, unknown>
        const date = row.date_start
        const spend = nonnegativeNumber(row.spend)
        if (typeof date !== 'string' || !expectedDateSet.has(date) || row.date_stop !== date
            || coveredDates.has(date) || spend === null) return false
        coveredDates.add(date)
        return true
      })
      && coveredDates.size === expectedDates.length
    if (!coverageValid) {
      return unresolvedMetricValues(
        `The closed account delivery window is incomplete for ${from}..${to}; evidence is unsourced.`,
      )
    }
    let q = db.from('daily_insights')
      .select('date_start, date_stop, spend, bookings, impressions, clicks, synced_at')
      .eq('ad_account_id', acct)
      .eq('entity_level', level)
      .gte('date_start', from)
      .lte('date_start', to)
    if (targetEntityId && level !== 'account') {
      const col = level === 'campaign' ? 'meta_campaign_id' : level === 'adset' ? 'meta_adset_id' : 'meta_ad_id'
      q = q.eq(col, targetEntityId)
    }
    const { data, error } = await q
    if (error) throw new Error(error.message)
    const rows = data ?? []
    const seenDates = new Set<string>()
    const rowsValid = rows.every((raw) => {
      const row = raw as Record<string, unknown>
      const date = row.date_start
      if (typeof date !== 'string' || !expectedDateSet.has(date) || row.date_stop !== date
          || seenDates.has(date) || nonnegativeNumber(row.spend) === null
          || nonnegativeNumber(row.bookings) === null
          || nonnegativeNumber(row.impressions) === null) return false
      seenDates.add(date)
      return true
    })
    if (!rowsValid) {
      return unresolvedMetricValues(
        `The ${level}-level warehouse identity or metric values are incomplete for the closed window ${from}..${to}; evidence is unsourced.`,
      )
    }
    if (rows.length === 0) {
      return unresolvedMetricValues(
        `No warehouse rows for ${level}${targetEntityId ? ` ${targetEntityId}` : ''} in the closed window ${from}..${to}; evidence is unsourced.`,
      )
    }
    const sum = (k: string) => rows.reduce((n, r) => (
      n + nonnegativeNumber((r as Record<string, unknown>)[k])!
    ), 0)
    const spend = sum('spend')
    const modelled = sum('bookings')
    const latestSyncMs = Math.max(...rows.map((r) => Date.parse(String((r as Record<string, unknown>).synced_at ?? ''))).filter(Number.isFinite))
    const dataAgeHours = Number.isFinite(latestSyncMs)
      ? Math.max(0, (Date.now() - latestSyncMs) / 3_600_000)
      : null
    return {
      available: true,
      metrics: [
        { name: 'spend', value: spend, source: 'meta_api', unit: '$' },
        // MODELLED, and named so. Never presented as an actual or causal conversion count.
        { name: 'meta_modelled_conversions', value: modelled, source: 'meta_api', unit: 'count' },
        { name: 'impressions', value: sum('impressions'), source: 'meta_api', unit: 'count' },
      ],
      spend,
      modelledBookings: modelled,
      dataAgeHours,
      window: { start: from, end: to },
      note: `Resolved server-side from ${rows.length} ${level}-level warehouse row(s) for ${from}..${to}.`,
    }
  } catch (e) {
    return unresolvedMetricValues(
      `Evidence could not be resolved (${logToolError('evaluate_recommendation', 'EVIDENCE_RESOLUTION_FAILED', e)}); left unsourced rather than assumed.`,
    )
  }
}

function unavailableAuthority(recommendationType: RecommendationType): ActionAuthorityDecision {
  const kind = actionKindForRecommendation(recommendationType)
  return {
    tier: 'diagnostic_only',
    isMoneyAction: isMoneyKind(kind),
    authorityBasis: 'unavailable',
    plane: 'meta_modelled',
    directionSupported: false,
    directionCeiling: 'unsupported',
    reason: 'The required closed-window evidence is unavailable, so no proposal was evaluated.',
    copy: 'No action is available from this evaluation.',
  }
}

const RECOMMENDATION_TYPES: ReadonlySet<string> = new Set<RecommendationType>([
  'scale', 'reduce_budget', 'pause', 'activate', 'refresh_creative', 'change_optimization_event',
  'change_audience', 'restructure', 'launch_test', 'keep', 'investigate', 'hold', 'no_action',
  'launch_setup', 'audience_test', 'creative_test', 'budget_watch', 'scale_proposal', 'pause_watch',
  'funnel_diagnosis', 'attribution_issue', 'tracking_issue', 'low_data_guidance', 'weekly_strategy',
  'do_not_touch',
])
const TARGET_TYPES: ReadonlySet<string> = new Set<TargetEntityType>([
  'account', 'campaign', 'adset', 'ad', 'audience', 'creative', 'none',
])
const EVIDENCE_BASES: ReadonlySet<string> = new Set<EvidenceBasis>([
  'observed_performance', 'external_best_practice', 'test_hypothesis',
])

// MCP tool: run a PROPOSED recommendation through the grounding gate + no-oscillation rule and return
// the structured Recommendation. The agent should call this before surfacing any change so confidence,
// risk, the three safety warnings, and the no-oscillation verdict are computed in code, not asserted.

export interface EvaluateArgs {
  recommendation_type: RecommendationType
  target_entity_type?: TargetEntityType
  target_entity_id?: string
  target_entity_name?: string
  observed_fact: string
  reason_for_action: string
  basis: EvidenceBasis
  window_days: number
}

export async function evaluateRecommendation(args: EvaluateArgs): Promise<object> {
  if (!args || !RECOMMENDATION_TYPES.has(args.recommendation_type)
      || !EVIDENCE_BASES.has(args.basis) || !args.observed_fact || !args.reason_for_action) {
    return { error: 'recommendation_type, observed_fact, reason_for_action and basis are required.' }
  }
  const targetType = args.target_entity_type ?? 'none'
  if (!TARGET_TYPES.has(targetType)) return { error: 'target_entity_type is not supported.' }
  if (targetType !== 'account' && targetType !== 'none' && !args.target_entity_id) {
    return { error: 'target_entity_id is required for non-account targets.' }
  }
  if (!Number.isInteger(args.window_days) || args.window_days < 1 || args.window_days > 90) {
    return { error: 'window_days must be an integer from 1 to 90.' }
  }

  const resolved = await resolveMetricValues(args.window_days, targetType, args.target_entity_id ?? null)
  if (!resolved.available) {
    return {
      recommendation: null,
      evidence_window: null,
      evidence_resolution: resolved.note,
      action_authority: unavailableAuthority(args.recommendation_type),
      formatted: null,
      gate_decision: 'hold',
      gate_passed: false,
      note: 'Recommendation evaluation was withheld because required evidence is unavailable, not zero.',
    }
  }

  const input: BuildRecommendationInput = {
    recommendation_type: args.recommendation_type,
    target_entity_type: targetType,
    target_entity_id: args.target_entity_id ?? null,
    target_entity_name: args.target_entity_name ?? null,
    observed_fact: args.observed_fact,
    reason_for_action: args.reason_for_action,
    basis: args.basis,
    date_range: resolved.window,
    // Evidence-bearing fields are SERVER RESOLVED. They are intentionally absent from the public MCP
    // schema so a model cannot mint a green gate by supplying convenient economics or freshness.
    spend: resolved.spend,
    bookings: resolved.modelledBookings,
    window_days: args.window_days,
    data_age_hours: resolved.dataAgeHours,
    uses_meta_estimate_as_revenue: false,
    days_since_last_change: null,
    exited_learning: null,
    trend_stable: null,
    conflicting_signal: false,
    claims_per_campaign_roas: false,
    attributed_share: null,
    account_dormant: false,
    reversible: false,
    today: nyToday(),
    metric_values: resolved.metrics,
  }

  const built = buildRecommendation(input)

  // THE SAME authority layer every other surface answers to. A gate pass is necessary but not
  // sufficient: a money action still needs interaction-cohort evidence before it may be presented as
  // an instruction, so a green gate on modelled evidence comes back diagnostic_only.
  const basis = await getOperatingModeSignalsBasis(actionKindForRecommendation(args.recommendation_type))
  const authority = decideRecommendationAuthority({
    recommendation: built,
    intendedType: args.recommendation_type,
    basis,
    plane: 'meta_modelled',
    preflight: null,
  })
  const rec = applyRecommendationAuthority(built, args.recommendation_type, authority)
  const surfacedAuthority = authority.tier === 'diagnostic_only'
    ? {
        ...authority,
        reason: 'Final authority remained diagnostic-only, so the model-authored proposal is withheld.',
        copy: 'No action is available from this evaluation.',
      }
    : authority
  const maySurfaceProposal = authority.tier !== 'diagnostic_only'

  return {
    recommendation: maySurfaceProposal ? rec : null,
    evidence_window: resolved.window,
    evidence_resolution: resolved.note,
    action_authority: surfacedAuthority,
    formatted: maySurfaceProposal ? formatRecommendation(rec) : null,
    gate_decision: rec.grounding.decision,
    gate_passed: rec.grounding.passed,
    note:
      rec.grounding.passed
        ? `Grounding passed; final action authority is ${authority.tier}. Only the final authority tier governs how this may be presented.`
        : `Grounding did not clear (decision=${rec.grounding.decision}); final action authority is ${authority.tier}.`,
  }
}
