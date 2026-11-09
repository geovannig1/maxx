import { describe, it, expect } from 'vitest'
import { aggregateMetrics, emptyMetrics } from '@/lib/metrics/aggregate'

describe('aggregateMetrics', () => {
  it('returns zeroed/null metrics for no rows', () => {
    expect(aggregateMetrics([])).toEqual(emptyMetrics())
  })

  it('sums additive fields and derives rates from totals (not averages of daily rates)', () => {
    const rows = [
      { spend: 100, leads: 4, bookings: 1, impressions: 10_000, reach: 8_000, clicks: 200, frequency: 1.25, appointment_value: 250 },
      { spend: 300, leads: 6, bookings: 1, impressions: 30_000, reach: 20_000, clicks: 400, frequency: 1.5, appointment_value: 250 },
    ]
    const m = aggregateMetrics(rows)
    expect(m.spend).toBe(400)
    expect(m.leads).toBe(10)
    expect(m.impressions).toBe(40_000)
    expect(m.clicks).toBe(600)
    // ctr = 600/40000*100 = 1.5% (from totals — NOT the avg of daily 2.0% and 1.33%)
    expect(m.ctr).toBeCloseTo(1.5, 6)
    expect(m.cpc).toBeCloseTo(400 / 600, 6)
    expect(m.cpm).toBeCloseTo((400 / 40_000) * 1000, 6)
    expect(m.cpl).toBeCloseTo(40, 6) // 400/10
    expect(m.cpa).toBeCloseTo(200, 6) // 400/2 bookings
    // Reach is not additive across daily Meta rows. Preserve only the exact peak-daily statistic;
    // selected-period reach requires a separate all-days Meta query.
    expect(m.reach).toBe(20_000)
    // Daily frequency also cannot be converted into selected-period frequency. Withhold it rather
    // than averaging daily values and presenting the result as the selected-period Meta metric.
    expect(m.frequency).toBeNull()
    expect(m.roas).toBeCloseTo(500 / 400, 6)
    expect(m.appointment_value).toBe(500)
  })

  it('preserves exact reach and frequency for a single daily row', () => {
    const m = aggregateMetrics([{ impressions: 1_000, reach: 800, frequency: 1.25 }])
    expect(m.reach).toBe(800)
    expect(m.frequency).toBe(1.25)
  })

  // p25 is a RETENTION MILESTONE (25% of video LENGTH), never a 3-second hook. With no
  // early-view field in these rows the early-view rate must be UNAVAILABLE, not p25-derived, and the
  // old hold_rate (thruplays / p25 — able to exceed 100% on a long video) is retired.
  it('builds retention milestones from summed quartile counts, with NO p25-derived hook', () => {
    const rows = [
      { impressions: 10_000, video_p25_watched: 1_000, video_p50_watched: 600, video_p75_watched: 400, video_p100_watched: 250, video_thru_plays: 500, video_avg_play_time: 6 },
      { impressions: 10_000, video_p25_watched: 1_000, video_p50_watched: 400, video_p75_watched: 200, video_p100_watched: 150, video_thru_plays: 500, video_avg_play_time: 4 },
    ]
    const m = aggregateMetrics(rows)
    expect(m.p25).toBe(2_000)
    expect(m.p100).toBe(400)
    // No early-view field in these rows => UNAVAILABLE. The old code returned 2000/20000 = 10%.
    expect(m.early_view_source).toBe('unavailable')
    expect(m.hook_rate).toBeNull()
    // hold_rate is retired outright.
    expect(m.hold_rate).toBeNull()
    // Retention denominator falls back to impressions (no video-start count) and says so.
    expect(m.retention_denominator).toBe('impressions')
    expect(m.retention_p25_rate).toBeCloseTo(10, 6)   // 2000 / 20000
    expect(m.completion_rate).toBeCloseTo(2, 6)       // 400 / 20000
    // ThruPlay rate is measured against impressions, NOT against p25.
    expect(m.thruplay_rate).toBeCloseTo(5, 6)
    // avg play time impression-weighted = (6*10000 + 4*10000)/20000 = 5
    expect(m.avg_play_time).toBeCloseTo(5, 6)
    expect(m.derived_metric_warning_count).toBe(0)
  })

  it('uses video STARTS for the early-view rate and the retention denominator when present', () => {
    const rows = [
      { impressions: 10_000, video_plays: 4_000, video_p25_watched: 1_200, video_thru_plays: 500 },
    ]
    const m = aggregateMetrics(rows)
    expect(m.early_view_source).toBe('video_play_actions')
    expect(m.hook_rate).toBeCloseTo(40, 6)            // 4000 / 10000
    expect(m.retention_denominator).toBe('video_starts')
    expect(m.retention_p25_rate).toBeCloseTo(30, 6)   // 1200 / 4000
  })

  it('flags an impossible raw rate instead of clamping it silently', () => {
    const rows = [{ impressions: 100, video_thru_plays: 500 }]
    const m = aggregateMetrics(rows)
    expect(m.thruplay_rate).toBe(100)                 // clamped for display
    expect(m.derived_metric_warning_count).toBeGreaterThan(0) // ...but never silently
  })

  it('leaves rates null when their denominator is zero', () => {
    const m = aggregateMetrics([{ spend: 50, impressions: 0, clicks: 0, leads: 0 }])
    expect(m.ctr).toBeNull()
    expect(m.cpc).toBeNull()
    expect(m.cpl).toBeNull()
    expect(m.hook_rate).toBeNull()
  })
})


// `video_views` started at 0 and `num(null)` is 0, so a window where Meta returned NO
// video-start count rendered as a measured "0 video starts".
describe('video starts — unavailable is never a measured zero', () => {
  it('rows with NO video_views yield NULL, not 0', () => {
    const m = aggregateMetrics([{ impressions: 1000, video_p25_watched: 100 }])
    expect(m.video_views).toBeNull()
  })

  it('a PRESENT zero is a real measurement', () => {
    const m = aggregateMetrics([{ impressions: 1000, video_views: 0 }])
    expect(m.video_views).toBe(0)
  })

  it('only rows that carried a count contribute', () => {
    const m = aggregateMetrics([
      { impressions: 1000, video_views: 400 },
      { impressions: 1000 },              // no field at all
      { impressions: 1000, video_views: 100 },
    ])
    expect(m.video_views).toBe(500)
  })

  it('an empty set is NULL, not 0', () => {
    expect(aggregateMetrics([]).video_views).toBeNull()
  })
})


// Summing only rows that carry a start count is safe for the raw subtotal, but using that
// PARTIAL subtotal as the retention denominator — while the quartiles sum EVERY video row — inflates
// every retention rate. One measured row plus one missing-start row reported 400 starts, 100%
// retention, and zero warnings.
describe('video-start COVERAGE — a partial denominator is never confident', () => {
  it('PARTIAL coverage does not inflate retention, and is labelled', () => {
    const m = aggregateMetrics([
      { impressions: 1000, video_views: 400, video_p25_watched: 400 },
      { impressions: 1000, video_p25_watched: 400 },   // video row with NO start count
    ])
    expect(m.video_start_coverage).toBe('partial')
    // 800 quartiles over the partial 400 starts would be 200%. The denominator falls back to
    // impressions and is labelled as such.
    expect(m.retention_denominator).toBe('impressions')
    expect(m.retention_p25_rate).toBeCloseTo(40, 6) // 800 / 2000
    expect(m.retention_p25_rate).not.toBeCloseTo(200, 0)
    expect(m.derived_metric_warning_count).toBeGreaterThan(0)
  })

  it('COMPLETE coverage uses video starts as the denominator', () => {
    const m = aggregateMetrics([
      { impressions: 1000, video_views: 400, video_p25_watched: 200 },
      { impressions: 1000, video_views: 600, video_p25_watched: 300 },
    ])
    expect(m.video_start_coverage).toBe('complete')
    expect(m.retention_denominator).toBe('video_starts')
    expect(m.retention_p25_rate).toBeCloseTo(50, 6) // 500 / 1000
    expect(m.derived_metric_warning_count).toBe(0)
  })

  it('NO start count anywhere is unavailable, not partial', () => {
    const m = aggregateMetrics([{ impressions: 1000, video_p25_watched: 100 }])
    expect(m.video_start_coverage).toBe('unavailable')
    expect(m.video_views).toBeNull()
    expect(m.retention_denominator).toBe('impressions')
  })

  it('a window with NO video rows at all is unavailable', () => {
    const m = aggregateMetrics([{ impressions: 1000, clicks: 10 }])
    expect(m.video_start_coverage).toBe('unavailable')
  })

  it('a retention rate can never exceed 100% from a partial denominator', () => {
    const m = aggregateMetrics([
      { impressions: 500, video_views: 10, video_p25_watched: 10 },
      { impressions: 500, video_p25_watched: 400 },  // huge quartile, no starts
    ])
    expect(m.retention_p25_rate).not.toBeNull()
    expect(m.retention_p25_rate!).toBeLessThanOrEqual(100)
    expect(m.video_start_coverage).toBe('partial')
  })
})
