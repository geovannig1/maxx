import type { Recommendation } from './types'
import type { InteractionCohortPairSignal } from '@/lib/modes/operating-mode'
import type { AuthorityTier } from '@/lib/authority/action-authority'
import { REC_THRESHOLDS } from './thresholds'
import {
  OWNER_ROAS_TARGET_FLOOR,
  OWNER_ROAS_TARGET_STRETCH,
  PRAGMATIC_DAILY_BUDGET_CEILING,
  recommendedScaleBudget,
} from '@/lib/economics/pragmatic-profit-evidence'
import { formatMoney, roundMoney } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

/**
 * PRAGMATIC MEDIA-BUYER RECOMMENDATION ENRICHMENT
 *
 * The owner has explicitly asked Maxx to act like an expert media buyer: recommend scale, cut,
 * pause, and creative-refresh moves from attributed paid-cohort evidence, with one-click owner
 * approval before any execution. This module does NOT grant authority — that lives in the
 * recommendation-authority layer. It adds the ROAS-target, upside/downside, and best-practice
 * sizing language that an expert buyer would put in front of an owner.
 *
 * Evidence plane is always honestly labeled as attributed association, not incrementality.
 */

export interface PragmaticEnrichmentInput {
  /** The setting must be on; otherwise the recommendation is returned unchanged. */
  enabled: boolean
  /** Diagnostic-only rows must never receive proposal-shaped copy in optional fields. */
  authorityTier: AuthorityTier
  /** Immutable interaction-cohort pair for the evaluated entity. */
  pair: InteractionCohortPairSignal | null
  /** Account-total daily budget at evaluation time. */
  currentAccountDailyBudget: number | null
  /** Owner-approved target CPA (diagnostic only; used for cut/pause context). null until set. */
  targetCpa: number | null
  /** Owner-approved watch CPA (diagnostic only; used for cut/pause context). null until set. */
  maxCpa: number | null
}

const r2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number) => `${formatMoney(n)}`

function attributedRoas(spend: number, recordedRevenue: number | null): number | null {
  if (!Number.isFinite(spend) || spend <= 0 || recordedRevenue === null || !Number.isFinite(recordedRevenue)) return null
  return r2(recordedRevenue / spend)
}

function scaleCopy(p: {
  currentBudget: number
  proposedBudget: number
  observedRoas: number | null
  recentSpend: number
  recentRevenue: number
  recentBookings: number
}): { reason: string; upside: string; downside: string } {
  const roasText = p.observedRoas != null ? `${p.observedRoas.toFixed(1)}x` : 'unknown'
  const gap = p.observedRoas != null ? OWNER_ROAS_TARGET_STRETCH - p.observedRoas : null
  const gapText = gap != null && gap > 0 ? ` (${gap.toFixed(1)}x below the ${OWNER_ROAS_TARGET_STRETCH}x stretch end of the owner target range)` : ''
  const rangeText = `owner target range ${OWNER_ROAS_TARGET_FLOOR}x–${OWNER_ROAS_TARGET_STRETCH}x`
  const incrementalSpend = p.proposedBudget - p.currentBudget
  const projectedRevenue = p.observedRoas != null && p.observedRoas > 0
    ? roundMoney(incrementalSpend * p.observedRoas)
    : null
  const upside = projectedRevenue != null && projectedRevenue > 0
    ? `If the observed ${roasText} attributed revenue ROAS holds, increasing account daily budget from ${fmt(p.currentBudget)} to ${fmt(p.proposedBudget)} could add ~${fmt(projectedRevenue)} in recorded collected value per day for an extra ${fmt(incrementalSpend)} in ad spend. Target is the ${rangeText}.`
    : `If efficiency holds, increasing account daily budget from ${fmt(p.currentBudget)} to ${fmt(p.proposedBudget)} may add recorded collected value. Target is the ${rangeText}.`
  const downside = `Attributed association is not incremental proof. The next dollar may convert at a lower rate, especially if the audience saturates or frequency rises. If ROAS drops to 1x on the incremental spend, the ${fmt(incrementalSpend)} daily increase becomes a loss.`
  const reason = `PRAGMATIC SCALE PROPOSAL — owner-reviewed change: account daily budget from ${fmt(p.currentBudget)} to ${fmt(p.proposedBudget)} (20% step, capped at ${fmt(PRAGMATIC_DAILY_BUDGET_CEILING)}). Recent exact paid cohort shows ${p.recentBookings} ${OW.one}(s), ${fmt(p.recentRevenue)} recorded collected value on ${fmt(p.recentSpend)} spend = ${roasText} attributed revenue ROAS${gapText}. Owner approval required; this is association evidence, not causal incrementality.`
  return { reason, upside, downside }
}

function cutCopy(p: {
  currentBudget: number | null
  reasonCode: 'loss' | 'zero_outcome'
  matureSpend: number
  matureRevenue: number
  matureBookings: number
  observedRoas: number | null
  targetCpa: number | null
  maxCpa: number | null
}): { reason: string; upside: string; downside: string } {
  const roasText = p.observedRoas != null ? `${p.observedRoas.toFixed(1)}x` : 'unknown'
  const budgetText = p.currentBudget != null ? fmt(p.currentBudget) : 'unknown'
  const reason = p.reasonCode === 'zero_outcome'
    ? `PRAGMATIC CUT PROPOSAL — spend reached ${fmt(p.matureSpend)} with zero ${OW.many} in the mature window. Recommended owner-reviewed change: account daily budget set to a smaller amount to stop the 3x-zero-outcome bleed. Current account daily budget is ${budgetText}. Owner approval required; this is association evidence, not causal incrementality.`
    : `PRAGMATIC CUT PROPOSAL — mature cohort shows ${p.matureBookings} ${OW.one}(s), ${fmt(p.matureRevenue)} recorded collected value on ${fmt(p.matureSpend)} spend = ${roasText} attributed revenue ROAS, below the ${OWNER_ROAS_TARGET_FLOOR}x floor of the owner target range (${OWNER_ROAS_TARGET_FLOOR}x–${OWNER_ROAS_TARGET_STRETCH}x). Recommended owner-reviewed change: account daily budget set to a smaller amount from ${budgetText}. Owner approval required; this is association evidence, not causal incrementality.`
  const cpaText = p.targetCpa !== null && p.maxCpa !== null
    ? ` Target CPA is ${fmt(p.targetCpa)}; max acceptable CPA is ${fmt(p.maxCpa)}.`
    : ' No CPA target is set.'
  const upside = `Stopping spend on a negative attributed ROAS unit prevents further losses and preserves budget for tests or winners.${cpaText}`
  const downside = `The loss may be temporary (bad week, creative fatigue, or auction noise). Cutting too early can forgo recoverable ${OW.many} and reset learning when the setup has not actually broken.`
  return { reason, upside, downside }
}

function pauseCopy(p: {
  currentBudget: number | null
  matureSpend: number
  matureRevenue: number
  matureBookings: number
  observedRoas: number | null
}): { reason: string; upside: string; downside: string } {
  const roasText = p.observedRoas != null ? `${p.observedRoas.toFixed(1)}x` : 'unknown'
  const budgetText = p.currentBudget != null ? fmt(p.currentBudget) : 'unknown'
  const reason = `PRAGMATIC PAUSE PROPOSAL — mature cohort shows ${p.matureBookings} ${OW.one}(s), ${fmt(p.matureRevenue)} recorded collected value on ${fmt(p.matureSpend)} spend = ${roasText} attributed revenue ROAS, below the ${OWNER_ROAS_TARGET_FLOOR}x floor of the owner target range (${OWNER_ROAS_TARGET_FLOOR}x–${OWNER_ROAS_TARGET_STRETCH}x). Recommended owner-reviewed change: place this unit on hold. Current account daily budget is ${budgetText}. Owner approval required; this is association evidence, not causal incrementality.`
  const upside = `Pausing stops the bleeding immediately and frees spend for proven or test angles.`
  const downside = `Restarting later may re-enter learning and lose auction history. Only pause if the negative signal is corroborated by the recent window and setup continuity is proven.`
  return { reason, upside, downside }
}

function activateCopy(p: {
  currentBudget: number | null
  proposedBudget: number | null
}): { reason: string; upside: string; downside: string } {
  const budgetText = p.currentBudget != null ? fmt(p.currentBudget) : 'unknown'
  const proposedText = p.proposedBudget != null ? fmt(p.proposedBudget) : 'unknown'
  const reason = `PRAGMATIC ACTIVATE PROPOSAL — reactivate this unit with an account daily budget of ${proposedText} (currently ${budgetText}). Only proceed if the prior attributed ROAS was positive and setup continuity holds. Owner approval required; this is association evidence, not causal incrementality.`
  const upside = `A previously positive unit can resume contribution without rebuilding social proof or auction history.`
  const downside = `Auction conditions and audiences change; past attributed ROAS may not repeat. Monitor closely for 7 days.`
  return { reason, upside, downside }
}

function refreshCopy(p: {
  frequency: number | null
  targetCpa: number | null
  maxCpa: number | null
}): { reason: string; upside: string; downside: string } {
  const freqText = p.frequency != null ? p.frequency.toFixed(1) : 'unknown'
  const cpaText = p.targetCpa !== null && p.maxCpa !== null
    ? `before CPA inflates beyond the ${fmt(p.maxCpa)} watch threshold (target ${fmt(p.targetCpa)})`
    : 'before CPA inflates'
  const reason = `PRAGMATIC CREATIVE REFRESH — frequency is ${freqText}, entering the 3.0–3.5 fatigue band. Refresh creative ${cpaText}. Owner approval required.`
  const upside = `New creative can reset auction freshness, lift CTR, and push CPA back toward the target before fatigue degrades ROAS.`
  const downside = `A new asset is an untested test; it can underperform the incumbent and reset learning.`
  return { reason, upside, downside }
}

function pickRecent(pair: InteractionCohortPairSignal) {
  return {
    spend: pair.recentScale.spend ?? 0,
    recordedRevenue: pair.recentScale.recordedRevenue ?? null,
    bookings: pair.recentScale.bookings ?? 0,
  }
}

function pickMature(pair: InteractionCohortPairSignal) {
  return pair.maturedCut.complete
    ? {
        spend: pair.maturedCut.spend ?? 0,
        recordedRevenue: pair.maturedCut.recordedRevenue ?? null,
        bookings: pair.maturedCut.bookings ?? 0,
      }
    : null
}

function findMetricValue(rec: Recommendation, name: string): number | null {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  for (const m of rec.metric_values) {
    if (m.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') === normalized) {
      return typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null
    }
  }
  return null
}

/**
 * Enrich a recommendation with media-buyer copy, ROAS-target context, and explicit upside/downside.
 *
 * The function is a no-op when pragmatic mode is disabled or the recommendation is not a money/creative
 * action. It preserves all authority-tier and grounding fields set upstream.
 */
export function enrichPragmaticMediaBuyerRecommendation(
  rec: Recommendation,
  input: PragmaticEnrichmentInput,
): Recommendation {
  if (!input.enabled || !input.pair || input.authorityTier === 'diagnostic_only') return rec
  const recent = pickRecent(input.pair)
  const mature = pickMature(input.pair)
  const recentRoas = attributedRoas(recent.spend, recent.recordedRevenue)
  const matureRoas = mature ? attributedRoas(mature.spend, mature.recordedRevenue) : null
  const proposedBudget = recommendedScaleBudget(input.currentAccountDailyBudget)

  let enrichment: { reason: string; upside: string; downside: string } | null = null

  switch (rec.recommendation_type) {
    case 'scale':
    case 'scale_proposal': {
      if (input.currentAccountDailyBudget == null || proposedBudget == null) return rec
      if (recent.recordedRevenue === null) return rec
      enrichment = scaleCopy({
        currentBudget: input.currentAccountDailyBudget,
        proposedBudget,
        observedRoas: recentRoas,
        recentSpend: recent.spend,
        recentRevenue: recent.recordedRevenue,
        recentBookings: recent.bookings,
      })
      break
    }
    case 'reduce_budget': {
      if (!mature) return rec
      if (mature.recordedRevenue === null) return rec
      const reasonCode = mature.bookings === 0 && mature.spend > 0 ? 'zero_outcome' : 'loss'
      enrichment = cutCopy({
        currentBudget: input.currentAccountDailyBudget,
        reasonCode,
        matureSpend: mature.spend,
        matureRevenue: mature.recordedRevenue,
        matureBookings: mature.bookings,
        observedRoas: matureRoas,
        targetCpa: input.targetCpa,
        maxCpa: input.maxCpa,
      })
      break
    }
    case 'pause': {
      if (!mature) return rec
      if (mature.recordedRevenue === null) return rec
      enrichment = pauseCopy({
        currentBudget: input.currentAccountDailyBudget,
        matureSpend: mature.spend,
        matureRevenue: mature.recordedRevenue,
        matureBookings: mature.bookings,
        observedRoas: matureRoas,
      })
      break
    }
    case 'activate': {
      enrichment = activateCopy({
        currentBudget: input.currentAccountDailyBudget,
        proposedBudget,
      })
      break
    }
    case 'refresh_creative':
    case 'creative_test': {
      const frequency = findMetricValue(rec, 'frequency')
      if (frequency == null && recent.spend > 0) return rec
      enrichment = refreshCopy({ frequency, targetCpa: input.targetCpa, maxCpa: input.maxCpa })
      break
    }
  }

  if (!enrichment) return rec

  return {
    ...rec,
    reason_for_action: enrichment.reason,
    expected_upside: enrichment.upside,
    possible_downside: enrichment.downside,
    minimum_data_needed: rec.minimum_data_needed
      ?? `This is attributed-association evidence, not a causal incrementality result. Re-check after the next ${recent.bookings < 10 ? '10' : '7'}-${OW.one} bucket or 7 days, whichever comes first.`,
  }
}

/** Best-practice media-buyer thresholds used by flag generators and diagnostics. */
export const MEDIA_BUYER_RULES = {
  /** Scale step size. */
  SCALE_STEP_PCT: 0.2,
  /** CPA at or above 150% of target is a cut/pause watch. */
  CPA_CUT_MULTIPLE_OF_TARGET: 1.5,
  /** Frequency band where creative fatigue typically begins. */
  FREQUENCY_REFRESH_MIN: 3.0,
  FREQUENCY_REFRESH_MAX: 3.5,
  /** Zero-outcome stop threshold expressed as multiples of max CPA — single source is REC_THRESHOLDS. */
  ZERO_OUTCOME_STOP_CPA_MULTIPLE: REC_THRESHOLDS.ZERO_OUTCOME_STOP_CPA_MULTIPLE,
} as const
