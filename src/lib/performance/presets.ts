import type { EntityLevel } from '@/lib/metrics/catalog'
import type { EntityMetrics } from '@/lib/metrics/aggregate'
import { metaOutcomeEventName } from '@/config/business-config'

// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export type PerformancePresetKey = 'results' | 'delivery' | 'funnel' | 'creative'

export interface PerformancePreset {
  key: PerformancePresetKey
  label: string
  description: string
  columns: Array<keyof EntityMetrics>
}

export const PERFORMANCE_PRESETS: PerformancePreset[] = [
  {
    key: 'results',
    label: 'Results',
    description: `Meta spend, canonical modelled ${EVENT} Results, and Meta cost / Result.`,
    columns: ['spend', 'bookings', 'cpa'],
  },
  {
    key: 'delivery',
    label: 'Delivery',
    description: 'Spend and additive auction delivery. Selected-period reach and frequency require a native Meta period read.',
    columns: ['spend', 'impressions', 'clicks', 'ctr', 'cpm'],
  },
  {
    key: 'funnel',
    label: 'Funnel',
    description: 'Link click to landing-page-view to Meta modelled Result progression.',
    columns: ['link_clicks', 'landing_page_views', 'bookings', 'cpa'],
  },
  {
    key: 'creative',
    label: 'Creative',
    description: 'Ad-level early-view and retention milestones with explicit denominators.',
    columns: ['spend', 'hook_rate', 'retention_p25_rate', 'retention_p50_rate', 'completion_rate', 'thruplay_rate'],
  },
]

export function performancePresetFromSearch(search: string): PerformancePresetKey | null {
  const value = new URLSearchParams(search).get('preset')
  // Preserve old shared links while ensuring every newly rendered control uses Results.
  if (value === 'return') return 'results'
  return PERFORMANCE_PRESETS.some((preset) => preset.key === value)
    ? value as PerformancePresetKey
    : null
}

export function columnsForPerformancePreset(
  preset: PerformancePresetKey,
  level: EntityLevel,
): Array<keyof EntityMetrics> {
  const selected = PERFORMANCE_PRESETS.find((candidate) => candidate.key === preset) ?? PERFORMANCE_PRESETS[0]
  if (preset === 'creative' && level !== 'ad') return ['spend', 'impressions', 'clicks', 'ctr', 'cpm']
  return [...selected.columns]
}

export function buildPerformanceDrilldownHref(
  pathname: string,
  preset: PerformancePresetKey,
  range: { from: string; to: string },
  filters: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams({ from: range.from, to: range.to, preset })
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  return `${pathname}?${params.toString()}`
}

const PERFORMANCE_QUERY_KEYS = ['range', 'from', 'to', 'preset', 'campaign', 'adset', 'ad'] as const

/** Keep valid Performance context when retiring a legacy route. */
export function buildPreservedPerformanceRedirect(
  pathname: string,
  search: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams()
  for (const key of PERFORMANCE_QUERY_KEYS) {
    const value = search[key]
    if (typeof value !== 'string' || !value) continue
    if (key === 'preset') {
      const preset = performancePresetFromSearch(`?preset=${encodeURIComponent(value)}`)
      if (preset) params.set(key, preset)
      continue
    }
    params.set(key, value)
  }
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}
