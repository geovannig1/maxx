import { computeVideoMetrics, type EarlyViewSource } from '@/lib/creative/video-metrics'
// Single source of truth for rolling up daily_insights rows into one entity's window metrics.
// Used by every entity API (campaigns / ad-sets / ads) so all three tables show identical math.
//
// Rule (matches health-score.ts): rates with additive denominators are recomputed from SUMMED totals,
// never averaged across daily rates — average-of-daily-rates double-counts and is wrong. Specifically:
//   ctr  = Σclicks / Σimpressions          cpc = Σspend / Σclicks       cpm = Σspend / Σimpressions × 1000
//   cpl  = Σspend / Σleads                  cpa = Σspend / Σbookings
// Daily reach and frequency are non-additive. A multi-day selected-period value requires a separate
// Meta `time_increment=all_days` result, which this daily-row rollup does not have. We expose peak
// daily reach as an explicitly labelled statistic and withhold frequency for multi-row windows.
// Video retention uses the summed _watched counts; hook/hold from those.

export interface EntityMetrics {
  // sums
  spend: number
  leads: number
  bookings: number
  impressions: number
  /** Exact daily reach for one row; peak daily reach for a multi-row window (never period reach). */
  reach: number
  clicks: number
  unique_clicks: number
  link_clicks: number
  landing_page_views: number
  /** Video STARTS. NULL when no source row carried a count — unavailable, never a measured 0. */
  video_views: number | null
  thruplays: number
  p25: number
  p50: number
  p75: number
  p100: number
  appointment_value: number | null
  // derived rates (from totals)
  ctr: number | null // %
  cpc: number | null
  cpm: number | null
  cpl: number | null
  cpa: number | null
  /** Exact daily frequency for one row; unavailable for a multi-row window. */
  frequency: number | null
  /** EARLY-VIEW rate: video starts (or continuous-2s views) ÷ impressions. NULL when Meta returned
   *  no early-view field — p25 is a RETENTION MILESTONE and is never substituted for it. */
  hook_rate: number | null
  /** RETIRED. Always null. It was thruplays ÷ p25, which can exceed 100% on a long video because
   *  ThruPlay counts a 15s view while p25 is 25% of the length. Use thruplay_rate / retention_* . */
  hold_rate: null
  thruplay_rate: number | null // % — ThruPlays ÷ impressions
  /** RETENTION MILESTONES: share reaching 25/50/75/100% of the video LENGTH. Denominator is video
   *  starts when known, else impressions (flagged by retention_denominator_is_impressions). */
  retention_p25_rate: number | null
  retention_p50_rate: number | null
  retention_p75_rate: number | null
  completion_rate: number | null
  /** 'video_starts' when a real play count was available, else 'impressions' — a DIFFERENT question
   *  ("of everyone who saw it"), never conflated with share-of-plays. */
  retention_denominator: 'video_starts' | 'impressions'
  /**
   * Whether the video-START count covers EVERY video row in the window.
   * 'complete'    — every video row reported a start count; the subtotal is a real total.
   * 'partial'     — some video rows reported none; `video_views` is a SUBTOTAL, not the window total,
   *                 and it is NOT used as a retention denominator.
   * 'unavailable' — no video row reported a start count.
   */
  video_start_coverage: 'complete' | 'partial' | 'unavailable'
  /** Which real field the early-view rate came from, or 'unavailable'. */
  early_view_source: EarlyViewSource
  /** >0 when a raw relationship was impossible; the value was clamped AND flagged, never silently. */
  derived_metric_warning_count: number
  avg_play_time: number | null // seconds, impression-weighted
  roas: number | null
}

// Columns aggregateMetrics() needs from daily_insights (the keying column is added per-API).
export const INSIGHT_METRIC_COLUMNS =
  'spend, leads, bookings, impressions, reach, clicks, unique_clicks, link_clicks, landing_page_views, frequency, video_views, video_thru_plays, video_avg_play_time, video_p25_watched, video_p50_watched, video_p75_watched, video_p100_watched, appointment_value, video_plays, video_continuous_2s_views, early_view_source'

type InsightRow = Record<string, unknown>

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function emptyMetrics(): EntityMetrics {
  return {
    spend: 0, leads: 0, bookings: 0, impressions: 0, reach: 0, clicks: 0, unique_clicks: 0,
    link_clicks: 0, landing_page_views: 0, video_views: null, thruplays: 0, p25: 0, p50: 0, p75: 0, p100: 0,
    appointment_value: null,
    ctr: null, cpc: null, cpm: null, cpl: null, cpa: null, frequency: null,
    hook_rate: null, hold_rate: null, thruplay_rate: null, avg_play_time: null, roas: null,
    retention_p25_rate: null, retention_p50_rate: null, retention_p75_rate: null, completion_rate: null,
    retention_denominator: 'impressions',
    video_start_coverage: 'unavailable',
    early_view_source: 'unavailable', derived_metric_warning_count: 0,
  }
}

export function aggregateMetrics(rows: InsightRow[]): EntityMetrics {
  const m = emptyMetrics()
  if (!rows || rows.length === 0) return m

  const freq: number[] = []
  let peakDailyReach = 0
  let playTimeWeighted = 0
  let playTimeImpr = 0
  let appointmentValue = 0
  let videoPlays: number | null = null
  let videoStarts: number | null = null
  let videoRows = 0
  let videoRowsWithStarts = 0
  let continuous2s: number | null = null

  for (const r of rows) {
    const impr = num(r.impressions)
    m.spend += num(r.spend)
    m.leads += num(r.leads)
    m.bookings += num(r.bookings)
    m.impressions += impr
    peakDailyReach = Math.max(peakDailyReach, num(r.reach))
    m.clicks += num(r.clicks)
    m.unique_clicks += num(r.unique_clicks)
    m.link_clicks += num(r.link_clicks)
    m.landing_page_views += num(r.landing_page_views)
    // ABSENT stays absent. `video_views` starts at 0 and `num(null)` is 0, so a window where Meta
    // returned NO video-start count rendered as a measured "0 video starts". Only rows that actually
    // carried a count contribute, and the field stays NULL when none did.
    // COVERAGE, not just a subtotal. Summing only rows that carry a start count is safe for the raw
    // number, but using that PARTIAL subtotal as the retention denominator — while the quartiles sum
    // EVERY video row — inflates every retention rate and can exceed 100%. A row counts as a video
    // row when it reports any video activity at all.
    // Two columns carry the START count: `video_plays` (canonical) and `video_views`
    // (repurposed by the `rev_i` contract). Either proves the row measured starts; coverage must consider both or a
    // row written through one path looks like missing data.
    const rowStarts = r.video_plays != null ? num(r.video_plays)
      : r.video_views != null ? num(r.video_views)
      : null
    const isVideoRow = rowStarts !== null || r.video_p25_watched != null ||
      r.video_p100_watched != null || r.video_thru_plays != null
    if (isVideoRow) {
      videoRows += 1
      if (rowStarts !== null) {
        videoStarts = (videoStarts ?? 0) + rowStarts
        videoRowsWithStarts += 1
      }
    }
    m.thruplays += num(r.video_thru_plays)
    m.p25 += num(r.video_p25_watched)
    m.p50 += num(r.video_p50_watched)
    m.p75 += num(r.video_p75_watched)
    m.p100 += num(r.video_p100_watched)
    // ABSENT stays absent. Only rows that actually carried an early-view field contribute, so a run
    // of rows with no measurement can never sum to a confident 0.
    if (r.video_plays != null) { videoPlays = (videoPlays ?? 0) + num(r.video_plays) }
    if (r.video_continuous_2s_views != null) { continuous2s = (continuous2s ?? 0) + num(r.video_continuous_2s_views) }
    appointmentValue += num(r.appointment_value)
    if (r.frequency != null) freq.push(Number(r.frequency))
    if (r.video_avg_play_time != null && impr > 0) {
      playTimeWeighted += Number(r.video_avg_play_time) * impr
      playTimeImpr += impr
    }
  }

  const div = (n: number, d: number): number | null => (d > 0 ? n / d : null)

  m.ctr = div(m.clicks * 100, m.impressions)
  m.cpc = div(m.spend, m.clicks)
  m.cpm = div(m.spend * 1000, m.impressions)
  m.cpl = div(m.spend, m.leads)
  m.cpa = div(m.spend, m.bookings)
  m.reach = peakDailyReach
  m.frequency = rows.length === 1 && freq.length === 1 ? freq[0] : null
  // Video rates go through the single contract-bearing derivation: honest early-view source, real
  // denominators, and NO silent clamping.
  // PARTIAL coverage must not become a confident denominator. When some video rows reported starts
  // and others did not, the subtotal covers only part of the window, so it is withheld: retention
  // falls back to the impressions denominator (which computeVideoMetrics labels) instead of dividing
  // every row's quartiles by a fraction of the starts.
  const startCoverage: 'complete' | 'partial' | 'unavailable' =
    videoRows === 0 || videoRowsWithStarts === 0 ? 'unavailable'
    : videoRowsWithStarts === videoRows ? 'complete'
    : 'partial'
  const usableStarts = startCoverage === 'complete' ? videoStarts : null

  const video = computeVideoMetrics({
    impressions: m.impressions,
    videoPlays, continuous2sViews: continuous2s,
    p25: m.p25, p50: m.p50, p75: m.p75, p100: m.p100,
    thruplays: m.thruplays,
    avgWatchSeconds: null,
    durationSeconds: null,
  }, usableStarts)
  // The raw subtotal is still reported when ANY row measured it, but the window is labelled partial
  // so no consumer reads it as a complete count.
  m.video_views = videoStarts
  m.video_start_coverage = startCoverage
  m.hook_rate = video.earlyView.value
  m.hold_rate = null
  m.thruplay_rate = video.thruplayRate.value
  m.retention_p25_rate = video.retentionP25.value
  m.retention_p50_rate = video.retentionP50.value
  m.retention_p75_rate = video.retentionP75.value
  m.completion_rate = video.completion.value
  m.retention_denominator = video.retentionDenominatorIsImpressions ? 'impressions' : 'video_starts'
  m.early_view_source = video.earlyViewSource
  // Partial start coverage is itself a derived-metric warning: the window's start count is a
  // SUBTOTAL, so no consumer may read it as the total. (Assigned here, after the video block, so it
  // is not overwritten.)
  m.derived_metric_warning_count = video.warnings.length + (startCoverage === 'partial' ? 1 : 0)
  m.avg_play_time = div(playTimeWeighted, playTimeImpr)
  m.appointment_value = appointmentValue > 0 ? appointmentValue : null
  m.roas = appointmentValue > 0 ? div(appointmentValue, m.spend) : null

  return m
}

export function publicEntityMetrics(metrics: EntityMetrics): EntityMetrics {
  return {
    ...metrics,
    appointment_value: null,
    roas: null,
  }
}
