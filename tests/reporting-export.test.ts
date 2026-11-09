import { describe, expect, it } from 'vitest'
import { buildReportCsv, metricsToExportRows } from '@/lib/reporting/export'
import { COMPLETE_FIELD_COVERAGE, makeReportMetric } from '@/lib/reporting/claims'

const context = {
  account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const, currency: 'USD' as const, asOf: '2026-09-05T17:00:00Z',
}

describe('report exports', () => {
  it('exports observed zero with its own source, event, dates and definition', () => {
    const metric = makeReportMetric({ context, key: 'bookings', label: 'Reported bookings',
      definition: 'Canonical AppointmentConfirmed results.', source: 'meta', unit: 'count',
      current: 0, previous: 2, coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE,
      event: 'AppointmentConfirmed' })
    const [row] = metricsToExportRows({ bookings: metric }, 'Warm ad', context)
    expect(row).toMatchObject({ value: 0, previous_value: 2, event: 'AppointmentConfirmed',
      from: '2026-09-02', comparison_from: '2026-08-30', timezone: 'America/New_York', source: 'meta' })
    expect(buildReportCsv([row])).toContain('Canonical AppointmentConfirmed results.')
  })
  it('neutralizes formula text while preserving numeric negatives and quoted multiline labels', () => {
    const metric = makeReportMetric({ context, key: 'spend', label: '=HYPERLINK("bad")',
      definition: 'Line one\nLine two', source: 'meta', unit: 'money', current: -2, coverage: COMPLETE_FIELD_COVERAGE })
    const rows = metricsToExportRows({ spend: metric }, ' \t+SUM(1,2)', context)
    const csv = buildReportCsv(rows)
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"')
    expect(csv).toContain('"\' \t+SUM(1,2)"')
    expect(csv).toContain(',-2,')
    expect(csv).toContain('"Line one\nLine two"')
  })
  it('does not export missing performance as zero', () => {
    const metric = makeReportMetric({ context, key: 'roas', label: 'ROAS', definition: 'Named value / spend.',
      source: 'meta', unit: 'ratio', current: null })
    const [row] = metricsToExportRows({ roas: metric }, 'Ad', context)
    expect(row.value).toBeNull()
    expect(row.availability).toBe('unavailable')
  })
  it('retains prior-period coverage and availability independently from complete current evidence', () => {
    const metric = makeReportMetric({ context, key: 'amount_paid', label: 'Amount paid', definition: 'Observed native paid amounts.',
      source: 'outcomes', unit: 'money', current: 300, previous: 50,
      coverage: { state: 'complete', numerator: 2, denominator: 2 },
      previousCoverage: { state: 'partial', numerator: 1, denominator: 2 } })
    const [row] = metricsToExportRows({ amount_paid: metric }, 'Service', context)
    expect(row).toMatchObject({ value: 300, previous_value: 50, coverage: 'complete', coverage_numerator: 2, coverage_denominator: 2,
      previous_coverage: 'partial', previous_coverage_numerator: 1, previous_coverage_denominator: 2,
      previous_availability: 'available', previous_as_of: context.asOf })
    expect(buildReportCsv([row])).toContain('previous_coverage')
    const missing = makeReportMetric({ context, key: 'amount_paid', label: 'Amount paid', definition: 'Observed native paid amounts.',
      source: 'outcomes', unit: 'money', current: 300, previous: null, coverage: COMPLETE_FIELD_COVERAGE, previousReason: 'No valid prior payment field.' })
    expect(metricsToExportRows({ amount_paid: missing }, 'Service', context)[0]).toMatchObject({ previous_value: null,
      previous_availability: 'unavailable', previous_limitations: 'No valid prior payment field.' })
  })
})
