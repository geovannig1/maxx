import { describe, expect, it } from 'vitest'
import {
  PERFORMANCE_PRESETS,
  buildPerformanceDrilldownHref,
  buildPreservedPerformanceRedirect,
  columnsForPerformancePreset,
  performancePresetFromSearch,
} from '@/lib/performance/presets'

describe('performance decision presets v2', () => {
  it('defines the four Meta-only owner-facing presets without presenting proxy ROAS', () => {
    expect(PERFORMANCE_PRESETS.map((preset) => preset.label)).toEqual([
      'Results', 'Delivery', 'Funnel', 'Creative',
    ])
    expect(columnsForPerformancePreset('results', 'campaign')).toEqual(['spend', 'bookings', 'cpa'])
    expect(columnsForPerformancePreset('delivery', 'adset')).toEqual(['spend', 'impressions', 'clicks', 'ctr', 'cpm'])
    expect(columnsForPerformancePreset('funnel', 'ad')).toEqual(['link_clicks', 'landing_page_views', 'bookings', 'cpa'])
    expect(columnsForPerformancePreset('creative', 'ad')).toEqual([
      'spend', 'hook_rate', 'retention_p25_rate', 'retention_p50_rate', 'completion_rate', 'thruplay_rate',
    ])
    expect(PERFORMANCE_PRESETS.flatMap((preset) => preset.columns)).not.toContain('roas')
  })

  it('keeps selected dates and preset explicit in every drilldown URL', () => {
    expect(buildPerformanceDrilldownHref('/performance/campaigns', 'delivery', {
      from: '2026-08-01',
      to: '2026-08-20',
    })).toBe('/performance/campaigns?from=2026-08-01&to=2026-08-20&preset=delivery')
  })

  it('maps the retired Return query to Results while rejecting unknown preset keys', () => {
    expect(performancePresetFromSearch('?preset=funnel&from=2026-08-01')).toBe('funnel')
    expect(performancePresetFromSearch('?preset=return&from=2026-08-01')).toBe('results')
    expect(performancePresetFromSearch('?preset=made-up')).toBeNull()
    expect(performancePresetFromSearch('')).toBeNull()
  })

  it('canonicalizes a retired Return query when preserving a legacy route', () => {
    expect(buildPreservedPerformanceRedirect('/performance/campaigns', {
      from: '2026-08-01',
      to: '2026-08-20',
      preset: 'return',
      campaign: 'meta-campaign-1',
    })).toBe('/performance/campaigns?from=2026-08-01&to=2026-08-20&preset=results&campaign=meta-campaign-1')
  })
})
