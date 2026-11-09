import { describe, expect, it } from 'vitest'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { deriveAdvertisingReview } from '@/lib/reporting/review/advertising'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { snapshotContext as context } from './fixtures/reporting-snapshot'

function entity(id: string, spend: number | null, total: number, click: number | null, view: number | null,
  level: ReportEntity['level'] = 'ad'): ReportEntity {
  const values = [{ value: String(total), attribution_windows: ['default'] },
    ...(click === null ? [] : [{ value: String(click), attribution_windows: ['7d_click'] }]),
    ...(view === null ? [] : [{ value: String(view), attribution_windows: ['1d_view'] }])]
  return { id, level, name: `Creative ${id}`, campaignId: 'campaign', campaignName: 'Campaign', adsetId: 'set', adsetName: 'Set',
    status: 'ACTIVE', configurationAsOf: context.asOf, audience: 'unknown', audienceLabel: 'Unknown', creative: null,
    metrics: buildMetaMetrics(context, { spend: spend === null ? undefined : String(spend), impressions: '10000',
      results: [{ indicator: 'actions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values }] }, undefined, { level, id }),
  }
}
function fixture(entities: ReportEntity[]): ReportingData {
  const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
  const meta = { state: 'available' as const, asOf: context.asOf, notes: [], data: { metrics: {}, entities,
    series: [], comparisonSeries: [], breakdowns: [], observations: [], attributionWindow: 'Native entity settings',
    reportingTime: 'Impression date', sourceDescription: 'Fictional native Meta input' } }
  validateReportingPacket({ section: 'meta', context, result: meta, notes: [] })
  return structuredClone({ context, meta, website: unavailable, business: unavailable })
}
const summary = (data: ReportingData) => deriveAdvertisingReview(data).find(value => value.id === 'advertising.attribution')!
const details = (data: ReportingData) => deriveAdvertisingReview(data).filter(value => value.id.startsWith('advertising.attribution:'))

describe('full native attribution-composition population', () => {
  it('proactively finds the lower-spend reversal beyond an agreeing highest-spend pair', () => {
    const data = fixture([entity('largest', 2000, 100, 100, 0), entity('second', 1500, 80, 80, 0),
      entity('lower-a', 400, 12, 2, 10), entity('lower-b', 300, 8, 6, 2)])
    const finding = summary(data)
    expect(finding).toMatchObject({ status: 'mixed', direction: 'mixed', priority: 'investigate', exposure: { value: 700, unit: 'money' } })
    expect(finding.observation.text).toMatch(/lower-a.*12.*lower-b.*8/)
    expect(finding.observation.text).toMatch(/reverse/i)
    expect(finding.observation.text).toContain('4')
    expect(finding.counterEvidence.text).toMatch(/2 compatible members.*no.*reversal/i)
    const rows = details(data)
    expect(rows).toHaveLength(4)
    expect(rows.filter(value => value.direction === 'mixed').map(value => value.entity?.id).sort()).toEqual(['lower-a', 'lower-b'])
    expect(rows.find(value => value.entity?.id === 'largest')!.observation.text).toMatch(/does not justify.*intervention/i)
    for (const value of [finding, ...rows]) verifyFindingReferences(data, value)
    const review = deriveExpertReview(data)
    expect(review.input.rejectedSources).toEqual([])
    expect(overviewFindings(review).some(value => value.id === finding.id)).toBe(true)
    expect(finding.nextInspection.href).toContain('level=ad')
  })

  it('retains every reversal member with linear finding count and deterministic ordering', () => {
    const data = fixture(Array.from({ length: 60 }, (_, index) => entity(`ad-${String(index).padStart(2, '0')}`, index,
      100 + index, 60 - index, 40 + index * 2)))
    const result = deriveAdvertisingReview(data)
    expect(details(data)).toHaveLength(60)
    expect(details(data).every(value => value.direction === 'mixed')).toBe(true)
    expect(result).toHaveLength(62)
    const reversed = fixture([...data.meta.data!.entities].reverse())
    expect(details(reversed).map(value => [value.id, value.observation.text])).toEqual(details(data).map(value => [value.id, value.observation.text]))
  })

  it('retains native adset composition and all other native members without mixing hierarchy exposure', () => {
    const data = fixture([entity('ad-missing', 500, 9, null, null), entity('campaign', 5000, 100, 100, 0, 'campaign'),
      entity('set-a', 1000, 12, 2, 10, 'adset'), entity('set-b', 700, 8, 6, 2, 'adset')])
    expect(summary(data).exposure?.value).toBe(1700)
    expect(summary(data).observation.text).toMatch(/ad.?set/i)
    expect(summary(data).limitations.join(' ')).toMatch(/hierarch.*not summed|not summed.*hierarch/i)
    expect(details(data).map(value => value.entity?.id).sort()).toEqual(['ad-missing', 'campaign', 'set-a', 'set-b'])
    const campaign = details(data).find(value => value.entity?.level === 'campaign')!
    expect(new URL(campaign.nextInspection.href, 'https://maxx.local').searchParams.get('campaign')).toBe('campaign')
  })

  it('surfaces a complete adset reversal when one ad split exists without a compatible ad peer', () => {
    const data = fixture([entity('ad-one-split', 100, 7, 7, 0), entity('ad-no-split', 80, 4, null, null),
      entity('set-a', 1000, 12, 2, 10, 'adset'), entity('set-b', 700, 8, 6, 2, 'adset')])
    const review = deriveExpertReview(data)
    expect(review.input.rejectedSources).toEqual([])
    const finding = review.findings.find(value => value.id === 'advertising.attribution')!
    expect(finding).toMatchObject({ direction: 'mixed', priority: 'investigate', exposure: { value: 1700 } })
    expect(overviewFindings(review)).toContainEqual(finding)
    expect(new URL(finding.nextInspection.href, 'https://maxx.local').searchParams.get('level')).toBe('adset')
    expect(finding.observation.text).toMatch(/2 eligible native ad populations.*0 have a compatible/)
    expect(finding.observation.text).toMatch(/2 eligible native ad-set populations.*2 have a compatible.*2 reversal members/)
    expect(details(data)).toHaveLength(4)
    for (const value of [finding, ...details(data)]) verifyFindingReferences(data, value)
  })

  it('preserves agreeing ad peers and incomplete ads alongside an independent adset reversal', () => {
    const data = fixture([entity('ad-a', 4000, 20, 16, 4), entity('ad-b', 3000, 10, 8, 2),
      entity('ad-missing', 2000, 6, null, null), entity('set-a', 1000, 12, 2, 10, 'adset'), entity('set-b', 700, 8, 6, 2, 'adset')])
    expect(summary(data)).toMatchObject({ direction: 'mixed', exposure: { value: 1700 } })
    expect(summary(data).observation.text).toMatch(/3 eligible native ad populations.*2 have a compatible.*0 reversal members/)
    expect(summary(data).counterEvidence.text).toMatch(/ad: 2 compatible members.*no total-versus-click reversal/)
    expect(details(data)).toHaveLength(5)
    expect(details(data).filter(value => value.direction === 'mixed').map(value => value.entity!.id)).toEqual(['set-a', 'set-b'])
    expect(details(data).find(value => value.entity!.id === 'ad-a')!.observation.text).toMatch(/does not justify.*intervention/)
    expect(details(data).find(value => value.entity!.id === 'ad-missing')!.observation.text).toMatch(/unavailable.*unresolved/)
  })

  it('keeps same native IDs in different hierarchy levels independent', () => {
    const data = fixture([entity('same', 400, 12, 2, 10), entity('peer', 300, 8, 6, 2),
      entity('same', 1000, 10, 8, 2, 'adset'), entity('peer', 800, 5, 3, 2, 'adset')])
    const result = details(data)
    expect(result).toHaveLength(4)
    expect(result.filter(value => value.direction === 'mixed').map(value => value.entity!.level)).toEqual(['ad', 'ad'])
    expect(result.filter(value => value.entity!.level === 'adset').every(value => /does not justify.*intervention/.test(value.observation.text))).toBe(true)
    for (const value of result) {
      expect(value.observation.evidence.every(ref => ref.metric.current.entity.level === value.entity!.level)).toBe(true)
      verifyFindingReferences(data, value)
    }
  })

  it('proactively retains a campaign reversal even when every ad has agreeing usable splits', () => {
    const data = fixture([entity('ad-a', 4000, 20, 16, 4), entity('ad-b', 3000, 10, 8, 2),
      entity('campaign-a', 1000, 12, 2, 10, 'campaign'), entity('campaign-b', 700, 8, 6, 2, 'campaign')])
    expect(summary(data)).toMatchObject({ direction: 'mixed', exposure: { value: 1700 } })
    expect(new URL(summary(data).nextInspection.href, 'https://maxx.local').searchParams.get('level')).toBe('campaign')
    expect(details(data).map(value => value.entity!.id).sort()).toEqual(['ad-a', 'ad-b', 'campaign-a', 'campaign-b'])
    expect(summary(data).observation.text).toMatch(/2 eligible native campaign populations.*2 reversal members/)
  })

  it('retains native account composition when supplied child totals are unavailable', () => {
    const child = { ...entity('unavailable', 50, 1, 1, 0), metrics: buildMetaMetrics(context, { spend: '50' }, undefined, { level: 'ad', id: 'unavailable' }) }
    const data = fixture([child])
    data.meta.data!.metrics = buildMetaMetrics(context, { spend: '100', results: [{
      indicator: 'actions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [
        { value: '4', attribution_windows: ['default'] }, { value: '4', attribution_windows: ['7d_click'] },
        { value: '0', attribution_windows: ['1d_view'] },
      ],
    }] }, undefined, { level: 'account', id: context.account.id })
    validateReportingPacket({ section: 'meta', context, result: data.meta, notes: [] })
    const finding = summary(data)
    expect(finding.exposure?.value).toBe(100)
    expect(finding.observation.text).toMatch(/1 eligible native account.*Meta account: 4 total.*view-attributed 0/)
    expect(finding.observation.text).toMatch(/cross-entity ordering comparison is unavailable/)
    expect(details(data)).toHaveLength(0)
    verifyFindingReferences(data, finding)
  })

  it('retains measured zero and missing-spend members, with missing splits unavailable rather than a remainder', () => {
    const data = fixture([entity('zero', 0, 0, 0, 0), entity('no-spend', null, 4, 4, 0), entity('no-splits', 90, 12, null, null)])
    const result = details(data)
    expect(result).toHaveLength(3)
    expect(result.find(value => value.entity?.id === 'zero')?.exposure?.value).toBe(0)
    expect(result.find(value => value.entity?.id === 'no-spend')?.exposure).toBeNull()
    const missing = result.find(value => value.entity?.id === 'no-splits')!
    expect(missing.observation.text).toMatch(/click-attributed unavailable.*view-attributed unavailable/)
    expect(missing.observation.text).not.toMatch(/view-attributed 12/)
    expect(missing.direction).toBeUndefined()
    expect(summary(data).counterEvidence.text).toMatch(/missing.*unknown.*no remainder/i)
  })

  it.each(['event', 'unit', 'window', 'source', 'attributionScope', 'measurementKind', 'definition', 'formula', 'sourceHead', 'asOf', 'coverage'] as const)(
    'does not compare incompatible %s claims, while retaining other native members', field => {
      const data = fixture([entity('a', 100, 12, 2, 10), entity('b', 90, 8, 6, 2)])
      const bad = data.meta.data!.entities[1].metrics.bookings_click
      if (field === 'event') bad.event = 'Purchase'
      else if (field === 'unit') bad.current.unit = 'money'
      else if (field === 'window') bad.current.window.start = '2026-08-01'
      else if (field === 'source') bad.current.source.system = 'ga4'
      else if (field === 'attributionScope') bad.current.attributionScope = 'none'
      else if (field === 'measurementKind') bad.current.measurementKind = 'measured'
      else if (field === 'definition') bad.current.definitionVersion = 2
      else if (field === 'formula') bad.current.formula = 'A different click attribution definition'
      else if (field === 'sourceHead') bad.current.source.head = 'other-read'
      else if (field === 'asOf') bad.current.asOf = '2026-09-05T16:00:00.000Z'
      else bad.current.coverage = { ...bad.current.coverage, state: 'partial' }
      expect(summary(data).direction).toBeUndefined()
      expect(details(data)).toHaveLength(2)
      expect(details(data).every(value => value.direction === undefined)).toBe(true)
    },
  )

  it('matches every strict inversion in a mixed population while excluding total and click ties', () => {
    const values = [[12, 2], [8, 6], [8, 6], [12, 6], [20, 20], [0, 0], [3, 1], [4, 1]]
    const data = fixture(values.map(([total, click], index) => entity(`member-${index}`, index * 30, total, click, total - click)))
    const expected = values.flatMap(([total, click], index) => values.some(([otherTotal, otherClick]) =>
      (total - otherTotal) * (click - otherClick) < 0) ? [`member-${index}`] : [])
    expect(details(data).filter(value => value.direction === 'mixed').map(value => value.entity!.id)).toEqual(expected)
    for (const value of details(data)) {
      verifyFindingReferences(data, value)
      const url = new URL(value.nextInspection.href, 'https://maxx.local')
      expect(url.searchParams.get('compare')?.split(',') ?? [url.searchParams.get('ad')]).toContain(value.entity!.id)
    }
  })

  it('keeps a valid reversal while withholding spend from a different source read', () => {
    const data = fixture([entity('a', 400, 12, 2, 10), entity('b', 300, 8, 6, 2)])
    data.meta.data!.entities[0].metrics.spend.current.source.head = 'different-native-read'
    expect(summary(data).direction).toBe('mixed')
    expect(summary(data).exposure).toBeNull()
    expect(details(data).find(value => value.entity?.id === 'a')!.exposure).toBeNull()
    expect(details(data).find(value => value.entity?.id === 'b')!.exposure?.value).toBe(300)
  })

  it('compares each matching definition group without ordering across incompatible groups', () => {
    const data = fixture([entity('a', 400, 12, 2, 10), entity('b', 300, 8, 6, 2),
      entity('c', 1000, 50, 1, 49), entity('d', 800, 30, 1, 29)])
    for (const row of data.meta.data!.entities.slice(2)) row.metrics.bookings_click.current.definitionVersion = 2
    expect(details(data).filter(value => value.direction === 'mixed').map(value => value.entity!.id)).toEqual(['a', 'b'])
    expect(summary(data).observation.text).toMatch(/2 definition groups/)
    expect(summary(data).limitations.join(' ')).toMatch(/different definition groups.*not compared/i)
  })

  it('keeps exact definition groups contiguous even when locale collation treats their text as equivalent', () => {
    const data = fixture([entity('a', 400, 12, 2, 10), entity('b', 300, 10, 4, 6),
      entity('c', 200, 8, 6, 2), entity('d', 100, 6, 5, 1)])
    data.meta.data!.entities.forEach((row, index) => {
      row.metrics.bookings_click.current.formula = index % 2 === 0 ? 'Native definition é' : 'Native definition e\u0301'
    })
    expect(details(data).filter(value => value.direction === 'mixed').map(value => value.entity!.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(summary(data).observation.text).toMatch(/2 definition groups/)
  })

  it('keeps favorable compatible ordering descriptive without inventing targets or historical rollout continuity', () => {
    const data = fixture([entity('a', 100, 10, 8, 2), entity('b', 90, 5, 3, 2), entity('tie', 0, 5, 3, 2)])
    const finding = summary(data)
    expect(finding.direction).toBeUndefined()
    expect(finding.observation.text).toMatch(/no.*reversal.*does not justify.*intervention/i)
    expect(finding.limitations.join(' ')).toMatch(/2026.*unverified|unverified.*2026/)
    expect(finding.counterEvidence.text).toMatch(/not.*incremental|not.*independently/i)
    expect(finding.observation.text).not.toMatch(/healthy|trusted|caused|budget increase/i)
  })
})
