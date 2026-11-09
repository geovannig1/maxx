import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { byAudience, byConcept, buildTodayRead, type AdRow } from '@/lib/cockpit/audience-performance'

/** A synthetic account's ads with their lifetime totals. */
const ACCOUNT_ADS: AdRow[] = [
  { adName: 'Warm | Daylight Set | May 2026 (7d)', status: 'PAUSED', spend: 812.60, results: 21, clicks: 1426, impressions: 52800 },
  { adName: 'Cold | Loft Tour | May 2026 (7d)', status: 'PAUSED', spend: 462.90, results: 3, clicks: 498, impressions: 27400 },
  { adName: 'gallery-walk-3', status: 'WITH_ISSUES', spend: 143.20, results: 2, clicks: 235, impressions: 9790 },
  { adName: 'Cold | Loft Tour | May 2026 (7d) (ADR-056 tagged)', status: 'ACTIVE', spend: 129.60, results: 0, clicks: 249, impressions: 8590 },
  { adName: 'Warm | Backdrop Wall | April 2026 (7d)', status: 'PAUSED', spend: 196.40, results: 5, clicks: 245, impressions: 12250 },
  { adName: 'promo-cut-b', status: 'PAUSED', spend: 74.85, results: 0, clicks: 19, impressions: 4750 },
  { adName: 'Cold | Mirror Wall | June 2026 (7d) (ADR-056 tagged)', status: 'ACTIVE', spend: 88.15, results: 0, clicks: 73, impressions: 2430 },
  { adName: 'Warm | Daylight Set | May 2026 (7d) (ADR-056 tagged)', status: 'ACTIVE', spend: 57.70, results: 2, clicks: 55, impressions: 1610 },
  { adName: 'teaser-v1', status: 'PAUSED', spend: 31.40, results: 1, clicks: 39, impressions: 1950 },
]

describe('grouping by audience', () => {
  const groups = byAudience(ACCOUNT_ADS)
  const get = (k: string) => groups.find((g) => g.key === k)!

  it('reproduces the audience split', () => {
    expect(get('Warm')).toMatchObject({ ads: 3, spend: 1066.7, results: 28, costPerResult: 38.1 })
    expect(get('Cold')).toMatchObject({ ads: 3, spend: 680.65, results: 3, costPerResult: 226.88 })
    expect(get('Unparsed')).toMatchObject({ ads: 3, spend: 249.45, results: 3, costPerResult: 83.15 })
  })

  it('tracks what is live separately from lifetime', () => {
    expect(get('Warm')).toMatchObject({ liveAds: 1, liveSpend: 57.7, liveResults: 2 })
    expect(get('Cold')).toMatchObject({ liveAds: 2, liveSpend: 217.75, liveResults: 0 })
  })

  it('puts unparsed last and never invents an audience for a legacy name', () => {
    expect(groups.at(-1)!.key).toBe('Unparsed')
    expect(groups.at(-1)!.audience).toBeNull()
  })

  it('leaves cost per result null rather than dividing by zero', () => {
    const none = byAudience([{ adName: 'Cold | X | Y', status: 'ACTIVE', spend: 50, results: 0, clicks: 1, impressions: 100 }])
    expect(none[0].costPerResult).toBeNull()
  })
})

describe('grouping by concept', () => {
  it('splits each audience into its creative concepts', () => {
    const groups = byConcept(ACCOUNT_ADS)
    const find = (k: string) => groups.find((g) => g.key === k)!
    expect(find('Warm | Daylight Set')).toMatchObject({ ads: 2, spend: 870.3, results: 23, costPerResult: 37.84 })
    expect(find('Cold | Loft Tour')).toMatchObject({ ads: 2, spend: 592.5, results: 3, costPerResult: 197.5 })
    expect(find('Warm | Backdrop Wall').linkCtrPct).toBe(2)
  })
})

describe('the read', () => {
  it('leads with live money spent for nothing — the finding that needs no cost model', () => {
    const read = buildTodayRead(byAudience(ACCOUNT_ADS))
    expect(read.kind).toBe('live_spend_no_results')
    expect(read.headline).toContain('Cold has spent $217.75 on live ads with no bookings')
    expect(read.headline).toContain('Warm is at $28.85 per booking')
  })

  // The money-authority guard: compare groups to each other, never to a dollar target.
  it('never states a verdict against a money target', () => {
    const read = buildTodayRead(byAudience(ACCOUNT_ADS))
    const text = [read.headline, ...read.evidence].join(' ')
    expect(text).not.toMatch(/target|budget|scale|cut|pause|kill|should/i)
  })

  it('falls back to a relative comparison when nothing live is burning', () => {
    const settled = ACCOUNT_ADS.map((ad) => ({ ...ad, status: 'PAUSED' }))
    const read = buildTodayRead(byAudience(settled))
    expect(read.kind).toBe('relative_efficiency')
    expect(read.headline).toMatch(/Cold costs 6\.0× what Warm costs per booking/)
    expect(read.headline).toContain('$226.88')
    expect(read.evidence.at(-1)).toMatch(/Same Meta-modelled basis/)
  })

  it('says plainly when nothing has separated instead of manufacturing a finding', () => {
    const thin = byAudience([
      { adName: 'Warm | A | X', status: 'PAUSED', spend: 40, results: 1, clicks: 5, impressions: 900 },
      { adName: 'Cold | B | X', status: 'PAUSED', spend: 30, results: 1, clicks: 4, impressions: 800 },
    ])
    const read = buildTodayRead(thin)
    expect(read.kind).toBe('insufficient')
    expect(read.headline).toMatch(/No group has separated yet/)
    expect(read.headline).not.toMatch(/insufficient data to judge/i)
  })

  it('will not call out a live group that has barely spent', () => {
    const trivial = byAudience([
      { adName: 'Cold | A | X', status: 'ACTIVE', spend: 12, results: 0, clicks: 2, impressions: 400 },
      { adName: 'Warm | B | X', status: 'PAUSED', spend: 900, results: 20, clicks: 90, impressions: 9000 },
    ])
    expect(buildTodayRead(trivial).kind).not.toBe('live_spend_no_results')
  })
})
