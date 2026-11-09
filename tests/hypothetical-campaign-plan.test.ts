import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { describe, expect, it } from 'vitest'
import {
  gradeHypotheticalCampaignPlan,
  predictHypotheticalDelivery,
  type HypotheticalCampaignPlan,
} from '@/lib/eval/hypothetical-campaign-plan'

function plan(overrides: Partial<HypotheticalCampaignPlan> = {}): HypotheticalCampaignPlan {
  const base: HypotheticalCampaignPlan = {
    name: 'Local-only fake prospecting plan',
    businessGoal: 'maximize_bookings_and_collected_revenue',
    objective: 'OUTCOME_LEADS',
    performanceGoal: 'OFFSITE_CONVERSIONS',
    conversionLocation: 'website',
    outcomeEvent: 'AppointmentConfirmed',
    desiredOutcomeMeasurable: true,
    budget: { daily: 90, accountDailyAfterLaunch: 90, control: 'campaign', bidStrategy: 'highest_volume', bidControlSupportedByGovernedEconomics: false },
    audience: {
      declaredIntent: 'prospecting',
      advantagePlusAudience: true,
      strictLocations: ['approved local service area'],
      languages: ['en'],
      minimumAge: 18,
      customAudiences: [],
      lookalikes: [],
      suggestions: ['photography'],
      customAudienceExclusions: ['website-180', 'instagram-90', 'recent-converters'],
      requiredWarmExclusions: ['website-180', 'instagram-90', 'recent-converters'],
      requiredConverterExclusions: ['recent-converters'],
      detailedTargetingExclusions: [],
      selectedAudienceEvidence: [],
    },
    placements: { mode: 'advantage_plus', selected: [], assetSupported: ['feed', 'stories', 'reels'], documentedRestriction: null },
    creative: {
      approvedDestinationUrl: 'https://example-studio.test/photo-studio-rental/',
      landingPageSnapshotApproved: true,
      audienceStageCompatible: true,
      reuseDisclosureComplete: true,
      assets: [
        { id: 'a1', conceptId: 'space-tour', format: 'video', destinationUrl: 'https://example-studio.test/photo-studio-rental/', freshConcept: true, isReused: false, placementCompatible: true },
        { id: 'a2', conceptId: 'creator-proof', format: 'image', destinationUrl: 'https://example-studio.test/photo-studio-rental/', freshConcept: true, isReused: false, placementCompatible: true },
        { id: 'a3', conceptId: 'production-use-case', format: 'carousel', destinationUrl: 'https://example-studio.test/photo-studio-rental/', freshConcept: true, isReused: false, placementCompatible: true },
        { id: 'a4', conceptId: 'space-tour', format: 'image', destinationUrl: 'https://example-studio.test/photo-studio-rental/', freshConcept: false, isReused: false, placementCompatible: true },
        { id: 'a5', conceptId: 'creator-proof', format: 'video', destinationUrl: 'https://example-studio.test/photo-studio-rental/', freshConcept: false, isReused: false, placementCompatible: true },
      ],
    },
    tracking: {
      immutableMetaIds: true,
      readableNames: true,
      exactPaidOutcomeComplete: true,
      settledCollectionLineageComplete: true,
      refundLineageComplete: true,
      variableCostLineageComplete: true,
      incrementalityDesignDefined: true,
      paymentExperimentAssignmentComplete: true,
      acceptedCapiDeliveryObserved: true,
      measurementDefinitionContinuous: true,
    },
    experiment: {
      design: 'randomized_holdout',
      assignmentUnit: 'eligible person',
      estimand: 'marginal_contribution_vs_current_state',
      variablesChanged: 1,
      changedVariables: { audience: true, creative: false, destination: false, budget: false, optimization: false },
      primaryMetric: 'outcome_checkout_revenue_and_paid_bookings',
      comparison: 'current governed baseline',
      maturityRule: 'declared cohort maturity lag',
      stopRule: 'owner-approved loss ceiling',
    },
  }
  return { ...base, ...overrides }
}

describe('offline hypothetical media-buyer grader', () => {
  it('rejects a mixed acquisition audience mislabeled as strict retargeting', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      audience: {
        ...plan().audience,
        declaredIntent: 'strict_retargeting',
        customAudiences: ['website visitors'],
        lookalikes: ['customer 1%'],
        advantagePlusAudience: true,
        selectedAudienceEvidence: [
          { id: 'website visitors', kind: 'website', operationStatus: 'ready', approximateSize: 6_000, sourceAudienceSize: null, sourceQuality: null },
          { id: 'customer 1%', kind: 'lookalike', operationStatus: 'ready', approximateSize: 100_000, sourceAudienceSize: 2_000, sourceQuality: 'high_value_customers' },
        ],
      },
    }))
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'retargeting_contains_lookalike',
      'retargeting_expansion_enabled',
    ]))
    expect(result).toMatchObject({ planStatus: 'blocked', score: 59, letter: 'F' })
    expect(result.metaWrites).toBe(false)
    expect(result.launchAuthority).toBe('offline_hypothesis_only')
  })

  it('blocks failed or low-quality lookalikes instead of trusting their names', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      audience: {
        ...plan().audience,
        declaredIntent: 'mixed',
        lookalikes: ['website-lal-1'],
        selectedAudienceEvidence: [{
          id: 'website-lal-1',
          kind: 'lookalike',
          operationStatus: 'failed',
          approximateSize: -1,
          sourceAudienceSize: 20,
          sourceQuality: 'website_visitors',
        }],
      },
    }))

    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'selected_audience_failed',
      'lookalike_seed_below_meta_minimum',
      'lookalike_seed_quality_risk',
    ]))
    expect(result).toMatchObject({ planStatus: 'blocked', score: 59, letter: 'F' })
  })

  it('warns on an eligible but sub-preferred visitor lookalike without inventing a launch prohibition', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      audience: {
        ...plan().audience,
        declaredIntent: 'mixed',
        lookalikes: ['website-lal-1'],
        selectedAudienceEvidence: [{
          id: 'website-lal-1',
          kind: 'lookalike',
          operationStatus: 'ready',
          approximateSize: 100_000,
          sourceAudienceSize: 500,
          sourceQuality: 'website_visitors',
        }],
      },
    }))

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'lookalike_seed_below_preferred_range', severity: 'warning' }),
      expect.objectContaining({ code: 'lookalike_seed_quality_risk', severity: 'warning' }),
    ]))
    expect(result).toMatchObject({ planStatus: 'coherent_hypothesis', letter: 'A' })
  })

  it('blocks prospecting that does not exclude every declared warm pool', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      audience: {
        ...plan().audience,
        customAudienceExclusions: ['instagram-90', 'recent-converters'],
      },
    }))

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'prospecting_warm_exclusion_gap',
      severity: 'blocker',
      message: expect.stringMatching(/website-180/),
    }))
    expect(result).toMatchObject({ planStatus: 'blocked', letter: 'F' })
  })

  it('blocks strict Warm when required converter exclusions are absent', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      audience: {
        ...plan().audience,
        declaredIntent: 'strict_retargeting',
        advantagePlusAudience: false,
        customAudiences: ['website-180'],
        lookalikes: [],
        suggestions: [],
        customAudienceExclusions: [],
        selectedAudienceEvidence: [{
          id: 'website-180',
          kind: 'website',
          operationStatus: 'ready',
          approximateSize: 6_000,
          sourceAudienceSize: null,
          sourceQuality: null,
        }],
      },
    }))

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'retargeting_converter_exclusion_gap',
      severity: 'blocker',
      message: expect.stringMatching(/recent-converters/),
    }))
    expect(result).toMatchObject({ planStatus: 'blocked', letter: 'F' })
  })

  it('blocks recycled video-only creative from being presented as a healthy launch', () => {
    const destinationUrl = plan().creative.approvedDestinationUrl
    const result = gradeHypotheticalCampaignPlan(plan({
      creative: {
        ...plan().creative,
        reuseDisclosureComplete: false,
        assets: [
          { id: 'v1', conceptId: 'tour', format: 'video', destinationUrl, freshConcept: false, isReused: true, placementCompatible: true },
          { id: 'v2', conceptId: 'tour', format: 'video', destinationUrl, freshConcept: false, isReused: true, placementCompatible: true },
        ],
      },
    }))

    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'creative_concept_diversity_missing',
      'creative_format_diversity_missing',
      'creative_volume_low',
      'fresh_creative_missing',
      'creative_reuse_undisclosed',
    ]))
    expect(result).toMatchObject({ planStatus: 'blocked', letter: 'F' })
  })

  it('blocks destination drift and computes experiment variables rather than trusting a declared count', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      creative: {
        ...plan().creative,
        assets: plan().creative.assets.map((asset, index) => index === 0
          ? { ...asset, destinationUrl: 'https://example-studio.test/book/' }
          : asset),
      },
      experiment: {
        ...plan().experiment,
        variablesChanged: 1,
        changedVariables: { audience: true, creative: false, destination: true, budget: false, optimization: false },
      },
    }))

    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'creative_destination_mismatch',
      'experiment_variable_count_invalid',
      'experiment_declared_variable_mismatch',
    ]))
    expect(result).toMatchObject({ planStatus: 'blocked', letter: 'F' })
  })

  it('rejects Traffic when the downstream booking outcome is measurable', () => {
    const result = gradeHypotheticalCampaignPlan(plan({ objective: 'OUTCOME_TRAFFIC' }))
    expect(result.categoryScores.objective).toBe(0)
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'measurable_outcome_objective_mismatch', severity: 'blocker' }))
  })

  it('also rejects Awareness for a measurable downstream booking outcome', () => {
    const result = gradeHypotheticalCampaignPlan(plan({ objective: 'OUTCOME_AWARENESS' }))
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'measurable_outcome_objective_mismatch', severity: 'blocker' }))
  })

  it('requires declared asset coverage for Advantage+ placements', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      placements: { mode: 'advantage_plus', selected: [], assetSupported: [], documentedRestriction: null },
    }))
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'advantage_placement_asset_coverage_unverified', severity: 'warning' }))
  })

  it('rejects an unsupported bid control instead of applying a universal budget multiple', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      budget: { ...plan().budget, bidStrategy: 'cost_per_result_goal', bidControlSupportedByGovernedEconomics: false },
    }))
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'bid_control_unsupported' }))
  })

  it('rejects any fake plan above the owner-approved account daily ceiling', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      budget: { ...plan().budget, daily: 35, accountDailyAfterLaunch: MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling + 1 },
    }))
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'budget_ceiling_exceeded', severity: 'blocker' }))
  })

  it('does not confuse a compliant campaign budget with a noncompliant account total', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      budget: { ...plan().budget, daily: 35, accountDailyAfterLaunch: MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling + 20 },
    }))
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'budget_ceiling_exceeded',
      message: expect.stringMatching(/active-account daily total/i),
    }))
  })

  it('rejects a plan that drops Acuity checkout revenue from the owner-confirmed growth objective', () => {
    const result = gradeHypotheticalCampaignPlan(plan({ businessGoal: 'maximize_bookings' }))
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'commercial_objective_mismatch', severity: 'blocker' }))
  })

  it('rejects incomplete growth proxies as the experiment primary metric', () => {
    for (const primaryMetric of ['bookings', 'platform_roas', 'ad_attributed_collected_revenue', 'causal_incremental_contribution', 'causal_incremental_contribution_dollars']) {
      const result = gradeHypotheticalCampaignPlan(plan({
        experiment: { ...plan().experiment, primaryMetric },
      }))
      expect(result.findings).toContainEqual(expect.objectContaining({ code: 'experiment_metric_mismatch', severity: 'blocker' }))
    }
  })

  it('keeps missing profit inputs visible without blocking a measurable bookings-and-revenue test', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      tracking: {
        ...plan().tracking,
        settledCollectionLineageComplete: false,
        refundLineageComplete: false,
        variableCostLineageComplete: false,
      },
    }))

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'settled_collection_lineage_incomplete', severity: 'observation' }),
      expect.objectContaining({ code: 'refund_lineage_incomplete', severity: 'warning' }),
      expect.objectContaining({ code: 'variable_cost_lineage_incomplete', severity: 'observation' }),
    ]))
    expect(result.planStatus).toBe('coherent_hypothesis')
  })

  it('rejects the removed detailed-targeting exclusion control', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      audience: { ...plan().audience, detailedTargetingExclusions: ['existing photographers'] },
    }))
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'detailed_targeting_exclusions_removed', severity: 'blocker' }))
  })

  it('requires a declared causal design and assignment unit', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      experiment: { ...plan().experiment, design: 'none', assignmentUnit: null },
    }))
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'experiment_design_missing',
      'experiment_assignment_unit_missing',
    ]))
  })

  it('validates setup boundaries instead of awarding a plausible-looking shell', () => {
    const result = gradeHypotheticalCampaignPlan(plan({
      performanceGoal: ' ',
      audience: { ...plan().audience, strictLocations: [' '], minimumAge: 99 },
      placements: { mode: 'manual', selected: [], assetSupported: [], documentedRestriction: 'Owner constraint' },
    }))
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'performance_goal_missing',
      'location_control_missing',
      'minimum_age_invalid',
      'manual_placements_empty',
    ]))
  })

  it('can grade a coherent fake setup without granting launch authority', () => {
    const result = gradeHypotheticalCampaignPlan(plan())
    expect(result).toMatchObject({ score: 100, letter: 'A', launchAuthority: 'offline_hypothesis_only', metaWrites: false })
    expect(result.planStatus).toBe('coherent_hypothesis')
    expect(result.findings).toEqual([])
  })

  it('predicts delivery ranges but refuses paid results across the live measurement break', () => {
    const fake = plan({
      tracking: {
        ...plan().tracking,
        exactPaidOutcomeComplete: false,
        settledCollectionLineageComplete: false,
        refundLineageComplete: false,
        variableCostLineageComplete: false,
        incrementalityDesignDefined: false,
        paymentExperimentAssignmentComplete: false,
        measurementDefinitionContinuous: false,
      },
    })
    const prediction = predictHypotheticalDelivery(fake, {
      days: 14,
      cpmRange: [20, 28],
      outboundCtrRateRange: [0.008, 0.012],
    })
    expect(prediction.spend).toBe(1260)
    expect(prediction.impressions[0]).toBeGreaterThan(30_000)
    expect(prediction.outboundClicks[0]).toBeGreaterThan(250)
    expect(prediction.associatedCollectedRevenue).toBeNull()
    expect(prediction.incrementalContributionAfterAds).toBeNull()
    expect(prediction.unavailable.join(' ')).toMatch(/definition.*discontinuous|cohort is incomplete/i)
  })

  it('only predicts money when comparable evidence supplies collected-revenue and incremental-contribution ranges', () => {
    const prediction = predictHypotheticalDelivery(plan(), {
      days: 14,
      cpmRange: [20, 28],
      outboundCtrRateRange: [0.008, 0.012],
      associatedCollectedRevenuePerOutboundRange: [2, 4],
      incrementalContributionBeforeAdSpendPerOutboundRange: [1.5, 3],
    })
    expect(prediction.associatedCollectedRevenue?.[0]).toBeGreaterThan(500)
    expect(prediction.incrementalContributionAfterAds?.[1]).toBeGreaterThan(0)
    expect(prediction.unavailable).toEqual([])
  })

  it('keeps paid-touch association separate from causal incrementality', () => {
    const noPaidTouch = predictHypotheticalDelivery(plan({
      tracking: { ...plan().tracking, exactPaidOutcomeComplete: false },
    }), {
      days: 14,
      cpmRange: [20, 28],
      outboundCtrRateRange: [0.008, 0.012],
      associatedCollectedRevenuePerOutboundRange: [2, 4],
      incrementalContributionBeforeAdSpendPerOutboundRange: [1.5, 3],
    })
    expect(noPaidTouch.associatedCollectedRevenue).toBeNull()
    expect(noPaidTouch.incrementalContributionAfterAds).not.toBeNull()

    const noExperimentAssignment = predictHypotheticalDelivery(plan({
      tracking: { ...plan().tracking, paymentExperimentAssignmentComplete: false },
    }), {
      days: 14,
      cpmRange: [20, 28],
      outboundCtrRateRange: [0.008, 0.012],
      associatedCollectedRevenuePerOutboundRange: [2, 4],
      incrementalContributionBeforeAdSpendPerOutboundRange: [1.5, 3],
    })
    expect(noExperimentAssignment.associatedCollectedRevenue).not.toBeNull()
    expect(noExperimentAssignment.incrementalContributionAfterAds).toBeNull()
  })

  it('uses interval arithmetic when causal contribution per outbound can be negative', () => {
    const prediction = predictHypotheticalDelivery(plan(), {
      days: 1,
      cpmRange: [90, 90],
      outboundCtrRateRange: [0.13, 0.26],
      incrementalContributionBeforeAdSpendPerOutboundRange: [-10, -5],
    })
    expect(prediction.outboundClicks).toEqual([130, 260])
    expect(prediction.incrementalContributionAfterAds).toEqual([-2690, -740])
  })

  it('rejects finite inputs whose combined prediction would overflow', () => {
    expect(() => predictHypotheticalDelivery(plan({
      budget: { ...plan().budget, daily: Number.MAX_VALUE },
    }), {
      days: 2,
      cpmRange: [20, 28],
      outboundCtrRateRange: [0.008, 0.012],
    })).toThrow(/finite numeric bounds/i)
  })
})
