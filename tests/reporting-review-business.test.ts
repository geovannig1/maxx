import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { appointmentResults } from './fixtures/reporting-creative'
import type { ReportMetric, ReportingContext, ReportingData } from '@/lib/reporting/contracts'
import { deriveBusinessReview } from '@/lib/reporting/review/business'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'

const context: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000000901', metaAccountId: 'act_123', name: 'Fictional studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-20T17:00:00.000Z',
}
function row(id: number, paid: number | null, name = 'Studio Rental', price = 300): BusinessLedgerRow {
  return { id, amount_paid: paid, price, canceled: false, booking_date_et: context.range.from, appointment_type: name }
}
function data(current = [row(1, 1_000)], previous = [row(2, 2_000)]): ReportingData {
  const metrics = buildMetaMetrics({ ...context, asOf: '2026-09-20T16:55:00.000Z' },
    { spend: '600', results: appointmentResults(20) }, { spend: '500', results: appointmentResults(10) })
  return {
    context, business: { state: 'available', asOf: context.asOf, notes: [],
      data: buildBusinessReport(context, current, previous.map(value => ({ ...value, booking_date_et: context.comparison.from }))) },
    meta: { state: 'available', asOf: '2026-09-20T16:55:00.000Z', notes: [], data: {
      metrics,
      entities: [], series: [], comparisonSeries: [], breakdowns: [], observations: [],
      sourceDescription: 'Synthetic Meta', attributionWindow: '7-day click / 1-day view', reportingTime: 'Impression date',
    } },
    website: { state: 'unavailable', asOf: null, data: null, notes: ['Fixture omits GA4.'] },
  }
}
function finding(value: ReportingData, id: string) {
  const result = deriveBusinessReview(value).find(item => item.id === id)
  expect(result, `missing ${id}`).toBeDefined()
  return result!
}
const trend = (value: ReportingData) => finding(value, 'business_platform_trend')
const payments = (value: ReportingData) => finding(value, 'business_payment_coverage')
const types = (value: ReportingData) => finding(value, value.business.data?.types[0]
  ? `business_type:${encodeURIComponent(value.business.data.types[0].id)}` : 'business_type_contribution')

describe('deterministic business report review', () => {
  it('shows business and platform trend tension with separate absolute observations and exact evidence', () => {
    const result = trend(data())
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/booked value was unchanged/i)
    expect(result.observation.text).toMatch(/recorded amount paid fell/i)
    for (const value of ['$1,000', '$2,000', '20', '10', '$600', '$500']) expect(result.observation.text).toContain(value)
    expect(result.observation.text).toMatch(/Outcomes.*all sources/i)
    expect(result.observation.text).toContain('AppointmentConfirmed')
    const refs = result.observation.evidence
    expect(refs.find(ref => ref.path === '/business/data/metrics/amount_paid')).toMatchObject({
      source: 'business', sourceAsOf: '2026-09-20T17:00:00.000Z',
      metric: { current: { value: 1000, source: { system: 'outcomes' } }, previous: { value: 2000 } },
    })
    expect(refs.find(ref => ref.path === '/meta/data/metrics/bookings')).toMatchObject({
      source: 'meta', sourceAsOf: '2026-09-20T16:55:00.000Z', metric: { event: 'AppointmentConfirmed' },
    })
    expect(result.materiality.text).toContain('$1,000')
    expect(result.authority).toEqual({ state: 'diagnostic', executable: false })
    expect(result.explanations.every(item => item.missing.length > 0)).toBe(true)
    expect(result.counterEvidence.text).toMatch(/population|booking.creation|impression.date/i)
    expect(result.nextInspection.outcomes.length).toBeGreaterThanOrEqual(2)
  })

  it('does not label same-direction movement as tension or advertising causation', () => {
    const result = trend(data([row(1, 2_000, 'Studio Rental', 600)], [row(2, 1_000)]))
    expect(result.status).toBe('observed')
    expect(result.observation.text).not.toMatch(/opposite directions|caused|generated|drove/i)
    expect(result.limitations.join(' ')).toMatch(/attribution|causal/i)
  })

  it('keeps measured zero distinct from unavailable and recognizes unchanged matched measures', () => {
    const value = data([row(1, 0)], [row(2, 0)])
    const bookings = value.meta.data!.metrics.bookings
    value.meta.data!.metrics.bookings = { ...bookings, current: { ...bookings.current, value: 10 } }
    const spend = value.meta.data!.metrics.spend
    value.meta.data!.metrics.spend = { ...spend, current: { ...spend.current, value: 500 } }
    const result = trend(value)
    expect(result.status).toBe('unchanged')
    expect(result.observation.text).toContain('$0')
    expect(result.observation.text).not.toMatch(/amount paid.*unavailable/i)
  })

  it.each(['current', 'prior'] as const)('limits only the payment comparison when %s payment coverage is incomplete', period => {
    const value = period === 'current' ? data([row(1, 1_000), row(3, null)])
      : data([row(1, 1_000)], [row(2, 2_000), row(3, null)])
    const result = trend(value)
    expect(result.status).toBe('mixed')
    expect(result.limitations.join(' ')).toMatch(/amount paid comparison unavailable.*(partial|coverage)/i)
    expect(result.observation.text).not.toMatch(/recorded amount paid (fell|rose)/i)
    expect(result.observation.text).toMatch(period === 'current' ? /booked value rose/i : /booked value fell/i)
    expect(result.title).not.toMatch(/decline|fell/i)
  })

  it.each(['entity', 'window', 'maturity'] as const)('does not compare incompatible prior %s claims', field => {
    const value = data(), paid = value.business.data!.metrics.amount_paid
    const previous = paid.previous!
    value.business.data!.metrics.amount_paid = { ...paid, previous: field === 'entity'
      ? { ...previous, entity: { ...previous.entity, id: 'another-account' } }
      : field === 'window' ? { ...previous, window: { ...previous.window, start: '2026-08-29' } }
        : { ...previous, maturity: { state: 'partial', matureThrough: null } } }
    expect(trend(value).observation.text).not.toMatch(/opposite directions|fell|decreased by/i)
  })

  it('preserves independent business observations when Meta is unavailable without replacing it with zero', () => {
    const value = data()
    value.meta = { state: 'unavailable', data: null, asOf: null, notes: ['Synthetic source failure.'] }
    const result = trend(value)
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toContain('$1,000')
    expect(result.observation.text).toMatch(/Meta.*unavailable/i)
    expect(result.observation.evidence.every(ref => ref.source === 'business')).toBe(true)
  })

  it('exposes actual payment-field coverage and lower bounds without a receivable calculation', () => {
    const value = data([row(1, 100), row(2, null), row(3, 0)])
    const result = payments(value)
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/2 of 3/)
    expect(result.observation.text).toMatch(/1.*unknown payment/i)
    expect(result.observation.text).toContain('$100')
    expect(result.observation.text).toMatch(/lower bound/i)
    expect(result.observation.evidence.map(ref => ref.path)).toContain('/business/data/metrics/unknown_payment_count')
    expect(result.observation.evidence.map(ref => ref.path)).toContain('/business/data/metrics/amount_paid')
    expect(result.materiality.text).toContain('3')
    expect(JSON.stringify(result)).not.toContain('$800')
    expect(result.limitations.join(' ')).toMatch(/settlement/i)
    expect(result.limitations.join(' ')).not.toMatch(/refund|cancellation|customer returns/i)
    const href = new URL(result.nextInspection.href, 'http://local')
    expect(href.pathname).toBe('/reports')
    expect(Object.fromEntries(href.searchParams)).toMatchObject({ from: '2026-09-02', to: '2026-09-04', report: 'business' })
    expect(href.hash).toBe('#business-results')
  })

  it('does not call zero active appointments 100% payment coverage', () => {
    const result = payments(data([], []))
    expect(result.observation.text).toMatch(/0 active bookings/)
    expect(result.observation.text).toMatch(/no denominator/i)
    expect(result.observation.text).not.toContain('100%')
  })

  it('does not turn completely unobserved payments into measured zero', () => {
    const result = payments(data([row(1, null)]))
    expect(result.observation.text).toMatch(/amount paid.*unavailable/i)
    expect(result.observation.text).not.toContain('$0')
    expect(result.observation.text).toContain('0 of 1')
  })

  it('describes matched native service values without an inferred persona', () => {
    const value = data([row(1, 500, 'Portrait Session'), row(2, 100, 'Studio Rental')])
    const result = types(value)
    expect(result).toMatchObject({ status: 'mixed', direction: 'improved' })
    expect(result.observation.text).toContain('Portrait Session')
    expect(result.observation.text).toContain('$500')
    expect(result.observation.text).toContain('prior $0')
    expect(result.observation.text).not.toMatch(/consumer|professional|persona/i)
    expect(result.limitations.join(' ')).not.toMatch(/current.only|prior.*type.*unavailable/i)
    expect(result.limitations.join(' ')).toMatch(/audience|service labels/i)
    expect(result.exposure).toMatchObject({ value: 500, unit: 'money' })
    const ref = result.observation.evidence.find(item => item.path === '/business/data/types/0/metrics/amount_paid')
    expect(ref?.metric.current.entity.id).toBe(`${context.account.id}:type:Portrait Session`)
    expect(ref?.metric.previous?.value).toBe(0)
  })

  it('keeps incomplete type amounts as lower bounds rather than definitive contribution shares', () => {
    const result = types(data([row(1, 500, 'Portrait Session'), row(2, null, 'Portrait Session'), row(3, 100, 'Studio Rental')]))
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/lower bound/i)
    expect(result.observation.text).not.toMatch(/83\.33%|83\.3%|share/i)
    expect(result.counterEvidence.text).toMatch(/missing|incomplete|unknown/i)
  })

  it('can inspect current type counts when native payment values are all unavailable', () => {
    const result = types(data([row(1, null, 'Portrait Session'), row(2, null, 'Portrait Session'), row(3, null, 'Studio Rental')]))
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toContain('Portrait Session')
    expect(result.observation.text).toMatch(/2 active bookings/)
    expect(result.observation.text).toMatch(/amount paid.*unavailable/i)
    expect(result.exposure).toMatchObject({ value: 2, unit: 'count' })
  })

  it('returns bounded unavailable business checks when no business source was measured', () => {
    const value = data()
    value.business = { state: 'unavailable', data: null, asOf: null, notes: ['Synthetic source failure.'] }
    expect(payments(value).status).toBe('unavailable')
    expect(types(value).status).toBe('unavailable')
    expect(trend(value).observation.text).toContain('20')
    expect(trend(value).observation.text).not.toContain('$0')
  })

  it.each(['amount_paid', 'booked_value', 'paid_bookings', 'active_appointments', 'unknown_payment_count', 'payment_coverage'])
  ('withholds %s when its declared unit contradicts its native meaning', key => {
    const value = data(), original = value.business.data!.metrics[key]
    const unit = original.current.unit === 'count' ? 'money' : 'count'
    value.business.data!.metrics[key] = { ...original, current: { ...original.current, unit },
      previous: original.previous ? { ...original.previous, unit } : null }
    const results = deriveBusinessReview(value)
    expect(results.flatMap(findingEvidence).map(ref => ref.path)).not.toContain(`/business/data/metrics/${key}`)
    if (key === 'amount_paid') {
      expect(trend(value).observation.text).toMatch(/amount paid.*unavailable/i)
      expect(trend(value).exposure).toMatchObject({ value: 300, unit: 'money' })
      expect(trend(value).exposure?.evidence[0].metric.key).toBe('booked_value')
    }
  })

  it.each(['bookings', 'spend'])('does not give the Meta %s key an incompatible unit meaning', key => {
    const value = data(), original = value.meta.data!.metrics[key]
    const unit = original.current.unit === 'count' ? 'money' : 'count'
    value.meta.data!.metrics[key] = { ...original, current: { ...original.current, unit },
      previous: original.previous ? { ...original.previous, unit } : null }
    expect(trend(value).observation.evidence.map(ref => ref.path)).not.toContain(`/meta/data/metrics/${key}`)
  })

  it('withholds wrong-unit type contributions while retaining the compatible current count', () => {
    const value = data(), original = value.business.data!.types[0].metrics.amount_paid
    value.business.data!.types[0].metrics.amount_paid = { ...original, current: { ...original.current, unit: 'count' } }
    const result = types(value)
    expect(result.observation.text).toMatch(/amount paid.*unavailable/i)
    expect(result.exposure).toMatchObject({ value: 1, unit: 'count' })
    expect(findingEvidence(result).map(ref => ref.path)).not.toContain('/business/data/types/0/metrics/amount_paid')
    const href = new URL(result.nextInspection.href, 'http://local')
    expect(href.searchParams.get('report')).toBe('business')
    expect(href.hash).toBe('#business-types')
  })

  it('does not infer complete native payments from other counts after both payment claims disappear', () => {
    const value = data(), metrics = value.business.data!.metrics
    value.business.data!.metrics = Object.fromEntries(Object.entries(metrics)
      .filter(([key]) => !['amount_paid', 'paid_bookings'].includes(key)))
    const result = payments(value)
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/coverage.*unavailable/i)
    expect(result.observation.text).not.toMatch(/population is complete/i)
  })

  it.each(['active_appointments', 'unknown_payment_count', 'payment_coverage'])
  ('does not establish full payment coverage when its %s control is missing', key => {
    const value = data(), metrics = value.business.data!.metrics
    value.business.data!.metrics = Object.fromEntries(Object.entries(metrics).filter(([name]) => name !== key))
    expect(payments(value).status).toBe('mixed')
    expect(payments(value).observation.text).not.toMatch(/population is complete/i)
  })

  it.each(['unknown', 'conflicting_percentage', 'conflicting_population'])('withholds complete payment coverage for %s controls', control => {
    const value = data(), metrics = value.business.data!.metrics
    const change = (key: string, current: Partial<ReportMetric['current']>) => {
      metrics[key] = { ...metrics[key], current: { ...metrics[key].current, ...current } }
    }
    if (control === 'unknown') change('amount_paid', { coverage: { state: 'unknown', numerator: null, denominator: null } })
    else if (control === 'conflicting_percentage') change('payment_coverage', { value: 50 })
    else change('active_appointments', { value: 2 })
    expect(payments(value).status).toBe('mixed')
    expect(payments(value).observation.text).not.toMatch(/population is complete/i)
  })

  it('states native payment completeness only when the actual population and coverage controls agree', () => {
    const result = payments(data())
    expect(result.status).toBe('observed')
    expect(result.observation.text).toMatch(/1 of 1/)
    expect(result.observation.text).toMatch(/population is complete/i)
  })

  it('is deterministic and preserves the supplied report and claim content', () => {
    const value = data(), before = structuredClone(value)
    expect(deriveBusinessReview(value)).toEqual(deriveBusinessReview(value))
    expect(value).toEqual(before)
    expect(deriveBusinessReview(value)).toHaveLength(4 + value.business.data!.types.length)
    expect(deriveBusinessReview(value).filter(finding => finding.id === 'business_booked_value_drivers')).toHaveLength(1)
    for (const result of deriveBusinessReview(value)) expect(() => verifyFindingReferences(value, result)).not.toThrow()
  })
})
