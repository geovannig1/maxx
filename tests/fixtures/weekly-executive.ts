import type { ExecutiveEvidenceSnapshotV1 } from '@/lib/report/executive-evidence'

export const WEEKLY_REPORT_ID = '00000000-0000-4000-8000-000000001081'
export const WEEK_START = '2026-08-03'
export const WEEK_END = '2026-08-09'

const outcomeWeek = (windowStart: string, windowEnd: string, activeAppointments: number) => ({
  windowStart, windowEnd, activeAppointments, valueBearingBookings: activeAppointments,
  zeroValueAppointments: 0, bookedValue: activeAppointments * 300,
  activeAmountPaidObserved: activeAppointments * 300,
  activeAmountPaidRevenue: activeAppointments * 300,
  amountPaidCoverage: { withRecordedAmount: activeAppointments, total: activeAppointments },
  canceledAppointments: 0, canceledAmountPaidObserved: 0,
})

const metaWeek = (windowStart: string, windowEnd: string, spendAmount: number, modeledBookings: number) => ({
  windowStart, windowEnd, spendAmount, impressions: 40_000, reach: 28_000,
  linkClicks: 600, landingPageViews: 450, leads: 35, modeledBookings,
  modeledBookingValue: modeledBookings * 300, modeledClickBookings: modeledBookings - 1,
  modeledViewBookings: 1, modeledUnknownBookings: 0,
})

/** The weekly renderer consumes a committed snapshot and never re-queries a live source. */
export const weeklyExecutiveEvidenceFixture = {
  contract: 'executive_evidence_snapshot',
  version: 1,
  generatedAt: '2026-08-10T10:05:00.000Z',
  account: {
    id: '00000000-0000-4000-8000-000000001080', name: 'Example Studio',
    timezone: 'America/New_York',
  },
  asOf: '2026-08-10T10:00:00.000Z',
  lastCompleteDate: WEEK_END,
  windows: {
    lastDay: { startDate: WEEK_END, endDate: WEEK_END, availability: 'available', blockerCodes: [] },
    trailing7: { startDate: WEEK_START, endDate: WEEK_END, availability: 'available', blockerCodes: [] },
    prior7: { startDate: '2026-07-27', endDate: '2026-08-02', availability: 'available', blockerCodes: [] },
    monthToDate: { startDate: '2026-08-01', endDate: WEEK_END, availability: 'available', blockerCodes: [] },
    postChange: {
      startDate: '2026-08-06', endDate: WEEK_END, availability: 'available',
      changeId: '00000000-0000-4000-8000-000000001083', blockerCodes: [],
    },
  },
  sources: {
    setupChanges: { availability: 'available', head: '2026-08-10T10:04:00.000Z', blockerCodes: [] },
    outcomes: { availability: 'available', head: '2026-08-10T10:02:00.000Z', blockerCodes: [] },
    meta: { availability: 'available', head: '2026-08-10T10:02:00.000Z', blockerCodes: [] },
    metaColdWarm: { availability: 'available', head: '2026-08-10T10:02:00.000Z', blockerCodes: [] },
    metaPlacements: { availability: 'available', head: '2026-08-10T10:02:00.000Z', blockerCodes: [] },
    tracking: { availability: 'available', head: '2026-08-10T10:04:00.000Z', blockerCodes: [] },
    capi: { availability: 'available', head: '2026-08-10T10:04:00.000Z', blockerCodes: [] },
    gaIdentity: { availability: 'available', head: '2026-08-10T10:04:00.000Z', blockerCodes: [] },
    paidCohort: {
      availability: 'unavailable', head: '2026-08-10T10:04:00.000Z',
      blockerCodes: ['maturity_lag_not_met'],
    },
  },
  outcomes: {
    byWindow: {
      lastDay: null,
      trailing7: outcomeWeek(WEEK_START, WEEK_END, 18),
      prior7: outcomeWeek('2026-07-27', '2026-08-02', 15),
      monthToDate: null,
      postChange: null,
    },
    weeklyTrend8: [
      outcomeWeek('2026-06-16', '2026-06-22', 11),
      outcomeWeek('2026-06-23', '2026-06-29', 12),
      outcomeWeek('2026-06-30', '2026-07-06', 13),
      outcomeWeek('2026-07-07', '2026-07-13', 14),
      outcomeWeek('2026-07-14', '2026-07-20', 13),
      outcomeWeek('2026-07-21', '2026-07-27', 16),
      outcomeWeek('2026-07-28', '2026-08-03', 15),
      outcomeWeek(WEEK_START, WEEK_END, 18),
    ],
  },
  meta: {
    byWindow: {
      lastDay: null,
      trailing7: metaWeek(WEEK_START, WEEK_END, 371, 5),
      prior7: metaWeek('2026-07-27', '2026-08-02', 363, 4),
      monthToDate: null,
      postChange: null,
    },
    weeklyTrend8: [
      metaWeek('2026-06-16', '2026-06-22', 312, 3),
      metaWeek('2026-06-23', '2026-06-29', 326, 3),
      metaWeek('2026-06-30', '2026-07-06', 341, 4),
      metaWeek('2026-07-07', '2026-07-13', 338, 4),
      metaWeek('2026-07-14', '2026-07-20', 357, 4),
      metaWeek('2026-07-21', '2026-07-27', 349, 5),
      metaWeek('2026-07-28', '2026-08-03', 363, 4),
      metaWeek(WEEK_START, WEEK_END, 371, 5),
    ],
  },
  metaColdWarm: {
    windowStart: WEEK_START,
    windowEnd: WEEK_END,
    // This week is NOT a comparable window and the normalizer would never return 'clean' for it: the
    // governed budget change landed 08-06 inside 08-03..08-09, that same edit reset cold-1, cold-1 is
    // still LEARNING, and warm-1's stage is not a Meta learning status so it cannot be verified.
    comparisonStatus: 'blocked',
    blockerCodes: [
      'comparison_cell_edited_in_window',
      'comparison_cell_learning',
      'comparison_cell_learning_unknown',
      'comparison_window_spans_material_change',
    ],
    units: [
      {
        entityLevel: 'adset', entityId: 'cold-1', parentCampaignId: 'campaign-1',
        name: 'Cold prospecting', comparisonRole: 'cold', ...metaWeek(WEEK_START, WEEK_END, 228, 3),
      },
      {
        entityLevel: 'adset', entityId: 'warm-1', parentCampaignId: 'campaign-1',
        name: 'Warm retargeting', comparisonRole: 'warm', ...metaWeek(WEEK_START, WEEK_END, 143, 2),
      },
    ],
  },
  metaPlacements: {
    windowStart: WEEK_START,
    windowEnd: WEEK_END,
    blockerCodes: [],
    rows: [
      {
        dimension: 'publisher_platform', value: 'instagram', spendAmount: 330,
        impressions: 30_000, clicks: 480, leads: 30, modeledBookings: 4,
      },
      {
        dimension: 'platform_position', value: 'instagram_reels', spendAmount: 190,
        impressions: 18_000, clicks: 310, leads: 18, modeledBookings: 3,
      },
    ],
  },
  tracking: {
    landingPageViews: 500, paidTouchObservations: 420, identityCompleteTouches: 390,
    identityIncompleteTouches: 30, linkedAppointments: 12,
  },
  capi: {
    mode: 'live', eligibleAppointments: 18, sentAppointments: 18,
    acceptedAppointments: 17, failedAppointments: 1, expiredAppointments: 0,
  },
  gaIdentity: {
    confirmationEvents: 18, identifiedEvents: 16, legacyUnlinkedEvents: 2,
    duplicateAppointments: 0, unmatchedAppointmentIds: 1, websiteBookingsMissingGa: 1,
    unknownOriginAppointments: 0, scope: 'mixed_partial_coverage',
  },
  paidCohort: null,
  setupChanges: {
    contract_version: 1,
    as_of: '2026-08-10T10:00:00.000Z',
    ad_account_db_id: '00000000-0000-4000-8000-000000001080',
    meta_account_id: '100000000000777',
    status: 'available',
    complete: true,
    blocker_codes: [],
    campaigns: [{
      meta_campaign_id: 'campaign-1', name: 'Springfield bookings', objective: 'OUTCOME_SALES',
      buying_type: 'AUCTION', special_ad_category: null, budget_control: 'abo',
      budget: { daily_amount: null, lifetime_amount: null }, advantage_plus_campaign: 'disabled',
      last_synced_at: '2026-08-10T10:00:00.000Z',
    }],
    adsets: [
      {
        meta_adset_id: 'cold-1', meta_campaign_id: 'campaign-1', name: 'Cold prospecting',
        comparison_role: 'cold', comparison_role_source: 'owner_declared',
        objective: 'OUTCOME_SALES', optimization_goal: 'OFFSITE_CONVERSIONS',
        optimization_event: 'SCHEDULE',
        attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
        budget: { daily_amount: 32, lifetime_amount: null },
        bid: { strategy: 'LOWEST_COST_WITHOUT_CAP', amount: null },
        placements: { mode: 'advantage_plus', selected: {} },
        advantage_plus: { audience: 'disabled', placements: 'enabled', observed_targeting_relaxations: [] },
        audience: {
          composition: 'lookalike', expansion: 'disabled', includedCustomAudiences: [],
          includedLookalikes: [{
            id: 'lookalike-1', name: 'Springfield lookalike 1%', subtype: 'LOOKALIKE',
            accountId: '100000000000777', sourceAudienceId: 'website-180',
            sourceAudienceName: 'Website visitors 180d',
          }],
          excludedAudiences: [], unresolvedIncludedAudienceIds: [], rejectedIncludedAudienceIds: [],
          unresolvedExcludedAudienceIds: [], rejectedExcludedAudienceIds: [],
          referencedIncludedAudienceCount: 1,
          locations: { countries: ['US'], regions: ['Massachusetts'], cities: ['Springfield'], radiusMiles: 25 },
          ageMin: 21, ageMax: 55, evidence: ['resolved lookalike targeting'], confidence: 1,
          unknownReason: null, frozen: false, nameSuggests: 'cold',
          nameConflictsWithTargeting: false, targetingAgeHours: 1,
          health: [{
            id: 'lookalike-1', name: 'Springfield lookalike 1%', subtype: 'LOOKALIKE',
            source_audience_id: 'website-180', source_audience_name: 'Website visitors 180d',
            approximate_count_lower_bound: 100_000, approximate_count_upper_bound: 120_000,
            retention_days: null, operation_status_code: 200, delivery_status_code: 200,
            last_synced_at: '2026-08-10T10:00:00.000Z', status: 'ready', reason: null,
          }],
          inventory_read: { status: 'available', reason: null },
        },
        learning_stage: 'LEARNING', latest_significant_edit_at: '2026-08-06T15:00:00.000Z',
        last_synced_at: '2026-08-10T10:00:00.000Z',
      },
      {
        meta_adset_id: 'warm-1', meta_campaign_id: 'campaign-1', name: 'Warm retargeting',
        comparison_role: 'warm', comparison_role_source: 'owner_declared',
        objective: 'OUTCOME_SALES', optimization_goal: 'OFFSITE_CONVERSIONS',
        optimization_event: 'SCHEDULE',
        attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
        budget: { daily_amount: 21, lifetime_amount: null },
        bid: { strategy: 'LOWEST_COST_WITHOUT_CAP', amount: null },
        placements: { mode: 'advantage_plus', selected: {} },
        advantage_plus: { audience: 'disabled', placements: 'enabled', observed_targeting_relaxations: [] },
        audience: {
          composition: 'retargeting_only', expansion: 'disabled',
          includedCustomAudiences: [{
            id: 'website-180', name: 'Website visitors 180d', subtype: 'WEBSITE',
            accountId: '100000000000777', retentionDays: 180,
          }],
          includedLookalikes: [], excludedAudiences: [], unresolvedIncludedAudienceIds: [],
          rejectedIncludedAudienceIds: [], unresolvedExcludedAudienceIds: [],
          rejectedExcludedAudienceIds: [], referencedIncludedAudienceCount: 1,
          locations: { countries: ['US'], regions: ['Massachusetts'], cities: ['Springfield'], radiusMiles: 25 },
          ageMin: 21, ageMax: 55, evidence: ['resolved website audience'], confidence: 1,
          unknownReason: null, frozen: false, nameSuggests: 'warm',
          nameConflictsWithTargeting: false, targetingAgeHours: 1,
          health: [{
            id: 'website-180', name: 'Website visitors 180d', subtype: 'WEBSITE',
            source_audience_id: null, source_audience_name: null,
            approximate_count_lower_bound: 4_000, approximate_count_upper_bound: 4_500,
            retention_days: 180, operation_status_code: 200, delivery_status_code: 200,
            last_synced_at: '2026-08-10T10:00:00.000Z', status: 'ready', reason: null,
          }],
          inventory_read: { status: 'available', reason: null },
        },
        learning_stage: 'ACTIVE', latest_significant_edit_at: null,
        last_synced_at: '2026-08-10T10:00:00.000Z',
      },
    ],
    active_ad_wrappers: [
      {
        meta_ad_id: 'ad-1', meta_adset_id: 'cold-1', name: 'Cold studio reel',
        meta_creative_id: 'creative-1', concept_id: 'studio-tour',
        wrapper_created_at: '2026-08-06T15:00:00.000Z', wrapper_updated_at: '2026-08-06T15:00:00.000Z',
        wrapper_relationship_to_latest_change: 'created_at_or_after',
        landing_destination: {
          url: 'https://example.com/book', source: 'ad_destination_url',
          url_tags: 'utm_content=cold', utm_status: 'present',
          ad_level_read_available: true, ad_level_synced_at: '2026-08-10T10:00:00.000Z',
        },
        underlying_media: { status: 'not_observed_reused', media_key: 'video:1', media_kind: 'video', other_meta_ad_ids: [], predates_latest_change: false },
        identity_summary: 'new_wrapper_media_reuse_not_observed',
      },
      {
        meta_ad_id: 'ad-2', meta_adset_id: 'warm-1', name: 'Warm proof carousel',
        meta_creative_id: 'creative-2', concept_id: 'social-proof',
        wrapper_created_at: '2026-08-06T15:00:00.000Z', wrapper_updated_at: '2026-08-06T15:00:00.000Z',
        wrapper_relationship_to_latest_change: 'created_at_or_after',
        landing_destination: {
          url: 'https://example.com/book', source: 'ad_destination_url',
          url_tags: 'utm_content=warm', utm_status: 'present',
          ad_level_read_available: true, ad_level_synced_at: '2026-08-10T10:00:00.000Z',
        },
        underlying_media: { status: 'not_observed_reused', media_key: 'carousel:2', media_kind: 'carousel', other_meta_ad_ids: [], predates_latest_change: false },
        identity_summary: 'new_wrapper_media_reuse_not_observed',
      },
    ],
    creative_reuse: {
      distinct_active_ad_wrappers: 2, distinct_active_meta_creative_ids: 2,
      distinct_active_media: 2, concept_coverage_complete: true, distinct_known_concepts: 2,
      reused_meta_creative_id_groups: [], reused_media_groups: [], reused_concept_groups: [],
    },
    cold_warm_comparison: {
      status: 'clean', cold_meta_adset_id: 'cold-1', warm_meta_adset_id: 'warm-1',
      role_basis: 'governed', blocker_codes: [],
    },
    latest_material_change: {
      status: 'known', governanceBasis: 'confirmed_executed_decision',
      materialChangeId: '00000000-0000-4000-8000-000000001083',
      materialChangeIds: ['00000000-0000-4000-8000-000000001083'],
      occurredAt: '2026-08-06T15:00:00.000Z', reason: 'Cold daily budget changed from $27 to $32.',
      source: 'ad_setup_decisions', settingCategories: ['budget'], affectedMetaIds: ['cold-1'],
    },
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
  },
  authority: {
    tier: 'diagnostic_only', moneyActionsAuthorized: false,
    reason: 'Snapshot supplies evidence, not autonomous action authority.',
  },
  governedActions: {
    availability: 'unavailable', items: null, blockerCodes: ['governed_actions_not_connected'],
  },
  blockerCodes: ['paid_cohort:maturity_lag_not_met'],
} as unknown as ExecutiveEvidenceSnapshotV1
