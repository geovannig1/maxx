import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { executiveFixture } from './reporting-browser/executive-fixture'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard' }))

describe('approved Reference dashboard composition', () => {
  it('leads with the interpretation while retaining every executive investigation module', () => {
    const html = renderToStaticMarkup(<OverviewReport data={executiveFixture()} />)
    expect(html.indexOf('aria-label="Executive interpretation"')).toBeGreaterThan(-1)
    expect(html.indexOf('aria-label="Executive interpretation"')).toBeLessThan(html.indexOf('aria-label="Business results"'))
    for (const label of ['Business results', 'Advertising results', 'Creative comparison', 'Campaigns and ad sets',
      'Audience and delivery', 'Booking economics &amp; outlook', 'Customer history', 'Recorded upcoming demand', 'After the click']) {
      expect(html).toContain(label)
    }
  })
  it('offers an explicitly secondary attention view and keeps watch, engagement, clicks and ROAS in the default table', () => {
    const html = renderToStaticMarkup(<OverviewReport data={executiveFixture()} />)
    expect(html).toContain('aria-label="Creative view"')
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Table<\/button>/)
    expect(html).toContain('Attention × CPA')
    for (const label of ['Average watch', 'Engagement / impression', 'Outbound clicks', 'ROAS']) expect(html).toContain(label)
    expect(html.match(/<tr[^>]*aria-label="Creative \d+ comparison"/g)).toHaveLength(10)
  })
  it('exposes native account delivery without summing reach or frequency from ad sets', () => {
    const data = executiveFixture()
    const html = renderToStaticMarkup(<OverviewReport data={data} />)
    expect(html).toContain('aria-label="Account delivery"')
    expect(html).toContain('Native account totals')
    for (const label of ['Impressions', 'Reach', 'Frequency', 'CPM']) expect(html).toContain(label)
  })
})
