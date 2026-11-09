import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { OverviewPerformance } from '@/components/reporting/OverviewPerformance'
import { ExpertReviewPanel } from '@/components/reporting/ExpertReviewPanel'
import { Topbar } from '@/components/layout/Topbar'
import { Sidebar } from '@/components/layout/Sidebar'
import { deriveExpertReview } from '@/lib/reporting/review'
import type { OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { customerReportingFixture } from './reporting-browser/customer-fixture'
import { executiveFixture } from './reporting-browser/executive-fixture'

const navigation = vi.hoisted(() => ({ search: '', path: '/dashboard' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => navigation.path,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))

const savedId = '00000000-0000-4000-8000-000000001401'
const data = customerReportingFixture(), review = deriveExpertReview(data)
const saved = { saved: { id: savedId }, data, review } as OpenSavedReportingReportReply
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'))
beforeEach(() => { navigation.search = ''; navigation.path = '/dashboard' })

describe('saved report investigation links', () => {
  it.each(['adset', 'campaign'])('carries the provider saved ID through overview %s destinations without requiring a query copy', level => {
    const evidence = executiveFixture(), before = JSON.stringify(evidence)
    navigation.search = level === 'adset' ? 'overview_compare=set-1,set-2' : 'overview_level=campaign'
    const html = renderToStaticMarkup(<SavedReportProvider value={{ ...saved, data: evidence }}><OverviewPerformance data={evidence} /></SavedReportProvider>)
    const advertising = hrefs(html).filter(href => href.startsWith('/performance'))
    expect(advertising.length).toBeGreaterThan(3)
    expect(advertising.some(href => {
      const params = new URL(href, 'https://maxx.invalid').searchParams
      return params.get('level') === level && params.get('view') === 'detail' && params.has(level)
    })).toBe(true)
    if (level === 'adset') expect(advertising.some(href => href.includes('view=compare'))).toBe(true)
    for (const href of advertising) {
      const url = new URL(href, 'https://maxx.invalid')
      expect(url.searchParams.get('saved')).toBe(savedId)
      expect(url.searchParams.get('from')).toBe(data.context.range.from)
      expect(url.searchParams.get('to')).toBe(data.context.range.to)
    }
    expect(JSON.stringify(evidence)).toBe(before)
    expect(hrefs(renderToStaticMarkup(<OverviewPerformance data={data} />)).every(href => !href.includes('saved='))).toBe(true)
  })
  it('projects stored assessment drill and full-review links while leaving the original review immutable', () => {
    navigation.search = 'saved=wrong-report&from=2030-01-01&to=2030-01-02'
    const before = JSON.stringify(review)
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><ExpertReviewPanel review={review} /></SavedReportProvider>)
    const links = hrefs(html).filter(href => /^\/(reports|performance|creative|dashboard)\?/.test(href))
    expect(links.length).toBeGreaterThan(1)
    expect(links.every(href => new URL(href, 'https://maxx.invalid').searchParams.get('saved') === savedId)).toBe(true)
    expect(links.some(href => href.endsWith('#full-assessments'))).toBe(true)
    expect(JSON.stringify(review)).toBe(before)
  })
  it('keeps all four report destinations reachable in the real sidebar and leaves supporting tools outside saved mode', () => {
    navigation.search = `saved=${savedId}&from=2026-09-02&to=2026-09-04`
    const links = hrefs(renderToStaticMarkup(<Sidebar />)).map(href => new URL(href, 'https://maxx.invalid'))
    for (const pathname of ['/dashboard', '/performance', '/creative', '/reports']) {
      expect(links.some(url => url.pathname === pathname && url.searchParams.get('saved') === savedId)).toBe(true)
    }
    expect(links.some(url => url.pathname === '/settings' && !url.searchParams.has('saved'))).toBe(true)
  })
})

describe('saved reporting chrome', () => {
  it.each(['/dashboard', '/performance', '/creative', '/reports'])('freezes sync/date chrome on %s even before saved data loads', path => {
    navigation.path = path; navigation.search = `saved=${savedId}&from=broken&to=wrong`
    const html = renderToStaticMarkup(<Topbar />)
    expect(html).toContain('Saved report')
    expect(html).toContain('Dates and data are fixed')
    expect(html).not.toContain('Checking sync')
    expect(html).not.toContain('>Sync</button>')
    expect(html).not.toContain('Command palette (⌘K)')
    expect(html).not.toContain('broken')
  })
  it('does not freeze ordinary current or unsupported routes', () => {
    expect(renderToStaticMarkup(<Topbar />)).toContain('Open reporting Trust summary')
    expect(renderToStaticMarkup(<Topbar />)).toContain('Command palette (⌘K)')
    navigation.path = '/settings'; navigation.search = `saved=${savedId}`
    expect(renderToStaticMarkup(<Topbar />)).toContain('Checking sync')
  })
})
