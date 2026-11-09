import { describe, expect, it } from 'vitest'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { overviewMerBins, overviewTrendBins } from '@/lib/reporting/overview-trends'
import { DEMO_ACCOUNT, demoCalendar, demoPacket, demoReportingData } from '../scripts/demo/sample/demo-account'
import { DEMO_ADS } from '../scripts/demo/sample/demo-delivery'

// The `npm run demo` account (README screenshots come from it): every section must pass the same
// validation the browser applies, its totals must reconcile across levels and days, and its daily
// series must be complete so the overview charts and daily MER render instead of "unavailable".

const calendar = demoCalendar(new Date('2026-11-08T15:00:00Z'))

describe('demo sample account', () => {
  it('anchors the default range to the 28 complete days ending yesterday in the account timezone', () => {
    expect(calendar).toEqual({ today: '2026-11-08', asOf: '2026-11-08T13:00:00Z', range: { from: '2026-10-11', to: '2026-11-07' } })
    // 02:00Z on Nov 9 is still Nov 8 in New York
    expect(demoCalendar(new Date('2026-11-09T02:00:00Z')).today).toBe('2026-11-08')
  })

  it.each(['meta', 'business', 'website', 'measurement'])('validates the %s packet for the default and a custom range', (section) => {
    expect(() => validateReportingPacket(demoPacket(section, calendar.range, calendar))).not.toThrow()
    expect(() => validateReportingPacket(demoPacket(section, { from: '2026-10-25', to: '2026-10-31' }, calendar))).not.toThrow()
  })

  it('reconciles spend across ads, ad sets, campaigns, the account and its days', () => {
    const meta = demoReportingData(calendar.range, calendar).meta.data!
    const spend = meta.metrics.spend.current.value as number
    expect(spend).toBeGreaterThan(500)
    for (const level of ['campaign', 'adset', 'ad'] as const) {
      const sum = meta.entities.filter((e) => e.level === level).reduce((total, e) => total + (e.metrics.spend.current.value as number), 0)
      expect(sum, level).toBeCloseTo(spend, 2)
    }
    expect(meta.series).toHaveLength(28)
    expect(meta.series.reduce((total, point) => total + (point.metrics.spend.current.value as number), 0)).toBeCloseTo(spend, 2)
    expect(meta.entities.filter((e) => e.level === 'ad')).toHaveLength(DEMO_ADS.length)
  })

  it('fills every overview chart day and the daily MER', () => {
    const data = demoReportingData(calendar.range, calendar)
    const meta = overviewTrendBins(data.context, data.meta.data!.series, data.meta.data!.comparisonSeries, 'meta')
    const business = overviewTrendBins(data.context, data.business.data!.series, data.business.data!.comparisonSeries, 'business')
    expect(meta.every((bin) => bin.current.value !== null && bin.prior.value !== null)).toBe(true)
    expect(business.every((bin) => bin.current.value !== null)).toBe(true)
    const mer = overviewMerBins(business, meta)
    expect(mer.every((bin) => bin.state === 'available')).toBe(true)
    const booked = data.business.data!.metrics.booked_value.current.value as number
    const spend = data.meta.data!.metrics.spend.current.value as number
    // a plausible small studio: several outcomes a week, returns a few times its ad spend
    expect(booked / spend).toBeGreaterThan(2)
    expect(booked / spend).toBeLessThan(8)
  })

  it('shows the same figures for the default range whatever day the demo starts', () => {
    const later = demoCalendar(new Date('2027-03-02T15:00:00Z'))
    const a = demoReportingData(calendar.range, calendar), b = demoReportingData(later.range, later)
    expect(b.meta.data!.metrics.spend.current.value).toBe(a.meta.data!.metrics.spend.current.value)
    expect(b.business.data!.metrics.booked_value.current.value).toBe(a.business.data!.metrics.booked_value.current.value)
  })

  it('is obviously fictional', () => {
    const data = demoReportingData(calendar.range, calendar)
    expect(data.context.account).toEqual(DEMO_ACCOUNT)
    expect(data.context.account.name).toContain('sample')
    for (const ad of data.meta.data!.entities.filter((e) => e.level === 'ad')) expect(ad.creative?.destination).toMatch(/^https:\/\/example\.test\//)
  })
})

describe('demo sample creatives', () => {
  it('draws one labelled illustration per sample ad and nothing for an unknown index', async () => {
    const { sampleCreativeSvg } = await import('../scripts/demo/media')
    const svg = sampleCreativeSvg(0)!
    expect(svg).toContain('<svg')
    expect(svg).toContain(DEMO_ADS[0].headline)
    expect(svg).toContain('sample creative')
    expect(svg).not.toMatch(/<script|href=/i)
    expect(sampleCreativeSvg(DEMO_ADS.length)).toBeNull()
  })
})
