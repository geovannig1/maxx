// The metric column catalog — one definition per metric, shared by the campaigns / ad-sets / ads
// tables so labels, formatting, banding, and the column chooser stay identical everywhere.
// Banding reuses the app's target ranges (getMetricStatus) — no thresholds invented here.

import { getMetricStatus, type MetricKey } from '@/lib/targets/target-ranges'
import type { EntityMetrics } from '@/lib/metrics/aggregate'
import { formatMoney } from '@/lib/utils/format-currency'

export type EntityLevel = 'campaign' | 'adset' | 'ad'
export type MetricFormat = 'currency' | 'percent' | 'number' | 'seconds' | 'ratio'
export type MetricTone = 'good' | 'warn' | 'bad' | 'neutral'

export interface MetricDef {
  key: keyof EntityMetrics
  label: string // full name (column chooser)
  header: string // short table header
  format: MetricFormat
  decimals?: number // for number/seconds; counts default to integer w/ thousands separators
  align: 'left' | 'right'
  /** target-ranges key used to colour the value (excellent/healthy → green, watch → amber, critical → red) */
  bandMetric?: MetricKey
  /** special-cased video bands (no target range exists) — uses the Ads-table thresholds */
  videoBand?: 'hook' | 'hold'
  levels: EntityLevel[]
  defaultVisible: boolean
  description?: string
}

const ALL: EntityLevel[] = ['campaign', 'adset', 'ad']

// Order here is the column order in every table.
export const METRIC_CATALOG: MetricDef[] = [
  { key: 'spend', label: 'Spend', header: 'Spend', format: 'currency', align: 'right', levels: ALL, defaultVisible: true },
  // The warehouse field is named `bookings` for compatibility, but its source is Meta's canonical
  // AppointmentConfirmed Results column. It is modelled platform attribution, not the outcome ledger.
  { key: 'bookings', label: 'Meta Results (modelled 7dc/1dv)', header: 'Results', format: 'number', align: 'right', levels: ALL, defaultVisible: true, description: 'AppointmentConfirmed Results under Meta 7-day click / 1-day view attribution; not verified business appointments.' },
  { key: 'cpa', label: 'Meta Cost / Result', header: 'Cost/Result', format: 'currency', align: 'right', levels: ALL, defaultVisible: true, description: 'Spend ÷ Meta modelled AppointmentConfirmed Results; not exact paid CPA.' },
  { key: 'leads', label: 'Leads', header: 'Leads', format: 'number', align: 'right', levels: ALL, defaultVisible: false },
  { key: 'cpl', label: 'Cost / Lead', header: 'CPL', format: 'currency', align: 'right', bandMetric: 'cpl', levels: ALL, defaultVisible: false },
  { key: 'ctr', label: 'All-click CTR', header: 'All-click CTR', format: 'percent', align: 'right', bandMetric: 'ctr', levels: ALL, defaultVisible: true, description: 'all clicks ÷ impressions' },
  { key: 'cpc', label: 'Cost / Click', header: 'CPC', format: 'currency', align: 'right', bandMetric: 'cpc', levels: ALL, defaultVisible: true },
  { key: 'cpm', label: 'Cost / 1k Impr.', header: 'CPM', format: 'currency', align: 'right', bandMetric: 'cpm', levels: ALL, defaultVisible: true },
  { key: 'frequency', label: 'Daily Frequency', header: 'Daily freq', format: 'number', decimals: 2, align: 'right', levels: ALL, defaultVisible: false, description: 'Exact for a single daily row; unavailable for a multi-day selection. Not selected-period Meta frequency.' },
  { key: 'impressions', label: 'Impressions', header: 'Impr.', format: 'number', align: 'right', levels: ALL, defaultVisible: false },
  { key: 'reach', label: 'Peak Daily Reach', header: 'Peak reach', format: 'number', align: 'right', levels: ALL, defaultVisible: false, description: 'Highest daily reach in the selection; not selected-period deduplicated Meta reach.' },
  { key: 'clicks', label: 'Clicks (all)', header: 'Clicks', format: 'number', align: 'right', levels: ALL, defaultVisible: false },
  { key: 'link_clicks', label: 'Link Clicks', header: 'Link clk', format: 'number', align: 'right', levels: ALL, defaultVisible: false },
  { key: 'landing_page_views', label: 'Landing Page Views', header: 'LPV', format: 'number', align: 'right', levels: ALL, defaultVisible: false },
  { key: 'unique_clicks', label: 'Unique Clicks', header: 'Uniq clk', format: 'number', align: 'right', levels: ALL, defaultVisible: false },
  // Video — meaningful at every level (Meta aggregates the quartiles up), shown by default on ads.
  // EARLY VIEW — never called a "3s hook": Meta's batch insights expose no three-second field, so
  // this is video STARTS (or continuous-2s views) over impressions, and unavailable when neither
  // came back. video_p25 is a RETENTION MILESTONE (25% of video LENGTH) and is never substituted.
  { key: 'hook_rate', label: 'Early-View Rate', header: 'Early view', format: 'percent', decimals: 1, align: 'right', videoBand: 'hook', levels: ['ad'], defaultVisible: true, description: 'video starts (or continuous-2s views) ÷ impressions — NOT a 3-second hook' },
  // RETENTION MILESTONES — share reaching a % of the video LENGTH. On a 60-120s creative the 25%
  // milestone is ~15-30 seconds of watch time; it means something different on a 15s video.
  { key: 'retention_p25_rate', label: 'Retention 25%', header: 'R25', format: 'percent', decimals: 1, align: 'right', levels: ['ad'], defaultVisible: true, description: 'reached 25% of video LENGTH ÷ video starts (impressions when starts are unknown)' },
  { key: 'retention_p50_rate', label: 'Retention 50%', header: 'R50', format: 'percent', decimals: 1, align: 'right', levels: ['ad'], defaultVisible: false, description: 'reached 50% of video LENGTH' },
  { key: 'retention_p75_rate', label: 'Retention 75%', header: 'R75', format: 'percent', decimals: 1, align: 'right', levels: ['ad'], defaultVisible: false, description: 'reached 75% of video LENGTH' },
  { key: 'completion_rate', label: 'Completion', header: 'Compl.', format: 'percent', decimals: 1, align: 'right', levels: ['ad'], defaultVisible: false, description: 'reached 100% of video LENGTH' },
  { key: 'thruplay_rate', label: 'ThruPlay Rate', header: 'ThruPlay', format: 'percent', decimals: 1, align: 'right', levels: ['campaign', 'adset', 'ad'], defaultVisible: false, description: 'ThruPlays (15s, or a full play if shorter) ÷ impressions — kept SEPARATE from retention' },
  { key: 'avg_play_time', label: 'Avg Watch Time', header: 'Avg watch', format: 'seconds', decimals: 1, align: 'right', levels: ['campaign', 'adset', 'ad'], defaultVisible: false },
  { key: 'video_views', label: 'Video Starts', header: 'Starts', format: 'number', align: 'right', levels: ['campaign', 'adset', 'ad'], defaultVisible: false, description: 'video_play_actions — the number of times the video STARTED. NOT a p25 milestone and NOT a three-second view. Null when Meta returned no start count.' },
]

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(METRIC_CATALOG.map((m) => [m.key, m]))

export function metricsForLevel(level: EntityLevel): MetricDef[] {
  return METRIC_CATALOG.filter((m) => m.levels.includes(level))
}

export function defaultVisibleKeys(level: EntityLevel): string[] {
  return metricsForLevel(level).filter((m) => m.defaultVisible).map((m) => m.key)
}

export function formatMetric(def: MetricDef, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  switch (def.format) {
    case 'currency':
      return def.decimals === undefined ? formatMoney(value) : formatMoney(value, { minimumFractionDigits: def.decimals, maximumFractionDigits: def.decimals })
    case 'percent':
      return `${value.toFixed(def.decimals ?? 2)}%`
    case 'seconds':
      return `${value.toFixed(def.decimals ?? 1)}s`
    case 'ratio':
      return `${value.toFixed(def.decimals ?? 2)}x`
    case 'number':
      return def.decimals != null ? value.toFixed(def.decimals) : Math.round(value).toLocaleString()
  }
}

function statusTone(status: string): MetricTone {
  if (status === 'excellent' || status === 'healthy') return 'good'
  if (status === 'watch') return 'warn'
  if (status === 'critical') return 'bad'
  return 'neutral' // needs_data / estimate_only / no_target / unknown
}

// Ads-table video thresholds (kept consistent with lib/creative/verdict.ts).
function hookTone(rate: number): MetricTone {
  if (rate > 15) return 'good'
  if (rate >= 5) return 'warn'
  return 'bad'
}
function holdTone(rate: number): MetricTone {
  if (rate > 30) return 'good'
  if (rate >= 15) return 'warn'
  return 'bad'
}

/** Colour band for one metric value, grounded in the same ranges/gates as the rest of the app. */
export function metricTone(def: MetricDef, m: EntityMetrics, windowDays: number): MetricTone {
  const value = m[def.key]
  if (value === null || value === undefined || !Number.isFinite(value as number)) return 'neutral'
  if (def.videoBand === 'hook') return hookTone(value as number)
  if (def.videoBand === 'hold') return holdTone(value as number)
  if (def.bandMetric) {
    const evalResult = getMetricStatus(def.bandMetric, value as number, {
      spend: m.spend, clicks: m.clicks, impressions: m.impressions, bookings: m.bookings, windowDays,
    })
    return statusTone(evalResult.status)
  }
  return 'neutral'
}
