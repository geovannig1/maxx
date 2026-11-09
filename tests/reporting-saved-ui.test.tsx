import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SavedReportProvider, savedReportHref } from '@/components/reporting/SavedReportContext'
import { CustomerResultSummary } from '@/components/reporting/CustomerResultSummary'
import { deriveExpertReview } from '@/lib/reporting/review'
import type { OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { customerReportingFixture } from './reporting-browser/customer-fixture'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/reports' }))
describe('saved evidence presentation', () => {
  it('keeps the original assessment instead of deriving a new customer conclusion', () => {
    const data = customerReportingFixture(), review = deriveExpertReview(data)
    const original = 'Original customer assessment retained from the saved review.'
    const saved = { data, review: { ...review, findings: review.findings.map(finding => finding.id === 'business_customers'
      ? { ...finding, observation: { ...finding.observation, text: original } } : finding) } } as OpenSavedReportingReportReply
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><CustomerResultSummary data={data} /></SavedReportProvider>)
    expect(html).toContain(original)
    const live = renderToStaticMarkup(<CustomerResultSummary data={data} />)
    expect(live).not.toContain(original)
    expect(live).toContain('First observed in retained history')
  })
  it('does not invent an assessment absent from the original saved review', () => {
    const data = customerReportingFixture()
    const saved = { data, review: { ...deriveExpertReview(data), findings: [] } } as unknown as OpenSavedReportingReportReply
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><CustomerResultSummary data={data} /></SavedReportProvider>)
    expect(html).toContain('This assessment was not included in the saved report.')
    expect(html).not.toContain('First observed in retained history')
  })
  it('preserves exact report identity through supported investigations, including the target section', () => {
    expect(savedReportHref('/reports?report=business#business-customers', 'saved-a')).toBe('/reports?report=business&saved=saved-a#business-customers')
    expect(savedReportHref('/creative?ad=ad-2&saved=old', 'saved-a')).toBe('/creative?ad=ad-2&saved=saved-a')
    expect(savedReportHref('/settings', 'saved-a')).toBe('/settings')
    expect(savedReportHref('/reports?report=business', null)).toBe('/reports?report=business')
  })
})
