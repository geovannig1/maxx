import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildBusinessCustomers, type BusinessIntelligenceRow } from '@/lib/reporting/business-intelligence-metrics'
import type { ReportingContext, ReportingData } from '@/lib/reporting/contracts'
import { deriveBusinessIntelligenceReview } from '@/lib/reporting/review/business-intelligence'
import { deriveCustomerReview } from '@/lib/reporting/review/business-customers'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'

const context: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: 'act_123', name: 'Fictional studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00.000Z',
}
function row(id: number, date: string, price: number, email: string | null, extra: Partial<BusinessIntelligenceRow> = {}): BusinessIntelligenceRow {
  return { id, booking_date_et: date, appointment_type: 'Studio', appointment_type_id: 1, price, amount_paid: price,
    canceled: false, email, datetime: null, datetime_created: null, appointment_duration: '60', ...extra }
}
const rows = [
  row(1, '2026-08-01', 100, 'retained@example.test'),
  row(2, '2026-08-30', 1000, 'retained@example.test', { appointment_duration: '300' }),
  row(3, '2026-08-30', 100, 'old-first@example.test'), row(4, '2026-08-30', 100, null),
  row(5, '2026-09-02', 100, 'RETAINED@example.test', { amount_paid: 25 }),
  row(6, '2026-09-03', 100, 'retained@example.test', { amount_paid: 25 }),
  row(7, '2026-09-02', 550, 'current-first@example.test', { amount_paid: 225 }),
  row(8, '2026-09-03', 550, 'current-first@example.test', { amount_paid: 225 }),
  row(9, '2026-09-02', 100, null),
]
function packet(input = rows): ReportingData {
  const scoped = (range: typeof context.range) => input.filter(item => item.booking_date_et! >= range.from && item.booking_date_et! <= range.to)
  const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
  const business = { state: 'available' as const, asOf: context.asOf, notes: [], data: {
    ...buildBusinessReport(context, scoped(context.range), scoped(context.comparison)), intelligence: {
      customers: buildBusinessCustomers(context, input), leadTime: unavailable, upcoming: unavailable,
    },
  } }
  validateReportingPacket({ section: 'business', context, result: business, notes: [] })
  return structuredClone({ context, business, meta: unavailable, website: unavailable })
}
const customers = (data: ReportingData) => data.business.data!.intelligence!.customers.data!
const group = (data: ReportingData, id = 'prior_booking') => customers(data).groups.find(item => item.id === id)!
const get = deriveCustomerReview
const combined = (result: ReturnType<typeof get>) => [result.observation.text, result.materiality.text, result.counterEvidence.text, ...result.limitations].join(' ')

describe('prepared customer-group business results', () => {
  it('answers a reconciled headline gain with all signed group contributions and contrary payments/hours', () => {
    const data = packet(), result = get(data)
    expect(result).toMatchObject({ id: 'business_customers', status: 'mixed', direction: 'mixed', priority: 'investigate' })
    expect(result.observation.text).toMatch(/booked value.*\$1,400.*prior \$1,200.*\+\$200/i)
    expect(result.observation.text).toMatch(/prior booking.*\$200.*prior \$1,000.*−\$800/i)
    expect(result.observation.text).toMatch(/first observed.*\$1,100.*prior \$100.*\+\$1,000/i)
    expect(result.observation.text).toMatch(/unidentified.*\$100.*prior \$100.*unchanged/i)
    expect(result.observation.text).toMatch(/5 bookings.*prior 3/)
    expect(result.observation.text).toMatch(/recorded payments.*\$600.*prior \$1,200/i)
    expect(result.observation.text).toMatch(/recorded hours.*5.*prior 7/i)
    expect(combined(result)).toMatch(/offset/i)
    expect(result.observation.text.length).toBeLessThan(1100)
    expect(findingEvidence(result).filter(ref => /groups\/\d+\/metrics\/booked_value$/.test(ref.path))).toHaveLength(3)
    expect(() => verifyFindingReferences(data, result)).not.toThrow()
    expect(JSON.stringify(result)).not.toMatch(/example\.test|refund|cancellation|return rate/i)
  })

  it('reconciles against value-bearing bookings, not all active bookings or all-active payments', () => {
    const data = packet([...rows, row(10, '2026-09-02', 0, null, { amount_paid: 75 })]), result = get(data)
    expect(data.business.data!.metrics.active_appointments.current.value).toBe(6)
    expect(data.business.data!.metrics.amount_paid.current.value).toBe(675)
    expect(result.observation.text).toMatch(/5 bookings.*prior 3/)
    expect(result.observation.text).toMatch(/recorded payments.*\$600/i)
    expect(result.observation.text).not.toContain('$675')
    expect(result.limitations.join(' ')).not.toMatch(/do not reconcile/)
  })

  it('retains booked-value movement independently of unknown current payment and duration fields', () => {
    const data = packet(rows.map(item => item.booking_date_et! >= context.range.from ? { ...item, amount_paid: null, appointment_duration: null } : item))
    const result = get(data)
    expect(result.observation.text).toContain('+$200')
    expect(result.observation.text).toContain('−$800')
    expect(combined(result)).toMatch(/payment.*unavailable|payment.*incomplete/i)
    expect(combined(result)).toMatch(/duration.*incomplete|hours.*unavailable/i)
    expect(result.observation.text).not.toMatch(/payments.*\$0|hours.*0 \(prior 7\)/i)
    expect(result.status).not.toBe('unavailable')
  })

  it('retains qualified payment/hour subtotals without claiming a complete-period decline', () => {
    const data = packet(rows.map(item => item.id === 5 ? { ...item, amount_paid: null, appointment_duration: null } : item)), result = get(data)
    expect(result.observation.text).toContain('+$200')
    expect(combined(result)).toMatch(/\$25.*partial|partial.*\$25/)
    expect(combined(result)).toMatch(/1.*hour.*partial|partial.*1.*hour/)
    expect(combined(result)).toMatch(/1 of 2/)
    expect(result.observation.text).not.toMatch(/recorded payments.*\$575.*prior \$1,200/)
    expect(findingEvidence(result).some(ref => ref.path.endsWith('/groups/0/metrics/amount_paid'))).toBe(true)
  })

  it('permits no intervention for stable compatible group results', () => {
    const data = packet([rows[0], row(20, '2026-08-30', 100, 'retained@example.test'), row(21, '2026-09-02', 100, 'retained@example.test')])
    const result = get(data)
    expect(result).toMatchObject({ status: 'unchanged', priority: 'context' })
    expect(result.direction).toBeUndefined()
    expect(result.observation.text).toMatch(/unchanged/i)
    expect(result.nextInspection.question).toMatch(/no intervention/i)
  })

  it('distinguishes healthy empty periods from unavailable customer history', () => {
    const data = packet([]), result = get(data)
    expect(result.status).toBe('unchanged')
    expect(result.observation.text).toMatch(/no qualifying bookings in either period/i)
    expect(result.observation.text).not.toMatch(/NaN|Infinity|%/)
    data.business.data!.intelligence!.customers = { state: 'unavailable', data: null, asOf: null, notes: [] }
    expect(get(data).status).toBe('unavailable')
    expect(get(data).observation.text).not.toContain('$0')
  })

  it.each(['current', 'prior'] as const)('retains honest %s-only signed contributions', period => {
    const result = get(packet([row(20, period === 'current' ? context.range.from : context.comparison.from, 100, null)]))
    expect(result.observation.text).toContain(period === 'current' ? '+$100' : '−$100')
    expect(result.observation.text).toMatch(/unidentified/i)
    expect(combined(result)).not.toMatch(/unidentified customers|Infinity|NaN/)
  })

  it.each(['source', 'unit', 'entity', 'definition', 'date', 'clock'] as const)('withholds only a group period with invalid native %s', field => {
    const data = packet(), metric = group(data).metrics.booked_value, prior = metric.previous!
    if (field === 'source') prior.source.system = 'meta'
    if (field === 'unit') prior.unit = 'count'
    if (field === 'entity') prior.entity.id = context.account.id
    if (field === 'date') prior.window.start = '2026-08-29'
    if (field === 'clock') prior.asOf = '2026-09-05T17:00:00.000000001Z'
    if (field === 'definition') { metric.definition = 'Invented customer revenue'; metric.current.formula = metric.definition; prior.formula = metric.definition }
    const result = get(data)
    expect(result.observation.text).not.toContain('−$800')
    expect(result.observation.text).toContain('+$1,000')
    if (field !== 'definition') expect(result.observation.text).toMatch(/prior booking.*\$200.*prior unavailable/i)
    expect(result.limitations.join(' ')).toMatch(/reconcil|unavailable|invalid/i)
  })

  it('keeps raw observations but not a comparison when its declared comparison window is wrong', () => {
    const data = packet()
    group(data).metrics.booked_value.current.comparison.window!.start = '2026-08-29'
    const result = get(data)
    expect(result.observation.text).toMatch(/prior booking.*\$200.*prior \$1,000/i)
    expect(result.observation.text).not.toContain('−$800')
    expect(result.limitations.join(' ')).toMatch(/comparison/i)
  })

  it.each(['missing', 'duplicate'] as const)('does not explain the whole business with a %s group', change => {
    const data = packet()
    customers(data).groups = change === 'missing' ? customers(data).groups.filter(item => item.id !== 'unidentified')
      : [...customers(data).groups, structuredClone(group(data, 'unidentified'))]
    const result = get(data)
    expect(result.observation.text).toContain('−$800')
    expect(result.observation.text).not.toMatch(/^Booked value.*\+\$200/i)
    expect(result.limitations.join(' ')).toMatch(/missing|duplicate/i)
    expect(result.limitations.join(' ')).toMatch(/reconcil/i)
  })

  it('withholds whole-business contribution when either period has a residual', () => {
    const data = packet()
    data.business.data!.metrics.booked_value.previous!.value = 1300
    const result = get(data)
    expect(result.observation.text).toContain('−$800')
    expect(result.observation.text).not.toMatch(/^Booked value/i)
    expect(result.limitations.join(' ')).toMatch(/prior.*\$1,200.*\$1,300/i)
  })

  it('preserves group money when its booking count is unavailable', () => {
    const data = packet()
    delete group(data).metrics.bookings
    const result = get(data)
    expect(result.observation.text).toContain('−$800')
    expect(result.observation.text).not.toMatch(/^Booked value/i)
    expect(result.limitations.join(' ')).toMatch(/bookings.*unavailable|count.*unavailable/i)
  })

  it('rejects future source clocks exactly, while an older source under a newer report context stays usable', () => {
    const data = packet()
    data.context.asOf = '2026-09-06T17:00:00.000Z'
    expect(get(data).observation.text).toContain('+$200')
    data.business.data!.intelligence!.customers.asOf = '2026-09-06T17:00:00.000000001Z'
    expect(get(data).status).toBe('unavailable')
  })

  it('keeps retained history and missing identity qualifications accessible without inventing acquisition', () => {
    const data = packet(), result = get(data)
    expect(combined(result)).toContain('2026-08-01')
    expect(combined(result)).toContain('2026-09-04')
    expect(combined(result)).toMatch(/first observed.*not.*newly acquired/i)
    expect(combined(result)).toMatch(/2.*multiple cohort bookings/i)
    expect(new URL(result.nextInspection.href, 'http://local').hash).toBe('#business-customers')
    expect(new URL(result.nextInspection.href, 'http://local').searchParams.get('from')).toBe(context.range.from)
    expect(deriveBusinessIntelligenceReview(data).filter(item => item.id === 'business_customers')).toHaveLength(1)
  })

  it('does not describe a single group’s opposing count/value changes as offsetting group contributions', () => {
    const result = get(packet([rows[0], row(20, '2026-08-30', 500, 'retained@example.test'),
      row(21, '2026-09-02', 100, 'retained@example.test'), row(22, '2026-09-02', 100, 'retained@example.test')]))
    expect(result.observation.text).toContain('−$300')
    expect(result.observation.text).toContain('2 bookings (prior 1)')
    expect(result.observation.text).not.toMatch(/group gains and losses offset/i)
  })

  it('surfaces opposing payment movements inside groups even when aggregate recorded payments are unchanged', () => {
    const result = get(packet([rows[0], row(20, '2026-08-30', 100, 'retained@example.test'),
      row(21, '2026-08-30', 200, null), row(22, '2026-09-02', 200, 'retained@example.test', { amount_paid: 50 }),
      row(23, '2026-09-02', 200, null, { amount_paid: 250 })]))
    expect(result.counterEvidence.text).toMatch(/prior booking.*recorded payments.*\$50.*prior \$100/i)
    expect(result.status).toBe('mixed')
    expect(result.nextInspection.question).not.toMatch(/no intervention/i)
  })

  it('does not compare payment claims from a contradictory group population while retaining their observed amount', () => {
    const data = packet()
    group(data).metrics.amount_paid.current.coverage = { state: 'complete', numerator: 20, denominator: 20 }
    const result = get(data)
    expect(result.observation.text).toContain('−$800')
    expect(result.observation.text).not.toMatch(/recorded payments.*\$600.*prior \$1,200/i)
    expect(combined(result)).toMatch(/\$50.*population|population.*\$50/i)
    expect(result.limitations.join(' ')).toMatch(/payment.*population|population.*payment/i)
  })

  it('withholds contradicted hour coverage without erasing value or valid payment comparisons', () => {
    const data = packet()
    group(data).metrics.duration_coverage.current.value = 50
    const result = get(data)
    expect(result.observation.text).toContain('+$200')
    expect(result.observation.text).toMatch(/recorded payments.*\$600.*prior \$1,200/i)
    expect(result.observation.text).not.toMatch(/recorded hours.*5.*prior 7/i)
    expect(result.limitations.join(' ')).toMatch(/hours.*unavailable|duration.*invalid/i)
  })
})
