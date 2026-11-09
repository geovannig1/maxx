import type { ReportingData } from './contracts'
import { deriveBusinessDrivers, type BusinessDriverRow } from './business-drivers'
import { metricsToExportRows, type ReportExportRow } from './export'

/** Export the same validated arithmetic shown in the Business report, with both input periods. */
export function businessDriverExportRows(data: ReportingData): ReportExportRow[] {
  const result = deriveBusinessDrivers(data)
  const exportRow = (row: BusinessDriverRow, account = false): ReportExportRow[] => {
    const refs = Object.values(row.evidence).filter(ref => ref !== null)
    const anchor = row.evidence.bookedValue ?? row.evidence.bookings ?? row.evidence.recordedHours
    if (!anchor) return [] // The ordinary native export still retains the supplied unavailable metrics.
    const entity = `Booked-value drivers · ${account ? 'Account' : row.name} (${row.id})`
    const base = metricsToExportRows({ native: anchor.metric }, entity, data.context)[0]
    const inputs = JSON.stringify({ current: row.current, prior: row.prior,
      references: refs.map(ref => ({ path: ref.path, currentClaimId: ref.metric.current.claimId,
        priorClaimId: ref.metric.previous?.claimId ?? null, sourceAsOf: ref.sourceAsOf,
        currentAsOf: ref.metric.current.asOf, priorAsOf: ref.metric.previous?.asOf ?? null })) })
    const common: ReportExportRow = { ...base, source: 'maxx', event: null, unit: 'money', as_of: result.sourceAsOf ?? '', previous_as_of: result.sourceAsOf ?? '',
      claim_id: null, input_claim_ids: null, previous_claim_id: null, previous_input_claim_ids: null,
      from: data.context.range.from, to: data.context.range.to,
      comparison_from: data.context.comparison.from, comparison_to: data.context.comparison.to,
      timezone: data.context.timezone, currency: data.context.currency,
      date_basis: 'booking_created_date_et', attribution_scope: 'all_sources', freshness: 'unknown', maturity: 'not_applicable',
      previous_value: null, previous_availability: '', previous_coverage: '', previous_coverage_numerator: null,
      previous_coverage_denominator: null, previous_maturity: '', previous_freshness: '', previous_limitations: '',
      coverage_numerator: null, coverage_denominator: null,
      limitations: [...result.limitations, ...row.limitations, `Split state: ${row.decomposition.state}.`, 'Observed arithmetic; not a causal or pure-price effect.',
        ...(account ? [`Service reconciliation: ${JSON.stringify(result.reconciliation)}`] : []), `Native inputs: ${inputs}`].join(' · '),
    }
    const calculation = (metric: string, value: number | null, definition: string): ReportExportRow => ({
      ...common, metric, value, availability: value === null ? 'unavailable' : 'available',
      coverage: value === null ? 'unknown' : 'complete', definition,
    })
    return [
      calculation('Booked-value change', row.change.bookedValue,
        'Selected booked value minus previous booked value for the same positive-price booking population; inputs use booking creation dates.'),
      calculation('Booking-count component', row.decomposition.bookingCount,
        '(Selected positive-price booking count − previous count) × (selected value per booking + previous value per booking) / 2. Requires bookings in both periods.'),
      calculation('Value-per-booking component', row.decomposition.valuePerBooking,
        '(Selected value per positive-price booking − previous value per booking) × (selected booking count + previous count) / 2. Includes changing booking composition; not a pure-price effect.'),
      { ...calculation('Value per positive-price booking', row.current.valuePerBooking,
        'Booked value divided by positive-price booking count in the same period. A zero booking count has no mean.'),
      previous_value: row.prior.valuePerBooking,
      previous_availability: row.prior.valuePerBooking === null ? 'unavailable' : 'available',
      previous_coverage: row.prior.valuePerBooking === null ? 'unknown' : 'complete' },
    ]
  }
  return [...exportRow(result.account, true), ...result.services.flatMap(row => exportRow(row))]
}
