import { describe, expect, it, vi } from 'vitest'
import {
  buildMetaSetupGenerationFingerprint,
  deriveMaterialSetupChanges,
  normalizeAdSetupSnapshot,
  normalizeAdsetSetupSnapshot,
  normalizeCreativeSetupSnapshot,
} from '@/lib/setup-history'
import { captureMetaSetupGeneration } from '@/lib/setup-history/capture'

const ACCOUNT = '00000000-0000-4000-8000-000000000107'
const SYNC_LOG = '00000000-0000-4000-8000-000000001107'
const OBSERVED_AT = '2026-08-16T12:00:00.000Z'

function adset(over: Record<string, unknown> = {}) {
  return {
    id: 'adset-db-1',
    ad_account_id: ACCOUNT,
    campaign_id: 'campaign-db-1',
    adset_id: '238-adset-1',
    adset_name: 'Warm + LAL',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    billing_event: 'IMPRESSIONS',
    destination_type: 'WEBSITE',
    promoted_object: { pixel_id: 'px-1', custom_event_type: 'PURCHASE' },
    targeting: {
      age_min: 25,
      age_max: 55,
      custom_audiences: [{ id: 'website-180' }],
      targeting_automation: { advantage_audience: 1 },
    },
    targeting_optimization_types: [{ key: 'lookalike', value: 1 }],
    daily_budget: 50,
    lifetime_budget: null,
    bid_amount: null,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    learning_stage: 'LEARNING',
    last_sig_edit_ts: '2026-08-15T10:00:00.000Z',
    meta_created_time: '2026-08-01T00:00:00.000Z',
    meta_updated_time: '2026-08-15T10:00:00.000Z',
    start_time: '2026-08-01T00:00:00Z',
    end_time: null,
    last_synced_at: OBSERVED_AT,
    targeting_last_synced_at: OBSERVED_AT,
    ...over,
  }
}

describe('setup-history normalization', () => {
  it('creates deterministic setup fingerprints independent of object key order', () => {
    const left = normalizeAdsetSetupSnapshot(adset())
    const right = normalizeAdsetSetupSnapshot(adset({
      targeting: {
        targeting_automation: { advantage_audience: 1 },
        custom_audiences: [{ id: 'website-180' }],
        age_max: 55,
        age_min: 25,
      },
    }))

    expect(left.entity_level).toBe('adset')
    expect(left.config.targeting).toEqual(right.config.targeting)
    expect(left.config).toMatchObject({
      learning_stage: 'LEARNING',
      last_sig_edit_ts: '2026-08-15T10:00:00.000Z',
      meta_created_time: '2026-08-01T00:00:00.000Z',
      meta_updated_time: '2026-08-15T10:00:00.000Z',
    })
    expect(left.config_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(left.config_fingerprint).toBe(right.config_fingerprint)
  })

  it('marks material changes as reason_unknown unless an approved plan exactly matches the change', () => {
    const before = normalizeAdsetSetupSnapshot(adset({ daily_budget: 50 }))
    const after = normalizeAdsetSetupSnapshot(adset({ daily_budget: 75 }))

    const changes = deriveMaterialSetupChanges({
      adAccountId: ACCOUNT,
      fromGenerationId: 'from-gen',
      toGenerationId: 'to-gen',
      before: [before],
      after: [after],
      approvedPlans: [],
    })

    expect(changes).toEqual([
      expect.objectContaining({
        entity_level: 'adset',
        meta_entity_id: '238-adset-1',
        change_type: 'updated',
        field_path: 'daily_budget',
        before_value: 50,
        after_value: 75,
        reason_status: 'reason_unknown',
        approved_plan_id: null,
        reason: null,
      }),
    ])
  })

  it('uses complete-generation fingerprints from the normalized entity set only', () => {
    const snapshots = [
      normalizeAdsetSetupSnapshot(adset({ adset_id: 'b' })),
      normalizeAdsetSetupSnapshot(adset({ adset_id: 'a' })),
    ]
    const reversed = [...snapshots].reverse()
    expect(buildMetaSetupGenerationFingerprint(snapshots)).toBe(buildMetaSetupGenerationFingerprint(reversed))
  })

  it('requires a durable material change UUID before projecting a known setup change', async () => {
    const { projectLatestSetupMaterialChange } = await import('@/lib/setup-history')
    const baseChange = {
      ad_account_id: ACCOUNT,
      from_generation_id: '00000000-0000-4000-8000-000000002107',
      to_generation_id: '00000000-0000-4000-8000-000000003107',
      entity_level: 'adset' as const,
      meta_entity_id: '238-adset-1',
      change_type: 'updated' as const,
      field_path: 'daily_budget',
      before_value: 50,
      after_value: 75,
      reason_status: 'matched_approved_plan' as const,
      approved_plan_id: '00000000-0000-4000-8000-000000004107',
      reason: 'Owner-approved scale plan',
      created_at: '2026-08-16T12:00:00.000Z',
    }

    expect(projectLatestSetupMaterialChange({
      changes: [baseChange],
      through: '2026-08-16T13:00:00.000Z',
    })).toEqual({
      status: 'unknown',
      occurredAt: '2026-08-16T12:00:00.000Z',
      reasonCode: 'setup_change_identity_unknown',
    })

    expect(projectLatestSetupMaterialChange({
      changes: [{ ...baseChange, id: '00000000-0000-4000-8000-000000005107' }],
      through: '2026-08-16T13:00:00.000Z',
    })).toEqual(expect.objectContaining({
      status: 'known',
      governanceBasis: 'matched_approved_plan',
      materialChangeId: '00000000-0000-4000-8000-000000005107',
      materialChangeIds: ['00000000-0000-4000-8000-000000005107'],
    }))
  })

  it('fails closed when the latest generation batch mixes approved and unexplained setup changes', async () => {
    const { projectLatestSetupMaterialChange } = await import('@/lib/setup-history')
    const approved = {
      id: '00000000-0000-4000-8000-000000006107',
      ad_account_id: ACCOUNT,
      from_generation_id: '00000000-0000-4000-8000-000000002107',
      to_generation_id: '00000000-0000-4000-8000-000000003107',
      entity_level: 'adset' as const,
      meta_entity_id: '238-adset-1',
      change_type: 'updated' as const,
      field_path: 'daily_budget',
      before_value: 50,
      after_value: 75,
      reason_status: 'matched_approved_plan' as const,
      approved_plan_id: '00000000-0000-4000-8000-000000004107',
      reason: 'Owner-approved budget scale',
      created_at: '2026-08-16T12:00:00.000Z',
    }
    const unexplained = {
      ...approved,
      id: '00000000-0000-4000-8000-000000007107',
      meta_entity_id: '238-adset-2',
      field_path: 'targeting.custom_audiences',
      reason_status: 'reason_unknown' as const,
      approved_plan_id: null,
      reason: null,
    }

    expect(projectLatestSetupMaterialChange({
      changes: [approved, unexplained],
      through: '2026-08-16T13:00:00.000Z',
    })).toEqual({
      status: 'unknown',
      occurredAt: '2026-08-16T12:00:00.000Z',
      reasonCode: 'setup_change_reason_unknown',
    })

    expect(projectLatestSetupMaterialChange({
      changes: [approved, { ...approved, id: '00000000-0000-4000-8000-000000008107', field_path: 'targeting.age_min' }],
      through: '2026-08-16T13:00:00.000Z',
    })).toEqual(expect.objectContaining({
      status: 'known',
      governanceBasis: 'matched_approved_plan',
      materialChangeId: '00000000-0000-4000-8000-000000006107',
      materialChangeIds: [
        '00000000-0000-4000-8000-000000006107',
        '00000000-0000-4000-8000-000000008107',
      ],
      settingCategories: ['daily_budget', 'targeting'],
    }))
  })
})

type FakeCall = { table: string; op: string; column?: string; value?: unknown; selected?: string; payload?: unknown }

class QueryBuilder {
  private readonly filters: Array<{ column: string; value: unknown }> = []
  private selected = ''

  constructor(
    private readonly table: string,
    private readonly state: {
      rows: Record<string, unknown[]>
      calls: Array<{ table: string; op: string; column?: string; value?: unknown; selected?: string; payload?: unknown }>
    },
  ) {}

  select(selected: string) {
    this.selected = selected
    this.state.calls.push({ table: this.table, op: 'select', selected })
    return this
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value })
    this.state.calls.push({ table: this.table, op: 'eq', column, value })
    return this
  }

  order() {
    return this
  }

  limit() {
    return this
  }

  async insert(payload: unknown) {
    this.state.calls.push({ table: this.table, op: 'insert', payload })
    const rows = Array.isArray(payload) ? payload : [payload]
    this.state.rows[this.table] = [...(this.state.rows[this.table] ?? []), ...rows]
    return {
      data: rows.map((row, index) => ({
        ...(typeof row === 'object' && row ? row : {}),
        id: `inserted-${this.table}-${index}`,
      })),
      error: null,
    }
  }

  then(resolve: (value: { data: unknown[]; error: null }) => void) {
    const data = (this.state.rows[this.table] ?? []).filter((row) =>
      this.filters.every((filter) => (row as Record<string, unknown>)[filter.column] === filter.value),
    )
    resolve({ data, error: null })
  }
}

function fakeSupabase(rows: Record<string, unknown[]>) {
  const state = { rows: { ...rows }, calls: [] as FakeCall[] }
  return {
    state,
    from(table: string) {
      return new QueryBuilder(table, state)
    },
  }
}

describe('captureMetaSetupGeneration', () => {
  it('captures account-scoped setup snapshots without calling Meta or inferring reasons', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const db = fakeSupabase({
      campaigns: [{
        id: 'campaign-db-1',
        ad_account_id: ACCOUNT,
        campaign_id: '238-campaign-1',
        campaign_name: 'Bookings',
        objective: 'OUTCOME_SALES',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        buying_type: 'AUCTION',
        special_ad_category: 'NONE',
        daily_budget: null,
        lifetime_budget: null,
        start_time: null,
        stop_time: null,
      }],
      adsets: [adset()],
      ads: [{
        id: 'ad-db-1',
        ad_account_id: ACCOUNT,
        campaign_id: 'campaign-db-1',
        adset_id: 'adset-db-1',
        creative_id: 'creative-db-1',
        meta_creative_id: '238-creative-1',
        ad_id: '238-ad-1',
        ad_name: 'Booking angle',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        url_tags: 'utm_campaign=bookings',
        tracking_specs: [{ action: 'offsite_conversion' }],
        conversion_specs: null,
        creative_angle: 'booking-angle',
        meta_created_time: '2026-08-02T00:00:00.000Z',
        meta_updated_time: '2026-08-15T11:00:00.000Z',
      }],
      creatives: [{
        id: 'creative-db-1',
        ad_account_id: ACCOUNT,
        creative_id: '238-creative-1',
        creative_name: 'Offer creative',
        body: 'Book now',
        title: 'Springfield photos',
        description: 'Full upfront payment',
        call_to_action_type: 'BOOK_NOW',
        link_url: 'https://example.com/book',
        url_tags: 'utm_campaign=bookings',
        image_hash: 'hash-1',
        video_id: null,
        object_story_spec: { page_id: 'page-1' },
        asset_feed_spec: null,
        meta_created_time: '2026-08-02T00:00:00.000Z',
      }],
      custom_audiences: [{
        id: 'aud-db-1',
        ad_account_id: ACCOUNT,
        audience_id: 'website-180',
        name: 'Website visitors 180',
        subtype: 'WEBSITE',
        meta_account_id: 'act_123',
        source_audience_id: null,
        approximate_count: 5000,
        retention_days: 180,
        lookalike_spec: null,
        operation_status: { code: 200 },
        delivery_status: { code: 200 },
      }],
      meta_setup_generations: [],
      meta_setup_entity_snapshots: [],
      setup_change_plans: [],
      setup_material_changes: [],
    })

    const result = await captureMetaSetupGeneration(db, {
      adAccountId: ACCOUNT,
      syncLogId: SYNC_LOG,
      observedAt: OBSERVED_AT,
    })

    expect(result.complete).toBe(true)
    expect(result.entityCount).toBe(5)
    expect(result.generationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const table of ['campaigns', 'adsets', 'ads', 'creatives', 'custom_audiences']) {
      expect(db.state.calls).toContainEqual(expect.objectContaining({
        table,
        op: 'eq',
        column: 'ad_account_id',
        value: ACCOUNT,
      }))
    }
    expect(db.state.calls.find((call) => call.table === 'adsets' && call.op === 'select')?.selected)
      .toContain('attribution_spec')
    expect(db.state.calls.find((call) => call.table === 'ads' && call.op === 'select')?.selected)
      .toContain('destination_url')
    expect(db.state.rows.meta_setup_entity_snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity_level: 'ad',
        config: expect.objectContaining({
          creative_angle: 'booking-angle',
          meta_created_time: '2026-08-02T00:00:00.000Z',
          meta_updated_time: '2026-08-15T11:00:00.000Z',
        }),
      }),
      expect.objectContaining({
        entity_level: 'creative',
        config: expect.objectContaining({ meta_created_time: '2026-08-02T00:00:00.000Z' }),
      }),
    ]))
  })

  it('durably marks a generation incomplete and derives no changes after a source failure', async () => {
    const db = fakeSupabase({
      campaigns: [], adsets: [], ads: [], creatives: [], custom_audiences: [],
      meta_setup_generations: [], meta_setup_entity_snapshots: [], setup_change_plans: [],
      setup_material_changes: [],
    })

    const result = await captureMetaSetupGeneration(db, {
      adAccountId: ACCOUNT,
      syncLogId: SYNC_LOG,
      observedAt: OBSERVED_AT,
      blockerCodes: ['creative_sync_failed', 'custom_audience_sync_failed'],
    })

    expect(result).toMatchObject({
      complete: false,
      blockerCodes: ['creative_sync_failed', 'custom_audience_sync_failed'],
    })
    expect(db.state.rows.meta_setup_generations[0]).toMatchObject({
      complete: false,
      blocker_codes: ['creative_sync_failed', 'custom_audience_sync_failed'],
    })
    expect(db.state.rows.setup_material_changes).toEqual([])
  })

  it('does not carry retained pre-run entities into a synchronized setup generation', async () => {
    const db = fakeSupabase({
      campaigns: [{
        id: 'campaign-current', ad_account_id: ACCOUNT, campaign_id: 'current',
        last_synced_at: '2026-08-16T12:00:01.000Z',
      }, {
        id: 'campaign-retained', ad_account_id: ACCOUNT, campaign_id: 'retained',
        last_synced_at: '2026-08-16T11:59:59.000Z',
      }],
      adsets: [], ads: [], creatives: [], custom_audiences: [],
      meta_setup_generations: [], meta_setup_entity_snapshots: [], setup_change_plans: [],
      setup_material_changes: [],
    })

    const result = await captureMetaSetupGeneration(db, {
      adAccountId: ACCOUNT,
      observedAt: OBSERVED_AT,
      sourceNotBefore: '2026-08-16T12:00:00.000Z',
    })

    expect(result.entityCount).toBe(1)
    expect(db.state.rows.meta_setup_entity_snapshots).toEqual([
      expect.objectContaining({ meta_entity_id: 'current' }),
    ])
  })
})

// Regression: most recorded "material changes" can turn out not to be changes at all —
// `destination_url_synced_at` (a record of when WE read the ad) and rotating Facebook CDN URLs.
// A field describing our own sync, or a signed URL the platform rotates on its own schedule, can never
// be an advertiser change. This noise both drowns the change history and, via the recommendation
// lifecycle guard, quarantines every open recommendation.
describe('material change detection ignores volatile fields', () => {
  const ad = (syncedAt: string) => ({
    id: 'ad-db-1', ad_id: '1', campaign_id: 'c1', adset_id: 's1',
    ad_name: 'Cold | Video 1', status: 'ACTIVE', effective_status: 'ACTIVE',
    destination_url: 'https://example.com/book', destination_url_synced_at: syncedAt,
    last_synced_at: syncedAt,
  })

  const creative = (url: string) => ({
    id: 'cr-db-1', creative_id: 'cr1', creative_name: 'Video 1',
    image_hash: 'stable-hash', video_id: 'v-123',
    thumbnail_url: url, image_url: url,
    object_story_spec: { video_data: { video_id: 'v-123', image_url: url } },
  })

  const diff = (before: unknown, after: unknown) => deriveMaterialSetupChanges({
    adAccountId: 'account-1', fromGenerationId: 'gen-1', toGenerationId: 'gen-2',
    before: [before as never], after: [after as never],
  })

  it('records nothing when only a sync timestamp moved', () => {
    const before = normalizeAdSetupSnapshot(ad('2026-03-04T08:14:37Z'))
    const after = normalizeAdSetupSnapshot(ad('2026-03-05T19:52:11Z'))
    expect(diff(before, after)).toEqual([])
  })

  it('records nothing when only a rotating CDN URL moved', () => {
    const before = normalizeCreativeSetupSnapshot(creative('https://cdn.fb.net/a?token=OLD'))
    const after = normalizeCreativeSetupSnapshot(creative('https://cdn.fb.net/a?token=NEW'))
    expect(diff(before, after)).toEqual([])
  })

  it('still records a genuine advertiser change', () => {
    const before = normalizeAdSetupSnapshot(ad('2026-03-04T08:14:37Z'))
    const after = normalizeAdSetupSnapshot({ ...ad('2026-03-05T19:52:11Z'), status: 'PAUSED' })
    expect(diff(before, after).map((c) => c.field_path)).toEqual(['status'])
  })

  it('still records a real creative swap, since asset identity is not volatile', () => {
    const before = normalizeCreativeSetupSnapshot(creative('https://cdn.fb.net/a?token=OLD'))
    const after = normalizeCreativeSetupSnapshot({ ...creative('https://cdn.fb.net/a?token=NEW'), image_hash: 'different-hash' })
    expect(diff(before, after).map((c) => c.field_path)).toEqual(['image_hash'])
  })
})
