import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildPerformanceDrilldownHref,
  buildPreservedPerformanceRedirect,
} from '@/lib/performance/presets'

describe('performance drilldown navigation', () => {
  it('carries the selected dates, decision lens, and entity filter to child details', () => {
    expect(buildPerformanceDrilldownHref(
      '/performance/ads',
      'creative',
      { from: '2026-08-01', to: '2026-08-20' },
      { ad: 'ad 123' },
    )).toBe('/performance/ads?from=2026-08-01&to=2026-08-20&preset=creative&ad=ad+123')
  })

  it('preserves compatible performance query parameters through legacy redirects', () => {
    expect(buildPreservedPerformanceRedirect('/performance/ads', {
      range: '1m', from: '2026-08-01', to: '2026-08-20', preset: 'funnel', adset: 'adset-1', ignored: 'nope',
    })).toBe('/performance/ads?range=1m&from=2026-08-01&to=2026-08-20&preset=funnel&adset=adset-1')
  })

  it('guards overview state against an older date request and exposes a creative-to-ad-details link', () => {
    const overview = readFileSync('src/components/performance/PerformanceOverview.tsx', 'utf8')
    const scorecard = readFileSync('src/components/performance/PerformanceScorecard.tsx', 'utf8')
    const creative = readFileSync('src/components/performance/CreativePerformance.tsx', 'utf8')
    const ads = readFileSync('src/app/(dashboard)/performance/ads/page.tsx', 'utf8')

    expect(overview).toContain('requestIdRef')
    expect(overview).toContain('requestId === requestIdRef.current')
    expect(creative).toContain('View ad details')
    expect(creative).toContain('buildPerformanceDrilldownHref')
    expect(ads).toContain("const requestedAdId = searchParams.get('ad')")
    expect(scorecard).toContain('min-h-11')
    expect(scorecard).toContain('cursor-pointer focus-visible:outline-none focus-visible:ring-2')
  })
})
