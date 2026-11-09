import { describe, expect, it } from 'vitest'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportMetric, ReportingData, WebsiteRow } from '@/lib/reporting/contracts'
import { deriveJourneyReview } from '@/lib/reporting/review/journey'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { websiteRowKey, websiteRowAnchor, websiteEventAnchor } from '@/lib/reporting/website-identity'
import { buildWebsiteReport, type BuildWebsiteReportInput } from '@/lib/reporting/website-metrics'
import { matchedWebsitePairs, websitePopulationReview } from '@/lib/reporting/review/website-population'

const context: ReportingData['context'] = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Fictional studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
function traffic(index: number, key: string, current: number | null, previous?: number | null): ReportMetric {
  return structuredClone(makeReportMetric({ context, source: 'ga4', key, label: key, definition: `Native GA4 ${key}.`,
    unit: key === 'engagement_rate' ? 'percent' : 'count', current, previous,
    entity: { level: 'account', id: `${context.account.id}:journey:${index}` },
    coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE }))
}
function page(index: number, landingPage: string, device: string, sessions: number, rate: number,
  priorSessions?: number, priorRate?: number): WebsiteRow {
  const row = { landingPage, device, channel: 'Paid Social' }
  return { ...row, id: websiteRowKey(row), metrics: {
    sessions: traffic(index, 'sessions', sessions, priorSessions),
    engaged_sessions: traffic(index, 'engaged_sessions', sessions * rate / 100,
      priorSessions === undefined || priorRate === undefined ? undefined : priorSessions * priorRate / 100),
    engagement_rate: traffic(index, 'engagement_rate', rate, priorRate),
  } }
}
function data(rows: WebsiteRow[]): ReportingData {
  return { context, meta: { state: 'unavailable', data: null, asOf: null, notes: [] },
    business: { state: 'unavailable', data: null, asOf: null, notes: [] },
    website: { state: 'available', asOf: context.asOf, notes: [], data: {
      sourceDescription: 'Fictional GA4 traffic', metrics: {}, rows, events: [],
      metadata: { timezone: context.timezone, currency: 'USD', subjectToThresholding: false,
        dataLossFromOtherRow: false, sampled: false, returnedRows: rows.length, totalRows: rows.length },
    } } }
}
function pageFinding(fixture: ReportingData, row: WebsiteRow) {
  return deriveJourneyReview(fixture).find(finding => finding.id === `journey.page:${websiteRowKey(row)}`)
}

describe('complete website investigation', () => {
  it('surfaces a smaller declining row before an unchanged highest-session pair', () => {
    const fixture = data([page(0, '/large', 'mobile', 1000, 50, 1000, 50), page(1, '/large', 'desktop', 1000, 50, 1000, 50),
      page(2, '/book', 'mobile', 100, 20, 100, 70), page(3, '/book', 'desktop', 100, 60, 100, 60)])
    validateReportingPacket({ context, section: 'website', result: fixture.website, notes: [] })
    const findings = deriveJourneyReview(fixture)
    expect(findings.filter(finding => finding.id.startsWith('journey.page:'))).toHaveLength(4)
    const decline = pageFinding(fixture, fixture.website.data!.rows[2])!
    expect(decline).toMatchObject({ direction: 'declined', priority: 'investigate' })
    expect(decline.observation.text).toContain('70%')
    expect(decline.observation.text).toContain('20%')
    expect(overviewFindings(deriveExpertReview(fixture)).some(finding => finding.id === decline.id)).toBe(true)
    verifyFindingReferences(fixture, decline)
    const url = new URL(decline.nextInspection.href, 'https://maxx.local')
    expect(url.searchParams.get('website_page')).toBe('/book')
    expect(url.searchParams.get('website_device')).toBe('mobile')
    expect(url.hash).toBe(`#${websiteRowAnchor(fixture.website.data!.rows[2])}`)
    expect(deriveExpertReview(fixture).populationCoverage).toContainEqual({ family: 'Website', level: 'page', supplied: 4, evaluated: 4, limited: 0 })
  })

  it('assesses every one-dimension group instead of a single largest-volume pair', () => {
    const fixture = data([page(0, '/large', 'mobile', 1000, 50), page(1, '/large', 'desktop', 1000, 50),
      page(2, '/book', 'mobile', 100, 20), page(3, '/book', 'desktop', 100, 60)])
    const groups = deriveJourneyReview(fixture).filter(finding => finding.id === 'journey.ga4.matched_pair' || finding.id.startsWith('journey.group:'))
    expect(groups).toHaveLength(4)
    expect(groups.some(finding => finding.observation.text.includes('/book') && finding.observation.text.includes('20%'))).toBe(true)
    for (const finding of groups) verifyFindingReferences(fixture, finding)
  })

  it('explains a period traffic-mix reversal without calling each improving device worse', () => {
    const fixture = data([page(0, '/book', 'mobile', 900, 30, 100, 20), page(1, '/book', 'desktop', 100, 90, 900, 80)])
    const mix = deriveJourneyReview(fixture).find(finding => finding.id.startsWith('journey.mix:'))!
    expect(mix).toBeDefined()
    expect(mix.observation.text).toContain('36%')
    expect(mix.observation.text).toContain('74%')
    expect(mix.observation.text).toMatch(/improved.*every.*device/i)
    expect(mix.observation.text).toMatch(/mix/i)
    expect(mix).toMatchObject({ direction: 'mixed', priority: 'investigate' })
    verifyFindingReferences(fixture, mix)
    expect(overviewFindings(deriveExpertReview(fixture)).some(finding => finding.id === mix.id)).toBe(true)
  })

  it('rejects a reversal explanation when a device has missing prior evidence or incompatible counts', () => {
    const fixture = data([page(0, '/book', 'mobile', 900, 30, 100, 20), page(1, '/book', 'desktop', 100, 90)])
    expect(deriveJourneyReview(fixture).some(finding => finding.id.startsWith('journey.mix:'))).toBe(false)
    fixture.website.data!.rows[1] = page(1, '/book', 'desktop', 100, 90, 900, 80)
    fixture.website.data!.rows[1].metrics.engaged_sessions.current.value = 101
    expect(deriveJourneyReview(fixture).some(finding => finding.id.startsWith('journey.mix:'))).toBe(false)
  })

  it('does not turn a current-only, missing, wrong-unit or fractional session row into deterioration', () => {
    const fixture = data([page(0, '/current', 'mobile', 10, 20), page(1, '/missing', 'mobile', 10, 20, 10, 50),
      page(2, '/wrong-unit', 'desktop', 10, 20, 10, 80), page(3, '/fractional', 'desktop', 1.5, 20, 10, 50)])
    fixture.website.data!.rows[1].metrics.engagement_rate.current.value = null
    fixture.website.data!.rows[1].metrics.engagement_rate.current.availability = { state: 'unavailable', blockerCodes: ['missing'] }
    fixture.website.data!.rows[2].metrics.sessions.current.unit = 'seconds'
    for (const row of fixture.website.data!.rows) expect(pageFinding(fixture, row)?.direction).toBeUndefined()
    expect(pageFinding(fixture, fixture.website.data!.rows[0])?.status).toBe('observed')
  })

  it('retains named event changes below the largest event row without page/person attribution', () => {
    const fixture = data([])
    fixture.website.data!.events = ['form_start', 'appointment_confirmed'].map((name, index) => ({ name, device: 'mobile', channel: 'Paid Social', metrics: {
      event_count: structuredClone(makeReportMetric({ context, source: 'ga4', key: 'event_count', label: 'Event count', definition: `GA4 ${name}`,
        unit: 'count', event: name, current: index ? 3 : 500, previous: index ? 9 : 500,
        entity: { level: 'account', id: `account-db:event:${index}` }, coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE })),
    } }))
    const events = deriveJourneyReview(fixture).filter(finding => finding.id === 'journey.ga4.event_telemetry' || finding.id.startsWith('journey.event:'))
    expect(events).toHaveLength(2)
    const decline = events.find(finding => finding.observation.text.includes('appointment_confirmed'))!
    expect(decline).toMatchObject({ direction: 'declined', priority: 'investigate' })
    verifyFindingReferences(fixture, decline)
    expect(decline.nextInspection.href).toContain(websiteEventAnchor(fixture.website.data!.events[1]))
    expect(decline.observation.text).not.toMatch(/people|customers|booked appointments/i)
    fixture.website.data!.events[1].metrics.event_count.current.unit = 'money'
    expect(deriveJourneyReview(fixture).find(finding => finding.observation.text.includes('appointment_confirmed'))?.direction).toBeUndefined()
  })

  it('rejects a deep link whose page or anchor is not the measured population', () => {
    const fixture = data([page(0, '/book', 'mobile', 10, 20, 10, 50)])
    const finding = pageFinding(fixture, fixture.website.data!.rows[0])!
    expect(finding).toBeDefined()
    const url = new URL(finding.nextInspection.href, 'https://maxx.local')
    url.searchParams.set('website_page', '/different')
    expect(() => verifyFindingReferences(fixture, { ...finding, nextInspection: { ...finding.nextInspection, href: `${url.pathname}${url.search}${url.hash}` } })).toThrow()
    expect(() => verifyFindingReferences(fixture, { ...finding, nextInspection: { ...finding.nextInspection, href: finding.nextInspection.href.replace(/#.+$/, '#website-row-forged') } })).toThrow()
  })
})

describe('native website population evidence boundaries', () => {
  const totals = (sessions: number, engagedSessions: number, engagementRate: number) => ({
    sessions, engagedSessions, engagementRate, users: sessions, pageViews: sessions,
  })
  const row = (device: string, sessions: number, engaged: number, rate: number) => ({
    ...totals(sessions, engaged, rate), landingPage: '/book', device, channel: 'Paid Social',
  })
  function native(input: Partial<BuildWebsiteReportInput>): ReportingData {
    const report = buildWebsiteReport(context, {
      currentTotals: totals(100, 20, 0.2), previousTotals: totals(100, 80, 0.8), rows: [], events: [],
      metadata: { timezone: context.timezone, currency: 'USD', subjectToThresholding: false,
        dataLossFromOtherRow: false, sampled: false, returnedRows: 1, totalRows: 1 }, ...input,
    }).report
    const packet = validateReportingPacket({ context, section: 'website', notes: [],
      result: { state: 'partial', data: report, asOf: context.asOf, notes: [] } })
    if (packet.section !== 'website') throw new Error('unexpected fixture section')
    return { ...data([]), website: packet.result }
  }

  it('withholds an inconsistent native current rate without discarding its exact session and engaged counts', () => {
    const fixture = native({ rows: [row('mobile', 100, 20, 0.8)], previousRows: [row('mobile', 100, 80, 0.8)] })
    const review = deriveExpertReview(fixture)
    expect(review.input.rejectedSources).toEqual([])
    const finding = review.findings.find(item => item.id.startsWith('journey.page:'))!
    expect(finding.status).toBe('observed')
    expect(finding.direction).toBeUndefined()
    expect(finding.observation.text).toContain('100 sessions')
    expect(finding.observation.text).toContain('20 engaged sessions')
    expect(finding.observation.text).toMatch(/unavailable engagement rate/)
    expect(finding.limitations.join(' ')).toMatch(/inconsistent|reconcil/i)
    expect(finding.exposure?.value).toBe(100)
    expect(review.populationCoverage).toContainEqual({ family: 'Website', level: 'page', supplied: 1, evaluated: 0, limited: 1 })
    verifyFindingReferences(fixture, finding)
  })

  it('requires count/rate consistency for each member of a matched pair and for prior-period rate changes', () => {
    const fixture = native({ rows: [row('mobile', 100, 20, 0.8), row('desktop', 100, 60, 0.6)],
      previousRows: [row('mobile', 100, 20, 0.2), row('desktop', 100, 30, 0.6)] })
    expect(matchedWebsitePairs(fixture)).toEqual([])
    for (const value of fixture.website.data!.rows) expect(pageFinding(fixture, value)?.direction).toBeUndefined()
    const coherent = native({ rows: [row('mobile', 100, 20, 0.2), row('desktop', 100, 60, 0.6)],
      previousRows: [row('mobile', 100, 80, 0.8), row('desktop', 100, 30, 0.3)] })
    expect(matchedWebsitePairs(coherent)).toHaveLength(1)
    expect(pageFinding(coherent, coherent.website.data!.rows.find(value => value.device === 'mobile')!)?.direction).toBe('declined')
  })

  it.each(['partial', 'unknown'] as const)('retains qualified raw page/event counts under %s coverage and withholds comparisons', state => {
    const incomplete = { state, numerator: null, denominator: null }
    const event = { name: 'form_start', device: 'mobile', channel: 'Paid Social', eventCount: 10 }
    const fixture = native({ rows: [row('mobile', 100, 20, 0.2)], previousRows: [row('mobile', 100, 80, 0.8)],
      events: [event], previousEvents: [{ ...event, eventCount: 50 }], journeyCoverage: incomplete, eventCoverage: incomplete })
    const review = deriveExpertReview(fixture)
    const page = review.findings.find(value => value.id.startsWith('journey.page:'))!
    const namedEvent = review.findings.find(value => value.id === 'journey.ga4.event_telemetry')!
    expect(page.observation.text).toContain('100 sessions')
    expect(page.observation.text).toContain('20 engaged sessions')
    expect(namedEvent.observation.text).toContain('10 observed events')
    for (const finding of [page, namedEvent]) {
      expect(finding.status).toBe('observed')
      expect(finding.direction).toBeUndefined()
      expect(finding.observation.evidence.length).toBeGreaterThan(0)
      expect(finding.limitations.join(' ')).toMatch(/coverage.*limited|limited.*coverage/i)
      expect(finding.observation.text).toMatch(/qualified|coverage/i)
      verifyFindingReferences(fixture, finding)
    }
    expect(page.exposure?.value).toBe(100)
    expect(namedEvent.exposure?.value).toBe(10)
    expect(page.nextInspection.href).toContain(websiteRowAnchor(fixture.website.data!.rows[0]))
    expect(namedEvent.nextInspection.href).toContain(websiteEventAnchor(fixture.website.data!.events[0]))
    expect(review.populationCoverage).toEqual(expect.arrayContaining([
      { family: 'Website', level: 'page', supplied: 1, evaluated: 0, limited: 1 },
      { family: 'Website', level: 'event', supplied: 1, evaluated: 0, limited: 1 },
    ]))
  })

  it('allows floating-point roundoff while rejecting a small rate discrepancy that the old 0.01 tolerance accepted', () => {
    const equivalent = native({ rows: [row('mobile', 7, 3, 0.4285714285714286)], previousRows: [row('mobile', 7, 2, 2 / 7)] })
    expect(pageFinding(equivalent, equivalent.website.data!.rows[0])?.direction).toBe('improved')
    const inconsistent = native({ rows: [row('mobile', 900, 180, 0.20001), row('desktop', 100, 90, 0.9)],
      previousRows: [row('mobile', 100, 10, 0.1), row('desktop', 900, 720, 0.8)] })
    expect(websitePopulationReview(inconsistent).findings.some(value => value.id.startsWith('journey.mix:'))).toBe(false)
    expect(pageFinding(inconsistent, inconsistent.website.data!.rows.find(value => value.device === 'mobile')!)?.direction).toBeUndefined()
  })

  it.each([80, 90])('recognizes a mix reversal when devices improve or hold steady (desktop engaged %s)', engaged => {
    const fixture = native({ rows: [row('mobile', 900, 180, 0.2), row('desktop', 100, engaged, engaged / 100)],
      previousRows: [row('mobile', 100, 20, 0.2), row('desktop', 900, 720, 0.8)] })
    const mix = websitePopulationReview(fixture).findings.find(value => value.id.startsWith('journey.mix:'))!
    expect(mix).toBeDefined()
    expect(mix.observation.text).toMatch(/held steady|improved or held steady/)
    expect(mix.observation.text).toContain('74%')
    expect(mix.observation.text).toContain(engaged === 80 ? '26%' : '27%')
    expect(mix.counterEvidence.text).toMatch(/does not prove a cause/)
    verifyFindingReferences(fixture, mix)
  })
})
