import './_support/outcome-noun-booking'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BusinessOverview } from '@/components/reporting/BusinessOverview'
import { BusinessDetailReport } from '@/components/reporting/BusinessDetailReport'
import { CustomerFollowupResult } from '@/components/reporting/CustomerFollowupResult'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { businessExportRows } from '@/lib/reporting/business-export'
import type { BusinessCustomers } from '@/lib/reporting/contracts'
import type { OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { deriveExpertReview } from '@/lib/reporting/review'
import { deriveCustomerFollowupReview } from '@/lib/reporting/review/business-customer-followup'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { customerFollowupReportingFixture as followupFixture } from './reporting-browser/customer-followup-fixture'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('report=business'),
  usePathname: () => '/reports' }))

type CustomersWithFollowup = BusinessCustomers & { followup?: {
  observedThrough: string
  horizons: Array<{ id: string; name: string; metrics: BusinessCustomers['metrics'] }>
} }

describe('equal-follow-up customer results', () => {
  it('makes the maturity-adjusted reversal explicit without serializing customer identity', () => {
    const data = followupFixture()
    const customers = data.business.data!.intelligence!.customers.data as CustomersWithFollowup
    expect(data.business.data!.metrics.booked_value.current.value).toBe(1250)
    expect(data.business.data!.metrics.booked_value.previous!.value).toBe(200)
    expect(customers.followup?.observedThrough).toBe('2026-09-07')
    expect(customers.followup?.horizons.map(row => row.id)).toEqual(['7_day', '14_day', '30_day'])
    const seven = customers.followup!.horizons[0].metrics
    expect([seven.eligible_customers.current.value, seven.repeat_customers.current.value,
      seven.repeat_rate.current.value, seven.repeat_booked_value.current.value]).toEqual([2, 0, 0, 0])
    expect([seven.eligible_customers.previous!.value, seven.repeat_customers.previous!.value,
      seven.repeat_rate.previous!.value, seven.repeat_booked_value.previous!.value]).toEqual([2, 2, 100, 200])
    expect(JSON.stringify(data)).not.toContain('@example.test')
  })

  it('prepares one exact equal-follow-up assessment and verifies every evidence reference', () => {
    const data = followupFixture(), review = deriveExpertReview(data)
    const finding = review.findings.find(item => item.id === 'business_customer_followup')
    expect(finding).toBeDefined()
    expect(finding).toMatchObject({ area: 'business', direction: 'declined' })
    expect(finding!.observation.text).toMatch(/7-day follow-up/i)
    expect(finding!.observation.text).toMatch(/2 eligible/i)
    expect(finding!.observation.text).toMatch(/0%.*prior:.*100%|100%.*prior:.*0%/i)
    expect(finding!.limitations.join(' ')).toMatch(/first observed.*not.*acqui|not.*acqui.*first observed/i)
    expect(finding!.nextInspection.href).toContain('#business-customer-followup')
    expect(() => verifyFindingReferences(data, finding!)).not.toThrow()
  })

  it('keeps valid Acuity follow-up evidence when a later source advances the assembled report clock', () => {
    const source = followupFixture()
    const data = { ...source, context: { ...source.context, asOf: '2026-09-08T16:00:00Z' } }
    const finding = deriveCustomerFollowupReview(data)
    expect(finding).toMatchObject({ id: 'business_customer_followup', direction: 'declined' })
    expect(() => verifyFindingReferences(data, finding!)).not.toThrow()
  })

  it('uses the eligible subset in a partly matured range and withholds a corrupted ratio', () => {
    const partial = followupFixture('2026-08-10T16:00:00Z')
    const eligible = deriveCustomerFollowupReview(partial)
    expect(eligible).toMatchObject({ direction: 'declined' })
    expect(eligible!.observation.text).toMatch(/2 eligible current-cohort customers/i)
    const corrupt = structuredClone(partial)
    corrupt.business.data!.intelligence!.customers.data!.followup!.horizons[0].metrics.repeat_rate.current.value = 50
    expect(deriveCustomerFollowupReview(corrupt)).toMatchObject({ status: 'unavailable' })
  })

  it.each([BusinessOverview, BusinessDetailReport])('shows the prepared result before follow-up qualifications in %s', Component => {
    const html = renderToStaticMarkup(<Component data={followupFixture()} />)
    expect(html).toContain('data-customer-followup-result="business_customer_followup"')
    expect(html).toContain('Equal follow-up')
    expect(html).toContain('7-day follow-up')
    expect(html).toContain('Observed through 2026-09-07')
    expect(html).toContain('Eligible customers')
    expect(html).toContain('Repeat booked value')
    expect(html).not.toMatch(/lifetime value|is an acquired customer/i)
  })

  it('exports every horizon with its cohort window and observation limit, without identity or excluded topics', () => {
    const rows = businessExportRows(followupFixture())
    const followup = rows.filter(row => row.entity.startsWith('First-observed customer follow-up'))
    expect(followup).toHaveLength(21)
    expect(new Set(followup.map(row => row.from))).toEqual(new Set(['2026-08-02']))
    expect(new Set(followup.map(row => row.comparison_from))).toEqual(new Set(['2026-07-30']))
    expect(new Set(followup.map(row => row.date_basis))).toEqual(new Set(['booking_created_date_et']))
    expect(followup.every(row => row.limitations.includes('Observed through 2026-09-07'))).toBe(true)
    expect(followup.some(row => row.entity.includes('7-day follow-up') && row.metric === 'Repeat rate'
      && row.value === 0 && row.previous_value === 100)).toBe(true)
    expect(JSON.stringify(followup)).not.toMatch(/@example\.test|refund|return|cancel/i)
  })

  it('keeps an original packet without follow-up usable and does not invent a current result', () => {
    const data = followupFixture()
    delete (data.business.data!.intelligence!.customers.data as CustomersWithFollowup).followup
    const review = deriveExpertReview(data)
    expect(review.findings.some(item => item.id === 'business_customers' && item.status !== 'unavailable')).toBe(true)
    expect(review.findings.some(item => item.id === 'business_customer_followup')).toBe(false)
    const html = renderToStaticMarkup(<BusinessDetailReport data={data} />)
    expect(html).toContain('First observed in retained history')
    expect(html).not.toContain('data-customer-followup-result=')
  })

  it('keeps the original saved follow-up assessment instead of deriving current wording', () => {
    const data = followupFixture(), review = deriveExpertReview(data)
    const original = 'Original saved equal-follow-up assessment.'
    const saved = { data, review: { ...review, findings: review.findings.map(finding =>
      finding.id === 'business_customer_followup' ? { ...finding,
        observation: { ...finding.observation, text: original } } : finding) } } as OpenSavedReportingReportReply
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}>
      <CustomerFollowupResult data={data} />
    </SavedReportProvider>)
    expect(html).toContain(original)
    expect(html).not.toContain('0 of 2 eligible current-cohort customers')
  })
})
