import './_support/outcome-noun-booking'
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewCreative } from '@/components/reporting/OverviewCreative'
import { OverviewCreativeDetails } from '@/components/reporting/OverviewCreativeDetails'
import { overviewCreativeFocus, overviewCreativePage, overviewCreativeRows } from '@/lib/reporting/overview-creative'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import { executiveFixture } from './reporting-browser/executive-fixture'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'

const appointment = OVERVIEW_EVENTS.appointment_confirmed
const purchase = OVERVIEW_EVENTS.purchase

it('keeps empty creative inventory loading while Meta totals have arrived before details', () => {
  const data = executiveFixture()
  const pending = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: [], detailState: 'loading' as const } } }
  const html = renderToStaticMarkup(<OverviewCreative data={pending} event={appointment} />)
  expect(html).toContain('Creative evidence is loading.')
  expect(html).not.toContain('No ad executions were supplied')
})

it('searches all ten supplied ads before paging and retains lower-spend results', () => {
  const data = executiveFixture()
  const first = overviewCreativePage(data, appointment)
  expect(first.total).toBe(10)
  expect(first.rows.map(row => row.id)).toEqual(['ad-1', 'ad-2', 'ad-3', 'ad-4', 'ad-5', 'ad-6', 'ad-7', 'ad-8', 'ad-10', 'ad-9'])
  expect(first.pages).toBe(1)
  const compact = overviewCreativePage(data, appointment, { pageSize: 5 })
  expect(compact.rows.map(row => row.id)).toEqual(['ad-1', 'ad-2', 'ad-3', 'ad-4', 'ad-5'])
  expect(compact.pages).toBe(2)
  expect(overviewCreativePage(data, appointment, { search: 'Creative 8' }).rows.map(row => row.id)).toEqual(['ad-8'])
  expect(overviewCreativePage(data, appointment, { search: 'Audience 7' }).rows.map(row => row.id)).toEqual(['ad-7'])
  expect(overviewCreativePage(data, appointment, { search: 'does not exist' }).rows).toEqual([])
  expect(overviewCreativePage(data, appointment, { page: 20, pageSize: 5 }).page).toBe(2)
})

it('sorts measured zero ahead of unavailable and never substitutes another result event', () => {
  const data = executiveFixture()
  const results = overviewCreativeRows(data, appointment, { sort: 'results' })
  expect(results.at(-1)?.id).toBe('ad-10')
  expect(results.findIndex(row => row.id === 'ad-9')).toBeLessThan(results.findIndex(row => row.id === 'ad-10'))
  expect(overviewCreativeRows(data, appointment, { sort: 'cpa' })[0].id).toBe('ad-8')
  expect(overviewCreativeRows(data, purchase, { sort: 'cpa' })[0].id).toBe('ad-9')
  const html = renderToStaticMarkup(<OverviewCreative data={data} event={purchase} savedId="saved-review" />)
  expect(html).toContain('Purchase')
  expect(html).toContain('$900.00')
  expect(html).toContain('0.11×')
  for (const field of ['count', 'CPA', 'ROAS', 'value']) expect(html).toContain(`aria-label="Purchase ${field}"`)
  expect(html).not.toContain('$225.00')
  expect(html).not.toContain('1.11×')
  expect(html).toContain('saved=saved-review')
})

it('focuses supported result leaders across the whole population without fabricating attention evidence', () => {
  const data = executiveFixture()
  const focus = overviewCreativeFocus(data, appointment)
  expect(focus.mostResults?.id).toBe('ad-1')
  expect(focus.lowestCpa?.id).toBe('ad-8')
  expect(focus.contrast).toBeNull()
  const html = renderToStaticMarkup(<OverviewCreative data={data} event={appointment} />)
  expect(html).toContain('href="#overview-creative-ad-8"')
  expect(html).toContain('10 ads supplied')
  expect(html).toContain('Most results (9/10 eligible)')
  expect(html).toContain('Lowest CPA (7/10 eligible)')
  expect(html).toContain('Most results compares supplied ads with a complete, fresh Meta ad-level AppointmentConfirmed count')
  expect(html).toContain('No minimum conversion count is applied.')
  expect(html).toContain('aria-label="Creative page size"')
  expect(html).toContain('aria-label="Lowest CPA (7/10 eligible): Creative 8"')
  expect(html).toContain('Page 1 of 1')
  expect(html).toContain('aria-label="Search creative"')
  expect(html).not.toContain('data-creative-contrast')
})

it('keeps valid Meta creative evidence when another source advances the shared as-of time', () => {
  const data = creativeReportingFixture()
  const laterSource = { ...data, context: { ...data.context, asOf: '2026-09-06T17:00:00Z' } }
  const focus = overviewCreativeFocus(laterSource, appointment)
  expect(focus.lowestCpa?.id).toBe('302')
  expect(focus.contrast?.higherAttention.id).toBe('301')
  const html = renderToStaticMarkup(<OverviewCreative data={laterSource} event={appointment} />)
  expect(html).toContain('70.0%')
  expect(html).toContain('href="#overview-creative-302"')
})

it.each(['2026-09-05T16:00:00Z', '2026-09-05T18:00:00Z'])('rejects creative observations that do not match Meta source time %s', asOf => {
  const data = creativeReportingFixture()
  const mismatched = { ...data, context: { ...data.context, asOf: '2026-09-06T17:00:00Z' }, meta: { ...data.meta, asOf } }
  const focus = overviewCreativeFocus(mismatched, appointment)
  expect(focus.mostResults).toBeNull()
  expect(focus.lowestCpa).toBeNull()
  expect(focus.contrast).toBeNull()
  const html = renderToStaticMarkup(<OverviewCreative data={mismatched} event={appointment} />)
  expect(html).not.toContain('70.0%')
  expect(html).not.toContain('4.0 s')
})

it('blocks attention-result contrast when attention, result coverage, or population differs', () => {
  const data = creativeReportingFixture()
  const focus = overviewCreativeFocus(data, appointment)
  expect(focus.contrast?.higherAttention.id).toBe('301')
  expect(focus.contrast?.lowerAttention.id).toBe('302')
  const incompatible = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => ({
    ...entity, metrics: { ...entity.metrics, bookings: { ...entity.metrics.bookings,
      current: { ...entity.metrics.bookings.current, coverage: { state: 'unknown' as const, numerator: null, denominator: null } } },
      cost_per_booking: { ...entity.metrics.cost_per_booking,
        current: { ...entity.metrics.cost_per_booking.current, coverage: { state: 'unknown' as const, numerator: null, denominator: null } } } },
  })) } } }
  expect(overviewCreativeFocus(incompatible, appointment).contrast).toBeNull()
  expect(overviewCreativeFocus(incompatible, appointment).lowestCpa).toBeNull()
  const wrongWindow = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => ({
    ...entity, metrics: { ...entity.metrics, retention_p50: { ...entity.metrics.retention_p50,
      current: { ...entity.metrics.retention_p50.current, window: { ...entity.metrics.retention_p50.current.window, start: '2026-08-01' } } } },
  })) } } }
  expect(overviewCreativeFocus(wrongWindow, appointment).contrast).toBeNull()
})

it('does not present a mismatched event identity as the selected result', () => {
  const data = executiveFixture()
  const mismatched = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => ({
    ...entity, metrics: { ...entity.metrics, bookings: { ...entity.metrics.bookings, event: 'Purchase' } },
  })) } } }
  const focus = overviewCreativeFocus(mismatched, appointment)
  expect(focus.mostResults).toBeNull()
  expect(focus.lowestCpa).toBeNull()
  const html = renderToStaticMarkup(<OverviewCreative data={mismatched} event={appointment} />)
  expect(html).toContain('aria-label="AppointmentConfirmed count"')
  expect(html).toMatch(/Unavailable<\/p><p[^>]*>Reported results/)
})

it('shows short and long video attention in native seconds and percentage, with discrete detail points', () => {
  const data = creativeReportingFixture(undefined, undefined, 'https://127.0.0.1:9443')
  const html = renderToStaticMarkup(<OverviewCreative data={data} event={appointment} />)
  expect(html).toContain('70.0%')
  expect(html).toContain('10.0%')
  expect(html).toContain('4.0 s')
  expect(html).toContain('10.0 s')
  expect(html).toContain('8 s video')
  expect(html).toContain('60 s video')
  expect(html).toContain('Outbound CTR')
  expect(html).toContain('Engagement / impression')
  expect(html).toContain('Video metrics not applicable')
  expect(html).toContain('CPA is undefined because there are no selected-event results.')
  expect(html).toContain('No results')
  const short = data.meta.data!.entities.find(entity => entity.id === '301')!
  const details = renderToStaticMarkup(<OverviewCreativeDetails entity={short} context={data.context} event={appointment} />)
  expect(details).toContain('<video')
  expect(details).toContain('original-8.mp4')
  expect(details).toContain('data-retention-value="70"')
  expect(details).not.toContain('<polyline')
  expect(details).toContain('5,000 starts')
  expect(details).toContain('Instagram profile visits')
  expect(details).toContain('Messaging conversations started')
  expect(details).toContain('Call to action was not supplied')
  expect(details).toContain('Reported bookings is measured zero; this metric cannot be calculated.')
})

it('exposes the local missing-metric reason and dynamic preview limitation in details', () => {
  const data = creativeReportingFixture()
  const missing = data.meta.data!.entities.find(entity => entity.id === '308')!
  const html = renderToStaticMarkup(<OverviewCreativeDetails entity={missing} context={data.context} event={appointment} />)
  expect(html).toContain('Unavailable')
  expect(html).toContain('not supplied')
  const short = data.meta.data!.entities.find(entity => entity.id === '301')!
  const dynamic = { ...short, creative: { ...short.creative!, identity: { ...short.creative!.identity!, structure: 'asset_feed' as const } } }
  expect(renderToStaticMarkup(<OverviewCreativeDetails entity={dynamic} context={data.context} event={appointment} />)).toContain('Ad results cover all delivered variants')
})

it('explains withheld creative efficiency without hiding the observed count or value', () => {
  const base = creativeReportingFixture()
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity => entity.id !== '302' ? entity : ({
    ...entity, metrics: { ...entity.metrics, ...Object.fromEntries(['cost_per_booking', 'appointment_roas'].map(key => [key, {
      ...entity.metrics[key], current: { ...entity.metrics[key].current, value: null,
        availability: { state: 'unavailable' as const, blockerCodes: ['meta_outcome_hierarchy_unreconciled'] },
        coverage: { state: 'unknown' as const, numerator: null, denominator: null },
      },
    }])) },
  })) } } }
  const html = renderToStaticMarkup(<OverviewCreative data={data} event={appointment} />)
  expect(html).toContain('Withheld · reconciliation evidence incomplete')
  expect(html).toContain('an exact current-period reconciliation record for this ad’s campaign and selected event was not supplied')
  expect(html).not.toContain('CPA and ROAS are withheld because')
  const row = html.match(/<tr[^>]*id="overview-creative-302"[\s\S]*?<\/tr>/)?.[0] ?? ''
  expect(row).toContain('Reported results')
  expect(row).toContain('$100.00')
  expect(row).toContain('Withheld')
  expect(renderToStaticMarkup(<OverviewCreative data={base} event={appointment} />)).not.toContain('Meta totals disagree')
  for (const missingKey of ['bookings', 'appointment_value']) {
    const missing = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => entity.id !== '302' ? entity : ({
      ...entity, metrics: { ...entity.metrics, [missingKey]: { ...entity.metrics[missingKey], current: {
        ...entity.metrics[missingKey].current, value: null,
        availability: { state: 'unavailable' as const, blockerCodes: ['not_supplied'] },
      } } },
    })) } } }
    const missingHtml = renderToStaticMarkup(<OverviewCreative data={missing} event={appointment} />)
    expect(missingHtml).not.toContain('The reported count and value remain visible as observations.')
    expect(missingHtml).not.toContain('totals disagree')
    expect(missingHtml).toContain('Withheld · reconciliation evidence incomplete')
  }
})
