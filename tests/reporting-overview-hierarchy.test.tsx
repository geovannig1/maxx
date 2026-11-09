import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OverviewHierarchy } from '@/components/reporting/OverviewHierarchy'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { hierarchyHasNoResults } from '@/lib/reporting/overview-hierarchy'
import type { ReportingData } from '@/lib/reporting/contracts'
import { executiveFixture } from './reporting-browser/executive-fixture'
import { audienceReportingFixture } from './reporting-browser/audience-fixture'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => '/dashboard' }))
const render = (data = executiveFixture(), event = OVERVIEW_EVENTS.appointment_confirmed as typeof OVERVIEW_EVENTS[keyof typeof OVERVIEW_EVENTS]) =>
  renderToStaticMarkup(<OverviewHierarchy data={data} event={event} savedId="saved-example" />)
const rows = (html: string) => [...html.matchAll(/data-hierarchy-row="([^"]+)"/g)].map(match => match[1])
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://maxx.test'))
const rowHtml = (html: string, id: string) => html.split(`data-hierarchy-row="${id}"`)[1]?.split('</article>')[0] ?? ''
const metric = (html: string, key: string) => html.split(`data-hierarchy-metric="${key}"`)[1]?.split('</dd>')[0] ?? ''
beforeEach(() => { navigation.search = '' })

describe('dashboard campaign and ad-set comparison', () => {
  it.each([OVERVIEW_EVENTS.appointment_confirmed, OVERVIEW_EVENTS.purchase])('binds account-level $label zero counts to the selected account', event => {
    const data = executiveFixture()
    const entity = (id: string) => ({ id, level: 'account' as const, metrics: buildMetaMetrics(data.context, {
      actions: [{ action_type: 'purchase', value: '0' }],
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [{ value: '0', attribution_windows: ['default'] }] }],
    }, null, { level: 'account', id }) })
    const selected = entity(data.context.account.id)
    expect(hierarchyHasNoResults(data, selected, event)).toBe(true)
    expect(hierarchyHasNoResults(data, entity('different-account'), event)).toBe(false)
    expect(hierarchyHasNoResults(data, { ...selected, id: 'different-account' }, event)).toBe(false)
  })

  it('renders the complete 12-ad-set comparison without pagination and preserves lower-ranked drills', () => {
    const data = executiveFixture()
    const template = data.meta.data!.entities.find(entity => entity.id === 'set-9')!
    data.meta.data = { ...data.meta.data!, entities: [...data.meta.data!.entities,
      { ...template, id: 'set-11', name: 'Set 11' }, { ...template, id: 'set-12', name: 'Set 12' }] }
    const html = render(data)
    expect(rows(html)).toHaveLength(12)
    expect(rows(html)).toEqual(expect.arrayContaining(['set-1', 'set-7', 'set-11', 'set-12']))
    expect(html).toContain('12 ad sets')
    expect(html).not.toContain('overview_hierarchy_page')
    expect(html).not.toContain('>Next<')
    const detail = links(html).find(link => link.pathname === '/performance' && link.searchParams.get('adset') === 'set-7')!
    expect(Object.fromEntries(detail.searchParams)).toMatchObject({ account: 'fixture-db', from: '2026-09-02', to: '2026-09-04',
      saved: 'saved-example', adset: 'set-7', campaign: 'campaign-2', level: 'adset', view: 'detail' })
  })

  it('keeps a larger dynamic ad-set population fully reachable and searchable', () => {
    const data = executiveFixture()
    const template = data.meta.data!.entities.find(entity => entity.id === 'set-9')!
    const additions = Array.from({ length: 15 }, (_, index) => ({
      ...template, id: `dynamic-${index + 1}`, name: `Dynamic ${index + 1}`,
    }))
    data.meta.data = { ...data.meta.data!, entities: [...data.meta.data!.entities, ...additions] }
    expect(rows(render(data))).toHaveLength(25)
    navigation.search = 'overview_q=dynamic-15'
    expect(rows(render(data))).toEqual(['dynamic-15'])
  })

  it('keeps campaign and ad-set comparisons separate and normalizes spend bars within the selected level', () => {
    expect(render()).toContain('Spend, highest first')
    expect(rowHtml(render(), 'set-1')).toContain('data-spend-percent="100"')
    navigation.search = 'overview_level=campaign'
    const html = render()
    expect(rows(html)).toEqual(['campaign-1', 'campaign-2', 'campaign-3'])
    expect(html).toContain('3 campaigns')
    expect(rowHtml(html, 'campaign-1')).toContain('data-spend-percent="100"')
    expect(rowHtml(html, 'campaign-1')).toContain('$1,900.00')
    expect(rows(html).some(id => id.startsWith('set-') || id.startsWith('ad-'))).toBe(false)
  })

  it('searches the full population by name or ID without changing the observed spend-bar scale', () => {
    navigation.search = 'overview_q=set-7'
    const html = render()
    expect(rows(html)).toEqual(['set-7'])
    expect(rowHtml(html, 'set-7')).toMatch(/data-spend-percent="6\.6/)
    navigation.search = 'overview_q=no-matching-entity'
    expect(rows(render())).toEqual([])
    expect(render()).toContain('No ad sets match this search')
  })

  it('distinguishes explicit zero selected-event results from missing inputs', () => {
    const html = render()
    expect(rowHtml(html, 'set-7')).toContain('Spend with 0 Meta AppointmentConfirmed events')
    expect(metric(rowHtml(html, 'set-7'), 'bookings')).toContain('>0')
    expect(metric(rowHtml(html, 'set-7'), 'cost_per_booking')).toContain('— · No results')
    expect(metric(rowHtml(html, 'set-7'), 'appointment_roas')).toContain('0.00×')
    expect(metric(rowHtml(html, 'set-10'), 'bookings')).toContain('Unavailable')
    expect(rowHtml(html, 'set-10')).not.toContain('Spend with 0')
    expect(rowHtml(html, 'set-9')).not.toContain('Spend with 0')
    expect(metric(rowHtml(html, 'set-9'), 'cost_per_booking')).toContain('— · No results')
    expect(metric(rowHtml(html, 'set-9'), 'appointment_roas')).toContain('Unavailable')
  })

  it.each(['event', 'period', 'entity', 'source', 'coverage', 'unavailable'] as const)('does not label incompatible %s count evidence as no results', invalid => {
    const base = executiveFixture()
    const data: ReportingData = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity => {
      if (entity.id !== 'set-7') return entity
      const metric = entity.metrics.bookings, claim = metric.current
      return { ...entity, metrics: { ...entity.metrics, bookings: { ...metric,
        event: invalid === 'event' ? 'Purchase' : metric.event,
        current: { ...claim,
          ...(invalid === 'period' ? { window: { ...claim.window, end: '2026-09-03' } } : {}),
          ...(invalid === 'entity' ? { entity: { ...claim.entity, id: 'set-8' } } : {}),
          ...(invalid === 'source' ? { source: { ...claim.source, role: 'measurement_qa' as const } } : {}),
          ...(invalid === 'coverage' ? { coverage: { ...claim.coverage, state: 'partial' as const } } : {}),
          ...(invalid === 'unavailable' ? { availability: { state: 'unavailable' as const, blockerCodes: ['not_supplied'] } } : {}),
        },
      } } }
    }) } } }
    const html = rowHtml(render(data), 'set-7')
    expect(metric(html, 'cost_per_booking')).toContain('Unavailable')
    expect(html).not.toContain('No results')
  })

  it.each(['adset', 'campaign'] as const)('keeps zero Purchase CPA and ROAS distinct from nonzero AppointmentConfirmed at %s level', level => {
    const base = executiveFixture(), id = level === 'adset' ? 'set-7' : 'campaign-2'
    const metrics = buildMetaMetrics(base.context, { spend: '60',
      actions: [{ action_type: 'purchase', value: '0' }], action_values: [{ action_type: 'purchase', value: '0' }],
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [{ value: '2', attribution_windows: ['default'] }] }],
      conversion_values: [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '200' }],
    }, null, { level, id })
    const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity =>
      entity.id !== id ? entity : { ...entity, metrics }) } } }
    navigation.search = `overview_level=${level}`
    const purchase = rowHtml(render(data, OVERVIEW_EVENTS.purchase), id)
    expect(metric(purchase, 'cost_per_purchase')).toContain('— · No results')
    expect(metric(purchase, 'purchase_roas')).toContain('0.00×')
    const appointment = rowHtml(render(data), id)
    expect(metric(appointment, 'cost_per_booking')).toContain('$30.00')
    expect(metric(appointment, 'appointment_roas')).toContain('3.33×')
    expect(appointment).not.toContain('No results')
  })

  it.each(['spend', 'appointment_value'] as const)('keeps known no results while independently missing %s prevents ROAS', missingKey => {
    const base = executiveFixture()
    const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity =>
      entity.id !== 'set-7' ? entity : { ...entity, metrics: { ...entity.metrics, [missingKey]: { ...entity.metrics[missingKey], current: {
        ...entity.metrics[missingKey].current, value: null, availability: { state: 'unavailable' as const, blockerCodes: ['not_supplied'] },
      } } } }) } } }
    const html = rowHtml(render(data), 'set-7')
    expect(metric(html, 'cost_per_booking')).toContain('— · No results')
    expect(metric(html, 'appointment_roas')).toContain('Unavailable')
    if (missingKey === 'spend') expect(html).not.toContain('Spend with 0')
  })

  it('preserves exact-scope withheld CPA and ROAS even when the selected count is zero', () => {
    const base = executiveFixture()
    const data: ReportingData = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity =>
      entity.id !== 'set-7' ? entity : { ...entity, metrics: { ...entity.metrics,
        ...Object.fromEntries(['cost_per_booking', 'appointment_roas'].map(key => [key, { ...entity.metrics[key], current: {
          ...entity.metrics[key].current, value: null,
          availability: { state: 'unavailable' as const, blockerCodes: ['meta_outcome_hierarchy_unreconciled'] },
        } }])),
      } }) } } }
    const html = rowHtml(render(data), 'set-7')
    expect(metric(html, 'cost_per_booking')).toContain('Withheld')
    expect(metric(html, 'appointment_roas')).toContain('Withheld')
    expect(html).toContain('Why CPA is withheld')
    expect(html).toContain('AppointmentConfirmed CPA is withheld for ad set set-7 during 2026-09-02 – 2026-09-04')
    expect(html).toContain('because its outcome hierarchy could not be reconciled')
    expect(html).toContain('This reported CPA cannot support a cost-per-result comparison for this period.')
    expect(html).toContain('This reported ROAS cannot support an efficiency ranking for this period.')
    expect(html).not.toContain('campaign totals disagree')
    expect(html).not.toContain('No results')
    expect(metric(rowHtml(render(base), 'set-10'), 'cost_per_booking')).toContain('Unavailable')
    const entity = data.meta.data!.entities.find(entity => entity.id === 'set-7')!
    const wrongPeriod = { ...data, context: { ...data.context, range: { ...data.context.range, to: '2026-09-03' } } }
    expect(rowHtml(render(wrongPeriod), entity.id)).not.toContain('Withheld')
  })

  it('shows count, CPA, value and ROAS only for the selected named event', () => {
    const html = rowHtml(render(executiveFixture(), OVERVIEW_EVENTS.purchase), 'set-1')
    expect(metric(html, 'purchase_count')).toContain('>1')
    expect(metric(html, 'cost_per_purchase')).toContain('$900.00')
    expect(metric(html, 'purchase_value')).toContain('$100.00')
    expect(metric(html, 'purchase_roas')).toContain('0.11×')
    expect(html).not.toContain('AppointmentConfirmed')
    expect(html).not.toContain('$1,000.00')
  })

  it('rejects wrong-event, wrong-period and wrong-entity values instead of displaying numeric aliases', () => {
    const data = executiveFixture()
    data.meta.data = { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => entity.id !== 'set-1' ? entity : {
      ...entity, metrics: { ...entity.metrics,
        purchase_count: { ...entity.metrics.purchase_count, event: 'AppointmentConfirmed' },
        purchase_value: { ...entity.metrics.purchase_value, current: { ...entity.metrics.purchase_value.current, entity: { level: 'adset', id: 'set-2' } } },
        spend: { ...entity.metrics.spend, current: { ...entity.metrics.spend.current, window: { ...entity.metrics.spend.current.window, end: '2026-09-03' } } },
      },
    }) }
    navigation.search = 'overview_q=set-1'
    const html = rowHtml(render(data, OVERVIEW_EVENTS.purchase), 'set-1')
    for (const key of ['spend', 'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas']) expect(metric(html, key)).toContain('Unavailable')
  })

  it('sorts unavailable spend last while preserving measured zero and avoiding an unavailable bar', () => {
    const data = executiveFixture()
    data.meta.data = { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => entity.id !== 'set-1' ? entity : {
      ...entity, metrics: { ...entity.metrics, spend: { ...entity.metrics.spend, current: { ...entity.metrics.spend.current,
        value: null, availability: { state: 'unavailable', blockerCodes: ['not_supplied'] } } } },
    }) }
    const html = render(data)
    expect(rows(html).slice(-5)).toEqual(['set-7', 'set-8', 'set-10', 'set-9', 'set-1'])
    expect(metric(rowHtml(html, 'set-9'), 'spend')).toContain('$0.00')
    expect(rowHtml(html, 'set-1')).not.toContain('data-spend-percent')
  })

  it('surfaces the lower-spend audience failure with exact native evidence and a saved audience destination', () => {
    const data = audienceReportingFixture(), html = render(data)
    expect(rows(html)).toContain('set-7')
    expect(html).toContain('Audience and delivery')
    expect(html).toContain('Lower-spend exception')
    expect(html).toContain('failed-exclusion')
    expect(html).toContain('433')
    const audience = links(html).find(link => link.hash === '#audience-adset-set-7')!
    expect(Object.fromEntries(audience.searchParams)).toMatchObject({ account: 'fixture-db', from: '2026-09-02', to: '2026-09-04', report: 'audience', saved: 'saved-example' })
    navigation.search = 'overview_q=set-7'
    const member = render(data)
    expect(member).toContain('Could not create lookalike')
    expect(member).toContain('Operation status')
    expect(member).toContain('Delivery status')
    expect(member).toContain('Approximate size')
    expect(member).toContain('Period frequency')
    expect(member).toContain('Current configuration')
    expect(member).toContain('observed 2026-09-05')
    expect(member).not.toMatch(/100% exhausted|20 members|is suppressing nobody/)
  })

  it('keeps actual supplied audience and delivery observations with entity and observation time', () => {
    const base = executiveFixture()
    const data: ReportingData = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, observations: [{
      id: 'native-delivery-7', kind: 'delivery', title: 'Ad set delivery failed', detail: 'Meta returned status WITH_ISSUES for this ad set.',
      entityId: 'set-7', observedAt: '2026-09-05T17:00:00Z',
    }] } } }
    const html = render(data)
    expect(html).toContain('Ad set delivery failed')
    expect(html).toContain('Meta returned status WITH_ISSUES for this ad set.')
    expect(html).toContain('observed 2026-09-05T17:00:00Z')
    expect(links(html).some(link => link.searchParams.get('adset') === 'set-7')).toBe(true)
  })

  it('does not promote unbound audience codes or absent Meta data into evidence', () => {
    const base = audienceReportingFixture()
    const data: ReportingData = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity => ({
      ...entity, audienceEvidence: entity.audienceEvidence && { ...entity.audienceEvidence, accountId: 'another-account' },
    })) } } }
    expect(render(data)).not.toContain('433')
    expect(render(data)).toContain('Audience operation and size evidence unavailable')
    expect(render({ ...data, meta: { state: 'unavailable', data: null, asOf: null, notes: [] } })).toContain('Meta campaign and ad-set evidence unavailable')
  })
})
