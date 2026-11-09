import { describe, expect, it } from 'vitest'

import {
  projectMetaSetupEvidence,
  type MetaSetupEvidenceInput,
} from '@/lib/report/setup-evidence'

const NOW = '2026-08-16T12:00:00.000Z'
const ACCOUNT_DB_ID = '10000000-0000-4000-8000-000000000001'

function audience(
  id: string,
  subtype: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: `${subtype} ${id}`,
    subtype,
    accountId: '100000000000777',
    approximateCountLowerBound: 1_000,
    approximateCountUpperBound: 1_500,
    operationStatus: { code: 200 },
    deliveryStatus: { code: 200 },
    lastSyncedAt: '2026-08-16T10:00:00.000Z',
    ...overrides,
  }
}

function baseInput(): MetaSetupEvidenceInput {
  return {
    as_of: NOW,
    ad_account_db_id: ACCOUNT_DB_ID,
    meta_account_id: '100000000000777',
    audience_inventory: {
      read_available: true,
      schema: 'rich',
      row_count: 2,
      reason_code: null,
      reason: null,
    },
    audiences_by_id: {
      website_180: audience('website_180', 'WEBSITE'),
      converter_30: audience('converter_30', 'CUSTOM'),
    },
    campaigns: [{
      id: 'campaign-db',
      campaign_id: '111',
      campaign_name: 'Bookings',
      objective: 'OUTCOME_LEADS',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      buying_type: 'AUCTION',
      special_ad_category: null,
      daily_budget: null,
      lifetime_budget: null,
      advantage_plus_campaign: false,
      last_synced_at: '2026-08-16T10:00:00.000Z',
    }],
    adsets: [
      {
        id: 'warm-db',
        campaign_id: 'campaign-db',
        adset_id: '211',
        adset_name: 'Warm',
        comparison_role: 'warm',
        comparison_role_source: 'owner_declared',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        optimization_goal: 'OFFSITE_CONVERSIONS',
        promoted_object: { custom_event_str: 'AppointmentConfirmed', pixel_id: 'pixel-1' },
        attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
        daily_budget: 41,
        lifetime_budget: null,
        bid_amount: null,
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: {
          custom_audiences: [{ id: 'website_180' }],
          excluded_custom_audiences: [{ id: 'converter_30' }],
          targeting_automation: { advantage_audience: 0 },
          geo_locations: { countries: ['US'] },
        },
        targeting_last_synced_at: '2026-08-16T10:00:00.000Z',
        targeting_optimization_types: [],
        learning_stage: 'LEARNING',
        last_sig_edit_ts: '2026-08-14T12:00:00.000Z',
        meta_created_time: '2026-08-01T12:00:00.000Z',
        meta_updated_time: '2026-08-14T12:00:00.000Z',
        last_synced_at: '2026-08-16T10:00:00.000Z',
      },
      {
        id: 'cold-db',
        campaign_id: 'campaign-db',
        adset_id: '212',
        adset_name: 'Cold',
        comparison_role: 'cold',
        comparison_role_source: 'owner_declared',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        optimization_goal: 'OFFSITE_CONVERSIONS',
        promoted_object: { custom_event_str: 'AppointmentConfirmed', pixel_id: 'pixel-1' },
        attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
        daily_budget: 27,
        lifetime_budget: null,
        bid_amount: null,
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: {
          excluded_custom_audiences: [{ id: 'website_180' }, { id: 'converter_30' }],
          targeting_automation: { advantage_audience: 0 },
          geo_locations: { countries: ['US'] },
        },
        targeting_last_synced_at: '2026-08-16T10:00:00.000Z',
        targeting_optimization_types: [],
        learning_stage: 'LEARNING',
        last_sig_edit_ts: '2026-08-14T12:00:00.000Z',
        meta_created_time: '2026-08-01T12:00:00.000Z',
        meta_updated_time: '2026-08-14T12:00:00.000Z',
        last_synced_at: '2026-08-16T10:00:00.000Z',
      },
    ],
    ads: [
      {
        id: 'warm-ad-db', campaign_id: 'campaign-db', adset_id: 'warm-db', creative_id: 'creative-warm-db',
        ad_id: '311', ad_name: 'Warm proof', status: 'ACTIVE', effective_status: 'ACTIVE',
        destination_url: 'https://example.com/book', url_tags: 'utm_campaign=bookings&utm_content=warm',
        destination_url_read_available: true, destination_url_synced_at: '2026-08-16T10:00:00.000Z',
        creative_angle: 'proof', meta_creative_id: '411', meta_created_time: '2026-08-15T10:00:00.000Z',
        meta_updated_time: '2026-08-15T10:00:00.000Z', last_synced_at: '2026-08-16T10:00:00.000Z',
      },
      {
        id: 'cold-ad-db', campaign_id: 'campaign-db', adset_id: 'cold-db', creative_id: 'creative-cold-db',
        ad_id: '312', ad_name: 'Cold tour', status: 'ACTIVE', effective_status: 'ACTIVE',
        destination_url: null, url_tags: 'utm_campaign=bookings&utm_content=cold',
        destination_url_read_available: true, destination_url_synced_at: '2026-08-16T10:00:00.000Z',
        creative_angle: 'tour', meta_creative_id: '412', meta_created_time: '2026-08-15T10:00:00.000Z',
        meta_updated_time: '2026-08-15T10:00:00.000Z', last_synced_at: '2026-08-16T10:00:00.000Z',
      },
    ],
    creatives: [
      {
        id: 'creative-warm-db', creative_id: '411', asset_type: 'video', video_id: 'video-warm', image_hash: null,
        link_url: 'https://example.com/book', url_tags: null, object_story_spec: null, asset_feed_spec: null,
        meta_created_time: '2026-07-01T12:00:00.000Z', last_synced_at: '2026-08-16T10:00:00.000Z',
      },
      {
        id: 'creative-cold-db', creative_id: '412', asset_type: 'video', video_id: 'video-cold', image_hash: null,
        link_url: 'https://example.com/cold', url_tags: null, object_story_spec: null, asset_feed_spec: null,
        meta_created_time: '2026-07-01T12:00:00.000Z', last_synced_at: '2026-08-16T10:00:00.000Z',
      },
    ],
    latest_material_change: {
      status: 'known',
      governanceBasis: 'matched_approved_plan',
      materialChangeId: '00000000-0000-4000-8000-000000000151',
      materialChangeIds: ['00000000-0000-4000-8000-000000000151'],
      occurredAt: '2026-08-14T12:00:00.000Z',
      reason: 'Owner-approved UTM wrapper replacement',
      source: 'meta_observation',
      settingCategories: ['utm', 'creative'],
      affectedMetaIds: ['311', '312'],
    },
  }
}

describe('projectMetaSetupEvidence', () => {
  it('projects the current Meta setup and proves a clean, owner-declared Cold/Warm split', () => {
    const result = projectMetaSetupEvidence(baseInput())

    expect(result.status).toBe('available')
    expect(result.blocker_codes).toEqual([])
    expect(result.campaigns[0]).toMatchObject({
      meta_campaign_id: '111',
      objective: 'OUTCOME_LEADS',
      budget_control: 'abo',
      special_ad_category: null,
    })
    expect(result.adsets.map((adset) => ({
      id: adset.meta_adset_id,
      event: adset.optimization_event,
      daily: adset.budget.daily_amount,
      placements: adset.placements.mode,
      audience: adset.audience.composition,
    }))).toEqual([
      { id: '212', event: 'AppointmentConfirmed', daily: 27, placements: 'advantage_plus', audience: 'broad_advantage' },
      { id: '211', event: 'AppointmentConfirmed', daily: 41, placements: 'advantage_plus', audience: 'retargeting_only' },
    ])
    expect(result.cold_warm_comparison).toMatchObject({
      status: 'clean',
      cold_meta_adset_id: '212',
      warm_meta_adset_id: '211',
      blocker_codes: [],
    })
    expect(result.adsets.find((adset) => adset.meta_adset_id === '211')).toMatchObject({
      attribution_spec: [
        { event_type: 'CLICK_THROUGH', window_days: 7 },
        { event_type: 'VIEW_THROUGH', window_days: 1 },
      ],
      bid: { strategy: 'LOWEST_COST_WITHOUT_CAP', amount: null },
      advantage_plus: { audience: 'disabled', placements: 'enabled' },
      audience: {
        includedCustomAudiences: [{ id: 'website_180' }],
        excludedAudiences: [{ id: 'converter_30' }],
        health: expect.arrayContaining([
          expect.objectContaining({
            id: 'website_180', status: 'ready',
            approximate_count_lower_bound: 1_000,
            approximate_count_upper_bound: 1_500,
          }),
        ]),
      },
    })
    expect(result.adsets.find((adset) => adset.meta_adset_id === '312')).toBeUndefined()
    expect(result.active_ad_wrappers).toHaveLength(2)
    expect(result.active_ad_wrappers.find((ad) => ad.meta_ad_id === '312')?.landing_destination).toEqual({
      url: 'https://example.com/cold',
      source: 'creative_link_url',
      url_tags: 'utm_campaign=bookings&utm_content=cold',
      utm_status: 'present',
      ad_level_read_available: true,
      ad_level_synced_at: '2026-08-16T10:00:00.000Z',
    })
    expect(result.action_authority_tier).toBe('diagnostic_only')
    expect(result.prescriptions).toEqual([])
  })

  it('labels a creative fallback but blocks setup completeness when the ad-level destination read failed', () => {
    const input = baseInput()
    input.ads[1].destination_url = 'https://stale.example/old?utm_campaign=stale'
    input.ads[1].url_tags = 'utm_campaign=stale'
    input.ads[1].destination_url_read_available = false
    input.ads[1].destination_url_synced_at = null

    const result = projectMetaSetupEvidence(input)
    const destination = result.active_ad_wrappers.find((ad) => ad.meta_ad_id === '312')?.landing_destination

    expect(destination).toMatchObject({
      url: 'https://example.com/cold',
      source: 'creative_link_url',
      url_tags: null,
      utm_status: 'unknown',
      ad_level_read_available: false,
      ad_level_synced_at: null,
    })
    expect(JSON.stringify(destination)).not.toContain('stale.example')
    expect(JSON.stringify(destination)).not.toContain('utm_campaign=stale')
    expect(result.blocker_codes).toContain('ad_destination_read_unavailable')
    expect(result.complete).toBe(false)
  })

  it('projects CBO and manual placement constraints without inventing inherited ad-set budgets', () => {
    const input = baseInput()
    input.campaigns[0].daily_budget = 90
    for (const adset of input.adsets) {
      adset.daily_budget = null
      adset.targeting = {
        ...adset.targeting,
        publisher_platforms: ['facebook', 'instagram'],
        instagram_positions: ['feed', 'stream'],
      }
    }

    const result = projectMetaSetupEvidence(input)

    expect(result.campaigns[0]).toMatchObject({
      budget_control: 'cbo',
      budget: { daily_amount: 90, lifetime_amount: null },
    })
    expect(result.adsets.every((adset) => adset.budget.daily_amount === null)).toBe(true)
    expect(result.adsets[0].placements).toEqual({
      mode: 'manual',
      selected: {
        publisher_platforms: ['facebook', 'instagram'],
        instagram_positions: ['feed', 'stream'],
      },
    })
    expect(result.adsets[0].advantage_plus.placements).toBe('disabled')
    expect(result.blocker_codes).not.toContain('budget_unknown')
  })

  it('uses Cold/Warm names only as display hints and blocks an ungoverned comparison', () => {
    const input = baseInput()
    for (const adset of input.adsets) {
      adset.comparison_role = null
      adset.comparison_role_source = null
    }

    const result = projectMetaSetupEvidence(input)

    expect(result.cold_warm_comparison).toMatchObject({
      status: 'blocked',
      role_basis: 'display_name_only',
      blocker_codes: ['comparison_roles_unverified'],
    })
  })

  it('blocks Cold/Warm when attribution or optimization configuration is unknown or mismatched', () => {
    const input = baseInput()
    input.adsets[0].attribution_spec = null
    input.adsets[1].promoted_object = { custom_event_str: 'Lead', pixel_id: 'pixel-1' }

    const result = projectMetaSetupEvidence(input)

    expect(result.cold_warm_comparison).toMatchObject({ status: 'blocked' })
    expect(result.cold_warm_comparison.blocker_codes).toEqual(expect.arrayContaining([
      'attribution_unknown',
      'comparison_optimization_event_mismatch',
    ]))
  })

  it('blocks setup completeness when Advantage+ campaign or observed targeting relaxation state is unknown', () => {
    const input = baseInput()
    input.campaigns[0].advantage_plus_campaign = null
    input.adsets[0].targeting_optimization_types = null

    const result = projectMetaSetupEvidence(input)

    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toEqual(expect.arrayContaining([
      'campaign_advantage_plus_unknown',
      'targeting_relaxations_unknown',
    ]))
    expect(result.adsets.find((adset) => adset.meta_adset_id === '211')?.advantage_plus.observed_targeting_relaxations)
      .toBeNull()
    expect(result.cold_warm_comparison.blocker_codes).toContain('targeting_relaxations_unknown')
  })

  it('fails closed when the audience inventory read failed, even if names say Cold and Warm', () => {
    const input = baseInput()
    input.audience_inventory = {
      read_available: false,
      schema: null,
      row_count: null,
      reason_code: 'custom_audiences_read_failed',
      reason: 'Meta audience endpoint failed.',
    }
    input.audiences_by_id = {}

    const result = projectMetaSetupEvidence(input)

    expect(result.status).toBe('blocked')
    expect(result.blocker_codes).toContain('audience_inventory_read_failed')
    expect(result.cold_warm_comparison.status).toBe('blocked')
    expect(result.cold_warm_comparison.blocker_codes).toContain('audience_inventory_read_failed')
    expect(result.adsets.every((adset) => adset.audience.frozen)).toBe(true)
  })

  it.each([
    ['stale', audience('website_180', 'WEBSITE', { lastSyncedAt: '2026-08-10T10:00:00.000Z' })],
    ['failed', audience('website_180', 'WEBSITE', { operationStatus: { code: 433 } })],
    ['invalid-size', audience('website_180', 'WEBSITE', {
      approximateCountLowerBound: -1,
      approximateCountUpperBound: -1,
    })],
  ])('fails closed on %s referenced audience inventory', (_label, unhealthyAudience) => {
    const input = baseInput()
    input.audiences_by_id.website_180 = unhealthyAudience

    const result = projectMetaSetupEvidence(input)
    const warm = result.adsets.find((adset) => adset.meta_adset_id === '211')

    expect(result.status).toBe('blocked')
    expect(result.blocker_codes).toContain('audience_reference_unhealthy')
    expect(warm?.audience.health.find((row) => row.id === 'website_180')?.status).not.toBe('ready')
    expect(warm?.audience.frozen).toBe(true)
    expect(warm?.audience.composition).toBe('unknown')
    expect(result.cold_warm_comparison.status).toBe('blocked')
  })

  it('classifies absent readiness status as unknown, not failed, while still freezing conclusions', () => {
    const input = baseInput()
    input.audiences_by_id.website_180 = audience('website_180', 'WEBSITE', { operationStatus: null })

    const result = projectMetaSetupEvidence(input)
    const health = result.adsets
      .find((adset) => adset.meta_adset_id === '211')
      ?.audience.health.find((row) => row.id === 'website_180')

    expect(result.status).toBe('blocked')
    expect(health).toMatchObject({
      status: 'unknown',
      operation_status_code: null,
      delivery_status_code: 200,
    })
    expect(health?.reason).toMatch(/status is unknown|readiness/i)
    expect(health?.reason).not.toMatch(/not ready/i)
  })

  it('does not hide an explicit delivery failure behind an absent operation status', () => {
    const input = baseInput()
    input.audiences_by_id.website_180 = audience('website_180', 'WEBSITE', {
      operationStatus: null,
      deliveryStatus: { code: 300 },
    })

    const result = projectMetaSetupEvidence(input)
    const health = result.adsets
      .find((adset) => adset.meta_adset_id === '211')
      ?.audience.health.find((row) => row.id === 'website_180')

    expect(result.status).toBe('blocked')
    expect(health).toMatchObject({
      status: 'failed',
      operation_status_code: null,
      delivery_status_code: 300,
    })
    expect(health?.reason).toMatch(/not ready/i)
  })

  it('treats a readiness object without a numeric code as unknown, not failed', () => {
    const input = baseInput()
    input.audiences_by_id.website_180 = audience('website_180', 'WEBSITE', {
      operationStatus: { code: null },
    })

    const result = projectMetaSetupEvidence(input)
    const health = result.adsets
      .find((adset) => adset.meta_adset_id === '211')
      ?.audience.health.find((row) => row.id === 'website_180')

    expect(health).toMatchObject({
      status: 'unknown',
      operation_status_code: null,
      delivery_status_code: 200,
    })
  })

  it('blocks a nominal Warm/Cold read when Warm is mixed, expansion is enabled, and Cold does not exclude Warm', () => {
    const input = baseInput()
    input.audiences_by_id.lookalike_1 = audience('lookalike_1', 'LOOKALIKE', {
      sourceAudienceId: 'website_180',
    })
    input.adsets[0].targeting = {
      custom_audiences: [{ id: 'website_180' }, { id: 'lookalike_1' }],
      excluded_custom_audiences: [{ id: 'converter_30' }],
      targeting_automation: { advantage_audience: 1 },
    }
    input.adsets[1].targeting = {
      excluded_custom_audiences: [{ id: 'converter_30' }],
      targeting_automation: { advantage_audience: 1 },
    }

    const result = projectMetaSetupEvidence(input)

    expect(result.adsets.find((adset) => adset.meta_adset_id === '211')?.audience.composition).toBe('mixed')
    expect(result.cold_warm_comparison.status).toBe('blocked')
    expect(result.cold_warm_comparison.blocker_codes).toEqual(expect.arrayContaining([
      'audience_expansion_enabled',
      'warm_inventory_not_pure',
      'cold_warm_overlap_not_excluded',
    ]))
  })

  it('separates a newly created ad wrapper from historically reused underlying media', () => {
    const input = baseInput()
    input.ads.push({
      id: 'old-ad-db', campaign_id: 'campaign-db', adset_id: 'cold-db', creative_id: 'old-creative-db',
      ad_id: '399', ad_name: 'Old wrapper', status: 'PAUSED', effective_status: 'PAUSED',
      destination_url: 'https://example.com/cold', url_tags: null, creative_angle: 'tour',
      destination_url_read_available: true, destination_url_synced_at: '2026-08-16T10:00:00.000Z',
      meta_creative_id: '499', meta_created_time: '2026-06-01T10:00:00.000Z',
      meta_updated_time: '2026-06-01T10:00:00.000Z', last_synced_at: '2026-08-16T10:00:00.000Z',
    })
    input.creatives.push({
      id: 'old-creative-db', creative_id: '499', asset_type: 'video', video_id: 'video-cold', image_hash: null,
      link_url: 'https://example.com/cold', url_tags: null, object_story_spec: null, asset_feed_spec: null,
      meta_created_time: '2026-06-01T10:00:00.000Z', last_synced_at: '2026-08-16T10:00:00.000Z',
    })

    const result = projectMetaSetupEvidence(input)
    const current = result.active_ad_wrappers.find((ad) => ad.meta_ad_id === '312')

    expect(current).toMatchObject({
      wrapper_relationship_to_latest_change: 'created_at_or_after',
      meta_creative_id: '412',
      underlying_media: {
        status: 'reused',
        media_key: 'video:video-cold',
        other_meta_ad_ids: ['399'],
        predates_latest_change: true,
      },
      identity_summary: 'new_wrapper_reused_media',
    })
    expect(result.creative_reuse.distinct_active_ad_wrappers).toBe(2)
    expect(result.creative_reuse.distinct_active_media).toBe(2)
    expect(result.creative_reuse.reused_media_groups[0].meta_ad_ids).toEqual(['312', '399'])
  })

  it('does not invent distinct media when active wrapper media identity is unavailable', () => {
    const input = baseInput()
    input.creatives = []

    const result = projectMetaSetupEvidence(input)

    expect(result.blocker_codes).toContain('creative_identity_unknown')
    expect(result.creative_reuse.distinct_active_media).toBeNull()
  })

  it('blocks comparison when a material change is observed but its reason is unknown', () => {
    const input = baseInput()
    input.latest_material_change = {
      status: 'unknown',
      occurredAt: '2026-08-14T12:00:00.000Z',
      reasonCode: 'change_reason_not_recorded',
    }

    const result = projectMetaSetupEvidence(input)

    expect(result.status).toBe('blocked')
    expect(result.blocker_codes).toContain('latest_material_change_reason_unknown')
    expect(result.cold_warm_comparison.blocker_codes).toContain('latest_material_change_reason_unknown')
  })

  it('does not treat an ad-setup decision assertion as a governed change reason', () => {
    const input = baseInput()
    input.latest_material_change = {
      status: 'known',
      governanceBasis: 'matched_approved_plan',
      materialChangeId: '00000000-0000-4000-8000-000000000152',
      materialChangeIds: ['00000000-0000-4000-8000-000000000152'],
      occurredAt: '2026-08-10T12:00:00.000Z',
      reason: 'Claimed published tags',
      source: 'ad_setup_decisions',
      settingCategories: ['utm'],
      affectedMetaIds: ['311'],
    }

    const result = projectMetaSetupEvidence(input)

    expect(result.latest_material_change).toEqual({
      status: 'unknown',
      occurredAt: '2026-08-10T12:00:00.000Z',
      reasonCode: 'setup_change_reason_not_matched',
    })
    expect(result.blocker_codes).toContain('latest_material_change_reason_unknown')
    expect(result.active_ad_wrappers).toHaveLength(2)
  })

  it('blocks a new-versus-reused claim when wrapper creation time is not observed', () => {
    const input = baseInput()
    input.ads[0].meta_created_time = null

    const result = projectMetaSetupEvidence(input)

    expect(result.active_ad_wrappers.find((ad) => ad.meta_ad_id === '311')).toMatchObject({
      wrapper_relationship_to_latest_change: 'unknown',
      identity_summary: 'identity_unknown',
    })
    expect(result.status).toBe('blocked')
    expect(result.blocker_codes).toContain('wrapper_change_relationship_unknown')
  })

  it('does not trust a stale creative row for destination or media identity', () => {
    const input = baseInput()
    input.creatives[0].last_synced_at = '2026-08-10T10:00:00.000Z'

    const result = projectMetaSetupEvidence(input)

    expect(result.status).toBe('blocked')
    expect(result.blocker_codes).toContain('setup_snapshot_stale')
  })
})
