import { buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming,
  type BusinessIntelligenceRow } from '../../src/lib/reporting/business-intelligence-metrics'
import { buildBusinessReport } from '../../src/lib/reporting/business-metrics'
import type { ReportingContext, ReportingData } from '../../src/lib/reporting/contracts'
import { reportingFixture } from '../../scripts/demo/sample/reports'

function booking(id: number, date: string, price: number, email: string | null,
  options: Partial<BusinessIntelligenceRow> = {}): BusinessIntelligenceRow {
  return { id, booking_date_et: date, appointment_type: 'Fictional studio rental', appointment_type_id: 901,
    price, amount_paid: price, canceled: false, appointment_duration: '60', email,
    datetime_created: `${date}T12:00:00Z`, datetime: '2026-09-20T12:00:00Z', ...options }
}

/** Fictional reversal: recent booked value rises while matched 7-day repeat performance falls. */
export function customerFollowupReportingFixture(asOf = '2026-09-07T16:00:00Z',
  account?: ReportingContext['account']): ReportingData {
  const base = reportingFixture('2026-08-02', '2026-08-04', account, asOf)
  const context = base.context
  const rows = [
    booking(1, '2026-07-30', 100, 'prior-a@example.test'),
    booking(2, '2026-07-31', 100, 'prior-b@example.test'),
    booking(3, '2026-08-02', 500, 'current-a@example.test'),
    booking(4, '2026-08-02', 50, 'current-a@example.test'),
    booking(5, '2026-08-03', 500, 'current-b@example.test'),
    booking(6, '2026-08-03', 100, 'prior-a@example.test'),
    booking(7, '2026-08-04', 100, 'prior-b@example.test'),
    booking(8, '2026-08-12', 250, 'current-a@example.test'),
    booking(9, '2026-08-25', 400, 'current-b@example.test'),
    booking(10, '2026-09-05', 900, 'current-a@example.test'),
    booking(11, '2026-08-08', 300, null),
    booking(12, '2026-08-08', 300, 'current-b@example.test', { canceled: true }),
    booking(13, '2026-08-08', 0, 'current-b@example.test'),
  ]
  const inRange = (from: string, to: string) => rows.filter(row => row.booking_date_et! >= from && row.booking_date_et! <= to)
  const business = buildBusinessReport(context, inRange(context.range.from, context.range.to),
    inRange(context.comparison.from, context.comparison.to))
  return { ...base, business: { state: 'available', asOf: context.asOf,
    notes: ['Fictional equal-follow-up customer scenario.'], data: { ...business, intelligence: {
      customers: buildBusinessCustomers(context, rows), leadTime: buildBusinessLeadTime(context, rows),
      upcoming: buildBusinessUpcoming(context, rows, context.asOf),
    } } } }
}
