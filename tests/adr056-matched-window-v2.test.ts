import { describe, expect, it } from 'vitest'
import {
  buildAdr056LaunchComparison,
  type Adr056AdRow,
  type Adr056InsightRow,
} from '@/lib/launch/adr056-launch-comparison'

const ads: Adr056AdRow[] = [
  { id: 'new-warm', ad_id: 'meta-new-warm', ad_name: 'Warm | Tour (ADR-056 tagged)', meta_creative_id: 'cw', meta_created_time: '2026-08-13T09:17:32-04:00', meta_updated_time: '2026-08-13T10:02:22-04:00', effective_status: 'ACTIVE' },
  { id: 'new-cold', ad_id: 'meta-new-cold', ad_name: 'Cold | Tour (ADR-056 tagged)', meta_creative_id: 'cc', meta_created_time: '2026-08-13T09:17:26-04:00', meta_updated_time: '2026-08-13T10:02:18-04:00', effective_status: 'ACTIVE' },
  { id: 'old-warm', ad_id: 'meta-old-warm', ad_name: 'Warm | Tour', meta_creative_id: 'cw', meta_created_time: '2026-06-01T12:00:00-04:00', meta_updated_time: '2026-08-13T10:02:34-04:00', effective_status: 'PAUSED' },
  { id: 'old-cold', ad_id: 'meta-old-cold', ad_name: 'Cold | Tour', meta_creative_id: 'cc', meta_created_time: '2026-07-01T12:00:00-04:00', meta_updated_time: '2026-08-13T10:02:31-04:00', effective_status: 'PAUSED' },
]

const dates = Array.from({ length: 20 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`)
const treatmentMetaAdIds = ['meta-new-warm', 'meta-new-cold'] as const
const row = (ad_id: string, date_start: string, bookings: number, view: number | null): Adr056InsightRow => ({
  ad_id, date_start, spend: 10, impressions: 100, clicks: 10, link_clicks: 8,
  landing_page_views: 7, bookings, bookings_view_through: view,
})

const insights: Adr056InsightRow[] = [
  ...dates.slice(0, 12).flatMap((date) => [row('old-warm', date, 1, 1), row('old-cold', date, 0, null)]),
  row('old-warm', '2026-08-13', 1, 1),
  row('new-warm', '2026-08-13', 0, null),
  ...dates.slice(13, 20).flatMap((date) => [row('new-warm', date, 1, 1), row('new-cold', date, 0, null)]),
]

describe('ADR-056 matched comparison v2', () => {
  it('publishes canonical and equal-day windows while excluding the mixed launch day', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: dates,
      lastClosedDate: '2026-08-20',
      lastSyncedAt: '2026-08-21T12:00:00.000Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.windows).toEqual({
      previous: { from: '2026-08-01', to: '2026-08-12' },
      launchDay: { from: '2026-08-13', to: '2026-08-13' },
      tagged: { from: '2026-08-14', to: '2026-08-20' },
    })
    expect(result.matched!.windows).toEqual({
      previous: { from: '2026-08-06', to: '2026-08-12', days: 7 },
      tagged: { from: '2026-08-14', to: '2026-08-20', days: 7 },
    })
    expect(result.provenance.window).toEqual({
      mode: 'canonical_launch_as_of',
      requested: { from: null, to: '2026-08-20' },
      selectedFromApplied: false,
      selectedToAppliedAsOfDate: true,
    })
    expect(result.matched!.previous.warm.metrics.spend).toBe(70)
    expect(result.matched!.tagged.warm.metrics.spend).toBe(70)
    expect(result.verdict).toEqual({
      state: 'hold_investigate',
      label: 'HOLD / INVESTIGATE',
      financialConclusionAllowed: false,
    })
  })

  it('reports click/view composition and never treats absent view split as zero', () => {
    const partialSplit = insights.map((insight) => insight.ad_id === 'new-warm' && insight.date_start === '2026-08-20'
      ? { ...insight, bookings_view_through: null }
      : insight)
    const result = buildAdr056LaunchComparison({
      ads,
      insights: partialSplit,
      accountInsightDates: dates,
      lastClosedDate: '2026-08-20',
      lastSyncedAt: '2026-08-21T12:00:00.000Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.matched!.tagged.warm.metrics.attributionSplitAvailable).toBe(false)
    expect(result.matched!.tagged.warm.metrics.clickResults).toBeNull()
    expect(result.matched!.tagged.warm.metrics.viewResults).toBeNull()
  })

  it('does not claim a comparison before the first clean tagged day exists', () => {
    const result = buildAdr056LaunchComparison({
      ads,
      insights,
      accountInsightDates: dates.slice(0, 13),
      lastClosedDate: '2026-08-13',
      lastSyncedAt: '2026-08-14T12:00:00.000Z',
      taggedMetaAdIds: treatmentMetaAdIds,
    })

    expect(result.status).toBe('partial')
    expect(result.blockers).toContain('clean_tagged_window_not_observed')
    expect(result.matched!.windows.previous.days).toBe(0)
    expect(result.matched!.windows.tagged.days).toBe(0)
  })
})
