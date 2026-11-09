import { beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewCreative } from '@/components/reporting/OverviewCreative'
import { OverviewCreativeDetails } from '@/components/reporting/OverviewCreativeDetails'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'

const navigation = vi.hoisted(() => ({ query: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }))
beforeEach(() => { navigation.query = '' })
const event = OVERVIEW_EVENTS.appointment_confirmed

it.each(['image', 'carousel'] as const)('shows one not-applicable attention state for %s while retaining response and outcomes', format => {
  const base = creativeReportingFixture()
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity =>
    entity.id === '304' ? { ...entity, creative: { ...entity.creative!, format } } : entity) } } }
  const html = renderToStaticMarkup(<OverviewCreative data={data} event={event} />)
  const row = html.match(/<tr[^>]*id="overview-creative-304"[\s\S]*?<\/tr>/)?.[0] ?? ''
  expect(row.match(/Video metrics not applicable/g)).toHaveLength(1)
  expect(row).not.toContain('Not video')
  expect(row).not.toContain('Average watch')
  expect(row).not.toContain('Halfway / starts')
  for (const label of ['Outbound CTR', 'Outbound clicks', 'Engagement / impression', 'Spend', 'AppointmentConfirmed count',
    'AppointmentConfirmed CPA', 'AppointmentConfirmed ROAS', 'AppointmentConfirmed value']) expect(row).toContain(label)
  expect(row).toContain('1.0%')
  expect(row).toContain('$15.00')
  expect(row).toContain('6.67×')
})

it('rounds the preview duration for scanning and retains the exact supplied duration in accessible evidence', () => {
  const base = creativeReportingFixture()
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity =>
    entity.id === '301' ? { ...entity, creative: { ...entity.creative!, durationSeconds: 41.372 } } : entity) } } }
  const html = renderToStaticMarkup(<OverviewCreative data={data} event={event} />)
  expect(html).toContain('aria-label="Preview duration: 41.372 seconds"')
  expect(html).toContain('>41 s video</span>')
  expect(html).not.toContain('>41.372 s video<')
  const entity = data.meta.data!.entities.find(row => row.id === '301')!
  const details = renderToStaticMarkup(<OverviewCreativeDetails entity={entity} context={data.context} event={event} />)
  expect(details).toContain('41.372 seconds')
  expect(entity.creative!.durationSeconds).toBe(41.372)
})

it('keeps a missing duration distinct from a rounded observed duration', () => {
  const base = creativeReportingFixture()
  const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, entities: base.meta.data!.entities.map(entity =>
    entity.id === '301' ? { ...entity, creative: { ...entity.creative!, durationSeconds: null } } : entity) } } }
  const html = renderToStaticMarkup(<OverviewCreative data={data} event={event} />)
  const row = html.match(/<tr[^>]*id="overview-creative-301"[\s\S]*?<\/tr>/)?.[0] ?? ''
  expect(row).toContain('Video · duration unavailable')
  expect(row).not.toContain('Preview duration: 0 seconds')
})

it('keeps active creative filters and population outside the collapsed controls', () => {
  navigation.query = 'overview_creative_q=retargeting&overview_creative_sort=cpa'
  const html = renderToStaticMarkup(<OverviewCreative data={creativeReportingFixture()} event={event} />)
  const active = html.match(/<p[^>]*aria-label="Active creative filters"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''
  expect(active).toContain('retargeting')
  expect(active).toContain('AppointmentConfirmed CPA, lowest first')
  expect(html.indexOf('aria-label="Active creative filters"')).toBeGreaterThan(html.indexOf('</details>'))
  expect(html).toContain('8 ads supplied · 1 match · 1 on this page')
})
