import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AudienceAndDelivery, OverviewHierarchy } from '@/components/reporting/OverviewHierarchy'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import { executiveFixture } from './reporting-browser/executive-fixture'
import { audienceReportingFixture } from './reporting-browser/audience-fixture'

it('keeps every comparison metric visible before the configuration disclosure', () => {
  const data = executiveFixture()
  const html = renderToStaticMarkup(<OverviewHierarchy data={data} event={OVERVIEW_EVENTS.appointment_confirmed} showAudience={false} />)
  const row = html.split('data-hierarchy-row="set-1"')[1]?.split('</article>')[0] ?? ''
  const disclosure = row.indexOf('<details')
  expect(disclosure).toBeGreaterThan(0)
  for (const key of ['spend', 'bookings', 'cost_per_booking', 'appointment_value', 'appointment_roas']) {
    const position = row.indexOf(`data-hierarchy-metric="${key}"`)
    expect(position).toBeGreaterThan(0)
    expect(position).toBeLessThan(disclosure)
  }
  expect(row).toMatch(/<summary[^>]*>Configuration &amp; audience<\/summary>/)
  expect(row.slice(disclosure)).toContain('Current configuration · as of')
  expect(row.slice(disclosure)).toContain('Period frequency')
  expect(html).not.toContain('aria-label="Audience and delivery"')
})

it('retains the exact reporting period and source observation behind the compact context label', () => {
  const data = executiveFixture()
  const html = renderToStaticMarkup(<OverviewHierarchy data={data} event={OVERVIEW_EVENTS.purchase} showAudience={false} />)
  const context = html.match(/<details[^>]*aria-label="Comparison reporting context"[^>]*>([\s\S]*?)<\/details>/)?.[1] ?? ''
  expect(context).toContain(`${data.context.range.from}–${data.context.range.to}`)
  expect(context).toContain(data.context.timezone)
  expect(context).toContain('impression date')
  expect(context).toContain(`Meta as of ${data.meta.asOf}`)
  expect(html).toContain('Meta Purchase')
})

it('states shared outcome maturity once while retaining the claim evidence', () => {
  const data = executiveFixture()
  const html = renderToStaticMarkup(<OverviewHierarchy data={data} event={OVERVIEW_EVENTS.appointment_confirmed} showAudience={false} />)
  expect(html).toContain('Period &amp; source · Settling')
  expect(html.match(/Settling/g)).toHaveLength(1)
  expect(data.meta.data!.entities.find(entity => entity.id === 'set-1')!.metrics.bookings.current.maturity.state).toBe('settling')

  const base = executiveFixture()
  const mixed = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity => entity.id !== 'set-1' ? entity : {
    ...entity, metrics: { ...entity.metrics, bookings: { ...entity.metrics.bookings,
      current: { ...entity.metrics.bookings.current, maturity: { state: 'settled' as const, matureThrough: base.context.range.to } },
    } },
  }) } } }
  const mixedHtml = renderToStaticMarkup(<OverviewHierarchy data={mixed} event={OVERVIEW_EVENTS.appointment_confirmed} showAudience={false} />)
  expect(mixedHtml).not.toContain('Period &amp; source · Settling')
  expect((mixedHtml.match(/Settling/g) ?? []).length).toBeGreaterThan(1)
})

it('shows three affected ad sets in validated spend order and keeps all affected entities and native evidence available', () => {
  const data = audienceReportingFixture()
  const html = renderToStaticMarkup(<AudienceAndDelivery data={data} compact />)
  const visible = html.split('aria-label="All affected ad sets"')[0]
  expect([...visible.matchAll(/data-audience-concern="([^"]+)"/g)].map(match => match[1])).toEqual(['set-3', 'set-6', 'set-7'])
  expect(html).toContain('Show all 4 affected ad sets')
  expect(html).toContain('data-audience-concern="set-8"')
  expect(html).toContain('excluded Lookalike exclusion (failed-exclusion): operation 433, delivery 200')
  expect(html).toContain(`observed ${data.context.asOf}`)
  const invalidSpend = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: data.meta.data!.entities.map(entity =>
    entity.id !== 'set-3' ? entity : { ...entity, metrics: { ...entity.metrics, spend: { ...entity.metrics.spend,
      current: { ...entity.metrics.spend.current, window: { ...entity.metrics.spend.current.window, end: '2026-08-01' } },
    } } }) } } }
  const reordered = renderToStaticMarkup(<AudienceAndDelivery data={invalidSpend} compact />).split('aria-label="All affected ad sets"')[0]
  expect([...reordered.matchAll(/data-audience-concern="([^"]+)"/g)].map(match => match[1])).toEqual(['set-6', 'set-7', 'set-8'])
})
