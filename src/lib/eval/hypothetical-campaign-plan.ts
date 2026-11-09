import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { formatMoneyAmount } from '@/lib/utils/format-currency'

export type Objective = 'OUTCOME_LEADS' | 'OUTCOME_SALES' | 'OUTCOME_TRAFFIC' | 'OUTCOME_AWARENESS'
export type BidStrategy = 'highest_volume' | 'cost_per_result_goal' | 'bid_cap'
export type BusinessGoal =
  | 'maximize_incremental_contribution_from_ad_attributed_collected_revenue'
  | 'maximize_bookings_and_collected_revenue'
  | 'maximize_bookings'
  | 'maximize_roas'

export const MAXX_OWNER_GROWTH_GOAL = 'maximize_bookings_and_collected_revenue' as const
export const MAXX_GROWTH_EXPERIMENT_METRIC = 'outcome_checkout_revenue_and_paid_bookings' as const

export interface SelectedAudienceEvidence {
  id: string
  kind: 'website' | 'engagement' | 'customer_list' | 'lookalike' | 'other'
  operationStatus: 'ready' | 'failed' | 'unknown'
  approximateSize: number | null
  sourceAudienceSize: number | null
  sourceQuality: 'high_value_customers' | 'website_visitors' | 'engagers' | 'unknown' | null
}

export interface CampaignCreativeAsset {
  id: string
  conceptId: string
  format: 'image' | 'video' | 'carousel' | 'collection'
  destinationUrl: string
  freshConcept: boolean
  isReused: boolean
  placementCompatible: boolean
}

export interface HypotheticalCampaignPlan {
  name: string
  businessGoal: BusinessGoal
  objective: Objective
  performanceGoal: string
  conversionLocation: 'website' | 'instant_form' | 'messages' | 'calls'
  outcomeEvent: string | null
  desiredOutcomeMeasurable: boolean
  budget: {
    /** Daily budget assigned to this hypothetical campaign or ad set. */
    daily: number
    /** Projected total of every active account budget after launch; the policy ceiling applies here. */
    accountDailyAfterLaunch: number
    control: 'campaign' | 'adset'
    bidStrategy: BidStrategy
    bidControlSupportedByGovernedEconomics: boolean
  }
  audience: {
    declaredIntent: 'prospecting' | 'strict_retargeting' | 'mixed'
    advantagePlusAudience: boolean
    strictLocations: string[]
    languages: string[]
    minimumAge: number
    customAudiences: string[]
    lookalikes: string[]
    suggestions: string[]
    customAudienceExclusions: string[]
    /** Every first-party pool that the approved business policy classifies as warm. */
    requiredWarmExclusions: string[]
    /** Every conversion/customer pool that strict retargeting and prospecting must exclude. */
    requiredConverterExclusions: string[]
    detailedTargetingExclusions: string[]
    /** Live Meta evidence for every selected custom audience and lookalike. Names are not evidence. */
    selectedAudienceEvidence: SelectedAudienceEvidence[]
  }
  placements: {
    mode: 'advantage_plus' | 'manual'
    selected: string[]
    assetSupported: string[]
    documentedRestriction: string | null
  }
  creative: {
    approvedDestinationUrl: string
    landingPageSnapshotApproved: boolean
    audienceStageCompatible: boolean
    reuseDisclosureComplete: boolean
    assets: CampaignCreativeAsset[]
  }
  tracking: {
    immutableMetaIds: boolean
    readableNames: boolean
    exactPaidOutcomeComplete: boolean
    settledCollectionLineageComplete: boolean
    refundLineageComplete: boolean
    variableCostLineageComplete: boolean
    incrementalityDesignDefined: boolean
    paymentExperimentAssignmentComplete: boolean
    acceptedCapiDeliveryObserved: boolean
    measurementDefinitionContinuous: boolean
  }
  experiment: {
    design: 'randomized_holdout' | 'quasi_experimental' | 'none'
    assignmentUnit: string | null
    estimand: 'marginal_contribution_vs_current_state' | 'total_contribution_vs_no_ads' | null
    /** Retained for audit; the grader verifies it against changedVariables rather than trusting it. */
    variablesChanged: number
    changedVariables: {
      audience: boolean
      creative: boolean
      destination: boolean
      budget: boolean
      optimization: boolean
    }
    primaryMetric: string | null
    comparison: string | null
    maturityRule: string | null
    stopRule: string | null
  }
}

export interface HistoricalDeliveryBaseline {
  days: number
  cpmRange: readonly [number, number]
  outboundCtrRateRange: readonly [number, number]
  associatedCollectedRevenuePerOutboundRange?: readonly [number, number]
  incrementalContributionBeforeAdSpendPerOutboundRange?: readonly [number, number]
}

export interface PlanFinding {
  code: string
  severity: 'blocker' | 'warning' | 'observation'
  area: 'objective' | 'audience' | 'budget_bid' | 'placements' | 'creative' | 'destination' | 'measurement' | 'experiment'
  message: string
}

export interface HypotheticalPlanGrade {
  score: number
  letter: 'A' | 'B' | 'C' | 'D' | 'F'
  categoryScores: Record<PlanFinding['area'], number>
  findings: PlanFinding[]
  planStatus: 'blocked' | 'coherent_hypothesis'
  blockerCodes: string[]
  launchAuthority: 'offline_hypothesis_only'
  metaWrites: false
}

export interface DeliveryPrediction {
  spend: number
  impressions: readonly [number, number]
  outboundClicks: readonly [number, number]
  associatedCollectedRevenue: readonly [number, number] | null
  incrementalContributionAfterAds: readonly [number, number] | null
  unavailable: string[]
  basis: 'historical_delivery_scenario_not_forecast'
}

const CATEGORY_MAX: Record<PlanFinding['area'], number> = {
  objective: 15,
  audience: 20,
  budget_bid: 10,
  placements: 10,
  creative: 15,
  destination: 10,
  measurement: 15,
  experiment: 5,
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return null
  }
}

function letter(score: number): HypotheticalPlanGrade['letter'] {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

export function gradeHypotheticalCampaignPlan(plan: HypotheticalCampaignPlan): HypotheticalPlanGrade {
  const findings: PlanFinding[] = []
  const scores = { ...CATEGORY_MAX }
  const add = (finding: PlanFinding, deduction: number) => {
    findings.push(finding)
    scores[finding.area] = Math.max(0, scores[finding.area] - deduction)
  }

  if (plan.businessGoal !== MAXX_OWNER_GROWTH_GOAL) {
    add({ code: 'commercial_objective_mismatch', severity: 'blocker', area: 'objective', message: 'The owner-confirmed growth objective is more paid bookings and recorded collected value. Profit, platform ROAS, and delivery metrics are separate diagnostics.' }, 20)
  }
  if (plan.desiredOutcomeMeasurable && (plan.objective === 'OUTCOME_TRAFFIC' || plan.objective === 'OUTCOME_AWARENESS')) {
    add({ code: 'measurable_outcome_objective_mismatch', severity: 'blocker', area: 'objective', message: 'Traffic or Awareness is misaligned with a measurable downstream lead or sales outcome.' }, 20)
  }
  if ((plan.objective === 'OUTCOME_LEADS' || plan.objective === 'OUTCOME_SALES')
      && plan.conversionLocation === 'website' && !plan.outcomeEvent) {
    add({ code: 'outcome_event_missing', severity: 'blocker', area: 'objective', message: 'The website outcome objective has no declared optimization event.' }, 20)
  }
  if (!plan.performanceGoal.trim()) {
    add({ code: 'performance_goal_missing', severity: 'blocker', area: 'objective', message: 'No performance goal is declared.' }, 20)
  }

  if (plan.audience.strictLocations.every((location) => !location.trim())) {
    add({ code: 'location_control_missing', severity: 'blocker', area: 'audience', message: 'No strict service-area location control is declared.' }, 15)
  }
  if (!Number.isInteger(plan.audience.minimumAge) || plan.audience.minimumAge < 13 || plan.audience.minimumAge > 65) {
    add({ code: 'minimum_age_invalid', severity: 'blocker', area: 'audience', message: 'Minimum age must be a valid Meta age value from 13 through 65.' }, 10)
  }
  if (plan.audience.declaredIntent === 'strict_retargeting') {
    if (plan.audience.lookalikes.length > 0) {
      add({ code: 'retargeting_contains_lookalike', severity: 'blocker', area: 'audience', message: 'A lookalike makes this a mixed acquisition audience, not strict retargeting.' }, 10)
    }
    if (plan.audience.advantagePlusAudience || plan.audience.suggestions.length > 0) {
      add({ code: 'retargeting_expansion_enabled', severity: 'blocker', area: 'audience', message: 'Expansion or suggestions can deliver beyond the declared warm custom audiences.' }, 10)
    }
    if (plan.audience.customAudiences.length === 0) {
      add({ code: 'retargeting_seed_missing', severity: 'blocker', area: 'audience', message: 'Strict retargeting has no warm custom audience seed.' }, 20)
    }
    if (plan.audience.requiredConverterExclusions.length === 0) {
      add({ code: 'retargeting_converter_inventory_missing', severity: 'blocker', area: 'audience', message: 'Strict retargeting has no approved converter-exclusion inventory.' }, 15)
    } else {
      const exclusions = new Set(plan.audience.customAudienceExclusions)
      const missing = plan.audience.requiredConverterExclusions.filter((id) => !exclusions.has(id))
      if (missing.length > 0) {
        add({ code: 'retargeting_converter_exclusion_gap', severity: 'blocker', area: 'audience', message: `Strict retargeting does not exclude every required converter pool: ${missing.join(', ')}.` }, 15)
      }
    }
  }
  if (plan.audience.detailedTargetingExclusions.length > 0) {
    add({ code: 'detailed_targeting_exclusions_removed', severity: 'blocker', area: 'audience', message: 'Detailed-targeting exclusions are no longer a supported Meta control. Use supported audience controls or custom-audience exclusions.' }, 10)
  }
  const selectedIds = [...plan.audience.customAudiences, ...plan.audience.lookalikes]
  const evidenceById = new Map(plan.audience.selectedAudienceEvidence.map((row) => [row.id, row]))
  for (const id of selectedIds) {
    const evidence = evidenceById.get(id)
    if (!evidence) {
      add({ code: 'selected_audience_evidence_missing', severity: 'blocker', area: 'audience', message: `Selected audience ${id} has no live subtype, size, source, or operation-status evidence.` }, 10)
      continue
    }
    if (evidence.operationStatus === 'failed') {
      add({ code: 'selected_audience_failed', severity: 'blocker', area: 'audience', message: `Selected audience ${id} is failed in Meta and cannot be used in a launch plan.` }, 15)
    } else if (evidence.operationStatus === 'unknown') {
      add({ code: 'selected_audience_health_unverified', severity: 'blocker', area: 'audience', message: `Selected audience ${id} has unknown Meta operation status.` }, 10)
    }
    if (evidence.approximateSize == null || evidence.approximateSize < 0) {
      add({ code: 'selected_audience_size_invalid', severity: 'blocker', area: 'audience', message: `Selected audience ${id} has unavailable or invalid delivery-size evidence.` }, 10)
    }
    if (plan.audience.lookalikes.includes(id)) {
      if (evidence.kind !== 'lookalike') {
        add({ code: 'lookalike_subtype_mismatch', severity: 'blocker', area: 'audience', message: `Audience ${id} is declared as a lookalike but live metadata does not confirm that subtype.` }, 10)
      }
      if (evidence.sourceAudienceSize == null) {
        add({ code: 'lookalike_seed_size_unverified', severity: 'blocker', area: 'audience', message: `Lookalike ${id} has no verified source-audience size.` }, 10)
      } else if (evidence.sourceAudienceSize < 100) {
        add({ code: 'lookalike_seed_below_meta_minimum', severity: 'blocker', area: 'audience', message: `Lookalike ${id} has fewer than 100 source people and does not meet Meta's minimum source-size floor.` }, 10)
      } else if (evidence.sourceAudienceSize < 1_000) {
        add({ code: 'lookalike_seed_below_preferred_range', severity: 'warning', area: 'audience', message: `Lookalike ${id} is large enough to be eligible but below Meta's preferred 1,000–5,000 source range; treat performance as an unproven test, not a forecast.` }, 5)
      }
      if (evidence.sourceQuality !== 'high_value_customers') {
        add({ code: 'lookalike_seed_quality_risk', severity: 'warning', area: 'audience', message: `Lookalike ${id} is not sourced from a verified high-value customer population. Source quality is a test risk, not automatic proof that the audience cannot work.` }, 5)
      }
    }
  }
  if (plan.audience.declaredIntent === 'prospecting') {
    if (plan.audience.requiredWarmExclusions.length === 0) {
      add({ code: 'prospecting_exclusion_inventory_missing', severity: 'blocker', area: 'audience', message: 'Prospecting has no approved inventory of warm pools to exclude, so Cold/Warm separation is unverified.' }, 15)
    } else {
      const exclusions = new Set(plan.audience.customAudienceExclusions)
      const missing = plan.audience.requiredWarmExclusions.filter((id) => !exclusions.has(id))
      if (missing.length > 0) {
        add({ code: 'prospecting_warm_exclusion_gap', severity: 'blocker', area: 'audience', message: `Prospecting does not exclude every declared warm pool: ${missing.join(', ')}.` }, 15)
      }
    }
  }

  if (!Number.isFinite(plan.budget.daily) || plan.budget.daily <= 0) {
    add({ code: 'daily_budget_invalid', severity: 'blocker', area: 'budget_bid', message: 'Daily budget must be a positive finite amount.' }, 15)
  }
  if (!Number.isFinite(plan.budget.accountDailyAfterLaunch) || plan.budget.accountDailyAfterLaunch <= 0
      || (Number.isFinite(plan.budget.daily) && plan.budget.daily > plan.budget.accountDailyAfterLaunch)) {
    add({ code: 'account_daily_budget_invalid', severity: 'blocker', area: 'budget_bid', message: 'The projected active-account daily total must be finite, positive, and at least the hypothetical unit budget.' }, 15)
  } else if (plan.budget.accountDailyAfterLaunch > MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling) {
    add({ code: 'budget_ceiling_exceeded', severity: 'blocker', area: 'budget_bid', message: `The projected active-account daily total exceeds the owner-approved ${formatMoneyAmount(MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling)} ceiling.` }, 15)
  }
  if (plan.budget.bidStrategy !== 'highest_volume' && !plan.budget.bidControlSupportedByGovernedEconomics) {
    add({ code: 'bid_control_unsupported', severity: 'blocker', area: 'budget_bid', message: 'A cost or bid control lacks governed economics and outcome-volume support.' }, 15)
  }

  if (plan.placements.mode === 'manual') {
    if (plan.placements.selected.length === 0) {
      add({ code: 'manual_placements_empty', severity: 'blocker', area: 'placements', message: 'Manual placement mode must select at least one placement.' }, 10)
    }
    if (!plan.placements.documentedRestriction) {
      add({ code: 'manual_placements_unjustified', severity: 'warning', area: 'placements', message: 'Manual placement exclusions have no documented business or asset constraint.' }, 6)
    }
    const unsupported = plan.placements.selected.filter((placement) => !plan.placements.assetSupported.includes(placement))
    if (unsupported.length > 0) {
      add({ code: 'placement_asset_gap', severity: 'blocker', area: 'placements', message: `Selected placements lack supported assets: ${unsupported.join(', ')}.` }, 10)
    }
  } else if (plan.placements.assetSupported.length === 0) {
    add({ code: 'advantage_placement_asset_coverage_unverified', severity: 'warning', area: 'placements', message: 'Advantage+ placements are selected, but no placement-compatible asset coverage is declared.' }, 4)
  }

  const assets = plan.creative.assets
  const distinctConcepts = new Set(assets.map((asset) => asset.conceptId.trim()).filter(Boolean))
  const distinctFormats = new Set(assets.map((asset) => asset.format))
  if (distinctConcepts.size < 3) {
    add({ code: 'creative_concept_diversity_missing', severity: 'blocker', area: 'creative', message: `Only ${distinctConcepts.size} genuinely distinct creative concept(s) are declared; cosmetic variants do not count.` }, 15)
  }
  if (distinctFormats.size < 2) {
    add({ code: 'creative_format_diversity_missing', severity: 'blocker', area: 'creative', message: 'The plan uses only one creative format. At least two placement-compatible formats are required before launch.' }, 15)
  } else if (distinctFormats.size < 3) {
    add({ code: 'creative_format_diversity_limited', severity: 'warning', area: 'creative', message: 'Only two creative formats are declared; test a third format when budget and placement coverage permit.' }, 4)
  }
  if (assets.length < 3) {
    add({ code: 'creative_volume_low', severity: 'blocker', area: 'creative', message: `Only ${assets.length} creative asset(s) are declared; this cannot support a diverse launch.` }, 10)
  } else if (assets.length < 5) {
    add({ code: 'creative_volume_low', severity: 'warning', area: 'creative', message: `Only ${assets.length} creative asset(s) are declared; this provides limited simultaneous concept and placement coverage.` }, 4)
  }
  if (!assets.some((asset) => asset.freshConcept)) {
    add({ code: 'fresh_creative_missing', severity: 'blocker', area: 'creative', message: 'No asset represents a fresh creative concept; recycled media cannot be labeled a new creative test.' }, 10)
  }
  if (assets.some((asset) => asset.isReused) && !plan.creative.reuseDisclosureComplete) {
    add({ code: 'creative_reuse_undisclosed', severity: 'blocker', area: 'creative', message: 'Reused assets are present without complete reuse provenance.' }, 10)
  }
  if (assets.some((asset) => !asset.placementCompatible)) {
    add({ code: 'creative_placement_incompatible', severity: 'blocker', area: 'creative', message: 'At least one creative lacks verified compatibility with its selected placements.' }, 10)
  }

  const approvedDestination = normalizedUrl(plan.creative.approvedDestinationUrl)
  if (!approvedDestination) {
    add({ code: 'approved_destination_invalid', severity: 'blocker', area: 'destination', message: 'The approved destination is not a valid credential-free HTTP(S) URL.' }, 10)
  } else {
    const mismatched = assets.filter((asset) => normalizedUrl(asset.destinationUrl) !== approvedDestination)
    if (mismatched.length > 0) {
      add({ code: 'creative_destination_mismatch', severity: 'blocker', area: 'destination', message: `Creative destination drift exists on: ${mismatched.map((asset) => asset.id).join(', ')}.` }, 10)
    }
  }
  if (!plan.creative.landingPageSnapshotApproved) {
    add({ code: 'landing_page_snapshot_unapproved', severity: 'blocker', area: 'destination', message: 'The destination lacks an approved, versioned landing-page snapshot.' }, 10)
  }
  if (!plan.creative.audienceStageCompatible) {
    add({ code: 'destination_stage_mismatch', severity: 'blocker', area: 'destination', message: 'The hook, offer, CTA, and destination are not verified for the declared audience stage.' }, 10)
  }

  if (!plan.tracking.immutableMetaIds || !plan.tracking.readableNames) {
    add({ code: 'tracking_contract_incomplete', severity: 'blocker', area: 'measurement', message: 'Tracking must preserve immutable Meta IDs and readable names.' }, 10)
  }
  if (!plan.tracking.exactPaidOutcomeComplete) {
    add({ code: 'paid_outcome_unavailable', severity: 'warning', area: 'measurement', message: 'Paid-touch association is unavailable without complete outcome identity and mapped spend. This limits attribution diagnostics but does not invalidate a properly assigned causal experiment.' }, 2)
  }
  for (const [code, complete, severity, message] of [
    ['settled_collection_lineage_incomplete', plan.tracking.settledCollectionLineageComplete, 'observation', 'Stripe settlement reconciliation is incomplete. This limits net-cash/profit reporting but does not block optimization to recorded collected value.'],
    ['refund_lineage_incomplete', plan.tracking.refundLineageComplete, 'warning', 'Refund and chargeback lineage is incomplete. Report recorded collected value as gross booking revenue, not net revenue.'],
    ['variable_cost_lineage_incomplete', plan.tracking.variableCostLineageComplete, 'observation', 'Payment and variable fulfillment costs are incomplete. Profit is unavailable, but the owner-confirmed bookings and checkout-revenue objective remains measurable.'],
    ['incrementality_design_missing', plan.tracking.incrementalityDesignDefined, 'blocker', 'No controlled or defensible quasi-experimental incrementality design is declared.'],
    ['experiment_assignment_incomplete', plan.tracking.paymentExperimentAssignmentComplete, 'blocker', 'Paid bookings and recorded collected value cannot be joined to the governed treatment/control or quasi-experimental comparison.'],
  ] as const) {
    if (!complete) add({ code, severity, area: 'measurement', message }, severity === 'blocker' ? 6 : severity === 'warning' ? 3 : 0)
  }
  if (!plan.tracking.measurementDefinitionContinuous) {
    add({ code: 'measurement_definition_break', severity: 'blocker', area: 'measurement', message: 'Historical before/after comparison is invalid across a measurement-definition discontinuity.' }, 10)
  }
  if (!plan.tracking.acceptedCapiDeliveryObserved) {
    add({ code: 'capi_acceptance_unproven', severity: 'warning', area: 'measurement', message: 'Server-event delivery is unproven until an accepted Meta response is recorded.' }, 3)
  }

  const computedVariablesChanged = Object.values(plan.experiment.changedVariables).filter(Boolean).length
  if (computedVariablesChanged !== 1) {
    add({ code: 'experiment_variable_count_invalid', severity: 'blocker', area: 'experiment', message: 'An interpretable experiment changes exactly one declared variable.' }, 5)
  }
  if (plan.experiment.variablesChanged !== computedVariablesChanged) {
    add({ code: 'experiment_declared_variable_mismatch', severity: 'blocker', area: 'experiment', message: `The plan declared ${plan.experiment.variablesChanged} changed variable(s), but the structured comparison contains ${computedVariablesChanged}.` }, 5)
  }
  if (plan.experiment.design === 'none') {
    add({ code: 'experiment_design_missing', severity: 'blocker', area: 'experiment', message: 'No randomized holdout or governed quasi-experimental design is declared.' }, 5)
  }
  if (!plan.experiment.assignmentUnit?.trim()) {
    add({ code: 'experiment_assignment_unit_missing', severity: 'blocker', area: 'experiment', message: 'The causal design has no declared assignment or comparison unit.' }, 3)
  }
  if (!plan.experiment.estimand) {
    add({ code: 'experiment_estimand_missing', severity: 'blocker', area: 'experiment', message: 'The causal design does not declare whether it estimates marginal contribution versus the current state or total contribution versus no ads.' }, 3)
  }
  if (plan.experiment.primaryMetric && plan.experiment.primaryMetric !== MAXX_GROWTH_EXPERIMENT_METRIC) {
    add({ code: 'experiment_metric_mismatch', severity: 'blocker', area: 'experiment', message: 'The experiment must optimize the owner-confirmed outcome: recorded collected value together with paid bookings. Platform ROAS and delivery metrics are diagnostics.' }, 10)
  }
  for (const [code, value] of [
    ['experiment_metric_missing', plan.experiment.primaryMetric],
    ['experiment_comparison_missing', plan.experiment.comparison],
    ['experiment_maturity_missing', plan.experiment.maturityRule],
    ['experiment_stop_rule_missing', plan.experiment.stopRule],
  ] as const) {
    if (!value) add({ code, severity: 'blocker', area: 'experiment', message: 'The experiment contract is incomplete.' }, 3)
  }

  const rawScore = Object.values(scores).reduce((total, value) => total + value, 0)
  const blockerCodes = findings.filter((finding) => finding.severity === 'blocker').map((finding) => finding.code)
  const blocked = blockerCodes.length > 0
  const score = blocked ? Math.min(rawScore, 59) : rawScore
  return {
    score,
    letter: blocked ? 'F' : letter(score),
    categoryScores: scores,
    findings,
    planStatus: blocked ? 'blocked' : 'coherent_hypothesis',
    blockerCodes,
    launchAuthority: 'offline_hypothesis_only',
    metaWrites: false,
  }
}

function validRange(range: readonly [number, number], min: number, max: number): boolean {
  return range.every((value) => Number.isFinite(value) && value >= min && value <= max) && range[0] <= range[1]
}

function roundedRange(range: readonly [number, number]): readonly [number, number] {
  return [Math.floor(range[0]), Math.ceil(range[1])]
}

export function predictHypotheticalDelivery(
  plan: HypotheticalCampaignPlan,
  baseline: HistoricalDeliveryBaseline,
): DeliveryPrediction {
  if (!Number.isFinite(plan.budget.daily) || plan.budget.daily <= 0 || !Number.isInteger(baseline.days) || baseline.days <= 0) {
    throw new Error('Prediction requires a positive daily budget and positive integer day count.')
  }
  if (!validRange(baseline.cpmRange, 0.01, 1_000_000) || !validRange(baseline.outboundCtrRateRange, 0, 1)) {
    throw new Error('Prediction baseline ranges are invalid.')
  }
  const spend = plan.budget.daily * baseline.days
  if (!Number.isFinite(spend)) throw new Error('Prediction inputs exceed finite numeric bounds.')
  const rawImpressions: readonly [number, number] = [
    (spend / baseline.cpmRange[1]) * 1_000,
    (spend / baseline.cpmRange[0]) * 1_000,
  ]
  if (!rawImpressions.every(Number.isFinite)) throw new Error('Prediction inputs exceed finite numeric bounds.')
  const impressions = roundedRange(rawImpressions)
  const rawOutboundClicks: readonly [number, number] = [
    impressions[0] * baseline.outboundCtrRateRange[0],
    impressions[1] * baseline.outboundCtrRateRange[1],
  ]
  if (!rawOutboundClicks.every(Number.isFinite)) throw new Error('Prediction inputs exceed finite numeric bounds.')
  const outboundClicks = roundedRange(rawOutboundClicks)
  const unavailable: string[] = []
  let associatedCollectedRevenue: readonly [number, number] | null = null
  let incrementalContributionAfterAds: readonly [number, number] | null = null

  const continuityComplete = plan.tracking.measurementDefinitionContinuous
  const collectionComplete = plan.tracking.settledCollectionLineageComplete
  const refundsComplete = plan.tracking.refundLineageComplete
  const associatedReady = continuityComplete && collectionComplete && refundsComplete
    && plan.tracking.exactPaidOutcomeComplete && Boolean(baseline.associatedCollectedRevenuePerOutboundRange)
  const incrementalReady = continuityComplete && collectionComplete && refundsComplete
    && plan.tracking.variableCostLineageComplete && plan.tracking.incrementalityDesignDefined
    && plan.tracking.paymentExperimentAssignmentComplete
    && Boolean(baseline.incrementalContributionBeforeAdSpendPerOutboundRange)

  if (!continuityComplete) unavailable.push('historical measurement definition is discontinuous')
  if (!plan.tracking.exactPaidOutcomeComplete) unavailable.push('exact paid-touch association cohort is incomplete')
  if (!collectionComplete) unavailable.push('processor-settled collection lineage is incomplete')
  if (!refundsComplete) unavailable.push('refund and chargeback lineage is incomplete')
  if (!plan.tracking.variableCostLineageComplete) unavailable.push('variable cost lineage is incomplete')
  if (!plan.tracking.incrementalityDesignDefined) unavailable.push('incrementality design is undefined')
  if (!plan.tracking.paymentExperimentAssignmentComplete) unavailable.push('payment-to-experiment assignment is incomplete')
  if (!baseline.associatedCollectedRevenuePerOutboundRange) unavailable.push('no trusted associated collected-revenue range')
  if (!baseline.incrementalContributionBeforeAdSpendPerOutboundRange) unavailable.push('no trusted incremental contribution range')

  if (associatedReady && baseline.associatedCollectedRevenuePerOutboundRange) {
    if (!validRange(baseline.associatedCollectedRevenuePerOutboundRange, 0, 1_000_000)) {
      throw new Error('Associated collected-revenue range is invalid.')
    }
    associatedCollectedRevenue = [
      outboundClicks[0] * baseline.associatedCollectedRevenuePerOutboundRange[0],
      outboundClicks[1] * baseline.associatedCollectedRevenuePerOutboundRange[1],
    ]
    if (!associatedCollectedRevenue.every(Number.isFinite)) throw new Error('Prediction inputs exceed finite numeric bounds.')
  }

  if (incrementalReady && baseline.incrementalContributionBeforeAdSpendPerOutboundRange) {
    if (!validRange(baseline.incrementalContributionBeforeAdSpendPerOutboundRange, -1_000_000, 1_000_000)) {
      throw new Error('Incremental contribution range is invalid.')
    }
    const products = [
      outboundClicks[0] * baseline.incrementalContributionBeforeAdSpendPerOutboundRange[0],
      outboundClicks[0] * baseline.incrementalContributionBeforeAdSpendPerOutboundRange[1],
      outboundClicks[1] * baseline.incrementalContributionBeforeAdSpendPerOutboundRange[0],
      outboundClicks[1] * baseline.incrementalContributionBeforeAdSpendPerOutboundRange[1],
    ]
    incrementalContributionAfterAds = [Math.min(...products) - spend, Math.max(...products) - spend]
    if (!incrementalContributionAfterAds.every(Number.isFinite)) throw new Error('Prediction inputs exceed finite numeric bounds.')
  }

  return {
    spend,
    impressions,
    outboundClicks,
    associatedCollectedRevenue,
    incrementalContributionAfterAds,
    unavailable,
    basis: 'historical_delivery_scenario_not_forecast',
  }
}
