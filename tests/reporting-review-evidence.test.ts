import { describe, expect, it } from 'vitest'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportingData } from '@/lib/reporting/contracts'
import { comparable, delta, metricEvidence, numeric, statement, verifyFindingReferences, unavailableFinding } from '@/lib/reporting/review/evidence'

const context: ReportingData['context'] = {
  account: { id: 'report-account', metaAccountId: 'act_1', name: 'Synthetic studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
const metric = () => makeReportMetric({ context, key: 'spend', label: 'Spend', definition: 'Meta spend', source: 'meta', unit: 'money',
  current: 100, previous: 80, coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE })
function fixture(): ReportingData {
  const absent = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
  return { context, meta: { state: 'available', asOf: context.asOf, notes: [], data: { metrics: { spend: metric() }, entities: [],
    series: [], comparisonSeries: [], breakdowns: [], observations: [], attributionWindow: 'Native', reportingTime: 'impression', sourceDescription: 'Meta' } }, business: absent, website: absent }
}

describe('expert review evidence identity and comparison controls', () => {
  it('retains exact evidence content and source generation instead of treating a reused claim ID as identity', () => {
    const data = fixture()
    const evidence = metricEvidence(data, 'meta', ['metrics', 'spend'])!
    expect(evidence.path).toBe('/meta/data/metrics/spend')
    expect(evidence.sourceAsOf).toBe(data.meta.asOf)
    expect(evidence.metric).toEqual(data.meta.data!.metrics.spend)
    expect(evidence.metric).not.toBe(data.meta.data!.metrics.spend)
    const finding = { ...unavailableFinding(data, { id: 'test', area: 'advertising', title: 'Check', reason: 'No verdict', href: '/performance' }),
      observation: statement('Measured spend.', evidence) }
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    const changed = { ...evidence, metric: { ...evidence.metric, current: { ...evidence.metric.current, value: 999 } } }
    expect(() => verifyFindingReferences(data, { ...finding, observation: statement('Changed spend', changed) })).toThrow()
    expect(() => verifyFindingReferences({ ...data, meta: { ...data.meta, asOf: '2026-09-05T17:00:00Z' } }, finding)).toThrow()
  })
  it('does not resolve another section, missing metric or inherited property as evidence', () => {
    const data = fixture()
    expect(metricEvidence(data, 'business', ['metrics', 'spend'])).toBeNull()
    expect(metricEvidence(data, 'meta', ['metrics', 'missing'])).toBeNull()
    expect(metricEvidence(data, 'meta', ['metrics', '__proto__'])).toBeNull()
    expect(metricEvidence(data, 'meta', ['metrics', 'constructor'])).toBeNull()
  })
  it('identifies distinct populations behind repeated metric labels', () => {
    const data = fixture()
    const entity = (id: string, name: string) => ({ id, level: 'ad' as const, name, campaignId: null, campaignName: null,
      adsetId: null, adsetName: null, status: 'PAUSED', configurationAsOf: null, audience: 'unknown' as const,
      audienceLabel: 'Unknown', creative: null, metrics: { spend: makeReportMetric({ context, key: 'spend', label: 'Spend',
        definition: 'Meta spend', source: 'meta', unit: 'money', current: 10, entity: { level: 'ad', id }, coverage: COMPLETE_FIELD_COVERAGE }) } })
    const changed = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: [entity('a', 'Walkthrough'), entity('b', 'Portrait')] } } }
    expect(metricEvidence(changed, 'meta', ['entities', 0, 'metrics', 'spend'])?.populationLabel).toContain('Walkthrough')
    expect(metricEvidence(changed, 'meta', ['entities', 1, 'metrics', 'spend'])?.populationLabel).toContain('Portrait')
  })
  it('distinguishes explicit zero from unknown and compares only compatible complete periods', () => {
    const measured = metric()
    expect(delta(measured)).toBe(20)
    expect(numeric({ ...measured, current: { ...measured.current, value: 0 } })).toBe(0)
    expect(numeric(undefined)).toBeNull()
    expect(numeric({ ...measured, current: { ...measured.current, value: null } })).toBeNull()
    for (const modified of [
      { ...measured, previous: { ...measured.previous!, coverage: { state: 'partial' as const, numerator: 1, denominator: 2 } } },
      { ...measured, previous: { ...measured.previous!, entity: { level: 'account' as const, id: 'wrong-account' } } },
      { ...measured, previous: { ...measured.previous!, window: { ...measured.previous!.window, start: '2026-08-29' } } },
      { ...measured, previous: { ...measured.previous!, source: { ...measured.previous!.source, system: 'ga4' as const } } },
      { ...measured, previous: { ...measured.previous!, maturity: { ...measured.previous!.maturity, state: 'partial' as const } } },
      { ...measured, previous: { ...measured.previous!, definitionVersion: 2 } },
    ]) expect(delta(modified)).toBeNull()
    expect(comparable(measured, { ...measured, event: 'different-event' })).toBe(false)
  })
  it('requires exact dates and a supported internal inspection route', () => {
    const data = fixture()
    const finding = unavailableFinding(data, { id: 'test', area: 'advertising', title: 'Check', reason: 'No verdict', href: '/performance' })
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    for (const href of ['https://example.com', '/performance?from=2026-01-01&to=2026-01-02', '/api/reporting']) {
      expect(() => verifyFindingReferences(data, { ...finding, nextInspection: { ...finding.nextInspection, href } })).toThrow()
    }
  })
  it('checks exposure arithmetic, input units and additive population identity', () => {
    const data = fixture()
    const ref = metricEvidence(data, 'meta', ['metrics', 'spend'])!
    const base = { ...unavailableFinding(data, { id: 'test', area: 'advertising', title: 'Check', reason: 'No verdict', href: '/performance' }),
      observation: statement('Recorded spend', ref), exposure: { value: 100, unit: 'money' as const, evidence: [ref] } }
    expect(() => verifyFindingReferences(data, base)).not.toThrow()
    for (const exposure of [
      { value: 999, unit: 'money' as const, evidence: [ref] },
      { value: 100, unit: 'count' as const, evidence: [ref] },
      { value: 200, unit: 'money' as const, evidence: [ref, ref] },
    ]) expect(() => verifyFindingReferences(data, { ...base, exposure })).toThrow()
    const impressions = makeReportMetric({ context, key: 'impressions', label: 'Impressions', definition: 'Meta impressions',
      source: 'meta', unit: 'count', current: 100, coverage: COMPLETE_FIELD_COVERAGE })
    const reach = makeReportMetric({ context, key: 'reach', label: 'Reach', definition: 'Native reach',
      source: 'meta', unit: 'count', current: 100, coverage: COMPLETE_FIELD_COVERAGE })
    const changed = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, metrics: { ...data.meta.data!.metrics, impressions, reach } } } }
    const impressionRef = metricEvidence(changed, 'meta', ['metrics', 'impressions'])!
    const reachRef = metricEvidence(changed, 'meta', ['metrics', 'reach'])!
    expect(() => verifyFindingReferences(changed, { ...base, exposure: { value: 200, unit: 'count', evidence: [impressionRef, reachRef] } })).toThrow()
  })
  it('does not add parent totals to child populations even when source, level and units match', () => {
    const data = fixture()
    const paid = (id: string, amount: number) => makeReportMetric({ context, key: 'amount_paid', label: 'Amount paid',
      definition: 'Recorded payment amount.', source: 'outcomes', unit: 'money', current: amount,
      entity: { level: 'business', id }, coverage: COMPLETE_FIELD_COVERAGE })
    const changed: ReportingData = { ...data, business: { state: 'available', asOf: context.asOf, notes: [], data: {
      metrics: { amount_paid: paid(context.account.id, 100) }, series: [], comparisonSeries: [], sourceDescription: 'Acuity',
      types: [{ id: 'type-a', name: 'Rental A', category: 'unknown', metrics: { amount_paid: paid(`${context.account.id}:type:type-a`, 40) } },
        { id: 'type-b', name: 'Rental B', category: 'unknown', metrics: { amount_paid: paid(`${context.account.id}:type:type-b`, 60) } }],
    } } }
    const parent = metricEvidence(changed, 'business', ['metrics', 'amount_paid'])!
    const child = metricEvidence(changed, 'business', ['types', 0, 'metrics', 'amount_paid'])!
    const other = metricEvidence(changed, 'business', ['types', 1, 'metrics', 'amount_paid'])!
    const base = unavailableFinding(changed, { id: 'check', area: 'business', title: 'Payment population', reason: 'No verdict', href: '/reports' })
    expect(() => verifyFindingReferences(changed, { ...base, exposure: { value: 100, unit: 'money', evidence: [child, other] } })).not.toThrow()
    expect(() => verifyFindingReferences(changed, { ...base, exposure: { value: 140, unit: 'money', evidence: [parent, child] } })).toThrow()
  })
})
