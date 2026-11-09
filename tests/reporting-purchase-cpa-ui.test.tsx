import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { AdsReport } from '@/components/reporting/AdsReport'
import { AudienceReport } from '@/components/reporting/AudienceReport'
import { EntityComparison } from '@/components/reporting/EntityComparison'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { META_TREND_KEYS, entityDailyExportRows } from '@/lib/reporting/trend'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { creativeAd, creativeData } from './fixtures/reporting-creative'
import { purchaseCpaFixture } from './fixtures/reporting-purchase-cpa'

const navigation = vi.hoisted(() => ({ search: '', pathname: '/performance' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => navigation.pathname, useRouter: () => ({ push: vi.fn() }) }))
beforeEach(() => { navigation.search = ''; navigation.pathname = '/performance' })
const costLabel = 'Cost per reported Purchase'
const groupData = () => creativeData([
  creativeAd('301', { spend: '100', actions: [{ action_type: 'purchase', value: '5' }] }),
  creativeAd('302', { spend: '50', actions: [{ action_type: 'purchase', value: '10' }] }),
])

describe('named Purchase cost reading paths', () => {
  it('shows account Purchase CPA with its count while Purchase value and ROAS remain unavailable', () => {
    const data = purchaseCpaFixture()
    navigation.search = 'overview_event=purchase'; navigation.pathname = '/dashboard'
    const html = renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
    const advertising = html.match(/<section[^>]*aria-label="Advertising results"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(advertising).toContain('<option value="purchase" selected="">Purchase</option>')
    expect(advertising).toContain('aria-label="Cost / result: $20.00. Definition and source"')
    expect(advertising).toContain('aria-label="Reported results: 50. Definition and source"')
    expect(advertising).toContain('aria-label="Reported ROAS: Unavailable. Definition and source"')
    expect(advertising).toContain('aria-label="Purchase reported value: Unavailable. Definition and source"')
    expect(advertising).toContain('Meta · Attributed')
    expect(data.meta.data!.metrics.purchase_roas.current.value).toBeNull()
    expect(data.meta.data!.metrics.purchase_value.current.value).toBeNull()
  })

  it.each(['campaign', 'adset', 'ad'] as const)('retains %s cost and prior value in results and daily selection', level => {
    const data = purchaseCpaFixture(), entity = data.meta.data!.entities.find(row => row.level === level)!
    const parent = level === 'ad' ? `ad=${entity.id}` : `view=detail&level=${level}&campaign=${entity.campaignId}${level === 'adset' ? `&adset=${entity.id}` : ''}`
    const prefix = level === 'ad' ? 'ad' : 'entity'
    navigation.search = `${parent}&group=results&${prefix}_trend=cost_per_purchase`
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    const results = html.slice(html.indexOf(`id="${level === 'ad' ? 'ad' : 'entity'}-metrics"`))
    expect(results).toContain(costLabel)
    expect(results).toContain(level === 'ad' ? '$20.00' : '$18.75'); expect(results).toContain('$10.00')
    expect(results).toContain('value="cost_per_purchase" selected')
    expect(results).toContain('Unavailable')
    expect(META_TREND_KEYS).toContain('cost_per_purchase')
    const rows = entityDailyExportRows(entity, data.context).filter(row => row.metric === costLabel)
    expect(rows).toHaveLength(6)
    expect(rows.map(row => row.value)).toEqual(level === 'ad' ? [10, 15, null, 10, 10, 10] : [9.375, 14.0625, null, 10, 10, 10])
    expect(rows.every(row => row.event === 'Purchase')).toBe(true)
  })

  it('compares cost with volume in the response preset, including a lower-cost, lower-volume case', () => {
    const data = purchaseCpaFixture(), entities = data.meta.data!.entities.filter(row => row.level === 'ad').slice(0, 2)
    const html = renderToStaticMarkup(<EntityComparison entities={entities} context={data.context} group="response" />)
    const row = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].find(match => match[0].includes(costLabel))?.[0]
    expect(row).toBeDefined(); expect(row).toContain('$20.00'); expect(row).toContain('$5.00')
    expect(html).toContain('Reported purchases'); expect(html).toContain('Reported purchase value')
  })

  it('preserves the named cost and exact inputs in full results, creative and audience exports', () => {
    const data = purchaseCpaFixture()
    for (const preset of ['results', 'creative', 'audience'] as const) {
      const rows = collectReportExportRows(data, preset).filter(row => row.metric === costLabel)
      expect(rows.length, preset).toBeGreaterThan(0)
      expect(rows.some(row => row.value === (preset === 'audience' ? 18.75 : 20) && row.previous_value === 10), preset).toBe(true)
      expect(rows.every(row => row.event === 'Purchase' && row.source === 'meta')).toBe(true)
      const exact = data.meta.data!.entities.find(entity => entity.level === (preset === 'creative' ? 'ad' : 'adset'))!.metrics.cost_per_purchase.current
      expect(rows.find(row => row.claim_id === exact.claimId)?.input_claim_ids).toBe(JSON.stringify(exact.inputClaimIds))
    }
    expect(renderToStaticMarkup(<AudienceReport data={data} />)).toContain(costLabel)
  })

  it('keeps weighted creative-group CPA distinct from the average ad CPA', () => {
    const result = buildCreativeGroups(groupData()).groups[0].metrics.cost_per_purchase
    expect(result).toBeDefined()
    expect(result.current.value).toBe(10)
    expect(result.current.value).not.toBe(12.5)
    expect(result.event).toBe('Purchase')
  })

  it('includes zero-Purchase spend in group CPA while honoring a withheld source ratio', () => {
    const source = creativeData([
      creativeAd('301', { spend: '100', actions: [{ action_type: 'purchase', value: '5' }] }),
      creativeAd('302', { spend: '50', actions: [{ action_type: 'purchase', value: '0' }] }),
    ])
    expect(source.meta.data!.entities[1].metrics.cost_per_purchase.current.value).toBeNull()
    expect(buildCreativeGroups(source).groups[0].metrics.cost_per_purchase.current.value).toBe(30)
    const changed = { ...source, meta: { ...source.meta, data: { ...source.meta.data!,
      entities: source.meta.data!.entities.map(entity => {
        if (entity.id !== '302') return entity
        const metric = entity.metrics.cost_per_purchase
        return { ...entity, metrics: { ...entity.metrics, cost_per_purchase: { ...metric,
          current: { ...metric.current, value: null, availability: { state: 'unavailable' as const,
            blockerCodes: ['meta_outcome_hierarchy_unreconciled'] }, coverage: { state: 'unknown' as const, numerator: null, denominator: null } } } } }
      }) } } }
    expect(buildCreativeGroups(changed).groups[0].metrics.cost_per_purchase.current)
      .toMatchObject({ value: null, unavailableReason: 'source_ratio_withheld' })
  })

  it('does not reconstruct newly introduced CPA for an older saved creative group missing that metric', () => {
    const original = groupData(), data = { ...original, meta: { ...original.meta, data: { ...original.meta.data!,
      entities: original.meta.data!.entities.map(entity => ({ ...entity,
        metrics: Object.fromEntries(Object.entries(entity.metrics).filter(([key]) => key !== 'cost_per_purchase')) })) } } }
    const before = JSON.stringify(data)
    const result = buildCreativeGroups(data).groups[0].metrics.cost_per_purchase
    expect(result).toBeDefined()
    expect(result.current).toMatchObject({ value: null, unavailableReason: 'missing_source_ratio' })
    expect(JSON.stringify(data)).toBe(before)
  })

  it('uses a valid packet and leaves zero and missing Purchase counts distinguishable', () => {
    const data = purchaseCpaFixture()
    expect(() => validateReportingPacket({ section: 'meta', context: data.context, notes: [], result: data.meta })).not.toThrow()
    expect(data.meta.data!.metrics.cost_per_purchase.current.value).toBe(20)
    for (const level of ['campaign', 'adset'] as const) {
      const parents = data.meta.data!.entities.filter(entity => entity.level === level)
      expect(parents.map(entity => entity.metrics.cost_per_purchase.current.value)).toEqual([18.75, 25])
    }
    const zero = data.meta.data!.entities.find(row => row.id === '303')!, missing = data.meta.data!.entities.find(row => row.id === '304')!
    expect(zero.metrics.purchase_count.current.value).toBe(0)
    expect(missing.metrics.purchase_count.current.value).toBeNull()
    for (const entity of [zero, missing]) expect(entity.metrics.cost_per_purchase.current.value).toBeNull()
  })
})
