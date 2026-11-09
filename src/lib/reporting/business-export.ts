import type { ReportMetricMap, ReportingData } from './contracts'
import { metricsToExportRows, type ReportExportRow } from './export'
import { businessDriverExportRows } from './business-driver-export'

const publicMetrics = (metrics: ReportMetricMap): ReportMetricMap =>
  Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'canceled_appointments'))

/** Export each population with its own dates and qualification, never customer identity. */
export function businessExportRows(data: ReportingData): ReportExportRow[] {
  const business = data.business.data
  if (!business) return []
  const rows: ReportExportRow[] = []
  const add = (metrics: ReportMetricMap, entity: string, notes: readonly string[] = []) => {
    rows.push(...metricsToExportRows(publicMetrics(metrics), entity, data.context).map(row => ({ ...row,
      limitations: [row.limitations, ...notes].filter(Boolean).join(' · '),
    })))
  }
  add(business.metrics, 'Business outcomes', data.business.notes)
  for (const type of business.types) add(type.metrics, `Outcome type · ${type.name} (${type.id})`, data.business.notes)
  for (const [label, series] of [['current', business.series], ['prior', business.comparisonSeries]] as const)
    for (const day of series) add(day.metrics, `Outcome-created day · ${label} · ${day.date}`, data.business.notes)
  const intelligence = business.intelligence
  if (intelligence?.customers.data) {
    const source = intelligence.customers, customers = source.data!
    const notes = [...source.notes, `Customer cohorts use normalized email in the retained ledger, ${customers.historyFrom ?? 'unknown start'} through ${customers.historyTo}; first observed does not establish a new customer.`]
    add(customers.metrics, 'Customer history', notes)
    for (const group of customers.groups) add(group.metrics, `Customer cohort · ${group.name} (${group.id})`, notes)
    if (customers.followup) {
      const followupNotes = [...notes,
        `Observed through ${customers.followup.observedThrough}; each horizon includes only first-observed customers whose full follow-up elapsed by that date.`,
        'Repeat results cover later-date active positive-price bookings through each eligible customer’s deadline. Same-day appointments do not establish a later sequence.',
      ]
      for (const horizon of customers.followup.horizons) {
        add(horizon.metrics, `First-observed customer follow-up · ${horizon.name} (${horizon.id})`, followupNotes)
      }
    }
  }
  if (intelligence?.leadTime.data) {
    const source = intelligence.leadTime, lead = source.data!
    add(lead.metrics, 'Outcome creation to service lead time', source.notes)
    for (const bucket of lead.buckets) add(bucket.metrics, `Lead time · ${bucket.name}`, source.notes)
  }
  if (intelligence?.upcoming.data) {
    const source = intelligence.upcoming, upcoming = source.data!
    add(upcoming.metrics, 'Recorded upcoming schedule', source.notes)
    for (const day of upcoming.days) add(day.metrics, `Recorded upcoming service date · ${day.date}`, source.notes)
    for (const type of upcoming.types) add(type.metrics, `Recorded upcoming service · ${type.name} (${type.id})`, source.notes)
  }
  return [...rows, ...businessDriverExportRows(data)]
}
