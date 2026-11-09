import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import type { TargetPolicyStatus } from '@/lib/targets/store'
import {
  analyzePaidCohortDirection,
  type PaidCohortDirectionInput,
} from '@/lib/authority/paid-cohort-direction'
import { evaluateDirection, isSupported } from '@/lib/authority/directional-policy'
import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// Operating-mode detector.
//
// Maxx behaves very differently depending on how much real signal exists. This turns "how much data
// do we have / what authority do we have" into an explicit, testable state instead of leaving it to
// the LLM to remember. Two orthogonal axes are combined into one descriptor:
//
//   dataMode:  pre_launch → low_data → active_learning → sufficient   (how much we can claim)
//   authority: recommendation → approval_only → write                  (what we're allowed to do)
//
// The mode reflects runtime signals. It never replaces per-action authority or the executor gates.

export type DataMode = 'pre_launch' | 'low_data' | 'active_learning' | 'sufficient'
export type Authority = 'recommendation' | 'approval_only' | 'write'

export interface InteractionCohortSignal {
  generationId: string
  windowStart: string
  windowEnd: string
  asOfDate: string
  complete: boolean
  /** True only when every entity unit in the generation is complete, not merely this account unit. */
  allUnitsComplete: boolean
  blockerCodes: string[]
  spend: number | null
  bookings: number | null
  bookedValue: number | null
  /** Outcome-source amount_paid checkout revenue linked to this exact paid cohort. Null = unavailable. */
  recordedRevenue?: number | null
}

export interface InteractionCohortPairSignal {
  evaluationRunId: string
  recentScale: InteractionCohortSignal
  maturedCut: InteractionCohortSignal
}

export interface ModeSignals {
  /** Total Meta spend over the trailing 30 days. Null means the authoritative spend read failed. */
  spend30d: number | null
  /** TOTAL business volume from the outcome ledger (all sources: paid, organic, phone, manual).
   *  CONTEXT ONLY. On an organic-heavy account this is large while paid produces nothing, so it must
   *  never by itself unlock a paid-performance or budget claim. */
  businessBookings30d: number | null
  /** PAID business outcomes: value-bearing ledger appointments joined to a paid channel by EXACT
   *  appointment id, over a window with proven complete identity coverage. null = NOT PROVEN, which
   *  is different from zero. This may support descriptive paid-performance reporting, but it cannot
   *  unlock money authority because exact paid touch is association, not incrementality.
   *
   *  `bookings30d` previously accepted GA confirmation events, then the outcome-source
   *  business total including organic. Both could promote an organic-heavy account into a mode that
   *  authorises budget recommendations without a single verified paid outcome. */
  exactPaidBookings30d: number | null
  /** Meta's modelled conversion count — platform optimization/learning context. NOT a business
   *  outcome and never sufficient for a money claim. */
  metaModelledBookings30d: number | null
  /** Share of GA confirmation EVENTS attributed to a named campaign (0..1). null = unknown. A
   *  coverage statistic about TELEMETRY — never evidence that a booking occurred, and never on its own
   *  sufficient to authorise a per-campaign money claim. */
  attributedShare: number | null
  /** True only when EVERY exact paid booking maps to exactly one in-scope Meta campaign. False or null
   *  means some paid bookings are unattributed, so every campaign numerator is a LOWER BOUND. */
  campaignMappingComplete: boolean | null
  /** True only when the campaign spend rows RECONCILE to account spend. An authoritative account row
   *  does not prove each campaign DENOMINATOR is whole; a missing campaign-day inflates that
   *  campaign's ROAS. Passing only the spend BASIS let this gate open while the campaign
   *  panel — which already checks this — reported every ratio unavailable. */
  campaignSpendComplete: boolean | null
  /** True when spend came from the authoritative account-level insight rows. A campaign-row sum can be
   *  missing a campaign, which shrinks the denominator and INFLATES every ratio built on it. */
  authoritativeSpendBasis: boolean | null
  /** A LAGGED HISTORICAL PERIOD used as one input to cut authority.
   *
   *  DELIBERATELY NOT called "matured" or "cohort-matched". A review was right that moving both
   *  calendars backwards does NOT prove every dollar had time to convert: Meta spend is selected by
   *  SPEND date while outcomes are selected by BOOKING date, and nothing ties an appointment to the
   *  ad-interaction that produced it. So a booking early in the period may come from spend before it,
   *  and a click near its end may convert after it. True cohort maturity needs a persisted paid-touch
   *  timestamp, which does not exist yet — see the ADR's limitations.
   *
   *  It is therefore treated as a HISTORICAL-LOSS SIGNAL that must be CORROBORATED by the recent
   *  window before it can authorise anything. null = unavailable, which blocks a cut. */
  laggedPeriod: {
    spend: number
    /** Exact paid outcomes falling in that same period. null = not proven for it. */
    exactPaidBookings: number | null
    /** Days between the period's END and now. Must be >= MIN_MATURED_DAYS_FOR_CUT. */
    daysSinceEnd: number
    start: string
    end: string
  } | null
  /** NON-OVERLAPPING corroboration slice: the days strictly AFTER the lagged period ends, through the
   *  end of the reporting window.
   *
   *  Corroboration previously came from the trailing 30-day window, which CONTAINS the
   *  lagged 14-day period outright (recent 06-29..07-28 vs lagged 07-02..07-15). The same spend and
   *  the same outcomes were therefore counted as both the historical loss AND its independent
   *  confirmation. That is double evidence, and it could authorise a cut without ever showing that
   *  the loss continued after the historical period ended.
   *
   *  This slice shares no dates with the lagged period. It is NOT matured — it runs up to yesterday —
   *  which is why a ZERO here cannot corroborate anything (see postPeriodCorroboratesLoss).
   *  null = unavailable, which blocks a cut. */
  postPeriod: {
    spend: number
    /** null = not proven over this slice. */
    exactPaidBookings: number | null
    /** Days between this slice's END and now — its own maturity, judged separately. */
    daysSinceEnd: number
    start: string
    end: string
  } | null
  /** One immutable, same-run pair. Scale reads only recentScale; cut reads maturedCut and uses the
   *  recent direction only to detect recovery/conflict. These booking/value fields are diagnostic;
   *  the separate profit evidence below is required for a commercial direction. */
  interactionCohorts: InteractionCohortPairSignal | null
  /** Processor-settled, refund/cost-complete contribution evidence aligned to the paid cohorts.
   *  Omitted in production until that ledger exists, which intentionally fails all money gates closed. */
  profit?: PaidCohortDirectionInput['profit']
  /** True when NO material setting change separates the lagged period from now. A recovered setup must
   *  not be cut for its predecessor's performance. null = unknown, which blocks a cut. */
  structuralContinuity: boolean | null
  /** EFFECTIVE CPA targets at evaluation time. The rules said they moved with the "active"
   *  maximum, but REC_THRESHOLDS.TARGET_CPA/MAX_CPA are captured from METRIC_RANGES DEFAULTS at module
   *  load, so a Performance-Targets override never reached them — a $200 active max was still judged
   *  against $100. Callers pass the effective values; the pure function never reads a static default.
   *  null until the owner sets a CPA target. */
  targetCpa: number | null
  maxCpa: number | null
  /** Authority health for the policy that supplied targetCpa/maxCpa. Legacy app_settings rows and
   * defaults may label diagnostic bands, but only a durably versioned, owner-approved `governed`
   * policy may help authorize a budget direction. */
  targetPolicyStatus: TargetPolicyStatus
  /** The campaign objective this account optimises for. Booking-CPA rules apply only to conversion
   *  objectives; awareness and lead objectives must be judged on their own metrics, never on booking CPA. */
  objective: 'bookings' | 'leads' | 'awareness' | 'unknown'
  /** Days since the account last had a delivering ad. null = unknown. */
  daysSinceLastDelivery: number | null
  /** Count of ads currently delivering (spending). null = unknown, which is NOT zero — a caller whose
   *  spend evidence is unreadable must pass null rather than 0, or the dormancy branch below fires and
   *  the account is declared pre-launch on the strength of a failed read. */
  activeAdsDelivering: number | null
  /** Whether any ad set has plausibly exited the learning phase. */
  anyAdsetExitedLearning: boolean
  /** process.env.WRITE_MODE_ENABLED === 'true'. */
  writeModeEnabled: boolean
  /** When true, Maxx may emit OWNER-REVIEW budget recommendations from attributed paid-cohort evidence. */
  mediaBuyerRecommendationsEnabled: boolean
}

/**
 * The evidence class underneath a budget verdict.
 *
 * `interaction_cohort_complete` — every exact paid outcome in scope carries a persisted,
 *   provenance-backed AD-INTERACTION timestamp, and coverage over the evaluated window is complete.
 *   This supports an aligned diagnostic, not a causal claim or money move.
 *
 * `calendar_period_signal` — outcomes are identified by CONFIRMATION date and booking-session
 *   channel. That is a real, useful signal and it supports diagnosis. It is NOT a cohort: a booking
 *   caused by spend inside the window but confirmed after it lands outside the window and is never
 *   assigned back, and a booking confirmed inside the window may have been caused by spend before it.
 *   Moving both calendars backwards does not repair this — it relabels it.
 *
 * `unavailable` — not enough evidence to say anything.
 *
 * `decision_grade_causal_estimate` — an immutable causal-contribution estimate, bound to the exact
 *   experiment target and action-compatible estimand. This is the only basis policy v4 may use for
 *   a money decision; interaction cohorts remain valuable inputs and diagnostics, not authority.
 */
export type AuthorityBasis =
  | 'decision_grade_causal_estimate'
  | 'interaction_cohort_complete'
  /**
   * Meta's own modelled attribution, explicitly labeled as an estimate. Admissible ONLY for
   * owner-reviewed money recommendations, never for execution. Added 2026-08-18 because the
   * deterministic planes cannot answer money questions at a small account's volume: only a minority
   * of fbclid-carrying bookings link, and the capture numerator can be duplicate-inflated. A
   * labeled estimate the owner can act on beats silence that looks like a measured zero.
   */
  | 'meta_modelled_association'
  | 'calendar_period_signal'
  | 'unavailable'

export interface OperatingModeResult {
  dataMode: DataMode
  authority: Authority
  /** Short display label combining both, e.g. "Pre-launch · approval-only". */
  label: string
  reason: string
  focus: string
  // Capability gates — what Maxx is allowed to claim/do in this mode.
  canMakePerformanceClaims: boolean
  canClaimPerCampaignRoas: boolean
  /** SCALE (raise budget) — requires decision-grade positive incremental contribution. */
  canRecommendBudgetScale: boolean
  /** CUT — requires mature decision-grade negative incremental contribution corroborated by a
   *  non-overlapping recent window. Bookings, CPA and spend multiples cannot substitute. */
  canRecommendBudgetCut: boolean
  /** Retained for surfaces that ask the coarse question: true when EITHER action is permitted. */
  canRecommendBudgetChanges: boolean
  /** A contribution estimate that is directionally suggestive but not execution-grade receives a
   *  review verdict. Booking CPA can be displayed separately but never selects this verdict. */
  budgetVerdict:
    /** Reserved for a future verified causal-estimate reader; unreachable from current mode signals. */
    | 'scale_candidate'
    | 'cut_candidate'
    /** DIAGNOSTIC states. Real, useful, owner-facing — but they authorise NOTHING. A calendar period
     *  can show that money was lost or that results look healthy; it cannot show that the evaluated
     *  SPEND caused the observed OUTCOMES, so it cannot license moving budget. */
    | 'healthy_signal_review'
    | 'loss_signal_review'
    | 'conflicting_signals_review'
    | 'hold_watch'
    | 'insufficient_evidence'
  /** WHAT KIND of evidence the verdict rests on. See `AuthorityBasis`. */
  authorityBasis: AuthorityBasis
  /** Direction-specific bases. Callers authorising a money kind must use these, never infer one from
   *  the coarse account basis. */
  scaleAuthorityBasis: AuthorityBasis
  cutAuthorityBasis: AuthorityBasis
  targetPolicyStatus: TargetPolicyStatus
  restrictions: string[]
}

export function detectOperatingMode(s: ModeSignals): OperatingModeResult {
  const spendLabel = s.spend30d !== null ? `${formatMoney(s.spend30d, { maximumFractionDigits: 0 })}` : 'unknown spend'
  const dormantBySpend = s.spend30d !== null && s.spend30d <= REC_THRESHOLDS.DORMANT_SPEND_30D
  // Both legs are null-guarded: unknown delivery can never establish dormancy.
  const dormantByDelivery =
    s.activeAdsDelivering === 0 ||
    (s.daysSinceLastDelivery !== null && s.daysSinceLastDelivery >= REC_THRESHOLDS.DORMANT_DAYS_NO_DELIVERY)

  // The data mode describes whether there is enough OBSERVED ACTIVITY to say anything at all. It uses
  // the delivery/learning signals plus Meta's modelled volume — platform context — and deliberately
  // NOT the business total, which includes organic.
  const activityVolume = s.metaModelledBookings30d ?? 0

  let dataMode: DataMode
  if (dormantBySpend || dormantByDelivery) {
    dataMode = 'pre_launch'
  } else if (activityVolume < REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM) {
    dataMode = 'low_data'
  } else if (!s.anyAdsetExitedLearning) {
    dataMode = 'active_learning'
  } else {
    dataMode = 'sufficient'
  }

  // Calendar-period joins and interaction cohorts remain useful DIAGNOSTICS. The latter can align
  // observed spend and outcomes to paid interactions, but neither supplies the randomized or
  // defensible quasi-experimental comparison required to claim incremental contribution.
  const provenPaidOutcomes = s.exactPaidBookings30d

  // Authority: write mode is the strongest; without it we are approval-only (a human gates every
  // live action). "recommendation" = read-only suggestions that don't even queue an approval.
  const authority: Authority = s.writeModeEnabled ? 'write' : 'approval_only'

  const canMakePerformanceClaims =
    dataMode !== 'pre_launch'
    && s.interactionCohorts?.recentScale.complete === true
    && s.interactionCohorts.recentScale.allUnitsComplete === true
    && (s.interactionCohorts.recentScale.bookings ?? 0) >= REC_THRESHOLDS.MIN_BOOKINGS_STRONG_CLAIM
  // Per-campaign ROAS previously unlocked on named-campaign SHARE alone — a coverage
  // statistic about telemetry, with no appointment identity behind it. It now requires proven paid
  // outcomes; the share is a necessary extra condition, never a sufficient one.
  // This unlocked on account-level exact outcomes plus a 50% GA LABEL share, so the brain
  // contradicted the campaign panel — which already withholds ROAS when mapping is incomplete. A
  // per-CAMPAIGN claim needs per-CAMPAIGN completeness and an authoritative denominator.
  const canClaimPerCampaignRoas =
    canMakePerformanceClaims &&
    s.interactionCohorts?.recentScale.complete === true &&
    s.interactionCohorts.recentScale.allUnitsComplete === true

  const cpaRulesApply = s.objective === 'bookings'
  const pair = s.interactionCohorts
  const matured = pair?.maturedCut ?? null
  const direction = analyzePaidCohortDirection({
    cohorts: pair,
    objective: s.objective,
    structuralContinuity: s.structuralContinuity,
    targetCpa: s.targetCpa,
    maxCpa: s.maxCpa,
    targetPolicyStatus: s.targetPolicyStatus,
    profit: s.profit,
  })
  const scaleComplete = direction.scaleComplete
  const recentCutComplete = direction.recentCutComplete
  const maturedComplete = direction.maturedComplete
  const cutSpend = maturedComplete ? matured!.spend! : 0

  const historicalLoss = direction.historicalLoss
  const continuous = s.structuralContinuity === true
  const signalsConflict = direction.windowsConflict
  const evalOpts = { pragmaticMediaBuyerEnabled: s.mediaBuyerRecommendationsEnabled }
  const scaleVerdict = direction.evidence
    ? evaluateDirection('budget_scale', direction.evidence, evalOpts)
    : null
  const cutVerdict = direction.evidence
    ? evaluateDirection('budget_cut', direction.evidence, evalOpts)
    : null
  const lossSignalSound = cutVerdict !== null && isSupported(cutVerdict)
  // In pragmatic media-buyer mode, owner_review is a valid recommendation ceiling (not execution).
  const scaleEvidenceSound = dataMode !== 'pre_launch'
    && scaleVerdict !== null
    && (scaleVerdict.ceiling === 'execution'
      || (s.mediaBuyerRecommendationsEnabled && scaleVerdict.ceiling === 'owner_review'))
  const healthySignalSound = scaleEvidenceSound && !historicalLoss && !signalsConflict

  // Calendar-only fallback is diagnostic and keeps old observations visible while activation or
  // capture coverage is incomplete. It never supplies a money direction.
  const calendarCpa = s.spend30d !== null && provenPaidOutcomes && provenPaidOutcomes > 0
    ? s.spend30d / provenPaidOutcomes : null
  const cw = s.laggedPeriod
  const haveCalendarSignal = calendarCpa !== null || provenPaidOutcomes !== null || cw !== null
  const scaleAuthorityBasis: AuthorityBasis = scaleComplete
    ? 'interaction_cohort_complete'
    : haveCalendarSignal ? 'calendar_period_signal' : 'unavailable'
  const cutAuthorityBasis: AuthorityBasis = recentCutComplete && maturedComplete
    ? 'interaction_cohort_complete'
    : haveCalendarSignal ? 'calendar_period_signal' : 'unavailable'
  // Compatibility field only. This names the strongest observed diagnostic basis. Policy-v4 money
  // callers must instead bind an immutable `decision_grade_causal_estimate` to the ActionDecision.
  const authorityBasis: AuthorityBasis =
    scaleAuthorityBasis === 'interaction_cohort_complete'
      || cutAuthorityBasis === 'interaction_cohort_complete'
      ? 'interaction_cohort_complete'
      : haveCalendarSignal ? 'calendar_period_signal' : 'unavailable'

  // The feature flag may allow owner-review recommendations only when separate, valid profit
  // evidence exists. Booked appointment value alone never creates that evidence.
  const pragmaticScaleAllowed = !!s.mediaBuyerRecommendationsEnabled
    && scaleComplete
    && scaleVerdict !== null
    && (scaleVerdict.ceiling === 'owner_review' || scaleVerdict.ceiling === 'execution')
  const pragmaticCutAllowed = !!s.mediaBuyerRecommendationsEnabled
    && recentCutComplete
    && maturedComplete
    && cutVerdict !== null
    && (cutVerdict.ceiling === 'owner_review' || cutVerdict.ceiling === 'execution')
  // ModeSignals has no trusted causal-estimate identity or estimator-granted authority. The causal
  // pipeline may bind an immutable decision-grade estimate elsewhere; until then, this surface fails
  // closed for causal money recommendations. Pragmatic media-buyer mode is the only current path to
  // owner-review budget recommendations.
  const canRecommendBudgetScale = pragmaticScaleAllowed
  const canRecommendBudgetCut = pragmaticCutAllowed
  const canRecommendBudgetChanges = canRecommendBudgetScale || canRecommendBudgetCut

  const budgetVerdict: OperatingModeResult['budgetVerdict'] =
    signalsConflict ? 'conflicting_signals_review'
    : healthySignalSound ? (canRecommendBudgetScale ? 'scale_candidate' : 'healthy_signal_review')
    : lossSignalSound ? (canRecommendBudgetCut ? 'cut_candidate' : 'loss_signal_review')
    : 'insufficient_evidence'

  const effectiveCeiling = MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling
  const restrictions: string[] = []
  restrictions.push(`NORTH STAR: maximize monthly paid ${OW.many} and recorded collected value; capacity is not a growth ceiling. Profit claims remain a separate processor-settled contribution plane. The owner-approved account-wide daily ad-spend ceiling is ${formatMoneyAmount(effectiveCeiling)}.`)
  if (s.mediaBuyerRecommendationsEnabled) {
    restrictions.push(`MEDIA-BUYER RECOMMENDATIONS ARE ENABLED, but the flag does not create revenue lineage or raise the owner-approved budget ceiling. Booked ${OW.one} value remains diagnostic; every money direction still requires complete profit evidence and owner approval.`)
  }
  if (!s.profit) restrictions.push(`PROFIT EVIDENCE UNAVAILABLE: the decision lacks complete processor-settled collections, refunds/chargebacks, payment fees, governed variable fulfillment costs, matched ad spend, payment-to-experiment assignment, maturity, uncertainty, or causal comparison. Account-total observed contribution and exact paid touch are diagnostics only; ${OW.one} CPA, booked value and platform ROAS cannot substitute.`)
  if (!canMakePerformanceClaims) restrictions.push('No confident paid-performance claim: a complete recent interaction cohort with adequate count precision is unavailable. Meta-modelled volume and learning state cannot substitute.')
  if (!canClaimPerCampaignRoas) {
    restrictions.push('No per-campaign CPA/ROAS claim: the latest recent interaction generation is missing, blocked, or does not prove every campaign unit complete. GA labels and confirmation-date joins cannot substitute for unit cohort coverage.')
  }
  if (!cpaRulesApply) restrictions.push(`Delivery objective is "${s.objective}". This changes Meta's optimization context, not Maxx's commercial north star.`)
  if (signalsConflict) {
    const prior = `mature contribution remained below zero on ${formatMoney(cutSpend, { maximumFractionDigits: 0 })} ad spend`
    const why = !continuous
      ? (s.structuralContinuity === null
          ? 'structural continuity is unknown'
          : 'a material setup change separates the windows')
      : 'the recent contribution window recovered above zero'
    restrictions.push(`CONFLICTING WINDOWS — NEITHER money direction is authorised. ${prior}; ${why}. Review the setup transition before changing spend.`)
  } else if (canRecommendBudgetScale) {
    restrictions.push(`SCALE candidate: the recent interaction-aligned contribution signal is positive, and the proposed account-total budget remains within ${formatMoneyAmount(effectiveCeiling)}. ${s.mediaBuyerRecommendationsEnabled ? 'Pragmatic attributed-association evidence — owner approval required.' : 'Causal incrementality evidence supports this direction; execution still requires owner approval and write mode.'}`)
  } else if (canRecommendBudgetCut) {
    restrictions.push(`CUT candidate: the mature contribution signal is negative and corroborated by the recent window. ${s.mediaBuyerRecommendationsEnabled ? 'Pragmatic attributed-association evidence — owner approval required.' : 'Causal incrementality evidence supports this direction; execution still requires owner approval and write mode.'}`)
  } else if (budgetVerdict === 'healthy_signal_review') {
    restrictions.push('POSITIVE CONTRIBUTION SIGNAL — no scale authority. The point estimate is favorable, but causality, uncertainty, maturity, lineage, or the account-budget constraint did not clear every scale gate.')
  } else if (budgetVerdict === 'loss_signal_review') {
    restrictions.push('NEGATIVE CONTRIBUTION SIGNAL — no cut authority. The loss, uncertainty, maturity, continuity, or non-overlapping corroboration gates did not all clear.')
  } else {
    restrictions.push('No budget direction: complete direction-specific interaction evidence is not available or does not meet a governed action rule.')
  }
  restrictions.push(`Observed basis for scaling: ${scaleAuthorityBasis}. ${s.mediaBuyerRecommendationsEnabled ? 'Pragmatic mode uses attributed association; causal incrementality is not claimed.' : 'Policy v4 additionally requires an immutable decision-grade causal estimate for marginal contribution versus the current state; none is bound to this mode result.'}`)
  restrictions.push(`Observed basis for reducing spend: ${cutAuthorityBasis}. ${s.mediaBuyerRecommendationsEnabled ? 'Pragmatic mode uses attributed association; causal incrementality is not claimed.' : 'Policy v4 additionally requires an immutable decision-grade causal estimate for total contribution versus no ads; none is bound to this mode result.'}`)
  restrictions.push('Treat Meta appointment_value as a MODELLED estimate. recorded booked value is scheduled price; recorded collected value is owner-declared checkout revenue after discounts. GA confirmation events are telemetry. None alone proves incrementality or profit.')
  if (authority !== 'write') restrictions.push('Write mode OFF — every live change requires human approval out-of-band.')

  const labelData =
    dataMode === 'pre_launch' ? 'Pre-launch' : dataMode === 'low_data' ? 'Sparse modelled volume' : dataMode === 'active_learning' ? 'Learning state observed' : 'Learning exit observed'
  const labelAuth = authority === 'write' ? 'write' : authority === 'approval_only' ? 'approval-only' : 'recommendation'

  let reason: string
  let focus: string
  switch (dataMode) {
    case 'pre_launch':
      // activeAdsDelivering is nullable; interpolating null would print "null ad(s) delivering".
      reason = `Spend over 30d is ${spendLabel} and ${s.activeAdsDelivering ?? 'an unknown number of'} ad(s) delivering${s.daysSinceLastDelivery !== null ? ` (last delivery ${s.daysSinceLastDelivery}d ago)` : ''} — effectively dormant.`
      focus = 'Launch readiness: approved CampaignPlan, tracking identity, business constraints and measurement contract — NOT performance diagnosis.'
      break
    case 'low_data':
      reason = `Spend is flowing (${spendLabel}/30d) but only ${activityVolume} Meta-modelled conversion(s) — below ${REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM}.`
      focus = 'Complete settled-payment, refund, variable-cost, paid-touch and incrementality lineage; modelled volume alone is not a verdict.'
      break
    case 'active_learning':
      reason = `${activityVolume} Meta-modelled conversion(s) on ${spendLabel}/30d; no ad set has clearly exited the learning phase. This is delivery-system context, not a money-decision veto or proof.`
      focus = 'Evaluate settled incremental contribution, uncertainty and maturity independently from learning state.'
      break
    case 'sufficient':
      reason = `${activityVolume} Meta-modelled conversion(s) on ${spendLabel}/30d with at least one ad set out of learning. Exiting learning does not prove business impact. ${provenPaidOutcomes === null ? 'Paid outcomes are NOT PROVEN.' : `${provenPaidOutcomes} confirmation-period paid outcome(s) are visible; interaction-cohort completeness still governs decisions.`}`
      focus = 'Use settled incremental contribution, uncertainty, causal design and owner approval; report learning state separately.'
      break
  }

  return {
    dataMode,
    authority,
    label: `${labelData} · ${labelAuth}`,
    reason,
    focus,
    canMakePerformanceClaims,
    canClaimPerCampaignRoas,
    canRecommendBudgetScale,
    canRecommendBudgetCut,
    canRecommendBudgetChanges,
    budgetVerdict,
    authorityBasis,
    scaleAuthorityBasis,
    cutAuthorityBasis,
    targetPolicyStatus: s.targetPolicyStatus,
    restrictions,
  }
}
