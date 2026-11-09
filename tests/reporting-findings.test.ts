import { describe, expect, it } from 'vitest'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import { deriveReportFindings } from '@/lib/reporting/findings'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { reportingFixture } from '../scripts/demo/sample/reports'

const context: ReportingData['context'] = {
  account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: ['Source unavailable.'] }
function fixture(): ReportingData {
  const spend = makeReportMetric({ context, key: 'spend', label: 'Spend', definition: 'Meta spend',
    source: 'meta', unit: 'money', current: 100, previous: 80, coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE })
  return { context, meta: { state: 'available', asOf: context.asOf, notes: [], data: {
    metrics: { spend }, entities: [], series: [], comparisonSeries: [], breakdowns: [], observations: [],
    attributionWindow: '7d click / 1d view', reportingTime: 'impression', sourceDescription: 'Meta',
  } }, business: unavailable, website: unavailable }
}

describe('automatic reporting findings', () => {
  it('keeps refund and cancellation metrics out of legacy report interpretations', () => {
    expect(JSON.stringify(deriveReportFindings(reportingFixture())).match(/cancel|refund|customer returns/i)?.[0]).toBeUndefined()
  })
  it('always covers all seven checks and preserves actual performance when other sources fail', () => {
    const findings = deriveReportFindings(fixture())
    expect(new Set(findings.map(f => f.area)).size).toBe(7)
    expect(findings.find(f => f.area === 'results')).toMatchObject({ status: 'observed' })
    expect(findings.find(f => f.area === 'results')?.detail).toContain('100')
    expect(findings.find(f => f.area === 'journey')?.status).toBe('unavailable')
    expect(findings.find(f => f.area === 'coverage')?.detail).toContain('Outcomes')
  })
  it('binds every investigation link to exact current dates', () => {
    for (const finding of deriveReportFindings(fixture())) {
      const url = new URL(finding.href, 'https://maxx.test')
      expect(url.searchParams.get('from')).toBe(context.range.from)
      expect(url.searchParams.get('to')).toBe(context.range.to)
    }
  })
  it('never turns absent evidence into zero or recommendations', () => {
    const data = { ...fixture(), meta: unavailable }
    const findings = deriveReportFindings(data)
    expect(findings.find(f => f.area === 'results')?.status).toBe('unavailable')
    expect(findings.some(f => /scale|pause|winner|0 bookings/i.test(f.detail))).toBe(false)
  })
  it('ranks measured zero ahead of unknown spend and does not invent an absence of videos', () => {
    const data = fixture()
    const entity = (id: string, spend: number | null): ReportEntity => ({
      id, level: 'ad', name: id, campaignId: null, campaignName: null, adsetId: null, adsetName: null,
      status: 'PAUSED', configurationAsOf: context.asOf, audience: 'unknown', audienceLabel: 'Unresolved',
      creative: { id, name: id, format: 'video', thumbnailUrl: null, imageUrl: null, videoUrl: null,
        durationSeconds: null, body: null, headline: null, destination: null },
      metrics: { spend: makeReportMetric({ context, key: 'spend', label: 'Spend', definition: 'Meta spend',
        source: 'meta', unit: 'money', current: spend, previous: null, coverage: COMPLETE_FIELD_COVERAGE }) },
    })
    data.meta.data!.entities = [entity('unknown-video', null)]
    const missing = deriveReportFindings(data).find(f => f.area === 'attention')!
    expect(missing.status).toBe('unavailable')
    expect(missing.detail).toContain('measured spend value')
    expect(missing.detail).not.toContain('No video ads')
    data.meta.data!.entities = [...data.meta.data!.entities, entity('zero-spend-video', 0)]
    const measured = deriveReportFindings(data).find(f => f.area === 'attention')!
    expect(measured.status).toBe('observed')
    expect(measured.title).toContain('zero-spend-video')
    expect(measured.detail).toContain('Spend: $0')
    expect(new URL(measured.href, 'https://maxx.test').searchParams.get('ad')).toBe('zero-spend-video')
  })
  it('links an ad-set delivery observation to its ads instead of an unrelated ad ID', () => {
    const data = fixture()
    data.meta.data!.entities = [{ id: 'set-1', level: 'adset', name: 'A set', campaignId: null,
      campaignName: null, adsetId: null, adsetName: null, status: 'ACTIVE', configurationAsOf: context.asOf,
      audience: 'unknown', audienceLabel: 'Unresolved', creative: null, metrics: {} }]
    data.meta.data!.observations = [{ id: 'delivery-1', title: 'Delivery', detail: 'Observed learning state.',
      kind: 'delivery', entityId: 'set-1', observedAt: context.asOf }]
    const url = new URL(deriveReportFindings(data).find(f => f.area === 'delivery')!.href, 'https://maxx.test')
    expect(url.searchParams.get('adset')).toBe('set-1')
    expect(url.searchParams.get('level')).toBe('ad')
    expect(url.searchParams.has('ad')).toBe(false)
  })
})

function metric(key: string, current: number | null, previous: number | null = current, source: 'meta' | 'ga4' | 'outcomes' = 'meta') {
  return makeReportMetric({ context, key, label: key === 'spend' ? 'Spend' : key, definition: `${source} ${key}`, source,
    unit: key === 'spend' || key === 'amount_paid' ? 'money' : key.includes('rate') || key.includes('ctr') || key.includes('retention') ? 'percent' : 'count',
    current, previous, coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE })
}
function row(id: string, values: Record<string, [number | null, number | null]>, level: ReportEntity['level'] = 'ad'): ReportEntity {
  return { id, level, name: id, campaignId: null, campaignName: null, adsetId: null, adsetName: null,
    status: 'PAUSED', configurationAsOf: context.asOf, audience: 'unknown', audienceLabel: 'Unresolved',
    creative: { id, name: id, format: 'video', thumbnailUrl: null, imageUrl: null, videoUrl: null, durationSeconds: null, body: null, headline: null, destination: null },
    metrics: Object.fromEntries(Object.entries(values).map(([key, [current, previous]]) => {
      const value = metric(key, current, previous)
      return [key, { ...value, current: { ...value.current, entity: { level, id }, claimId: `${id}:${key}:current` },
        previous: value.previous ? { ...value.previous, entity: { level, id }, claimId: `${id}:${key}:prior` } : null }]
    })) }
}
function withEntities(entities: ReportEntity[]): ReportingData {
  const data = fixture()
  return { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities } } }
}

describe('comparative automatic review', () => {
  it('selects outcome versus spend allocation and keeps paused delivered ads', () => {
    const data = withEntities([row('expensive', { spend: [100, 80], bookings: [0, 2], impressions: [1000, 800] }),
      row('booked', { spend: [20, 20], bookings: [5, 1], impressions: [200, 200] })])
    const result = deriveReportFindings(data).find(f => f.area === 'results')!
    expect(result.detail).toContain('expensive')
    expect(result.detail).toContain('booked')
    expect(result.detail).toContain('bookings: 0 (previous 2)')
    expect(result.detail).toContain('Spend: $20 (previous $20)')
    expect(result.detail).toContain('impressions: 200')
    expect(new URL(result.href, 'https://maxx.test').searchParams.get('compare')?.split(',').sort()).toEqual(['booked', 'expensive'])
  })
  it('compares watch depth and entity click outcomes with exposure, instead of just selecting top spend', () => {
    const data = withEntities([row('watched', { spend: [90, 90], impressions: [900, 900], retention_p50: [70, 60], video_plays: [400, 400], outbound_ctr: [4, 3], bookings: [0, 0] }),
      row('booked', { spend: [30, 30], impressions: [300, 300], retention_p50: [20, 30], video_plays: [100, 100], outbound_ctr: [1, 1], bookings: [3, 1] })])
    for (const area of ['attention', 'click_quality']) {
      const finding = deriveReportFindings(data).find(f => f.area === area)!
      expect(finding.detail).toContain('watched')
      expect(finding.detail).toContain('booked')
      expect(finding.detail).toContain('impressions:')
      expect(new URL(finding.href, 'https://maxx.test').searchParams.get('view')).toBe('compare')
    }
    expect(deriveReportFindings(data).find(f => f.area === 'attention')!.detail).toContain('video_plays:')
  })
  it('compares resolved targeting cohorts without treating unknown as cold', () => {
    const warm = { ...row('warm-set', { spend: [80, 60], bookings: [0, 2] }, 'adset'), audience: 'warm' as const, audienceLabel: 'Warm · website visitors' }
    const cold = { ...row('cold-set', { spend: [20, 30], bookings: [3, 1] }, 'adset'), audience: 'cold' as const, audienceLabel: 'Cold · broad targeting' }
    const finding = deriveReportFindings(withEntities([warm, cold, row('unknown', { spend: [1000, 1] }, 'adset')])).find(f => f.area === 'audience')!
    expect(finding.detail).toContain('Warm · website visitors')
    expect(finding.detail).toContain('Cold · broad targeting')
    expect(finding.detail).toContain(context.asOf)
    expect(finding.detail).toContain('current targeting')
  })
  it('surfaces page/device behavior and useful Acuity evidence before unavailable Meta checks', () => {
    const data = { ...fixture(), meta: unavailable,
      website: { state: 'available' as const, asOf: context.asOf, notes: [], data: {
        metrics: { sessions: metric('sessions', 120, 100, 'ga4') }, series: [], comparisonSeries: [], events: [],
        rows: [{ id: 'mobile', landingPage: '/studio', device: 'mobile', channel: 'Organic Search', metrics: { sessions: metric('sessions', 100, 90, 'ga4'), engagement_rate: metric('engagement_rate', 20, 50, 'ga4') } },
          { id: 'desktop', landingPage: '/studio', device: 'desktop', channel: 'Organic Search', metrics: { sessions: metric('sessions', 20, 10, 'ga4'), engagement_rate: metric('engagement_rate', 80, 70, 'ga4') } }],
        metadata: { timezone: context.timezone, currency: 'USD', subjectToThresholding: false, dataLossFromOtherRow: false, sampled: false, returnedRows: 2, totalRows: 2 }, sourceDescription: 'GA4' } },
      business: { state: 'available' as const, asOf: context.asOf, notes: [], data: { metrics: { paid_bookings: metric('paid_bookings', 5, 3, 'outcomes') }, series: [], comparisonSeries: [], types: [], sourceDescription: 'Acuity' } } }
    const findings = deriveReportFindings(data)
    expect(findings.slice(0, 3).some(f => f.area === 'journey')).toBe(true)
    const journey = findings.find(f => f.area === 'journey')!
    expect(journey.detail).toContain('/studio')
    expect(journey.detail).toContain('mobile')
    expect(journey.detail).toContain('desktop')
    expect(journey.detail).toContain('engagement_rate: 20% (previous 50%)')
    expect(journey.detail).toContain('Outcomes, all sources')
    expect(journey.detail).toContain('paid_bookings: 5 (previous 3)')
    expect(journey.detail).toContain('separate populations')
  })
  it('preserves business-only observations when both advertising and website sources fail', () => {
    const data = { ...fixture(), meta: unavailable, business: { state: 'available' as const, asOf: context.asOf, notes: [], data: {
      metrics: { paid_bookings: metric('paid_bookings', 5, 3, 'outcomes') }, series: [], comparisonSeries: [], types: [], sourceDescription: 'Acuity' } } }
    const findings = deriveReportFindings(data)
    expect(findings[0].status).toBe('observed')
    expect(findings[0].detail).toContain('paid_bookings: 5 (previous 3)')
  })
  it('reports unchanged only for a valid measured comparison and leaves unknown prior unknown', () => {
    const data = fixture()
    const equal = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, metrics: { spend: metric('spend', 0, 0) } } } }
    expect(deriveReportFindings(equal).find(f => f.area === 'results')!.status).toBe('no_notable_difference')
    const missing = { ...equal, meta: { ...equal.meta, data: { ...equal.meta.data!, metrics: { spend: metric('spend', 0, null) } } } }
    const finding = deriveReportFindings(missing).find(f => f.area === 'results')!
    expect(finding.status).toBe('observed')
    expect(finding.detail).toContain('comparison unavailable')
    expect(finding.detail).not.toContain('unchanged')
  })
  it('does not rank partial or mismatched prior evidence as a measured change', () => {
    const data = fixture()
    const spend = metric('spend', 100, 1)
    const partial = { ...spend, current: { ...spend.current, coverage: { state: 'partial' as const, numerator: 1, denominator: 2 } } }
    const finding = deriveReportFindings({ ...data, meta: { ...data.meta, data: { ...data.meta.data!, metrics: { spend: partial } } } }).find(f => f.area === 'results')!
    expect(finding.detail).toContain('comparison unavailable')
    expect(finding.detail).toContain('Partial')
    expect(finding.status).not.toBe('no_notable_difference')
  })
})

describe('comparison boundaries and selection controls', () => {
  it('rejects an out-of-period prior instead of treating it as a measured difference', () => {
    const data = fixture()
    const spend = metric('spend', 100, 1)
    const bad = { ...spend, previous: { ...spend.previous!, window: { ...spend.previous!.window, start: '2026-08-01', end: '2026-08-03' } } }
    const result = deriveReportFindings({ ...data, meta: { ...data.meta, data: { ...data.meta.data!, metrics: { spend: bad } } } }).find(f => f.area === 'results')!
    expect(result.detail).toContain('comparison unavailable')
    expect(result.detail).not.toContain('previous $1)')
    expect(result.detail).not.toContain('Largest matched relative change')
  })
  it('selects the execution with a measured attention change even if another spent more', () => {
    const data = withEntities([row('steady-high-spend', { spend: [1000, 1000], video_plays: [500, 500], retention_p50: [60, 60] }),
      row('changed-watch', { spend: [10, 10], video_plays: [20, 20], retention_p50: [60, 10] })])
    const attention = deriveReportFindings(data).find(f => f.area === 'attention')!
    expect(attention.detail).toContain('changed-watch')
    expect(attention.detail).toContain('retention_p50: 60% (previous 10%)')
  })
  it('does not manufacture same-event contrasts from conflicting metric event identities', () => {
    const a = row('purchase', { spend: [100, 100], bookings: [0, 0] })
    const b = row('appointment', { spend: [20, 20], bookings: [10, 10] })
    const conflict = { ...a, metrics: { ...a.metrics, bookings: { ...a.metrics.bookings, event: 'Purchase' } } }
    const data = withEntities([conflict, b])
    expect(deriveReportFindings(data).find(f => f.area === 'results')!.detail).not.toContain('order these rows differently')
  })
  it('does not erase a comparison limit when all usable current values equal their prior values', () => {
    const data = fixture()
    const spend = metric('spend', 100, 100)
    const value = { ...spend, current: { ...spend.current, maturity: { state: 'settling' as const, matureThrough: null } } }
    const result = deriveReportFindings({ ...data, meta: { ...data.meta, data: { ...data.meta.data!, metrics: { spend: value } } } }).find(f => f.area === 'results')!
    expect(result.status).toBe('no_notable_difference')
    expect(result.detail).toContain('settling')
    expect(result.detail).toContain(context.comparison.from)
  })
  it('selects the same entity comparison when inventory order changes', () => {
    const entities = [row('b', { spend: [100, 100], bookings: [0, 1] }), row('a', { spend: [20, 20], bookings: [5, 1] }), row('c', { spend: [10, 10], bookings: [1, 1] })]
    expect(deriveReportFindings(withEntities(entities))).toEqual(deriveReportFindings(withEntities([...entities].reverse())))
  })
})

describe('optional paid-association and transport context', () => {
  it('keeps positive paid lower bounds distinct from CAPI receipts and preserves their limits', () => {
    const paid = makeReportMetric({ context, key: 'linked_value_bearing_bookings', label: 'Linked value-bearing bookings',
      source: 'first_party_attribution', unit: 'count', current: 2, definition: 'Observed identity-linked bookings.',
      coverage: { state: 'partial', numerator: null, denominator: null } })
    const receipt = makeReportMetric({ context, key: 'accepted_live_confirmations', label: 'Accepted live confirmations',
      source: 'capi', unit: 'count', current: 4, definition: 'Accepted CAPI receipts.', coverage: COMPLETE_FIELD_COVERAGE })
    const data: ReportingData = { ...fixture(), measurement: { state: 'available', asOf: context.asOf, notes: [], data: {
      paidAssociation: { linked_value_bearing_bookings: paid }, capi: { accepted_live_confirmations: receipt },
      paidAssociationNotes: ['No complete association window manifest.'], capiNotes: ['Accepted receipt does not prove ad attribution.'], sourceDescription: 'Internal evidence' } } }
    const findings = deriveReportFindings(data)
    const journey = findings.find(f => f.area === 'journey')!
    expect(journey.detail).toContain('Linked value-bearing bookings: 2')
    expect(journey.detail).toContain('lower bound')
    expect(journey.detail).toContain('No complete association window manifest.')
    const coverage = findings.find(f => f.area === 'coverage')!
    expect(coverage.detail).toContain('Accepted live confirmations: 4')
    expect(coverage.detail).toContain('Accepted receipt does not prove ad attribution.')
    expect(coverage.metrics).toContain(receipt)
    expect(findings.some(f => /paid CPA:|exact paid/i.test(f.detail))).toBe(false)
  })
  it('retains measurement loading and unavailable states without replacing them by zero', () => {
    const findings = deriveReportFindings({ ...fixture(), measurement: { state: 'loading', data: null, asOf: null, notes: ['Paid association is loading.'] } })
    expect(findings.find(f => f.area === 'coverage')!.detail).toContain('Paid association is loading.')
    expect(findings.find(f => f.area === 'journey')!.detail).not.toMatch(/linked.*: 0/i)
  })
})

it('does not relabel spend-only inventory as measured click quality', () => {
  const data = withEntities([row('spend-only', { spend: [100, 100] })])
  expect(deriveReportFindings(data).find(f => f.area === 'click_quality')!.status).toBe('unavailable')
})

describe('concise review summaries', () => {
  it('summarizes the chosen contrast, actual prior values and exposure while retaining full detail', () => {
    const findings = deriveReportFindings(withEntities([
      row('expensive', { spend: [100, 80], bookings: [0, 2], impressions: [1000, 800], purchase_roas: [2, 1], cost_per_booking: [null, 40] }),
      row('booked', { spend: [20, 20], bookings: [5, 1], impressions: [200, 200], purchase_roas: [3, 1], cost_per_booking: [4, 20] }),
    ]))
    const result = findings.find(f => f.area === 'results')!
    expect(result.summary).toContain('expensive')
    expect(result.summary).toContain('booked')
    expect(result.summary).toContain('bookings: 0 (previous 2)')
    expect(result.summary).toContain('impressions: 200 (previous 200)')
    expect(result.summary).not.toContain('purchase_roas')
    expect(result.detail).toContain('purchase_roas')
    expect(result.summary!.length).toBeLessThan(result.detail.length)
    expect(findings.every(f => !!f.summary)).toBe(true)
  })
  it('preserves valid account outcomes when lower-level outcomes cannot be measured', () => {
    const base = withEntities([row('spend-only', { spend: [100, 80], impressions: [1000, 800] })])
    const data = { ...base, meta: { ...base.meta, data: { ...base.meta.data!, metrics: {
      spend: metric('spend', 100, 80), bookings: metric('bookings', 6, 3), cost_per_booking: metric('cost_per_booking', 16.67, 26.67),
    } } } }
    const result = deriveReportFindings(data).find(f => f.area === 'results')!
    expect(result.summary).toContain('Meta account')
    expect(result.summary).toContain('bookings: 6 (previous 3)')
    expect(result.summary).toContain('Ad-level outcomes unavailable')
    expect(result.detail).toContain('Meta account results')
    expect(result.metrics).toContain(data.meta.data.metrics.bookings)
    expect(result.detail).not.toContain('spend-only: bookings: 6')
  })
  it('retains unknown comparison and partial evidence qualifiers in the short summary', () => {
    const base = fixture()
    const spend = metric('spend', 100, null)
    const partial = { ...spend, current: { ...spend.current, coverage: { state: 'partial' as const, numerator: 1, denominator: 2 } } }
    const result = deriveReportFindings({ ...base, meta: { ...base.meta, data: { ...base.meta.data!, metrics: { spend: partial } } } }).find(f => f.area === 'results')!
    expect(result.summary).toContain('previous unavailable')
    expect(result.summary).toContain('Partial evidence')
  })
})
