import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import type { ReportingContext, ReportingData } from '@/lib/reporting/contracts'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import { appointmentResults } from './reporting-creative'

export const platformContext: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000000901', metaAccountId: 'act_123', name: 'Fictional studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-20T17:00:00.000Z',
}
export function platformBooking(id: number, price: number, paid: number | null): BusinessLedgerRow {
  return { id, price, amount_paid: paid, canceled: false, booking_date_et: platformContext.range.from,
    appointment_type: 'Studio rental', appointment_type_id: 10 }
}
export function platformMeta(spend = 600, bookings = 20, value = 2400, purchases = 3, purchaseValue = 300): MetaRow {
  return { spend: String(spend), results: appointmentResults(bookings),
    conversion_values: [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: String(value) }],
    actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases) }],
    action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchaseValue) }] }
}
export function platformData(
  current = [platformBooking(1, 600, 100), platformBooking(2, 600, 100)],
  prior = [platformBooking(3, 800, 800)],
  metaCurrent: MetaRow = platformMeta(), metaPrior: MetaRow = platformMeta(500, 10, 1500, 2, 500),
): ReportingData {
  const context = platformContext
  const metaContext = { ...context, asOf: '2026-09-20T16:55:00.000Z' }
  return { context,
    business: { state: 'available', asOf: context.asOf, notes: ['Fictional native ledger.'],
      data: buildBusinessReport(context, current, prior.map(row => ({ ...row, booking_date_et: context.comparison.from }))) },
    meta: { state: 'available', asOf: metaContext.asOf, notes: ['Fictional native Meta rows.'], data: {
      metrics: buildMetaMetrics(metaContext, metaCurrent, metaPrior), entities: [], series: [], comparisonSeries: [],
      breakdowns: [], observations: [], detailState: 'complete', attributionWindow: 'Meta entity attribution settings',
      reportingTime: 'Impression date in America/New_York', sourceDescription: 'Fictional native Meta rows',
    } },
    website: { state: 'unavailable', data: null, asOf: null, notes: ['Not supplied.'] },
    measurement: { state: 'unavailable', data: null, asOf: null, notes: ['Not supplied.'] },
  }
}
