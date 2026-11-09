import { describe, expect, it } from 'vitest'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import { deriveCreativeReview } from '@/lib/reporting/review/creative'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { snapshotContext as context } from './fixtures/reporting-snapshot'

// Synthetic native Meta rows; these numbers do not describe a connected account.
type Values = { spend: number; impressions: number; starts: number | null; midpoint: number | null;
  outbound: number | null; landing: number | null; bookings: number | null }
const base: Values = { spend: 900, impressions: 10000, starts: 5000, midpoint: 1000,
  outbound: 200, landing: 150, bookings: 12 }
const action = (value: number | null, action_type: string) => value === null ? undefined : [{ action_type, value: String(value) }]
function native(values: Values): MetaRow {
  return { spend: String(values.spend), impressions: String(values.impressions), inline_link_clicks: '500',
    video_play_actions: action(values.starts, 'video_view'), video_p50_watched_actions: action(values.midpoint, 'video_view'),
    outbound_clicks: action(values.outbound, 'outbound_click'), actions: action(values.landing, 'landing_page_view'),
    results: values.bookings === null ? undefined : [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
      values: [{ value: String(values.bookings), attribution_windows: ['default'] }] }],
  }
}
function ad(id = 'long-offer', values: Partial<Values> = {}, duration: number | null = 60, prior?: Partial<Values>): ReportEntity {
  return { id, name: id, level: 'ad', campaignId: 'campaign-1', campaignName: 'Synthetic campaign', adsetId: 'adset-1', adsetName: 'Synthetic ad set',
    status: 'ACTIVE', configurationAsOf: context.asOf, audience: 'unknown', audienceLabel: 'Not supplied',
    creative: { id: `asset-${id}`, name: id, format: 'video', durationSeconds: duration, body: 'Synthetic offer qualification',
      headline: 'Synthetic studio offer', destination: `https://example.test/offers/${id}`, imageUrl: null, thumbnailUrl: null, videoUrl: null },
    metrics: buildMetaMetrics(context, native({ ...base, ...values }), prior ? native({ ...base, ...prior }) : undefined, { level: 'ad', id }),
  }
}
function report(entities: ReportEntity[]): ReportingData {
  const absent = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
  return { context, meta: { state: 'available', asOf: context.asOf, notes: [], data: {
    metrics: {}, entities, series: [], comparisonSeries: [], breakdowns: [], observations: [],
    attributionWindow: 'Native default', reportingTime: 'impression', sourceDescription: 'Synthetic Meta response', detailState: 'complete',
  } }, business: absent, website: absent }
}
const attention = (data: ReportingData) => deriveCreativeReview(data).find(f => f.id === 'creative_attention')!
const landing = (data: ReportingData) => deriveCreativeReview(data).find(f => f.id === 'creative_landing')!
const short = () => ad('short-offer', { spend: 200, impressions: 4000, starts: 2000, midpoint: 1600, outbound: 40, bookings: 4 }, 10)

describe('creative attention investigation', () => {
  it('prioritizes measured exposure and reflects stronger response despite lower watch percentage', () => {
    const tiny = ad('tiny-extreme', { spend: 1, impressions: 2, starts: 1, midpoint: 1, outbound: 1, bookings: 0 }, 6)
    const data = report([tiny, short(), ad()])
    expect(() => validateReportingPacket({ context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const finding = attention(data)
    expect(finding.status).toBe('mixed')
    expect(finding.exposure).toMatchObject({ value: 900, unit: 'money' })
    expect(new URL(finding.nextInspection.href, 'https://maxx.local').searchParams.get('ad')).toBe('long-offer')
    expect(finding.observation.text).toContain('5,000')
    expect(finding.observation.text).toContain('1,000')
    expect(finding.observation.text).toContain('20%')
    expect(finding.counterEvidence.text).toMatch(/lower.*watch.*higher.*outbound/i)
    expect(finding.counterEvidence.text).toContain('12')
    expect(finding.nextInspection.question).toMatch(/qualif/i)
    expect(finding.observation.evidence.some(ref => ref.metric.current.entity.id === 'tiny-extreme')).toBe(false)
    for (const review of deriveCreativeReview(data)) expect(() => verifyFindingReferences(data, review)).not.toThrow()
  })

  it('changes the investigation when the same attention now accompanies weaker response', () => {
    const stronger = attention(report([ad(), short()]))
    const weaker = attention(report([ad('long-offer', { outbound: 20, bookings: 0 }), short()]))
    expect(weaker.status).toBe('observed')
    expect(weaker.nextInspection.question).not.toBe(stronger.nextInspection.question)
    expect(weaker.nextInspection.question).toMatch(/message|offer/i)
    expect(weaker.counterEvidence.text).not.toMatch(/higher outbound/i)
  })

  it('keeps current preview lengths separate from unverified historical elapsed viewing time', () => {
    const finding = attention(report([ad(), short()]))
    expect(finding.observation.text).toContain('60 seconds')
    expect(finding.observation.text).not.toContain('the 50% point is')
    expect(finding.observation.text).toContain('10 seconds')
    expect(finding.observation.text).toContain('Current preview duration')
    expect(finding.limitations.join(' ')).toMatch(/different.*duration|duration.*different/i)
    expect(finding.limitations.join(' ')).toMatch(/unequal|optimizer/i)
    expect(attention(report([ad('unknown-duration', {}, null)])).limitations.join(' ')).toMatch(/duration.*unavailable/i)
  })

  it('keeps one measured start visible without inferring adequate exposure or weak creative', () => {
    const finding = attention(report([ad('one-start', { spend: 1, impressions: 2, starts: 1, midpoint: 0, outbound: 0, bookings: 0 })]))
    expect(finding.observation.text).toMatch(/0.*50%.*1 video start/i)
    expect(finding.exposure?.value).toBe(1)
    expect(finding.limitations.join(' ')).toMatch(/adequate|sufficient|experiment/i)
    expect(finding.explanations.every(explanation => explanation.missing.length > 0)).toBe(true)
    expect(finding.authority).toEqual({ state: 'diagnostic', executable: false })
  })

  it('does not turn missing watch or zero starts into weak creative', () => {
    expect(attention(report([ad('missing-watch', { midpoint: null })])).status).toBe('unavailable')
    expect(attention(report([ad('no-starts', { starts: 0, midpoint: 0 })])).status).toBe('unavailable')
    expect(attention(report([ad('zero-watch', { midpoint: 0 })])).status).not.toBe('unavailable')
  })

  it('uses eligible prior evidence but withdraws a trend when the prior definition is incompatible', () => {
    const entity = ad('prior-offer', {}, 60, { midpoint: 3000, outbound: 50 })
    const positive = attention(report([entity]))
    expect(positive.status).toBe('mixed')
    expect(positive.observation.text).toMatch(/prior/i)
    const retention = entity.metrics.retention_p50
    const invalid = { ...entity, metrics: { ...entity.metrics, retention_p50: { ...retention,
      previous: { ...retention.previous!, definitionVersion: 2 } } } }
    const blocked = attention(report([invalid]))
    expect(blocked.status).not.toBe('mixed')
    expect(blocked.observation.text).not.toMatch(/prior.*60%/i)
    expect(blocked.limitations.join(' ')).toMatch(/compatible.*comparison/i)
  })

  it('does not relabel another event as AppointmentConfirmed counterevidence', () => {
    const entity = ad()
    const invalid = { ...entity, metrics: { ...entity.metrics, bookings: { ...entity.metrics.bookings, event: 'Purchase' } } }
    const finding = attention(report([invalid, short()]))
    expect(finding.counterEvidence.text).toMatch(/AppointmentConfirmed.*unavailable/i)
    expect(finding.counterEvidence.evidence.some(ref => ref.metric.event === 'Purchase')).toBe(false)
    expect(finding.observation.text).not.toMatch(/fatigue|placement.*watch/i)
  })

  it('withdraws cross-ad contrast when the response event or attribution definition differs', () => {
    const other = short()
    for (const replacement of [
      { ...other.metrics.outbound_ctr, event: 'DifferentEvent' },
      { ...other.metrics.outbound_ctr, current: { ...other.metrics.outbound_ctr.current, attributionScope: 'none' as const } },
    ]) {
      const finding = attention(report([ad(), { ...other, metrics: { ...other.metrics, outbound_ctr: replacement } }]))
      expect(finding.status).not.toBe('mixed')
      expect(finding.observation.evidence.some(ref => ref.metric.current.entity.id === 'short-offer')).toBe(false)
    }
  })

  it.each(['retention_p50', 'outbound_ctr'])('withholds inconsistent current %s while retaining the native counts', key => {
    const entity = ad('arithmetic-control', { starts: 100, midpoint: 20, impressions: 1000, outbound: 20 })
    const good = attention(report([entity]))
    expect(good.status).toBe('observed')
    expect(good.observation.text).toContain('(20%)')
    expect(good.observation.text).toContain('2% outbound CTR')
    const changed = { ...entity, metrics: { ...entity.metrics, [key]: { ...entity.metrics[key],
      current: { ...entity.metrics[key].current, value: 80 } } } }
    // Structural lineage validation alone does not prove the arithmetic.
    expect(() => validateReportingPacket({ context, section: 'meta', result: report([changed]).meta, notes: [] })).not.toThrow()
    const bad = attention(report([changed]))
    expect(bad.status).toBe('unavailable')
    expect(bad.observation.text).toContain('20 50% watches from 100 video starts')
    expect(bad.observation.text).toContain('20 outbound clicks')
    expect(bad.observation.text).not.toContain('80%')
    expect(bad.observation.evidence.some(ref => ref.metric.key === key)).toBe(false)
    expect(bad.nextInspection.question).toMatch(/arithmetic|rate|denominator/i)
  })

  it.each(['retention_p50', 'outbound_ctr'])('withholds a prior %s contrast when the supplied ratio contradicts its native counts', key => {
    const entity = ad('prior-arithmetic', { starts: 100, midpoint: 20, impressions: 1000, outbound: 20 }, 60,
      { starts: 100, midpoint: 60, impressions: 1000, outbound: 5 })
    expect(attention(report([entity])).status).toBe('mixed')
    const changed = { ...entity, metrics: { ...entity.metrics, [key]: { ...entity.metrics[key],
      previous: { ...entity.metrics[key].previous!, value: 80 } } } }
    const bad = attention(report([changed]))
    expect(bad.status).not.toBe('mixed')
    expect(bad.observation.text).not.toMatch(/prior equal period|80%/i)
    expect(bad.observation.text).toContain('20 50% watches from 100 video starts')
    expect(bad.limitations.join(' ')).toMatch(/compatible.*comparison/i)
    expect(bad.limitations.join(' ')).toMatch(/prior rates.*withheld/i)
  })

  it.each(['unit', 'basis', 'event'])('does not give native video meaning to a metric with the wrong %s', field => {
    const entity = ad()
    const plays = entity.metrics.video_plays
    const replacement = field === 'event' ? { ...plays, event: 'Purchase' }
      : { ...plays, current: field === 'unit' ? { ...plays.current, unit: 'money' as const }
        : { ...plays.current, window: { ...plays.current.window, basis: 'closed_account_days' as const } } }
    const bad = attention(report([{ ...entity, metrics: { ...entity.metrics, video_plays: replacement } }]))
    expect(bad.status).toBe('unavailable')
    expect(bad.observation.text).not.toContain('5,000 video starts')
  })
})

describe('outbound and landing-page observation investigation', () => {
  it('keeps aggregate counts distinct and asks for the exact destination and placement inspection', () => {
    const data = report([ad()])
    const finding = landing(data)
    expect(finding.status).toBe('observed')
    expect(finding.observation.text).toContain('200 outbound clicks')
    expect(finding.observation.text).toContain('150 landing-page views')
    expect(finding.exposure).toMatchObject({ value: 900, unit: 'money' })
    expect(finding.nextInspection.question).toContain('https://example.test/offers/long-offer')
    expect(finding.nextInspection.question).toMatch(/placement/i)
    expect(finding.limitations.join(' ')).toMatch(/not.*joined/i)
    expect(finding.observation.text).not.toMatch(/lost|bounce|drop.?off|25%/i)
    expect(finding.nextInspection.outcomes).toHaveLength(2)
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
  })

  it('distinguishes unknown landing views from reported zero with the outgoing evidence retained', () => {
    const missing = landing(report([ad('missing-landing', { landing: null })]))
    const zero = landing(report([ad('zero-landing', { landing: 0 })]))
    expect(missing.status).toBe('unavailable')
    expect(missing.observation.text).toContain('200 outbound clicks')
    expect(missing.observation.text).toMatch(/landing-page views unavailable/i)
    expect(zero.status).toBe('observed')
    expect(zero.observation.text).toContain('0 landing-page views')
    expect(missing.nextInspection.question).not.toBe(zero.nextInspection.question)
    expect(missing.observation.text + zero.observation.text).not.toMatch(/100%|all.*lost/i)
  })

  it('uses reported landing counts at or above clicks as counterevidence to an assumed arrival deficit', () => {
    const lower = landing(report([ad()]))
    const higher = landing(report([ad('higher-landings', { landing: 220 })]))
    expect(higher.nextInspection.question).not.toBe(lower.nextInspection.question)
    expect(higher.counterEvidence.text).toMatch(/not lower|at least|exceed/i)
    const empty = landing(report([ad('no-clicks', { outbound: 0, landing: 0 })]))
    expect(empty.status).toBe('unchanged')
    expect(empty.nextInspection.question).toMatch(/delivery|outbound/i)
  })

  it('does not substitute link clicks or prioritize a tiny high count difference over spend', () => {
    const entity = ad('no-outbound', { outbound: null })
    expect(entity.metrics.link_clicks.current.value).toBe(500)
    expect(landing(report([entity])).status).toBe('unavailable')
    const tiny = ad('tiny', { spend: 1, impressions: 10, outbound: 10, landing: 0 })
    expect(landing(report([tiny, ad()])).exposure?.value).toBe(900)
  })

  it('withdraws the landing relationship when its event or attribution scope differs from native outbound observations', () => {
    const entity = ad()
    for (const replacement of [
      { ...entity.metrics.landing_page_views, event: 'Purchase' },
      { ...entity.metrics.landing_page_views, current: { ...entity.metrics.landing_page_views.current, attributionScope: 'none' as const } },
    ]) {
      const finding = landing(report([{ ...entity, metrics: { ...entity.metrics, landing_page_views: replacement } }]))
      expect(finding.status).toBe('unavailable')
      expect(finding.observation.text).not.toContain('150 landing-page views')
    }
  })
})
