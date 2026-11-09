import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReportingWorkspace } from '@/components/reporting/ReportingWorkspace'
import { useReportingData } from '@/lib/reporting/use-reporting-data'
import { reportingFixture } from '../scripts/demo/sample/reports'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard', useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/reporting/use-reporting-data', async importOriginal => ({ ...await importOriginal<object>(), useReportingData: vi.fn() }))

function reportState(overrides: Partial<Pick<ReturnType<typeof useReportingData>, 'data' | 'errors' | 'pending' | 'savedId'>> = {}): ReturnType<typeof useReportingData> {
  return { data: reportingFixture(), errors: {}, pending: {}, accessDenied: false, retry: vi.fn(), retryAll: vi.fn(), ready: true,
    notes: [], sources: null, saveReason: null, saved: null, savedId: null, savedError: null, ...overrides }
}
function renderReport(state: ReturnType<typeof useReportingData>) {
  vi.mocked(useReportingData).mockReturnValue(state)
  const html = renderToStaticMarkup(<ReportingWorkspace view="overview" />)
  const summary = html.match(/<details id="reporting-trust"[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]
  expect(summary).toBeDefined()
  return { html, summary: summary!.replace(/<[^>]*>/g, '') }
}

beforeEach(() => { navigation.search = ''; vi.clearAllMocks() })

describe('collapsed Trust source loading and retention', () => {
  it('counts partial sources against all four independent lanes', () => {
    const data = reportingFixture()
    const { html, summary } = renderReport(reportState({ data: { ...data, meta: { ...data.meta, state: 'partial' } } }))
    expect(summary).toContain('2 of 4 sources partial')
    expect(html).toMatch(/<details id="reporting-trust"[^>]*>/)
    expect(html).not.toMatch(/<details id="reporting-trust"[^>]* open=/)
  })

  it('reads as healthy when the only partial source is Tracking, partial by design with no issue', () => {
    const { html, summary } = renderReport(reportState())
    expect(summary).toContain('All 4 sources reporting · Tracking is a lower bound')
    expect(html).toContain('data-sources-healthy="true"')
  })

  it('does not read as healthy when Tracking carries an issue note', () => {
    const data = reportingFixture()
    const { html, summary } = renderReport(reportState({ data: { ...data, measurement: { ...data.measurement!, notes: ['paid_association_read_unavailable'] } } }))
    expect(summary).toContain('1 of 4 sources partial')
    expect(html).not.toContain('data-sources-healthy')
  })

  it.each(['available', 'partial'] as const)('preserves %s Meta data and labels its failed refresh with its original evidence time', state => {
    const data = reportingFixture()
    const retained = { ...data, meta: { ...data.meta, state } }
    const before = JSON.stringify(retained)
    const { html, summary } = renderReport(reportState({ data: retained, errors: { meta: 'Meta refresh request failed.' } }))
    expect(summary).toContain('1 source needs attention')
    expect(summary).toContain('Meta · refresh failed · retained Sep 5, 1:00 PM ET')
    expect(summary).toContain('Outcomes Sep 5 · GA4 Sep 5 · Tracking Sep 5 (partial)')
    expect(summary).not.toMatch(/Meta Sep 5|stale/i)
    expect(html).toContain('aria-label="All-source booked value ÷ Meta spend: 4.17×"')
    expect(html).toContain('$120')
    expect(JSON.stringify(retained)).toBe(before)
  })

  it('keeps a separate Acuity failure unavailable while retaining Meta evidence', () => {
    const data = reportingFixture()
    const { summary } = renderReport(reportState({ data: { ...data,
      business: { state: 'unavailable', data: null, asOf: null, notes: [] } },
    errors: { meta: 'Meta refresh request failed.', business: 'Acuity request failed.' } }))
    expect(summary).toContain('2 sources need attention')
    expect(summary).toContain('Meta · refresh failed · retained Sep 5, 1:00 PM ET')
    expect(summary).toContain('Outcomes unavailable · GA4 Sep 5')
    expect(summary).not.toContain('Outcomes Sep 5')
  })

  it('keeps a pending refresh distinct from a failure and an initial failure distinct from retained evidence', () => {
    const data = reportingFixture()
    const refreshing = renderReport(reportState({ pending: { meta: true } }))
    expect(refreshing.summary).toContain('Updating evidence…')
    expect(refreshing.summary).not.toContain('refresh failed')
    const failed = renderReport(reportState({ data: { ...data, meta: { state: 'unavailable', data: null, asOf: null, notes: [] } },
      errors: { meta: 'Meta request failed.' } }))
    expect(failed.summary).toContain('Meta unavailable')
    expect(failed.summary).not.toContain('retained')
  })

  it('keeps a frozen report on its original evidence and suppresses live refresh controls', () => {
    navigation.search = 'saved=00000000-0000-4000-8000-000000000001'
    const data = reportingFixture()
    const before = JSON.stringify(data)
    const { html, summary } = renderReport(reportState({ data, savedId: '00000000-0000-4000-8000-000000000001' }))
    expect(summary).toContain('Meta Sep 5 · Outcomes Sep 5 · GA4 Sep 5 · Tracking Sep 5 (partial)')
    expect(summary).not.toContain('refresh failed')
    expect(html).toContain('aria-label="Saved report"')
    expect(html).not.toContain('aria-label="Refresh Meta advertising"')
    expect(html).not.toContain('Save this report')
    expect(JSON.stringify(data)).toBe(before)
  })
})
