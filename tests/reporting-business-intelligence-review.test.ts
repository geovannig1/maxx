import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming, type BusinessIntelligenceRow } from '@/lib/reporting/business-intelligence-metrics'
import type { ReportMetric, ReportingContext, ReportingData } from '@/lib/reporting/contracts'
import { deriveBusinessReview } from '@/lib/reporting/review/business'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'

const context: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000000901', metaAccountId: 'act_123', name: 'Fictional studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00.000Z',
}
function row(id: number, date: string, type: string, paid: number | null, extra: Partial<BusinessIntelligenceRow> = {}): BusinessIntelligenceRow {
  return { id, booking_date_et: date, appointment_type: type, price: paid ?? 100, amount_paid: paid, canceled: false,
    email: `customer${id}@example.test`, datetime_created: `${date}T12:00:00-04:00`, datetime: '2026-09-10T12:00:00-04:00', ...extra }
}
function packet(rows = [row(1, context.range.from, 'Studio', 100), row(2, context.comparison.from, 'Studio', 200)]): ReportingData {
  const scoped = (range: typeof context.range) => rows.filter(item => item.booking_date_et! >= range.from && item.booking_date_et! <= range.to)
  return structuredClone({ context, meta: { state: 'unavailable', data: null, asOf: null, notes: [] },
    website: { state: 'unavailable', data: null, asOf: null, notes: [] },
    business: { state: 'available', asOf: context.asOf, notes: [], data: {
      ...buildBusinessReport(context, scoped(context.range), scoped(context.comparison)), intelligence: {
        customers: buildBusinessCustomers(context, rows), leadTime: buildBusinessLeadTime(context, rows),
        upcoming: buildBusinessUpcoming(context, rows, context.asOf),
      },
    } } }) as ReportingData
}
function get(data: ReportingData, id: string) {
  const result = deriveBusinessReview(data).find(item => item.id === id)
  expect(result, `missing ${id}`).toBeDefined()
  return result!
}
const service = (data: ReportingData, name: string) => get(data, `business_type:${encodeURIComponent(name)}`)
const text = (finding: ReturnType<typeof get>) => JSON.stringify(finding)

describe('prepared business intelligence review', () => {
  it('assesses every supplied service, including smaller, prior-only and contrary changes', () => {
    const data = packet([
      row(1, context.range.from, 'Largest', 1000, { appointment_duration: '120' }),
      row(2, context.comparison.from, 'Largest', 1000, { appointment_duration: '120' }),
      row(3, context.range.from, 'Small', 30), row(4, context.comparison.from, 'Small', 90),
      row(5, context.comparison.from, 'Prior only', 50),
      row(6, context.range.from, 'Improving', 70), row(7, context.comparison.from, 'Improving', 20),
      row(8, context.range.from, 'Mixed', 40), row(9, context.range.from, 'Mixed', 40), row(10, context.comparison.from, 'Mixed', 100),
    ])
    expect(deriveBusinessReview(data).filter(item => item.id.startsWith('business_type:'))).toHaveLength(5)
    expect(service(data, 'Small')).toMatchObject({ direction: 'declined', priority: 'investigate' })
    expect(service(data, 'Prior only')).toMatchObject({ direction: 'declined', priority: 'investigate' })
    expect(service(data, 'Prior only').observation.text).toMatch(/0 active bookings.*prior 1/)
    expect(service(data, 'Improving').direction).toBe('improved')
    expect(service(data, 'Mixed').direction).toBe('mixed')
    expect(service(data, 'Largest')).toMatchObject({ status: 'unchanged', priority: 'context' })
    expect(service(data, 'Small').observation.text).toContain('$30')
    expect(service(data, 'Small').observation.text).toContain('$90')
    expect(service(data, 'Small').nextInspection.question).not.toBe(service(data, 'Improving').nextInspection.question)
    expect(get(data, 'business_type_contribution').observation.text).not.toMatch(/largest|current-only|prior.*unavailable/i)
  })

  it('keeps unknown payments distinct from zero and withholds a payment direction', () => {
    const data = packet([row(1, context.range.from, 'Studio', null), row(2, context.comparison.from, 'Studio', 100)])
    const result = service(data, 'Studio')
    expect(result.direction).toBeUndefined()
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/amount paid.*unavailable/i)
    expect(result.observation.text).toContain('1 active bookings')
    expect(result.observation.text).not.toContain('$0')
    expect(result.limitations.join(' ')).toMatch(/payment|coverage/i)
  })

  it('retains a proven count decrease while payment comparisons remain unknown', () => {
    const data = packet([row(1, context.range.from, 'Studio', null), row(2, context.comparison.from, 'Studio', 100),
      row(3, context.comparison.from, 'Studio', 100)])
    const result = service(data, 'Studio')
    expect(result.direction).toBe('declined')
    expect(result.observation.text).toContain('1 active bookings (prior 2)')
    expect(result.nextInspection.question).toMatch(/booking.count.*payment.*limited/i)
    expect(result.observation.text).not.toContain('Recorded payments fell')
  })

  it.each(['source', 'unit', 'basis', 'event', 'entity'] as const)('withholds a service amount with wrong native %s', field => {
    const data = packet(), metric = data.business.data!.types[0].metrics.amount_paid
    if (field === 'event') metric.event = 'Purchase'
    else if (field === 'source') metric.current.source.system = 'meta'
    else if (field === 'unit') metric.current.unit = 'count'
    else if (field === 'basis') metric.current.window.basis = 'service_date_et'
    else metric.current.entity.id = 'wrong-business'
    const result = service(data, 'Studio')
    expect(result.observation.text).toMatch(/amount paid.*unavailable/i)
    expect(result.direction).toBeUndefined()
    expect(findingEvidence(result).map(ref => ref.path)).not.toContain('/business/data/types/0/metrics/amount_paid')
  })

  it.each(['unit', 'source', 'window', 'coverage'] as const)('does not compare a valid service amount with an invalid prior %s', field => {
    const data = packet(), prior = data.business.data!.types[0].metrics.amount_paid.previous!
    if (field === 'unit') prior.unit = 'count'
    else if (field === 'source') prior.source.system = 'meta'
    else if (field === 'window') prior.window.start = '2026-08-29'
    else prior.coverage.state = 'partial'
    const result = service(data, 'Studio')
    expect(result.observation.text).toContain('$100')
    expect(result.direction).toBeUndefined()
    expect(result.observation.text).not.toMatch(/payments fell|payments rose/i)
  })

  it('describes observed customer history and missing identity without claiming acquisition or CAC', () => {
    const data = packet([
      row(1, '2026-08-01', 'Studio', 100, { email: 'returning@example.test' }),
      row(2, context.range.from, 'Studio', 100, { email: 'RETURNING@example.test' }),
      row(3, context.range.from, 'Studio', 80), row(4, context.range.from, 'Studio', 20, { email: null }),
    ])
    const result = get(data, 'business_customers')
    expect(result.status).toBe('mixed')
    expect(result.materiality.text).toMatch(/1.*prior booking/i)
    expect(result.materiality.text).toMatch(/1.*first.observed/i)
    expect(result.materiality.text).toMatch(/1.*unidentified booking/i)
    expect(result.materiality.text).toContain('2026-08-01')
    expect(result.observation.text).toContain('+$200')
    expect(result.limitations.join(' ')).toMatch(/not.*acquisition|not.*newly acquired/i)
    expect(result.direction).toBe('improved')
    expect(result.nextInspection.question).toMatch(/unidentified/i)
    expect(text(result)).not.toContain('returning@example.test')
  })

  it('limits only unavailable history and preserves lead-time and service evidence', () => {
    const data = packet()
    data.business.data!.intelligence!.customers = { state: 'unavailable', data: null, asOf: null, notes: ['History read unavailable.'] }
    expect(get(data, 'business_customers').status).toBe('unavailable')
    expect(get(data, 'business_lead_time').status).not.toBe('unavailable')
    expect(service(data, 'Studio').status).not.toBe('unavailable')
  })

  it('names lead-time sample and dates while withholding a direction from incomplete timestamps', () => {
    const data = packet([row(1, context.range.from, 'Studio', 100), row(2, context.range.from, 'Studio', 100, { datetime: null }),
      row(3, context.comparison.from, 'Studio', 100)])
    const result = get(data, 'business_lead_time')
    expect(result.observation.text).toMatch(/1 of 2/)
    expect(result.observation.text).toContain('8 days')
    expect(result.observation.text).toContain('2026-09-02')
    expect(result.limitations.join(' ')).toMatch(/not.*ad.touch|not.*conversion lag/i)
    expect(result.direction).toBeUndefined()
    expect(result.nextInspection.question).toMatch(/missing|timestamp/i)
  })

  it('compares complete lead-time samples without declaring shorter or longer profitable', () => {
    const data = packet([row(1, context.range.from, 'Studio', 100, { datetime: '2026-09-04T12:00:00-04:00' }),
      row(2, context.comparison.from, 'Studio', 100)])
    const result = get(data, 'business_lead_time')
    expect(result.observation.text).toMatch(/median.*2 days.*11 days/i)
    expect(result.nextInspection.question).toMatch(/shorter/i)
    expect(result.direction).toBeUndefined()
  })

  it('describes future service-date workload outside the selected booking-created cohort', () => {
    const data = packet([row(1, '2026-08-01', 'Studio', 50, { price: 500, datetime: '2026-09-10T12:00:00-04:00' })])
    const result = get(data, 'business_upcoming')
    expect(result.observation.text).toContain('2026-09-06')
    expect(result.observation.text).toContain('2026-10-03')
    expect(result.observation.text).toContain('1 recorded bookings')
    expect(result.observation.text).toContain('$500')
    expect(result.observation.text).toContain('$50')
    expect(result.observation.text).toContain('2026-09-10')
    expect(result.direction).toBeUndefined()
    expect(result.limitations.join(' ')).toMatch(/partial|incomplete/i)
    expect(result.limitations.join(' ')).toMatch(/capacity|open slots/i)
    const refs = result.observation.evidence
    expect(refs.every(ref => ref.metric.current.window.basis === 'service_date_et' && ref.metric.previous === null
      && ref.metric.current.comparison.method === 'none')).toBe(true)
  })

  it('does not turn an empty future read into an empty calendar', () => {
    const result = get(packet([]), 'business_upcoming')
    expect(result.status).toBe('unavailable')
    expect(result.observation.text).not.toMatch(/0 recorded bookings|empty calendar/i)
    expect(result.observation.text).toMatch(/completeness|unavailable|unverified/i)
  })

  it.each(['customers', 'leadTime', 'upcoming'] as const)('rejects a wrong-source %s metric without inventing a zero', section => {
    const data = packet(), report = data.business.data!.intelligence![section].data!
    for (const metric of Object.values(report.metrics)) metric.current.source.system = 'meta'
    const id = { customers: 'business_customers', leadTime: 'business_lead_time', upcoming: 'business_upcoming' }[section]
    const result = get(data, id)
    if (section === 'customers') {
      expect(result.status).not.toBe('unavailable')
      expect(result.observation.text).toContain('−$100')
      expect(result.materiality.text).toContain('unavailable identified customers')
      expect(result.materiality.evidence.every(ref => ref.metric.previous?.source.system === 'outcomes')).toBe(true)
    } else {
      expect(result.status).toBe('unavailable')
      expect(result.observation.evidence).toHaveLength(0)
    }
  })

  it.each([
    ['customers', 'prior_booking_customers', 'money'], ['leadTime', 'median_lead_days', 'count'],
    ['upcoming', 'recorded_bookings', 'money'],
  ] as const)('retains independent %s evidence while withholding wrong-unit %s', (section, key, unit) => {
    const data = packet(), metric = data.business.data!.intelligence![section].data!.metrics[key]
    metric.current.unit = unit
    const id = { customers: 'business_customers', leadTime: 'business_lead_time', upcoming: 'business_upcoming' }[section]
    const result = get(data, id)
    if (section !== 'customers') expect(findingEvidence(result).map(ref => ref.path)).not.toContain(`/business/data/intelligence/${section}/data/metrics/${key}`)
    else expect(result.materiality.text).toContain('unavailable customers with a prior booking (prior 0)')
    expect(section === 'customers' ? result.materiality.text : result.observation.text).toContain('unavailable')
    expect(result.status).not.toBe('unavailable')
    expect(result.direction).toBe(section === 'customers' ? 'declined' : undefined)
  })

  it('rejects a future cohort relabeled as the selected booking-created comparison', () => {
    const data = packet(), metrics = data.business.data!.intelligence!.upcoming.data!.metrics
    for (const metric of Object.values(metrics)) {
      metric.current.window = { ...metric.current.window, start: context.range.from, end: context.range.to, basis: 'booking_created_date_et' } as ReportMetric['current']['window']
    }
    expect(get(data, 'business_upcoming').status).toBe('unavailable')
  })

  it('binds all new findings to exact source evidence and business destinations with selected dates preserved', () => {
    const data = packet()
    const results = deriveBusinessReview(data)
    for (const result of results) expect(() => verifyFindingReferences(data, result)).not.toThrow()
    for (const id of ['business_customers', 'business_lead_time', 'business_upcoming', 'business_type:Studio']) {
      const result = get(data, id), url = new URL(result.nextInspection.href, 'http://local')
      expect(url.pathname).toBe('/reports')
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ report: 'business', from: context.range.from, to: context.range.to })
      expect(url.hash).toBe(`#${id.startsWith('business_type:') ? 'business-types' : id.replaceAll('_', '-')}`)
    }
    expect(JSON.stringify(results)).not.toMatch(/refund|cancellation|canceled_appointments|return rate/i)
  })
})
