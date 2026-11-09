import type { ReportMetricMap, ReportingContext } from './contracts'

export interface ReportExportRow {
  account: string
  entity: string
  metric: string
  value: number | string | null
  previous_value: number | string | null
  unit: string
  source: string
  event: string | null
  from: string
  to: string
  comparison_from: string
  comparison_to: string
  timezone: string
  currency: string
  as_of: string
  availability: string
  coverage: string
  coverage_numerator: number | null
  coverage_denominator: number | null
  maturity: string
  previous_availability: string
  previous_coverage: string
  previous_coverage_numerator: number | null
  previous_coverage_denominator: number | null
  previous_maturity: string
  previous_as_of: string
  previous_freshness: string
  previous_limitations: string
  definition: string
  date_basis: string
  attribution_scope: string
  freshness: string
  limitations: string
  claim_id?: string | null
  input_claim_ids?: string | null
  previous_claim_id?: string | null
  previous_input_claim_ids?: string | null
}

const COLUMNS: Array<keyof ReportExportRow> = [
  'account', 'entity', 'metric', 'value', 'previous_value', 'unit', 'source', 'event',
  'from', 'to', 'comparison_from', 'comparison_to', 'timezone', 'currency', 'as_of',
  'availability', 'coverage', 'coverage_numerator', 'coverage_denominator', 'maturity',
  'previous_availability', 'previous_coverage', 'previous_coverage_numerator', 'previous_coverage_denominator',
  'previous_maturity', 'previous_as_of', 'previous_freshness', 'previous_limitations',
  'definition', 'date_basis', 'attribution_scope', 'freshness', 'limitations',
  'claim_id', 'input_claim_ids', 'previous_claim_id', 'previous_input_claim_ids',
]

export function metricsToExportRows(
  metrics: ReportMetricMap,
  entity: string,
  context: ReportingContext,
): ReportExportRow[] {
  return Object.values(metrics).map(metric => ({
    account: `${context.account.name ?? 'Meta account'} (${context.account.metaAccountId})`,
    entity,
    metric: metric.label,
    value: metric.current.availability.state === 'available' ? metric.current.value : null,
    previous_value: metric.previous?.availability.state === 'available' ? metric.previous.value : null,
    unit: metric.current.unit,
    source: metric.current.source.system,
    event: metric.event,
    from: metric.current.window.start,
    to: metric.current.window.end,
    comparison_from: metric.previous?.window.start ?? metric.current.comparison.window?.start ?? '',
    comparison_to: metric.previous?.window.end ?? metric.current.comparison.window?.end ?? '',
    timezone: metric.current.window.timezone,
    currency: context.currency,
    as_of: metric.current.asOf,
    availability: metric.current.availability.state,
    coverage: metric.current.coverage.state,
    coverage_numerator: metric.current.coverage.numerator,
    coverage_denominator: metric.current.coverage.denominator,
    maturity: metric.current.maturity.state,
    previous_availability: metric.previous?.availability.state ?? '',
    previous_coverage: metric.previous?.coverage.state ?? '',
    previous_coverage_numerator: metric.previous?.coverage.numerator ?? null,
    previous_coverage_denominator: metric.previous?.coverage.denominator ?? null,
    previous_maturity: metric.previous?.maturity.state ?? '',
    previous_as_of: metric.previous?.asOf ?? '',
    previous_freshness: metric.previous?.freshness.state ?? '',
    previous_limitations: metric.previous?.availability.blockerCodes.join('; ') ?? '',
    definition: metric.definition,
    date_basis: metric.current.window.basis,
    attribution_scope: metric.current.attributionScope,
    freshness: metric.current.freshness.state,
    limitations: metric.current.availability.blockerCodes.join('; '),
    claim_id: metric.current.claimId,
    input_claim_ids: JSON.stringify(metric.current.inputClaimIds),
    previous_claim_id: metric.previous?.claimId ?? null,
    previous_input_claim_ids: metric.previous ? JSON.stringify(metric.previous.inputClaimIds) : null,
  }))
}

export function reportCsvCell(value: string | number | null): string {
  if (value === null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const protectedText = /^[\s\uFEFF]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value)
    ? `'${value}` : value
  return `"${protectedText.replaceAll('"', '""')}"`
}

export function buildReportCsv(rows: readonly ReportExportRow[]): string {
  return [COLUMNS.join(','), ...rows.map(row => COLUMNS.map(column => reportCsvCell(row[column] ?? null)).join(','))].join('\r\n')
}

export function downloadReportCsv(rows: readonly ReportExportRow[], filename: string): void {
  const blob = new Blob(['\uFEFF', buildReportCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${filename.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.csv$/i, '')}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
