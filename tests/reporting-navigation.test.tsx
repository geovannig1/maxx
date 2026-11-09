import { describe, expect, it } from 'vitest'
import { ALL_NAV_ITEMS, NAV } from '@/components/layout/nav-config'
import {
  buildGlobalControlsUrl,
  removeGlobalTrafficSourceFromUrl,
  readGlobalControlParams,
  showsGlobalTrafficSource,
  withGlobalControlParams,
} from '@/lib/use-global-controls'

const now = new Date('2026-09-05T16:00:00Z')

describe('reporting navigation', () => {
  it('keeps the four owner reporting destinations primary', () => {
    expect(NAV[0]?.items.map(({ label, href }) => ({ label, href }))).toEqual([
      { label: 'Overview', href: '/dashboard' },
      { label: 'Ads', href: '/performance' },
      { label: 'Creative', href: '/creative' },
      { label: 'Reports', href: '/reports' },
    ])
  })

  it('keeps supporting tools and legacy drill destinations reachable', () => {
    expect(NAV[1]?.title).toBe('SECONDARY')
    expect(NAV[1]?.items.map(item => item.label)).toEqual([
      'Measurement', 'Decisions', 'Activity', 'Experiments',
      'Diagnostics', 'Launch setup', 'Settings', 'Ask Maxx',
    ])
    expect(ALL_NAV_ITEMS.map(item => item.href)).toEqual(expect.arrayContaining([
      '/performance/campaigns', '/performance/adsets', '/performance/ads',
      '/activity/reports', '/activity/change-log', '/activity/learnings',
      '/approvals', '/changes', '/conversions',
    ]))
  })
})

describe('shared reporting controls', () => {
  it('gives a valid custom period priority over a simultaneous preset', () => {
    expect(readGlobalControlParams(
      'range=1m&from=2026-08-01&to=2026-08-20&source=paid',
      now,
    )).toMatchObject({
      range: { preset: 'custom', from: '2026-08-01', to: '2026-08-20' },
      source: 'paid',
      hasDateParams: true,
    })
  })

  it('rejects impossible calendar dates even when they match the date pattern', () => {
    expect(readGlobalControlParams('from=2026-02-30&to=2026-03-02', now)).toMatchObject({
      range: null,
      hasDateParams: true,
    })
  })

  it('resolves each same-path history query independently', () => {
    const first = readGlobalControlParams('range=1w', now)
    const changed = readGlobalControlParams('from=2026-08-01&to=2026-08-20', now)
    const back = readGlobalControlParams('range=1w', now)

    expect(first.range?.preset).toBe('1w')
    expect(changed.range).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-08-20' })
    expect(back.range).toEqual(first.range)
  })

  it('writes exact date state while preserving unrelated page filters', () => {
    expect(buildGlobalControlsUrl({
      pathname: '/performance',
      search: 'status=active&range=1m',
      range: { preset: 'custom', from: '2026-08-01', to: '2026-08-20' },
      source: 'paid',
    })).toBe('/performance?status=active&from=2026-08-01&to=2026-08-20')
  })

  it('carries dates through navigation and removes false source scope from reports', () => {
    const search = 'from=2026-08-01&to=2026-08-20&source=paid&status=active'
    expect(withGlobalControlParams('/reports', search))
      .toBe('/reports?from=2026-08-01&to=2026-08-20')
    expect(withGlobalControlParams('/conversions', search))
      .toBe('/conversions?from=2026-08-01&to=2026-08-20&source=paid')
  })

  it('hides Paid and Organic scope on every prepared reporting destination', () => {
    for (const path of ['/dashboard', '/performance/ads', '/creative', '/reports', '/reports/2026-09-04']) {
      expect(showsGlobalTrafficSource(path)).toBe(false)
    }
    expect(showsGlobalTrafficSource('/conversions')).toBe(true)
  })

  it('removes stale source scope without replacing malformed custom bounds', () => {
    expect(removeGlobalTrafficSourceFromUrl(
      '/reports',
      'from=2026-02-30&to=2026-03-02&source=paid&report=website',
    )).toBe('/reports?from=2026-02-30&to=2026-03-02&report=website')
  })
})
