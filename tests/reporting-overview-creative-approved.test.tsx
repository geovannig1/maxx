import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewCreative } from '@/components/reporting/OverviewCreative'
import { OverviewCreativeDetails } from '@/components/reporting/OverviewCreativeDetails'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

const event = OVERVIEW_EVENTS.appointment_confirmed
const row = (html: string, id: string) => html.match(new RegExp(`<tr[^>]*id="overview-creative-${id}"[\\s\\S]*?<\\/tr>`))?.[0] ?? ''

function withBlockedMetric(
  base: ReportingData,
  adId: string,
  keys: string[],
  observationCampaignId?: string,
  issue = 'ad_bookings_unreconciled',
): ReportingData {
  const entities = base.meta.data!.entities.map(entity => entity.id !== adId ? entity : ({
    ...entity,
    metrics: Object.fromEntries(Object.entries(entity.metrics).map(([key, metric]) => [key, !keys.includes(key) ? metric : ({
      ...metric,
      current: {
        ...metric.current,
        value: null,
        availability: { state: 'unavailable' as const, blockerCodes: ['meta_outcome_hierarchy_unreconciled'] },
        coverage: { state: 'unknown' as const, numerator: null, denominator: null },
      },
    })])),
  }))
  const observations = observationCampaignId ? [{
    id: `hierarchy:current:${observationCampaignId}`,
    title: 'Outcome hierarchy needs reconciliation',
    detail: `current campaign ${observationCampaignId} outcome hierarchy could not be reconciled (${issue}).`,
    kind: 'quality' as const,
    entityId: observationCampaignId,
    observedAt: base.meta.asOf,
  }] : []
  return { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities, observations } } }
}

it('scopes each withheld efficiency to the selected event, affected campaign, and selected period', () => {
  const base = creativeReportingFixture()
  const cpaOnly = withBlockedMetric(base, '302', ['cost_per_booking'], '101')
  const cpaRow = row(renderToStaticMarkup(<OverviewCreative data={cpaOnly} event={event} />), '302')
  expect(cpaRow).toContain('Withheld · campaign totals disagree')
  expect(cpaRow).toContain('AppointmentConfirmed CPA is withheld for Synthetic studio campaign during 2026-09-02 – 2026-09-04')
  expect(cpaRow).toContain('because AppointmentConfirmed result counts do not reconcile between the campaign and its lower-level rows')
  expect(cpaRow).toContain('This campaign’s reported CPA cannot support a cost-per-result comparison for this period.')
  expect(cpaRow).not.toContain('reported ROAS cannot support')
  expect(cpaRow).toContain('10.00×')
  expect(cpaRow).not.toContain('ROAS is withheld')

  const roasOnly = withBlockedMetric(base, '302', ['appointment_roas'], '101')
  const roasRow = row(renderToStaticMarkup(<OverviewCreative data={roasOnly} event={event} />), '302')
  expect(roasRow).toContain('aria-label="AppointmentConfirmed CPA"')
  expect(roasRow).toContain('$10.00')
  expect(roasRow).toContain('AppointmentConfirmed ROAS is withheld for Synthetic studio campaign during 2026-09-02 – 2026-09-04')
  expect(roasRow).toContain('This campaign’s reported ROAS cannot support an efficiency ranking for this period.')
  expect(roasRow).not.toContain('reported CPA cannot support')
  expect(roasRow).not.toContain('CPA is withheld')
})

it('uses the selected event’s own supported hierarchy reason', () => {
  const base = creativeReportingFixture()
  const purchase = OVERVIEW_EVENTS.purchase
  const data = withBlockedMetric(base, '302', ['purchase_roas'], '101', 'ad_purchase_value_unreconciled')
  const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={purchase} />), '302')
  expect(creativeRow).toContain('Purchase ROAS is withheld for Synthetic studio campaign during 2026-09-02 – 2026-09-04')
  expect(creativeRow).toContain('because Purchase reported values do not reconcile between the campaign and its lower-level rows')
  expect(creativeRow).not.toContain('AppointmentConfirmed ROAS is withheld')
})

it('does not use a Purchase value-only contradiction to support a blocked Purchase CPA claim', () => {
  const base = creativeReportingFixture()
  const purchase = OVERVIEW_EVENTS.purchase
  const wrongInput = withBlockedMetric(base, '302', ['cost_per_purchase'], '101', 'ad_purchase_value_unreconciled')
  const wrongRow = row(renderToStaticMarkup(<OverviewCreative data={wrongInput} event={purchase} />), '302')
  expect(wrongRow).toContain('Withheld · reconciliation evidence incomplete')
  expect(wrongRow).not.toContain('campaign totals disagree')

  const countConflict = withBlockedMetric(base, '302', ['cost_per_purchase'], '101', 'ad_purchase_count_unreconciled')
  const countRow = row(renderToStaticMarkup(<OverviewCreative data={countConflict} event={purchase} />), '302')
  expect(countRow).toContain('Withheld · campaign totals disagree')
  expect(countRow).toContain('because Purchase result counts do not reconcile')

  const appointmentValueConflict = withBlockedMetric(base, '302', ['cost_per_booking'], '101', 'ad_value_mismatch:2026-09-03')
  const appointmentRow = row(renderToStaticMarkup(<OverviewCreative data={appointmentValueConflict} event={event} />), '302')
  expect(appointmentRow).toContain('Withheld · campaign totals disagree')
  expect(appointmentRow).toContain('because AppointmentConfirmed reported values do not reconcile')
})

it('labels reconciliation evidence incomplete when campaign proof is missing or belongs elsewhere', () => {
  const base = creativeReportingFixture()
  for (const observationCampaign of [undefined, '999']) {
    const data = withBlockedMetric(base, '302', ['cost_per_booking'], observationCampaign)
    const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={event} />), '302')
    expect(creativeRow).toContain('Withheld · reconciliation evidence incomplete')
    expect(creativeRow).not.toContain('totals disagree')
    expect(creativeRow).not.toContain('AppointmentConfirmed totals disagree for Synthetic studio audience')
  }
})

it.each(['campaign_authority_unavailable', 'meta_outcome_payload_invalid'])('treats %s as incomplete campaign evidence, not a supported mismatch', issue => {
  const base = creativeReportingFixture()
  const data = withBlockedMetric(base, '302', ['cost_per_booking'], '101', issue)
  const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={event} />), '302')
  expect(creativeRow).toContain('Withheld · reconciliation evidence incomplete')
  expect(creativeRow).not.toContain('Synthetic studio campaign during')
})

it('does not apply a prior-period hierarchy problem to current efficiency', () => {
  const base = creativeReportingFixture()
  const entities = base.meta.data!.entities.map(entity => entity.id !== '302' ? entity : ({
    ...entity,
    metrics: { ...entity.metrics, cost_per_booking: { ...entity.metrics.cost_per_booking,
      previous: { ...entity.metrics.cost_per_booking.previous!, value: null,
        availability: { state: 'unavailable' as const, blockerCodes: ['meta_outcome_hierarchy_unreconciled'] } } } },
  }))
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities, observations: [{
    id: 'hierarchy:previous:101', title: 'Outcome hierarchy needs reconciliation',
    detail: 'previous campaign 101 outcome hierarchy could not be reconciled.', kind: 'quality' as const,
    entityId: '101', observedAt: base.meta.asOf,
  }] } } }
  const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={event} />), '302')
  expect(creativeRow).toContain('aria-label="AppointmentConfirmed CPA"')
  expect(creativeRow).toContain('$10.00')
  expect(creativeRow).not.toContain('Withheld ·')
})

it('puts the full dynamic-asset warning behind a concise accessible row indicator', () => {
  const base = creativeReportingFixture()
  const entities = base.meta.data!.entities.map(entity => entity.id !== '301' ? entity : ({
    ...entity,
    creative: { ...entity.creative!, identity: { ...entity.creative!.identity!, structure: 'asset_feed' as const } },
  }))
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities } } }
  const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={event} />), '301')
  expect(creativeRow).toContain('aria-label="Dynamic creative preview details"')
  expect(creativeRow).toContain('Dynamic variants')
  expect(creativeRow).toContain('Ad results cover all delivered variants; this preview cannot isolate an individual variant’s results.')
  expect(creativeRow).not.toContain('Multiple or unresolved variants')
})

it('keeps both playable video and contained image assets available for inspection', () => {
  const data = creativeReportingFixture(undefined, undefined, 'https://127.0.0.1:9443')
  const video = data.meta.data!.entities.find(entity => entity.id === '301')!
  const image = data.meta.data!.entities.find(entity => entity.id === '304')!
  const videoDetail = renderToStaticMarkup(<OverviewCreativeDetails entity={video} context={data.context} event={event} />)
  const imageDetail = renderToStaticMarkup(<OverviewCreativeDetails entity={image} context={data.context} event={event} />)
  expect(videoDetail).toContain('<video')
  expect(videoDetail).toContain('original-8.mp4')
  expect(imageDetail).toContain('<img')
  expect(imageDetail).toContain('original.png')
})

it('keeps concise ad-set and audience context plus every required comparison measure in each stacked row', () => {
  const html = renderToStaticMarkup(<OverviewCreative data={creativeReportingFixture()} event={event} />)
  const creativeRow = row(html, '301')
  expect(creativeRow).toContain('Synthetic studio audience')
  expect(creativeRow).toContain('Synthetic audience; classification unavailable')
  for (const label of ['Halfway / starts', 'Average watch', 'Outbound CTR', 'Outbound clicks',
    'Engagement / impression', 'Spend', 'AppointmentConfirmed count', 'AppointmentConfirmed CPA',
    'AppointmentConfirmed ROAS', 'AppointmentConfirmed value']) expect(creativeRow).toContain(label)
  expect(creativeRow).toContain('grid min-w-0 grid-cols-6')
  expect(creativeRow).toContain('lg:table-row')
})

it('explains each focus population with metric-specific keyboard and touch controls', () => {
  const html = renderToStaticMarkup(<OverviewCreative data={creativeReportingFixture()} event={event} />)
  for (const label of ['Most results', 'Lowest CPA', 'Attention vs results']) {
    expect(html).toContain(`aria-label="Eligibility for ${label}"`)
  }
  expect(html).toContain('Most results compares supplied ads with a complete, fresh Meta ad-level AppointmentConfirmed count')
  expect(html).toContain('Lowest CPA additionally requires a positive AppointmentConfirmed count and an available CPA')
  expect(html).toContain('Attention vs results requires comparable halfway-view and AppointmentConfirmed count evidence')
  expect(html).toContain('No minimum conversion count is applied.')
  expect(html).toContain('The displayed count is comparability coverage, not a performance threshold.')
})

it('keeps measured zero, unavailable, and withheld result states distinct', () => {
  const base = creativeReportingFixture()
  const normal = renderToStaticMarkup(<OverviewCreative data={base} event={event} />)
  const zero = row(normal, '307')
  expect(zero).toContain('No results')
  expect(zero).toContain('0.00×')
  const unavailable = row(normal, '308')
  expect(unavailable).toContain('Unavailable')
  expect(unavailable).not.toContain('Withheld ·')

  const withheld = row(renderToStaticMarkup(<OverviewCreative data={withBlockedMetric(base, '302', ['appointment_roas'], '101')} event={event} />), '302')
  expect(withheld).toContain('Withheld · campaign totals disagree')
})

it('keeps CPA withholding visible when a complete observed count is zero', () => {
  const data = withBlockedMetric(creativeReportingFixture(), '307', ['cost_per_booking'], '101')
  const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={event} />), '307')
  expect(creativeRow).toContain('Withheld · campaign totals disagree')
  expect(creativeRow).not.toContain('No results')
  expect(creativeRow).toContain('0.00×')
})

it('does not promise other measures remain available when they independently failed', () => {
  const base = withBlockedMetric(creativeReportingFixture(), '302', ['cost_per_booking', 'appointment_roas'], '101')
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity =>
    entity.id !== '302' ? entity : { ...entity, metrics: { ...entity.metrics,
      ...Object.fromEntries(['spend', 'bookings', 'appointment_value'].map(key => [key, { ...entity.metrics[key], current: {
        ...entity.metrics[key].current, value: null, availability: { state: 'unavailable' as const, blockerCodes: ['not_supplied'] },
      } }])),
    } }) } } }
  const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={event} />), '302')
  expect(creativeRow).toContain('reported CPA cannot support a cost-per-result comparison')
  expect(creativeRow).toContain('reported ROAS cannot support an efficiency ranking')
  expect(creativeRow).not.toMatch(/(?:spend|counts?|Acuity)[^<]*(?:remain|unaffected|available|inspectable)/i)
})

it.each(['period', 'entity', 'source', 'unit'] as const)('does not turn incompatible %s selected count evidence into no results', invalid => {
  const base = creativeReportingFixture()
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity => {
    if (entity.id !== '307') return entity
    const claim = entity.metrics.bookings.current
    return { ...entity, metrics: { ...entity.metrics, bookings: { ...entity.metrics.bookings, current: { ...claim,
      ...(invalid === 'period' ? { window: { ...claim.window, end: '2026-09-03' } } : {}),
      ...(invalid === 'entity' ? { entity: { ...claim.entity, id: '302' } } : {}),
      ...(invalid === 'source' ? { source: { ...claim.source, system: 'ga4' as const } } : {}),
      ...(invalid === 'unit' ? { unit: 'money' as const } : {}),
    } } } }
  }) } } }
  const creativeRow = row(renderToStaticMarkup(<OverviewCreative data={data} event={event} />), '307')
  expect(creativeRow).not.toContain('No results')
})

it('does not hardcode a ten-ad population and clamps 53 ads after search and paging', async () => {
  const { overviewCreativePage } = await import('@/lib/reporting/overview-creative')
  const base = creativeReportingFixture()
  const template = base.meta.data!.entities.find(entity => entity.id === '301')!
  const ads: ReportEntity[] = Array.from({ length: 53 }, (_, index) => ({
    ...template,
    id: `bulk-${index + 1}`,
    name: index === 52 ? 'Unique final creative' : `Repeated creative ${index + 1}`,
    adsetName: index === 52 ? 'Unique audience' : 'Repeated audience',
  }))
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!,
    entities: [...base.meta.data!.entities.filter(entity => entity.level !== 'ad'), ...ads] } } }
  expect(overviewCreativePage(data, event, { pageSize: 25 }).rows).toHaveLength(25)
  expect(overviewCreativePage(data, event, { pageSize: 25 }).pages).toBe(3)
  expect(overviewCreativePage(data, event, { page: 99, pageSize: 25 }).page).toBe(3)
  const filtered = overviewCreativePage(data, event, { search: 'Unique final', page: 3, pageSize: 25 })
  expect(filtered.page).toBe(1)
  expect(filtered.total).toBe(53)
  expect(filtered.rows.map(entity => entity.id)).toEqual(['bulk-53'])
  expect(overviewCreativePage(data, event, { search: 'Repeated audience', pageSize: 25 }).filtered).toBe(52)
})
