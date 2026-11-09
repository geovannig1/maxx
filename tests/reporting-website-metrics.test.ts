import { describe, expect, it } from 'vitest'
import { buildWebsiteReport, type BuildWebsiteReportInput } from '@/lib/reporting/website-metrics'
import { WebsiteReportSchema } from '@/lib/reporting/contracts'

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}

describe('website reporting metrics', () => {
  it('uses native whole-period totals and keeps event counts separate from sessions and users', () => {
    const result = buildWebsiteReport(context, {
      currentTotals: { sessions: 10, engagedSessions: 4, engagementRate: 0.4, users: 8, pageViews: 16 },
      previousTotals: { sessions: 8, engagedSessions: 3, engagementRate: 0.375, users: 7, pageViews: 12 },
      rows: [{ landingPage: '/book/?utm_source=meta#top', device: 'mobile', channel: 'Paid Social',
        sessions: 7, engagedSessions: 2, engagementRate: 0.2, users: 6, pageViews: 11 }],
      events: [
        { name: 'begin_checkout', device: 'mobile', channel: 'Paid Social', eventCount: 5 },
        { name: 'generate_lead', device: 'mobile', channel: 'Paid Social', eventCount: 2 },
        { name: 'generate_lead', device: 'desktop', channel: 'Organic Search', eventCount: 3 },
        { name: 'form_start', device: 'desktop', channel: 'Organic Search', eventCount: 4 },
        { name: 'appointment_confirmed', device: 'mobile', channel: 'Paid Social', eventCount: 1 },
      ],
      previousEvents: [
        { name: 'begin_checkout', device: '(all)', channel: '(all)', eventCount: 3 },
        { name: 'appointment_confirmed', device: '(all)', channel: '(all)', eventCount: 2 },
      ],
      currentTotalsCoverage: { state: 'complete', numerator: 1, denominator: 1 },
      previousTotalsCoverage: { state: 'complete', numerator: 1, denominator: 1 },
      metadata: { timezone: 'America/New_York', currency: 'USD', subjectToThresholding: null,
        dataLossFromOtherRow: false, sampled: false, returnedRows: 6, totalRows: 6 },
    })

    expect(result.report.metrics.sessions.current.value).toBe(10)
    expect(result.report.metrics.engagement_rate.current.value).toBe(40)
    expect(result.report.metrics.engagement_rate.previous?.value).toBe(37.5)
    expect(result.report.metrics.intent_events.current.value).toBe(5)
    expect(result.report.metrics.lead_events.current.value).toBe(5)
    expect(result.report.metrics.confirmation_events.current.value).toBe(1)
    expect(result.report.metrics.confirmation_events.previous?.value).toBe(2)
    expect(result.report.rows[0].landingPage).toBe('/book/')
    expect(result.report.events.every(event => event.metrics.event_count.current.unit === 'count')).toBe(true)
    expect(result.report.events.find(event => event.name === 'form_start')?.metrics.event_count.current.value).toBe(4)
    expect(result.issues).toEqual([])
    expect(WebsiteReportSchema.safeParse(result.report).success).toBe(true)
  })

  it('makes malformed numeric fields unavailable instead of coercing them to zero', () => {
    const result = buildWebsiteReport(context, {
      currentTotals: { sessions: null, engagedSessions: 0, engagementRate: null, users: 0, pageViews: 0 },
      previousTotals: null,
      rows: [{ landingPage: '/', device: 'desktop', channel: 'Direct', sessions: null,
        engagedSessions: 0, engagementRate: null, users: 0, pageViews: 0 }],
      events: [],
      metadata: { timezone: 'America/New_York', currency: 'USD', subjectToThresholding: null,
        dataLossFromOtherRow: false, sampled: false, returnedRows: 1, totalRows: 1 },
      issues: ['ga4_invalid_metric:sessions'],
    })

    expect(result.report.metrics.sessions.current.value).toBeNull()
    expect(result.report.rows[0].metrics.sessions.current.value).toBeNull()
    expect(result.issues).toContain('ga4_invalid_metric:sessions')
  })

  it('requires controlled complete inventory before treating an absent event as zero', () => {
    const base = {
      currentTotals: { sessions: 10, engagedSessions: 4, engagementRate: 0.4, users: 8, pageViews: 16 },
      previousTotals: null,
      rows: [],
      events: [],
      metadata: { timezone: 'America/New_York', currency: 'USD', subjectToThresholding: null,
        dataLossFromOtherRow: false, sampled: false, returnedRows: 0, totalRows: 2 },
    }
    const uncontrolled = buildWebsiteReport(context, {
      ...base,
      eventCoverage: { state: 'partial', numerator: 0, denominator: 2 },
      eventAbsenceProven: false,
    })
    const controlled = buildWebsiteReport(context, {
      ...base,
      metadata: { ...base.metadata, totalRows: 0 },
      eventCoverage: { state: 'complete', numerator: 1, denominator: 1 },
      eventAbsenceProven: true,
    })

    expect(uncontrolled.report.metrics.confirmation_events.current.value).toBeNull()
    expect(uncontrolled.report.metrics.confirmation_events.current.availability.state).toBe('unavailable')
    expect(controlled.report.metrics.confirmation_events.current.value).toBe(0)
  })

  it('preserves an explicit zero event row without requiring absence inference', () => {
    const result = buildWebsiteReport(context, {
      currentTotals: { sessions: 0, engagedSessions: 0, engagementRate: 0, users: 0, pageViews: 0 },
      previousTotals: null,
      rows: [],
      events: [{ name: 'appointment_confirmed', device: 'mobile', channel: 'Direct', eventCount: 0 }],
      eventCoverage: { state: 'partial', numerator: 1, denominator: 2 },
      eventAbsenceProven: false,
      metadata: { timezone: 'America/New_York', currency: 'USD', subjectToThresholding: null,
        dataLossFromOtherRow: false, sampled: false, returnedRows: 1, totalRows: 2 },
    })

    expect(result.report.metrics.confirmation_events.current.value).toBe(0)
    expect(result.report.metrics.confirmation_events.current.coverage.state).toBe('partial')
  })

  it('blocks native rates when their own totals response is sampled or thresholded', () => {
    const result = buildWebsiteReport(context, {
      currentTotals: { sessions: 10, engagedSessions: 5, engagementRate: 0.5, users: 8, pageViews: 12 },
      previousTotals: { sessions: 8, engagedSessions: 4, engagementRate: 0.5, users: 6, pageViews: 10 },
      currentTotalsCoverage: { state: 'partial', numerator: null, denominator: null },
      previousTotalsCoverage: { state: 'complete', numerator: 1, denominator: 1 },
      rows: [], events: [], eventAbsenceProven: false,
      metadata: { timezone: 'America/New_York', currency: 'USD', subjectToThresholding: true,
        dataLossFromOtherRow: false, sampled: true, returnedRows: 0, totalRows: 0 },
    })

    expect(result.report.metrics.engagement_rate.current.value).toBeNull()
    expect(result.report.metrics.engagement_rate.current.coverage.state).toBe('partial')
    expect(result.report.metrics.engagement_rate.previous?.value).toBe(50)
    expect(result.report.metrics.sessions.current.value).toBe(10)
    expect(result.report.metrics.sessions.current.coverage.state).toBe('partial')
  })
})

describe('native website row comparisons', () => {
  const totals = { sessions: 10, engagedSessions: 4, engagementRate: 0.4, users: 8, pageViews: 16 }
  const base: BuildWebsiteReportInput = { currentTotals: totals, previousTotals: totals, rows: [], events: [],
    metadata: { timezone: 'America/New_York', currency: 'USD', subjectToThresholding: false,
      dataLossFromOtherRow: false, sampled: false, returnedRows: 0, totalRows: 0 } }
  const journey = (landingPage: string, sessions: number | null, device = 'mobile') => ({
    ...totals, landingPage, device, channel: 'Paid Social', sessions,
  })
  const event = (name: string, eventCount: number | null, device = 'mobile') => ({ name, device, channel: 'Paid Social', eventCount })

  it('matches exact dimensions regardless of order and retains both unmatched sides without invented zero', () => {
    const input = { ...base, rows: [journey('/b', 7), journey('/a', 6), journey('/a', 4, 'desktop')],
      previousRows: [journey('/prior-only', 9), journey('/a', 2), journey('/b', 3)] }
    const report = buildWebsiteReport(context, input).report
    const byTuple = new Map(report.rows.map(row => [JSON.stringify([row.landingPage, row.device, row.channel]), row]))
    expect(report.rows).toHaveLength(4)
    const matched = byTuple.get(JSON.stringify(['/a', 'mobile', 'Paid Social']))!
    expect(matched.metrics.sessions.current.value).toBe(6)
    expect(matched.metrics.sessions.previous?.value).toBe(2)
    expect(matched.metrics.sessions.previous?.window).toMatchObject({ start: context.comparison.from, end: context.comparison.to })
    const currentOnly = byTuple.get(JSON.stringify(['/a', 'desktop', 'Paid Social']))!
    expect(currentOnly.metrics.sessions.previous?.value).toBeNull()
    const priorOnly = byTuple.get(JSON.stringify(['/prior-only', 'mobile', 'Paid Social']))!
    expect(priorOnly.metrics.sessions.current.value).toBeNull()
    expect(priorOnly.metrics.sessions.previous?.value).toBe(9)
    expect(report.metrics.users.current.value).toBe(8)
    const reordered = buildWebsiteReport(context, { ...input, rows: [...input.rows].reverse(), previousRows: [...input.previousRows].reverse() }).report
    expect(reordered.rows).toEqual(report.rows)
  })

  it('matches event, device and channel together and preserves native event summaries', () => {
    const report = buildWebsiteReport(context, { ...base,
      events: [event('appointment_confirmed', 3), event('form_start', 0)],
      previousEvents: [event('appointment_confirmed', 9, 'desktop'), event('appointment_confirmed', 2), event('begin_checkout', 4)],
    }).report
    expect(report.events).toHaveLength(4)
    const matched = report.events.find(row => row.name === 'appointment_confirmed' && row.device === 'mobile')!
    expect(matched.metrics.event_count.previous?.value).toBe(2)
    const priorOnly = report.events.find(row => row.name === 'appointment_confirmed' && row.device === 'desktop')!
    expect(priorOnly.metrics.event_count.current.value).toBeNull()
    expect(priorOnly.metrics.event_count.previous?.value).toBe(9)
    expect(report.events.find(row => row.name === 'form_start')!.metrics.event_count.current.value).toBe(0)
    expect(report.metrics.confirmation_events.current.value).toBe(3)
    expect(report.metrics.confirmation_events.previous?.value).toBe(11)
  })

  it('retains each period coverage and withholds invalid numeric values rather than supplying zero', () => {
    const report = buildWebsiteReport(context, { ...base,
      rows: [{ ...journey('/a', 10), users: -2 }],
      previousRows: [{ ...journey('/a', null), engagementRate: 0.5 }],
      journeyCoverage: { state: 'complete', numerator: 1, denominator: 1 },
      previousJourneyCoverage: { state: 'partial', numerator: null, denominator: null },
      events: [event('form_start', Number.NaN)], previousEvents: [event('form_start', -1)],
    }).report
    expect(report.rows[0].metrics.engagement_rate.current.value).toBe(40)
    expect(report.rows[0].metrics.engagement_rate.previous?.value).toBeNull()
    expect(report.rows[0].metrics.engagement_rate.previous?.coverage.state).toBe('partial')
    expect(report.rows[0].metrics.sessions.previous?.value).toBeNull()
    expect(report.rows[0].metrics.users.current.value).toBeNull()
    expect(report.events[0].metrics.event_count.current.value).toBeNull()
    expect(report.events[0].metrics.event_count.previous?.value).toBeNull()
  })

  it('rejects duplicate or sanitized-colliding tuples rather than combining or losing a population', () => {
    expect(() => buildWebsiteReport(context, { ...base, rows: [journey('/a', 1), journey('/a', 1)] })).toThrow(/duplicate.*journey/)
    expect(() => buildWebsiteReport(context, { ...base, rows: [journey('/a?private=one', 1)],
      previousRows: [journey('/a?private=two', 2)] })).toThrow(/ambiguous.*journey/)
    expect(() => buildWebsiteReport(context, { ...base, events: [event('form_start', 1), event('form_start', 2)] })).toThrow(/duplicate.*event/)
    const report = buildWebsiteReport(context, { ...base, rows: [journey('/a?private=one', 1)],
      previousRows: [journey('/a?private=one', 2)] }).report
    expect(JSON.stringify(report)).not.toContain('private=one')
    expect(report.rows[0].metrics.sessions.previous?.value).toBe(2)
  })

  it('uses collision-free tuple identities even when dimension values contain delimiters', () => {
    const report = buildWebsiteReport(context, { ...base,
      rows: [journey('/a|b', 1, 'c'), journey('/a', 2, 'b|c')],
      previousRows: [journey('/a', 3, 'b|c'), journey('/a|b', 4, 'c')],
    }).report
    expect(new Set(report.rows.map(row => row.id)).size).toBe(2)
    expect(report.rows.find(row => row.device === 'c')!.metrics.sessions.previous?.value).toBe(4)
    expect(report.rows.find(row => row.device === 'b|c')!.metrics.sessions.previous?.value).toBe(3)
  })
})
