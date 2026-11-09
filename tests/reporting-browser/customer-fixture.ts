import { buildBusinessReport } from '../../src/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming, type BusinessIntelligenceRow } from '../../src/lib/reporting/business-intelligence-metrics'
import type { ReportingContext, ReportingData, ReportingRange } from '../../src/lib/reporting/contracts'
import { reportingFixture } from '../../scripts/demo/sample/reports'

// Fictional fixed-date ledger: identities never leave native aggregate builders.
function row(id: number, date: string, price: number, paid: number, hours: number, email: string | null): BusinessIntelligenceRow {
  return { id, booking_date_et: date, appointment_type: 'Fictional studio rental', appointment_type_id: 901,
    price, amount_paid: paid, canceled: false, appointment_duration: String(hours * 60), email,
    datetime_created: `${date}T12:00:00Z`, datetime: '2026-09-10T12:00:00Z' }
}
const retained = [
  row(1, '2026-08-01', 100, 100, 1, 'prior@example.test'),
  row(2, '2026-08-30', 500, 500, 3, 'prior@example.test'),
  row(3, '2026-08-30', 500, 500, 3, 'prior@example.test'),
  row(4, '2026-08-30', 200, 200, 1, null),
  row(5, '2026-09-02', 200, 50, 1, 'PRIOR@example.test'),
  row(6, '2026-09-02', 350, 100, 1, 'first-a@example.test'),
  row(7, '2026-09-02', 350, 100, 1, 'first-a@example.test'),
  row(8, '2026-09-02', 300, 150, 1, 'first-b@example.test'),
  row(9, '2026-09-02', 200, 200, 1, null),
]
const stable = [
  retained[0], row(10, '2026-08-30', 500, 500, 2, 'prior@example.test'),
  row(11, '2026-08-30', 500, 500, 2, 'earlier-first@example.test'),
  row(12, '2026-09-02', 500, 500, 2, 'prior@example.test'),
  row(13, '2026-09-02', 500, 500, 2, 'later-first@example.test'),
]

export function customerReportingFixture(from = '2026-09-02', to = '2026-09-04', mode: 'movement' | 'stable' | 'missing' = 'movement', account?: ReportingContext['account'], asOf?: string): ReportingData {
  const base = reportingFixture(from, to, account, asOf), context = base.context, rows = mode === 'stable' ? stable : retained
  const cohort = (range: ReportingRange) => rows.filter(record => record.booking_date_et! >= range.from && record.booking_date_et! <= range.to)
  return { ...base, business: { state: 'available', asOf: context.asOf, notes: ['Fictional customer-results scenario.'], data: {
    ...buildBusinessReport(context, cohort(context.range), cohort(context.comparison)), intelligence: {
      customers: mode === 'missing' ? { state: 'unavailable', asOf: null, data: null, notes: ['business_customer_read_unavailable'] }
        : buildBusinessCustomers(context, rows),
      leadTime: buildBusinessLeadTime(context, rows), upcoming: buildBusinessUpcoming(context, rows, context.asOf),
    },
  } } }
}
