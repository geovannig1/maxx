import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewCreativeScatter } from '@/components/reporting/OverviewCreativeScatter'
import { overviewScatter } from '@/lib/reporting/overview-scatter'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import type { ReportEntity, ReportMetric, ReportingData } from '@/lib/reporting/contracts'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'

const appointment = OVERVIEW_EVENTS.appointment_confirmed
const purchase = OVERVIEW_EVENTS.purchase
const changeAd = (data: ReportingData, id: string, edit: (entity: ReportEntity) => ReportEntity): ReportingData => ({
  ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => entity.id === id ? edit(entity) : entity) } },
})
const changeMetric = (data: ReportingData, key: string, edit: (metric: ReportMetric) => ReportMetric) =>
  changeAd(data, '302', entity => ({ ...entity, metrics: { ...entity.metrics, [key]: edit(entity.metrics[key]) } }))

it('plots native halfway / starts against selected CPA and keeps all supplied ads discoverable', () => {
  const view = overviewScatter(creativeReportingFixture(), appointment)
  expect(view.total).toBe(8)
  expect(view.rows).toHaveLength(8)
  expect(view.plotted.map(row => row.entity.id)).toEqual(['303', '302'])
  expect(view.plotted.find(row => row.entity.id === '302')).toMatchObject({ halfway: 40, halfwayCount: 200, starts: 500, spend: 10, results: 1, cpa: 10, value: 100, roas: 10 })
  expect(view.rows.find(row => row.entity.id === '304')).toMatchObject({ halfway: null, lane: 'attention' })
  expect(view.rows.find(row => row.entity.id === '301')).toMatchObject({ halfway: 70, results: 0, cpa: null, spend: 60, roas: 0, lane: 'cpa' })
  expect(view.rows.find(row => row.entity.id === '308')).toMatchObject({ results: null, cpa: null, roas: null })
})

it('uses bubble area, not radius, for spend and omits zero-size ads from numeric bubbles', () => {
  const view = overviewScatter(creativeReportingFixture(), appointment)
  const small = view.plotted.find(row => row.entity.id === '302')!
  const large = view.plotted.find(row => row.entity.id === '303')!
  expect(large.radius ** 2 / small.radius ** 2).toBeCloseTo(2.5)
  const zero = changeMetric(creativeReportingFixture(), 'spend', metric => ({ ...metric, current: { ...metric.current, value: 0 } }))
  expect(overviewScatter(zero, appointment).plotted.map(row => row.entity.id)).not.toContain('302')
})

it('does not assign numeric attention to an image even if video metrics were copied onto it', () => {
  const data = changeAd(creativeReportingFixture(), '302', entity => ({ ...entity, creative: { ...entity.creative!, format: 'image', durationSeconds: null } }))
  const row = overviewScatter(data, appointment).rows.find(row => row.entity.id === '302')!
  expect(row).toMatchObject({ halfway: null, cpa: 10, lane: 'attention' })
})

it.each(['account', 'range', 'observation', 'no_observation'] as const)('does not reuse supplied coordinates under a different %s context', conflict => {
  const base = creativeReportingFixture()
  const data = { ...base, context: { ...base.context,
    account: conflict === 'account' ? { ...base.context.account, metaAccountId: 'act_wrong' } : base.context.account,
    range: conflict === 'range' ? { from: '2026-08-02', to: '2026-08-04' } : base.context.range },
    meta: { ...base.meta, asOf: conflict === 'observation' ? '2026-09-05T18:00:00Z' : conflict === 'no_observation' ? null : base.meta.asOf } }
  const view = overviewScatter(data, appointment)
  expect(view.plotted).toEqual([])
  expect(view.rows).toHaveLength(8)
})

it('uses Meta observation time when another source advances the overall as-of time', () => {
  const base = creativeReportingFixture()
  expect(overviewScatter({ ...base, context: { ...base.context, asOf: '2026-09-06T17:00:00Z' } }, appointment).plotted).toHaveLength(2)
})

it.each(['coverage', 'partial', 'stale', 'entity', 'time', 'window', 'unit', 'event', 'lineage', 'arithmetic'] as const)
  ('withholds an invalid %s CPA while preserving the affected ad in a categorical lane', conflict => {
    const data = changeMetric(creativeReportingFixture(), 'cost_per_booking', metric => ({ ...metric,
      event: conflict === 'event' ? 'Purchase' : metric.event,
      current: { ...metric.current,
        coverage: conflict === 'coverage' ? { state: 'partial', numerator: 1, denominator: 2 } : metric.current.coverage,
        maturity: conflict === 'partial' ? { state: 'partial', matureThrough: null } : metric.current.maturity,
        freshness: conflict === 'stale' ? { ...metric.current.freshness, state: 'stale' } : metric.current.freshness,
        entity: conflict === 'entity' ? { level: 'ad', id: 'foreign-ad' } : metric.current.entity,
        asOf: conflict === 'time' ? '2026-09-05T18:00:00Z' : metric.current.asOf,
        window: conflict === 'window' ? { ...metric.current.window, basis: 'booking_created_date_et' } : metric.current.window,
        unit: conflict === 'unit' ? 'count' : metric.current.unit,
        inputClaimIds: conflict === 'lineage' ? ['foreign-spend', 'foreign-result'] : metric.current.inputClaimIds,
        value: conflict === 'arithmetic' ? 100 : metric.current.value,
      },
    }))
    const view = overviewScatter(data, appointment)
    expect(view.plotted.map(row => row.entity.id)).toEqual(['303'])
    expect(view.rows.find(row => row.entity.id === '302')).toMatchObject({ cpa: null, lane: 'cpa' })
    expect(view.rows).toHaveLength(8)
  })

it('rejects incomplete halfway inputs without moving the ad to zero attention', () => {
  const data = changeMetric(creativeReportingFixture(), 'video_plays', metric => ({ ...metric,
    current: { ...metric.current, coverage: { state: 'partial', numerator: 1, denominator: 2 } },
  }))
  expect(overviewScatter(data, appointment).rows.find(row => row.entity.id === '302')).toMatchObject({ halfway: null, lane: 'attention' })
})

it('does not resurrect CPA from an observed zero denominator even when a numeric cost was supplied', () => {
  const data = changeAd(creativeReportingFixture(), '301', entity => ({ ...entity, metrics: { ...entity.metrics,
    cost_per_booking: { ...entity.metrics.cost_per_booking, current: { ...entity.metrics.cost_per_booking.current,
      value: 0, availability: { state: 'available', blockerCodes: [] }, coverage: { state: 'complete', numerator: 1, denominator: 1 } } },
  } }))
  expect(overviewScatter(data, appointment).rows.find(row => row.entity.id === '301')).toMatchObject({ results: 0, cpa: null, lane: 'cpa' })
})

it('switches exact event counts, costs, value and ROAS without reusing AppointmentConfirmed', () => {
  const base = creativeReportingFixture()
  const data = changeAd(base, '302', entity => {
    const alternate = buildMetaMetrics(base.context, { spend: '10', actions: [{ action_type: 'purchase', value: '2' }],
      action_values: [{ action_type: 'purchase', value: '60' }] }, undefined, { level: 'ad', id: entity.id })
    return { ...entity, metrics: { ...entity.metrics, ...Object.fromEntries([purchase.count, purchase.cpa, purchase.value, purchase.roas].map(key => [key, alternate[key]])) } }
  })
  expect(overviewScatter(data, appointment).rows.find(row => row.entity.id === '302')).toMatchObject({ results: 1, cpa: 10, value: 100, roas: 10 })
  expect(overviewScatter(data, purchase).rows.find(row => row.entity.id === '302')).toMatchObject({ results: 2, cpa: 5, value: 60, roas: 6 })
  expect(overviewScatter(data, purchase, 'retargeting').rows.map(row => row.entity.id)).toEqual(['302'])
  expect(overviewScatter(data, purchase, 'known-false-match').rows).toEqual([])
})

it('provides readable axes, exact identity/value buttons, raw sample counts and separate unplotted lanes', () => {
  const html = renderToStaticMarkup(<OverviewCreativeScatter data={creativeReportingFixture()} event={appointment} onInspect={() => {}} />)
  expect(html).toContain('Halfway-view rate')
  expect(html).toContain('AppointmentConfirmed CPA')
  expect(html).toContain('lower is better')
  expect(html).toContain('data-scatter-point="302"')
  expect(html).not.toContain('data-scatter-point="304"')
  expect(html).not.toContain('data-scatter-point="301"')
  expect(html).toContain('data-scatter-lane="attention"')
  expect(html).toContain('data-scatter-lane="cpa"')
  expect(html).toContain('0 results')
  expect(html).toContain('$60.00 spend')
  expect(html).toContain('60 s video')
  expect(html).toContain('Synthetic studio audience')
  expect(html).toContain('data-scatter-values="303"')
  expect(html).toContain('200 halfway views / 2,000 starts')
  expect(html).toContain('2026-09-02')
  expect(html).toContain('America/New_York')
  expect(html.match(/data-scatter-ad=/g)).toHaveLength(8)
  expect(html).not.toMatch(/winner|scale this|cut this|hook rate/i)
})

it('keeps the highest-CPA bubble clear of the bottom axis while retaining exact observed cost', () => {
  const html = renderToStaticMarkup(<OverviewCreativeScatter data={creativeReportingFixture()} event={appointment} onInspect={() => {}} />)
  const point = html.match(/data-scatter-point="303"[\s\S]*?<circle[^>]+cy="([^"]+)"[^>]+r="([^"]+)"/)!
  expect(Number(point[1]) + Number(point[2])).toBeLessThan(292)
  expect(html).toContain('$25.00 CPA')
})

it('keeps zero-result and very large finite costs out of invalid SVG coordinates', () => {
  const base = creativeReportingFixture()
  const zero = renderToStaticMarkup(<OverviewCreativeScatter data={base} event={appointment} search="301" onInspect={() => {}} />)
  expect(zero).toContain('CPA undefined')
  expect(zero).not.toContain('data-scatter-point=')
  const data = changeAd(base, '303', entity => ({ ...entity, metrics: { ...entity.metrics,
    spend: { ...entity.metrics.spend, current: { ...entity.metrics.spend.current, value: 1e308 } },
    cost_per_booking: { ...entity.metrics.cost_per_booking, current: { ...entity.metrics.cost_per_booking.current, value: 1e308 } },
  } }))
  const large = renderToStaticMarkup(<OverviewCreativeScatter data={data} event={appointment} onInspect={() => {}} />)
  expect(large).toContain('data-scatter-point="303"')
  expect(large).not.toMatch(/(?:cx|cy|r)="(?:NaN|Infinity|-Infinity)"/)
})

it('shows observation time in Eastern Time while retaining the precise source timestamp', () => {
  const data = creativeReportingFixture()
  const html = renderToStaticMarkup(<OverviewCreativeScatter data={data} event={appointment} onInspect={() => {}} />)
  expect(html).toContain(`<time dateTime="${data.meta.asOf}" title="${data.meta.asOf}">Sep 5, 2026, 1:00 PM EDT</time>`)
})

it('labels the CPA axis with the account currency, never a fixed USD', () => {
  vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'EUR')
  try {
    const html = renderToStaticMarkup(<OverviewCreativeScatter data={creativeReportingFixture()} event={appointment} onInspect={() => {}} />)
    expect(html).toContain('CPA (EUR)')
    expect(html).not.toContain('(USD)')
  } finally { vi.unstubAllEnvs() }
})
