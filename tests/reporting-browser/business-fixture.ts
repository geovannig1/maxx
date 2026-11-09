import { buildBusinessReport } from '../../src/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming, type BusinessIntelligenceRow } from '../../src/lib/reporting/business-intelligence-metrics'
import type { ReportingData, ReportingRange } from '../../src/lib/reporting/contracts'
import { reportingFixture } from '../../scripts/demo/sample/reports'

// Fictional retained ledger inputs only. The returned packet contains native aggregates,
// not email identities, and never reads a connected account or appointment source.
const serviceNames = ['01 Native service', '02 Native service', '03 Native service', '04 Native service', '05 Native service', '06 Native service', '07 Low-volume seventh service', '08 Prior-only service']
function row(id: number, name: string, date: string, price: number, amount: number | null, email: string | null, lead: number | null = 5): BusinessIntelligenceRow {
  const created = `${date}T12:00:00Z`
  return { id, appointment_type: name, booking_date_et: date, price, amount_paid: amount, email, canceled: false, appointment_duration: '120',
    datetime_created: created, datetime: lead === null ? null : new Date(Date.parse(created) + lead * 86_400_000).toISOString() }
}

export function businessReportingFixture(from = '2026-09-02', to = '2026-09-04', options: { includeZeroPricePayment?: boolean } = {}): ReportingData {
  const base = reportingFixture(from, to), context = base.context
  // Current services reconcile to 8 bookings, $3,200 booked and $1,800 recorded paid;
  // prior services reconcile to 9 bookings, $2,700 booked and $1,600 recorded paid.
  const currentInputs = [[0, 500, 300], [0, 500, 300], [1, 700, 500], [2, 400, 300], [3, 400, 200], [4, 300, 0], [5, 200, null], [6, 200, 200]] as const
  const identities = ['prior-a@example.test', ' PRIOR-A@example.test ', 'first-a@example.test', 'first-a@example.test', 'first-b@example.test', 'first-c@example.test', 'prior-b@example.test', null]
  const leadDays = [0.5, 2, 6, 7.25, 10, 18, 33, null]
  const current = currentInputs.map(([type, price, paid], index) => ({ ...row(index + 1, serviceNames[type], context.range.from, price, paid, identities[index], leadDays[index]),
    appointment_duration: index === 6 ? null : type === 0 ? '60' : '120' }))
  const priorInputs = [[0, 250, 200], [0, 250, 200], [1, 400, 300], [2, 400, 300], [3, 400, 350], [4, 300, 0], [5, 150, 0], [6, 50, 0], [7, 500, 250]] as const
  const previous = priorInputs.map(([type, price, paid], index) => ({ ...row(100 + index, serviceNames[type], context.comparison.from, price, paid, `previous-${index}@example.test`),
    appointment_duration: type === 0 ? '180' : '120' }))
  const early = ['prior-a@example.test', 'prior-b@example.test'].map((email, index) => row(1000 + index, serviceNames[0], '2026-01-01', 100, 100, email))
  const future = [100, 0, null].map((paid, index) => ({ ...row(2000 + index, 'Future recorded service', '2026-08-29', index === 2 ? 300 : 200, paid, `future-${index}@example.test`),
    datetime: index === 2 ? '2026-09-30T12:00:00Z' : '2026-09-08T12:00:00Z' }))
  const zeroPrice = options.includeZeroPricePayment
    ? [row(3000, 'Zero-price recorded payment', context.range.from, 0, 75, 'zero-price@example.test')]
    : []
  const retained = [...early, ...previous, ...current, ...future, ...zeroPrice]
  const cohort = (range: ReportingRange) => retained.filter(record => record.booking_date_et! >= range.from && record.booking_date_et! <= range.to)
  return { ...base, business: { state: 'available', asOf: context.asOf, notes: ['Fictional business source note.'], data: {
    ...buildBusinessReport(context, cohort(context.range), cohort(context.comparison)), intelligence: {
      customers: buildBusinessCustomers(context, retained), leadTime: buildBusinessLeadTime(context, retained),
      upcoming: buildBusinessUpcoming(context, retained, context.asOf),
    },
  } }, measurement: { state: 'unavailable', data: null, asOf: null,
    notes: ['This fictional business scenario does not supply confirmation or paid-ad linkage evidence.'] } }
}
