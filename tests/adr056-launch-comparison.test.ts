import { describe, expect, it } from 'vitest'
import {
  buildAdr056LaunchComparison,
  type Adr056AdRow,
  type Adr056InsightRow,
} from '@/lib/launch/adr056-launch-comparison'

const ads: Adr056AdRow[] = [
  {
    id: 'new-warm',
    ad_id: 'meta-new-warm',
    ad_name: 'Warm | Tour (ADR-056 tagged)',
    meta_creative_id: 'creative-warm',
    meta_created_time: '2026-04-13T09:17:11-04:00',
    meta_updated_time: '2026-04-13T10:02:22-04:00',
    effective_status: 'ACTIVE',
  },
  {
    id: 'new-cold',
    ad_id: 'meta-new-cold',
    ad_name: 'Cold | Tour (ADR-056 tagged)',
    meta_creative_id: 'creative-cold',
    meta_created_time: '2026-04-13T09:17:03-04:00',
    meta_updated_time: '2026-04-13T10:02:18-04:00',
    effective_status: 'ACTIVE',
  },
  {
    id: 'old-warm',
    ad_id: 'meta-old-warm',
    ad_name: 'Warm | Tour',
    meta_creative_id: 'creative-warm',
    meta_created_time: '2026-01-30T12:00:00-04:00',
    meta_updated_time: '2026-04-13T10:02:36-04:00',
    effective_status: 'PAUSED',
  },
  {
    id: 'old-cold',
    ad_id: 'meta-old-cold',
    ad_name: 'Cold | Tour',
    meta_creative_id: 'creative-cold',
    meta_created_time: '2026-03-01T12:00:00-04:00',
    meta_updated_time: '2026-04-13T10:02:31-04:00',
    effective_status: 'PAUSED',
  },
]

const insights: Adr056InsightRow[] = [
  { ad_id: 'old-warm', date_start: '2026-04-01', spend: 22, impressions: 1_000, clicks: 20, link_clicks: 10, landing_page_views: 8, bookings: 2, bookings_view_through: 1 },
  { ad_id: 'old-cold', date_start: '2026-04-01', spend: 25, impressions: 1_000, clicks: 30, link_clicks: 12, landing_page_views: 10, bookings: 0, bookings_view_through: null },
  { ad_id: 'old-warm', date_start: '2026-04-13', spend: 10, impressions: 300, clicks: 6, link_clicks: 3, landing_page_views: 2, bookings: 1, bookings_view_through: 1 },
  { ad_id: 'new-warm', date_start: '2026-04-13', spend: 1, impressions: 20, clicks: 1, link_clicks: 1, landing_page_views: 1, bookings: 0, bookings_view_through: null },
  { ad_id: 'new-warm', date_start: '2026-04-14', spend: 26, impressions: 1_200, clicks: 24, link_clicks: 12, landing_page_views: 10, bookings: 3, bookings_view_through: 2 },
  { ad_id: 'new-cold', date_start: '2026-04-14', spend: 23, impressions: 1_100, clicks: 32, link_clicks: 14, landing_page_views: 12, bookings: 0, bookings_view_through: null },
]

const completeAccountDates = Array.from({ length: 14 }, (_, index) =>
  `2026-04-${String(index + 1).padStart(2, '0')}`,
)
const treatmentMetaAdIds = ['meta-new-warm', 'meta-new-cold'] as const

describe('ADR-056 launch comparison', () => {
  it('resolves the treatment from immutable Meta IDs, not shared creative identity', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('available')
    expect(result.taggedAds.map((ad) => ad.metaAdId)).toEqual([
      'meta-new-cold',
      'meta-new-warm',
    ])
    expect(result.predecessorAds.map((ad) => ad.metaAdId)).toEqual([
      'meta-old-cold',
      'meta-old-warm',
    ])
    expect(result.boundary).toMatchObject({
      launchDate: '2026-04-13',
      firstCleanTaggedDate: '2026-04-14',
      launchDateIsMixed: true,
    })
  })

  it('keeps historical cohort identity stable when current delivery statuses change', () => {
    const statusChangedAds = ads.map((ad) => ({
      ...ad,
      effective_status: ad.ad_name?.includes('ADR-056 tagged') ? 'PAUSED' : 'ACTIVE',
    }))
    const result = buildAdr056LaunchComparison({
      ads: statusChangedAds,
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('available')
    expect(result.taggedAds.map((ad) => ad.metaAdId)).toEqual([
      'meta-new-cold',
      'meta-new-warm',
    ])
    expect(result.predecessorAds.map((ad) => ad.metaAdId)).toEqual([
      'meta-old-cold',
      'meta-old-warm',
    ])
  })

  it('uses explicitly supplied immutable Meta ad IDs after the live names are renamed', () => {
    const renamedAds = ads.map((ad) => ad.id.startsWith('new-')
      ? { ...ad, ad_name: ad.id === 'new-warm' ? 'Warm creative renamed' : 'Cold creative renamed' }
      : ad)
    const result = buildAdr056LaunchComparison({
      ads: renamedAds,
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('available')
    expect(result.provenance.treatment).toEqual({
      basis: 'immutable_meta_ad_ids',
      cohortVersion: 'adr-056-v1',
      metaAdIds: ['meta-new-cold', 'meta-new-warm'],
    })
    expect(result.provenance.audience.warm).toBe('ad_name_derived')
    expect(result.taggedAds.map((ad) => ad.metaAdId)).toEqual(['meta-new-cold', 'meta-new-warm'])
  })

  it('uses disjoint comparison windows and keeps launch-day delivery separate', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.windows).toEqual({
      previous: { from: '2026-04-01', to: '2026-04-12' },
      launchDay: { from: '2026-04-13', to: '2026-04-13' },
      tagged: { from: '2026-04-14', to: '2026-04-14' },
    })
    expect(result.previous.warm.metrics).toMatchObject({ spend: 22, metaResults: 2 })
    expect(result.launchDay.previous.metrics.spend).toBe(10)
    expect(result.launchDay.tagged.metrics.spend).toBe(1)
    expect(result.tagged.warm.metrics).toMatchObject({
      spend: 26,
      metaResults: 3,
      clickResults: 1,
      viewResults: 2,
    })
  })

  it('never manufactures selected-period reach, frequency, booking value, or ROAS', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.tagged.combined.metrics).toMatchObject({
      nativePeriodReach: null,
      nativePeriodFrequency: null,
      appointmentValue: null,
      exactPaidCpa: null,
      exactPaidRoas: null,
    })
  })

  it('fails closed when an immutable treatment member is absent', () => {
    const result = buildAdr056LaunchComparison({
      ads: ads.filter((ad) => ad.id !== 'new-cold'),
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('unavailable')
    expect(result.blockers).toContain('tagged_cohort_count_mismatch')
  })

  it('marks the result partial when closed-day account coverage is missing', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: completeAccountDates.filter((date) => date !== '2026-04-14'),
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('partial')
    expect(result.blockers).toContain('account_insight_days_missing')
    expect(result.missingAccountInsightDates).toContain('2026-04-14')
  })

  it('fails closed instead of converting a malformed cohort metric to zero', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights: insights.map((row) => row.ad_id === 'new-warm' && row.date_start === '2026-04-14'
        ? { ...row, spend: 'not-a-number' }
        : row),
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('unavailable')
    expect(result.blockers).toContain('invalid_insight_metric')
  })

  it('fails closed when duplicate ad-day rows could double-count delivery or results', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights: [...insights, { ...insights[4] }],
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('unavailable')
    expect(result.blockers).toContain('duplicate_ad_insight_rows')
  })

  it('does not silently choose one predecessor when creative lineage is ambiguous', () => {
    const result = buildAdr056LaunchComparison({
      ads: [
        ...ads,
        {
          ...ads[2],
          id: 'old-warm-duplicate',
          ad_id: 'meta-old-warm-duplicate',
          meta_updated_time: '2026-04-13T10:02:37-04:00',
        },
      ],
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-15T10:00:00Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('partial')
    expect(result.blockers).toContain('predecessor_ambiguous:meta-new-warm')
    expect(result.predecessorAds.map((ad) => ad.metaAdId)).not.toContain('meta-old-warm')
    expect(result.predecessorAds.map((ad) => ad.metaAdId)).not.toContain('meta-old-warm-duplicate')
  })

  it('marks complete rows partial when source-generation freshness cannot be established', () => {
    const missingFreshness = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: null,
      taggedMetaAdIds: treatmentMetaAdIds,
    })
    const staleGeneration = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: completeAccountDates,
      lastClosedDate: '2026-04-14',
      lastSyncedAt: '2026-04-14T18:00:00-04:00',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(missingFreshness.status).toBe('partial')
    expect(missingFreshness.blockers).toContain('source_freshness_unavailable')
    expect(staleGeneration.status).toBe('partial')
    expect(staleGeneration.blockers).toContain('source_generation_not_post_window')
  })
})
