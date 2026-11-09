import './_support/outcome-noun-booking'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { OverviewResults } from '@/components/reporting/OverviewResults'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportingData } from '@/lib/reporting/contracts'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { deriveExpertReview } from '@/lib/reporting/review'
import type { OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { platformBooking, platformData, platformMeta } from './fixtures/reporting-business-platform'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => '/dashboard',
}))

beforeEach(() => { navigation.search = '' })
afterEach(() => { vi.unstubAllGlobals() })

const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: ['Source unavailable in this test.'] }
const decode = (html: string) => html.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')
const plain = (html: string) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
const section = (html: string, label: string) => html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?<\\/section>`))?.[0] ?? ''

function booking(id: number, date: string, price: number, durationMinutes: number): BusinessLedgerRow {
  return { ...platformBooking(id, price, price), booking_date_et: date, appointment_duration: String(durationMinutes) }
}

function recordedScenario(): ReportingData {
  const current = [
    booking(1, '2026-09-02', 145, 90),
    booking(2, '2026-09-03', 265, 150),
    booking(3, '2026-09-03', 320, 180),
    booking(4, '2026-09-04', 190, 120),
    booking(5, '2026-09-04', 410, 240),
    booking(6, '2026-09-04', 155, 90),
    booking(7, '2026-09-04', 230, 150),
  ]
  const prior = Array.from({ length: 10 }, (_, index) => booking(101 + index, '2026-08-30', index === 9 ? 128.5 : 160,
    index === 9 ? 60 : 120))
  const input = platformData(current, prior, platformMeta(267.1), platformMeta(251.3))
  const currentBusiness = buildBusinessReport(input.context, current, prior)
  const currentMeta = buildMetaMetrics({ ...input.context, asOf: input.meta.asOf! }, platformMeta(267.1), platformMeta(251.3))
  const spend = [81.3, 109.65, 76.15]
  const dates = ['2026-09-02', '2026-09-03', '2026-09-04']
  function day(source: 'business' | 'meta', date: string, key: 'booked_value' | 'paid_bookings' | 'spend', value: number) {
    const comparisonDate = new Date(Date.parse(`${date}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10)
    const sourceContext = { ...input.context, range: { from: date, to: date },
      comparison: { from: comparisonDate, to: comparisonDate }, asOf: input[source].asOf! }
    return makeReportMetric({ context: sourceContext, key, label: key, definition: `Native daily ${key}`, current: value,
      source: source === 'business' ? 'outcomes' : 'meta', unit: key === 'paid_bookings' ? 'count' : 'money',
      sourceHead: input[source].data!.metrics[key].current.source.head, coverage: COMPLETE_FIELD_COVERAGE,
      basis: source === 'business' ? 'booking_created_date_et' : 'impression_date_et',
      entity: { level: source === 'business' ? 'business' : 'account', id: source === 'business' ? `${sourceContext.account.id}:day:${date}` : sourceContext.account.id },
      freshness: { state: 'fresh', observedAt: sourceContext.asOf, maxAgeHours: 24 },
    })
  }
  return {
    ...input,
    business: { ...input.business, data: currentBusiness },
    meta: { ...input.meta, data: { ...input.meta.data!, metrics: currentMeta, series: dates.map((date, index) => ({ date,
      metrics: { spend: day('meta', date, 'spend', spend[index]) },
    })) } },
  }
}

function reversedScenario() {
  const current = [1, 2, 3].map(id => ({ ...platformBooking(id, 200, 200), appointment_duration: '120' }))
  const prior = [4, 5].map(id => ({ ...platformBooking(id, 700, 700), appointment_duration: '300' }))
  return platformData(current, prior, platformMeta(200), platformMeta(100))
}

function findByAriaLabel(node: ReactNode, label: string): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return null
  const element = node as ReactElement<Record<string, unknown>>
  if (element.props['aria-label'] === label) return element
  const children = element.props.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findByAriaLabel(child as ReactNode, label)
    if (match) return match
  }
  return null
}

describe('approved executive interpretation and hierarchy', () => {
  it('reads the recorded current/prior scenario as a decision and qualifies it with MER direction and supported concentration', () => {
    const data = recordedScenario()
    expect(() => validateReportingPacket({ context: data.context, section: 'business', result: data.business, notes: [] })).not.toThrow()
    expect(() => validateReportingPacket({ context: { ...data.context, asOf: data.meta.asOf! }, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const html = renderToStaticMarkup(<OverviewReport data={data} />)
    const opening = plain(section(html, 'Executive interpretation').split('<details')[0])
    expect(opening).toContain('Average booking value rose 56% to $245')
    expect(opening).toContain('all-source MER rose from 6.24× to 6.42×; Sep 4 supplied 57% of booked value')
    expect(plain(section(html, 'Executive interpretation'))).toContain('eligible bookings 10 → 7')
    expect(plain(section(html, 'Executive interpretation'))).toContain('All-source booked value rose 9%')
    expect(plain(section(html, 'Executive interpretation'))).toContain('Recorded hours fell 11%')
    expect(opening).not.toContain('alongside $267.10 in Meta spend')
    expect(html).toContain('aria-label="All-source booked value ÷ Meta spend: 6.42×"')
  })

  it('derives the reverse movement and a lower MER without reusing the recorded wording', () => {
    const html = renderToStaticMarkup(<OverviewReport data={reversedScenario()} />)
    const opening = plain(section(html, 'Executive interpretation').split('<details')[0])
    expect(opening).toContain('Average booking value fell 71% to $200')
    expect(opening).toContain('all-source MER fell from 14.00× to 3.00×')
    expect(plain(section(html, 'Executive interpretation'))).toContain('eligible bookings 2 → 3')
    expect(plain(section(html, 'Executive interpretation'))).toContain('All-source booked value fell 57%')
    expect(plain(section(html, 'Executive interpretation'))).toContain('Recorded hours fell 40%')
    expect(opening).not.toMatch(/Sep 4|57%|6\.24×|6\.42×/)
  })

  it('retains the supported MER comparison when no daily temporal finding exists', () => {
    const input = reversedScenario()
    const data = { ...input,
      business: { ...input.business, data: { ...input.business.data!, series: [], comparisonSeries: [] } },
      meta: { ...input.meta, data: { ...input.meta.data!, series: [], comparisonSeries: [] } },
    }
    const html = plain(section(renderToStaticMarkup(<OverviewReport data={data} />), 'Executive interpretation').split('<details')[0])
    expect(html).toContain('all-source MER fell from 14.00× to 3.00×.')
    expect(html).not.toMatch(/supplied .* booked value|per day while Meta spend/)
  })

  it('keeps business usable when Meta is missing and Meta usable when business is missing', () => {
    const full = platformData()
    const noMeta = renderToStaticMarkup(<OverviewReport data={{ ...full, meta: unavailable }} />)
    expect(noMeta).toContain('aria-label="Booked value: $1,200.00. Definition and source"')
    expect(noMeta).toContain('aria-label="All-source booked value ÷ Meta spend: Unavailable"')
    expect(section(noMeta, 'Advertising results')).toContain('aria-label="Reported results: Unavailable. Definition and source"')
    expect(plain(section(noMeta, 'Executive interpretation'))).not.toMatch(/Blended MER (?:improved|declined)/)

    const noBusiness = renderToStaticMarkup(<OverviewReport data={{ ...full, business: unavailable }} />)
    expect(noBusiness).toContain('aria-label="Booked value: Unavailable. Definition and source"')
    expect(noBusiness).toContain('aria-label="All-source booked value ÷ Meta spend: Unavailable"')
    expect(section(noBusiness, 'Advertising results')).toContain('aria-label="Reported results: 20. Definition and source"')
    expect(plain(section(noBusiness, 'Executive interpretation'))).not.toMatch(/Blended MER (?:improved|declined)/)
  })

  it('presents one event-specific Meta diagnostic strip in spend, count, CPA, value, ROAS order', () => {
    const html = section(renderToStaticMarkup(<OverviewReport data={platformData()} />), 'Advertising results')
    expect(html).toContain('aria-label="AppointmentConfirmed Meta result diagnostic strip"')
    const positions = ['Spend:', 'Reported results:', 'Cost / result:', 'AppointmentConfirmed reported value:', 'Reported ROAS:']
      .map(label => html.indexOf(`aria-label="${label}`))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('updates every selected Meta measure and preserves the other dashboard URL state', () => {
    const data = platformData()
    navigation.search = 'overview_event=purchase'
    const purchase = section(renderToStaticMarkup(<OverviewReport data={data} />), 'Advertising results')
    for (const value of ['Reported results: 3', 'Cost / result: $200.00', 'Purchase reported value: $300.00', 'Reported ROAS: 0.50×'])
      expect(purchase).toContain(`aria-label="${value}. Definition and source"`)

    const pushState = vi.fn()
    vi.stubGlobal('window', { location: { pathname: '/dashboard', search: '?from=2026-09-02&to=2026-09-04&saved=saved-1', hash: '#reporting-trust' },
      history: { pushState } })
    const select = findByAriaLabel(OverviewResults({ data, selected: 'appointment_confirmed', savedId: 'saved-1' }), 'Dashboard result event')
    expect(select).not.toBeNull()
    ;(select!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'purchase' } })
    expect(pushState).toHaveBeenCalledWith(null, '', '/dashboard?from=2026-09-02&to=2026-09-04&saved=saved-1&overview_event=purchase#reporting-trust')

    const removeEvent = vi.fn()
    vi.stubGlobal('window', { location: { pathname: '/dashboard', search: '?from=2026-09-02&overview_event=purchase&saved=saved-1', hash: '' },
      history: { pushState: removeEvent } })
    const purchaseSelect = findByAriaLabel(OverviewResults({ data, selected: 'purchase', savedId: 'saved-1' }), 'Dashboard result event')
    ;(purchaseSelect!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'appointment_confirmed' } })
    expect(removeEvent).toHaveBeenCalledWith(null, '', '/dashboard?from=2026-09-02&saved=saved-1')
  })

  it('keeps a saved interpretation frozen while showing the saved inputs in the composed executive unit', () => {
    const data = recordedScenario(), review = deriveExpertReview(data)
    const original = 'Original saved decision read. Preserve this wording exactly.'
    const saved = { saved: { id: 'saved-executive' }, data,
      review: { ...review, findings: review.findings.map(item => item.id === 'business_platform_trend'
        ? { ...item, observation: { ...item.observation, text: original } } : item) } } as OpenSavedReportingReportReply
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><OverviewReport data={data} /></SavedReportProvider>)
    const opening = section(html, 'Executive interpretation')
    expect(opening).toContain(original)
    expect(plain(opening)).not.toContain('Fewer bookings brought in more value and booked hours')
    expect(opening).toContain('aria-label="All-source booked value ÷ Meta spend: 6.42×"')
    expect(opening).toContain('saved=saved-executive')
  })
})
