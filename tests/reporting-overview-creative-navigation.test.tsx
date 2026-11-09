import { beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewCreative } from '@/components/reporting/OverviewCreative'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import { overviewCreativeSelectionHref } from '@/lib/reporting/overview-creative'
import { executiveFixture } from './reporting-browser/executive-fixture'

const navigation = vi.hoisted(() => ({ query: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }))
beforeEach(() => { navigation.query = '' })
const rows = (html: string) => [...html.matchAll(/<tr id="overview-creative-([^"]+)"/g)].map(match => match[1])
const render = () => renderToStaticMarkup(<OverviewCreative data={executiveFixture()} event={OVERVIEW_EVENTS.appointment_confirmed} />)

it('restores a creative page from the dashboard URL while keeping all supplied ads accessible', () => {
  navigation.query = 'overview_creative_page=2&overview_creative_size=5'
  expect(rows(render())).toEqual(['ad-6', 'ad-7', 'ad-8', 'ad-10', 'ad-9'])
})
it('uses the 25-row executive scan by default', () => {
  expect(rows(render())).toEqual(['ad-1', 'ad-2', 'ad-3', 'ad-4', 'ad-5', 'ad-6', 'ad-7', 'ad-8', 'ad-10', 'ad-9'])
})
it('restores a supplied-ad search independently of the hierarchy query', () => {
  navigation.query = 'overview_creative_q=Creative+8&overview_q=unrelated+adset'
  expect(rows(render())).toEqual(['ad-8'])
})
it('restores the selected creative ordering', () => {
  navigation.query = 'overview_creative_sort=cpa'
  expect(rows(render())[0]).toBe('ad-8')
})
it('keeps safe defaults for an invalid page or unsupported sort', () => {
  navigation.query = 'overview_creative_sort=quality_score&overview_creative_page=-3'
  expect(rows(render())).toEqual(['ad-1', 'ad-2', 'ad-3', 'ad-4', 'ad-5', 'ad-6', 'ad-7', 'ad-8', 'ad-10', 'ad-9'])
})

it('changes creative paging without losing date, event, saved-report, or Back history context', () => {
  const href = overviewCreativeSelectionHref(
    '/dashboard?from=2026-09-02&to=2026-09-04&overview_event=purchase&saved=saved-review&overview_creative_page=2#creative',
    { overview_creative_size: '5', overview_creative_page: null },
  )
  expect(href).toBe('/dashboard?from=2026-09-02&to=2026-09-04&overview_event=purchase&saved=saved-review&overview_creative_size=5#creative')
  expect(overviewCreativeSelectionHref(href, { overview_creative_page: '2' })).toContain('saved=saved-review')
})
