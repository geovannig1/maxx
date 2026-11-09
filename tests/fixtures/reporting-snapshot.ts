import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '../../src/lib/reporting/claims'
import type { ReportingContext, ReportingPacket } from '../../src/lib/reporting/contracts'

export const snapshotContext: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00.000Z',
}

export function snapshotPacket(context = snapshotContext): Extract<ReportingPacket, { section: 'meta' }> {
  const metric = (key: string, current: number | null) => makeReportMetric({ context, key, current,
    label: key, definition: `Native ${key}`, source: 'meta', unit: 'count', previous: 1,
    coverage: current === null ? { state: 'unknown', numerator: null, denominator: null } : COMPLETE_FIELD_COVERAGE,
    previousCoverage: COMPLETE_FIELD_COVERAGE, sourceHead: 'fixture-source-head',
  })
  return { context, section: 'meta', notes: ['Fictional persistence fixture.'], result: {
    state: 'partial', asOf: context.asOf, notes: ['Missing field remains unknown.'], data: {
      metrics: { clicks: metric('clicks', 0), missing: metric('missing', null) },
      entities: [], series: [], comparisonSeries: [], breakdowns: [], observations: [],
      attributionWindow: 'Fixture', reportingTime: 'Fixture', sourceDescription: 'Fictional data', detailState: 'complete',
    },
  } }
}
