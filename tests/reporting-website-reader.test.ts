import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateReportingPacket } from '@/lib/reporting/validation'

const runReport = vi.fn()
vi.mock('@google-analytics/data', () => ({
  BetaAnalyticsDataClient: vi.fn(function FakeClient() { return { runReport } }),
}))

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}

const metadata = {
  timeZone: 'America/New_York', currencyCode: 'USD', dataLossFromOtherRow: false,
  samplingMetadatas: [],
}

function response(dims: string[][], metrics: Array<Array<string | number>>, rowCount = dims.length,
  meta: Record<string, unknown> = metadata) {
  return [{
    rows: dims.map((values, index) => ({
      dimensionValues: values.map(value => ({ value })),
      metricValues: metrics[index].map(value => ({ value: String(value) })),
    })),
    rowCount,
    metadata: meta,
  }]
}

describe('website report reader', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.GA4_PROPERTY_ID = '123456'
    process.env.GA4_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: 'fake-reporting@example.invalid', private_key: 'not-a-real-private-key',
    })
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') {
        return response([['/book/?utm_source=meta', 'mobile', 'Paid Social']], [[7, 2, 0.2, 6, 11]], 1)
      }
      if (dimensions.length === 1) {
        return response([['appointment_confirmed'], ['page_view']], [[1], [20]], 2)
      }
      return response([
        ['appointment_confirmed', 'mobile', 'Paid Social'],
        ['page_view', 'mobile', 'Paid Social'],
      ], [[1], [20]], 2)
    })
  })

  afterEach(() => {
    delete process.env.GA4_PROPERTY_ID
    delete process.env.GA4_SERVICE_ACCOUNT_JSON
    delete process.env.GA4_INTENT_EVENTS
    delete process.env.GA4_LEAD_EVENTS
  })

  it('queries the verified fields on the same current/prior date basis and returns allowlisted metadata', async () => {
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    const calls = runReport.mock.calls.map(call => call[0])

    expect(calls).toHaveLength(6)
    expect(calls[0].dateRanges).toEqual([{ startDate: '2026-09-02', endDate: '2026-09-04' }])
    expect(calls[1].dateRanges).toEqual([{ startDate: '2026-08-30', endDate: '2026-09-01' }])
    expect(calls[2].dimensions.map((dimension: { name: string }) => dimension.name)).toEqual([
      'landingPage', 'deviceCategory', 'sessionDefaultChannelGroup',
    ])
    expect(calls[2].metrics.map((metric: { name: string }) => metric.name)).toEqual([
      'sessions', 'engagedSessions', 'engagementRate', 'totalUsers', 'screenPageViews',
    ])
    expect(calls[3].dimensions.map((dimension: { name: string }) => dimension.name)).toEqual([
      'eventName', 'deviceCategory', 'sessionDefaultChannelGroup',
    ])
    expect(calls[3].dimensionFilter).toMatchObject({ filter: {
      fieldName: 'eventName',
      inListFilter: { values: ['begin_checkout', 'generate_lead', 'appointment_confirmed', 'page_view'] },
    } })
    expect(calls[4].dateRanges).toEqual([{ startDate: '2026-08-30', endDate: '2026-09-01' }])
    expect(calls[4].dimensions).toEqual(calls[2].dimensions)
    expect(calls[5].dateRanges).toEqual([{ startDate: '2026-08-30', endDate: '2026-09-01' }])
    expect(calls[5].dimensions).toEqual(calls[3].dimensions)
    expect(section.state).toBe('available')
    expect(section.data?.metadata).toEqual({
      timezone: 'America/New_York', currency: 'USD', subjectToThresholding: null,
      dataLossFromOtherRow: false, sampled: false, returnedRows: 3, totalRows: 3,
    })
    expect(JSON.stringify(section)).not.toContain('fake-reporting@example.invalid')
  })

  it('queries and counts the configured GA4 event groups, with no card for unconfigured names', async () => {
    process.env.GA4_INTENT_EVENTS = 'quote_request_click'
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') return response([], [], 0)
      return response([['generate_lead', 'mobile', 'Direct'], ['page_view', 'mobile', 'Direct'],
        ['quote_request_click', 'mobile', 'Paid Social']], [[2], [20], [7]], 3)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    const eventCall = runReport.mock.calls.map(call => call[0]).find(call => call.dimensionFilter)

    expect(eventCall.dimensionFilter.filter.inListFilter.values)
      .toEqual(['quote_request_click', 'generate_lead', 'appointment_confirmed', 'page_view'])
    expect(section.state).toBe('available')
    expect(section.data?.metrics.intent_events.current.value).toBe(7)
    expect(section.data?.metrics.lead_events.current.value).toBe(2)
    expect(section.data?.metrics.confirmation_events.current.value).toBe(0)
    expect(Object.keys(section.data?.metrics ?? {}).filter(key => key.endsWith('_events')).sort())
      .toEqual(['confirmation_events', 'intent_events', 'lead_events'])
  })

  it('fails closed for an invalidly configured group without failing the report', async () => {
    process.env.GA4_LEAD_EVENTS = 'contact-form'
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    const eventCall = runReport.mock.calls.map(call => call[0]).find(call => call.dimensionFilter)

    expect(eventCall.dimensionFilter.filter.inListFilter.values).toEqual(['begin_checkout', 'appointment_confirmed', 'page_view'])
    expect(section.state).toBe('partial')
    expect(section.notes).toContain('ga4_event_config_invalid:GA4_LEAD_EVENTS')
    expect(section.data?.metrics.lead_events.current.value).toBeNull()
    expect(section.data?.metrics.confirmation_events.current.value).toBe(1)
  })

  it('marks malformed values and truncated pages as partial', async () => {
    let journeyCalls = 0
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [['not-a-number', 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') {
        journeyCalls += 1
        return journeyCalls === 1
          ? response([['/', 'desktop', 'Direct']], [[1, 1, 1, 1, 1]], 2)
          : response([], [], 2)
      }
      return response([], [], 0)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.metrics.sessions.current.value).toBeNull()
    expect(section.data?.metadata).toMatchObject({ timezone: 'America/New_York', returnedRows: 1, totalRows: 2 })
    expect(section.notes.join(' ')).toMatch(/ga4_journey_truncated/)
  })

  it('withholds data when GA4 reports a timezone that cannot support ET claims', async () => {
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      const utc = { ...metadata, timeZone: 'UTC' }
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1, utc)
      if (dimensions[0] === 'landingPage') return response([['/', 'desktop', 'Direct']], [[1, 1, 1, 1, 1]], 1, utc)
      return response([['page_view', ...(dimensions.length > 1 ? ['desktop', 'Direct'] : [])]], [[20]], 1, utc)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(section.notes.join(' ')).toContain('ga4_timezone_mismatch:UTC')
  })

  it('does not borrow a timezone from other requests when one source response omits it', async () => {
    let totalsCalls = 0
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) {
        totalsCalls += 1
        return response([[]], [[10, 4, 0.4, 8, 16]], 1, totalsCalls === 1 ? {} : metadata)
      }
      if (dimensions[0] === 'landingPage') return response([], [], 0)
      return response([['page_view', ...(dimensions.length > 1 ? ['mobile', 'Direct'] : [])]], [[20]], 1)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(section.notes).toContain('ga4_timezone_unknown')
  })

  it('returns unavailable without zero metrics when GA4 fails', async () => {
    runReport.mockRejectedValue(new Error('permission denied for service identity'))
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(JSON.stringify(section)).not.toMatch(/service identity|fake-reporting/i)
  })

  it('carries event truncation into event-count claim coverage', async () => {
    let eventCalls = 0
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') return response([], [], 0)
      if (dimensions.length === 1) return response([], [], 0)
      eventCalls += 1
      return eventCalls === 1
        ? response([['appointment_confirmed', 'mobile', 'Paid Social']], [[1]], 2)
        : response([], [], 2)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.metrics.confirmation_events.current.value).toBe(1)
    expect(section.data?.metrics.confirmation_events.current.coverage).toEqual({
      state: 'partial', numerator: 1, denominator: 2,
    })
    expect(section.data?.events[0].metrics.event_count.current.coverage.state).toBe('partial')
  })

  it('does not infer missing event zero when rowCount changes between pages', async () => {
    let currentEventCalls = 0
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') return response([], [], 0)
      if (dimensions.length === 1) return response([['page_view']], [[20]], 1)
      currentEventCalls += 1
      return currentEventCalls === 1
        ? response([['page_view', 'mobile', 'Direct']], [[20]], 2)
        : response([['begin_checkout', 'mobile', 'Direct']], [[1]], 3)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section.state).toBe('partial')
    expect(section.notes).toContain('ga4_events_row_count_changed')
    expect(section.data?.metrics.intent_events.current.value).toBe(1)
    expect(section.data?.metrics.intent_events.current.coverage.state).toBe('unknown')
    expect(section.data?.metrics.confirmation_events.current.value).toBeNull()
    expect(section.notes).toContain('ga4_event_inventory_uncontrolled')
  })

  it('keeps unreported events unavailable when a complete response lacks the positive control', async () => {
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') return response([], [], 0)
      return response([], [], 0)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.metrics.confirmation_events.current.value).toBeNull()
    expect(section.notes).toContain('ga4_event_inventory_uncontrolled')
  })

  it('uses each totals response metadata for its own native rate claim', async () => {
    let totalsCalls = 0
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) {
        totalsCalls += 1
        const meta = totalsCalls === 1
          ? { ...metadata, subjectToThresholding: true, samplingMetadatas: [{}] }
          : metadata
        return response([[]], [[10, 5, 0.5, 8, 16]], 1, meta)
      }
      if (dimensions[0] === 'landingPage') return response([], [], 0)
      return response([['page_view', ...(dimensions.length > 1 ? ['mobile', 'Direct'] : [])]], [[20]], 1)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.metrics.engagement_rate.current.value).toBeNull()
    expect(section.data?.metrics.engagement_rate.current.coverage.state).toBe('partial')
    expect(section.data?.metrics.engagement_rate.previous?.value).toBe(50)
  })

  it('fails closed when GA4 repeats a dimension tuple across pages', async () => {
    let journeyCalls = 0
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') {
        journeyCalls += 1
        return journeyCalls === 1
          ? response([['/', 'desktop', 'Direct']], [[1, 1, 1, 1, 1]], 2)
          : response([['/', 'desktop', 'Direct']], [[1, 1, 1, 1, 1]], 2)
      }
      return response([['page_view', ...(dimensions.length > 1 ? ['mobile', 'Direct'] : [])]], [[20]], 1)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section).toMatchObject({ state: 'unavailable', data: null })
  })

  it('retains loss metadata from later pages', async () => {
    let journeyCalls = 0
    runReport.mockImplementation(async request => {
      const dimensions = request.dimensions?.map((dimension: { name: string }) => dimension.name) ?? []
      if (dimensions.length === 0) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (dimensions[0] === 'landingPage') {
        journeyCalls += 1
        return journeyCalls === 1
          ? response([['/one', 'desktop', 'Direct']], [[1, 1, 1, 1, 1]], 2)
          : response([['/two', 'desktop', 'Direct']], [[1, 1, 1, 1, 1]], 2,
            { ...metadata, samplingMetadatas: [{}] })
      }
      return response([['page_view', ...(dimensions.length > 1 ? ['mobile', 'Direct'] : [])]], [[20]], 1)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.metadata.sampled).toBe(true)
    expect(section.data?.rows[0].metrics.engagement_rate.current.value).toBeNull()
    expect(section.data?.rows[0].metrics.sessions.current.coverage.state).toBe('partial')
  })

  it('reads same-dimension prior rows, including prior-only pages and events, without expanding current metadata counts', async () => {
    runReport.mockImplementation(async request => {
      const first = request.dimensions?.[0]?.name
      const prior = request.dateRanges[0].startDate === context.comparison.from
      if (!first) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (first === 'landingPage') return prior
        ? response([['/prior', 'desktop', 'Direct'], ['/current', 'mobile', 'Paid Social']], [[9, 3, 0.333, 6, 12], [4, 2, 0.5, 3, 7]])
        : response([['/current', 'mobile', 'Paid Social']], [[6, 3, 0.5, 5, 9]])
      return prior
        ? response([['form_start', 'desktop', 'Direct'], ['appointment_confirmed', 'mobile', 'Paid Social'], ['page_view', 'mobile', 'Direct']], [[4], [2], [10]])
        : response([['appointment_confirmed', 'mobile', 'Paid Social'], ['page_view', 'mobile', 'Direct']], [[3], [10]])
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    expect(section.data!.rows).toHaveLength(2)
    expect(section.data!.rows.find(row => row.landingPage === '/current')!.metrics.sessions.previous?.value).toBe(4)
    expect(section.data!.rows.find(row => row.landingPage === '/prior')!.metrics.sessions.current.value).toBeNull()
    expect(section.data!.events.find(row => row.name === 'form_start')!.metrics.event_count.previous?.value).toBe(4)
    expect(section.data!.metrics.confirmation_events.previous?.value).toBe(2)
    expect(section.data!.metadata).toMatchObject({ returnedRows: 3, totalRows: 3 })
    expect(validateReportingPacket({ section: 'website', context, notes: [], result: section }).section).toBe('website')
  })

  it.each(['totals', 'journey', 'events'])('preserves current output when the comparison %s query fails', async failed => {
    runReport.mockImplementation(async request => {
      const first = request.dimensions?.[0]?.name
      const lane = !first ? 'totals' : first === 'landingPage' ? 'journey' : 'events'
      if (request.dateRanges[0].startDate === context.comparison.from && lane === failed) throw new Error('private source detail')
      if (!first) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (first === 'landingPage') return response([['/current', 'mobile', 'Paid Social']], [[6, 3, 0.5, 5, 9]])
      return response([['appointment_confirmed', 'mobile', 'Paid Social'], ['page_view', 'mobile', 'Direct']], [[3], [10]])
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    expect(section.state).toBe('partial')
    expect(section.data!.metrics.sessions.current.value).toBe(10)
    expect(section.data!.rows[0].metrics.sessions.current.value).toBe(6)
    expect(section.data!.events[0].metrics.event_count.current.value).toBe(3)
    expect(section.notes).toContain(`ga4_comparison_${failed}_read_failed`)
    expect(JSON.stringify(section)).not.toContain('private source detail')
  })

  it.each(['sampling', 'threshold', 'loss'])('keeps prior %s qualifications off current native row claims and metadata', async flag => {
    runReport.mockImplementation(async request => {
      const first = request.dimensions?.[0]?.name
      const prior = request.dateRanges[0].startDate === context.comparison.from
      const qualified = { ...metadata, ...(flag === 'sampling' ? { samplingMetadatas: [{}] }
        : flag === 'threshold' ? { subjectToThresholding: true } : { dataLossFromOtherRow: true }) }
      if (!first) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (first === 'landingPage') return response([['/current', 'mobile', 'Paid Social']], [[6, 3, 0.5, 5, 9]], 1, prior ? qualified : metadata)
      return response([['appointment_confirmed', 'mobile', 'Paid Social'], ['page_view', 'mobile', 'Direct']], [[3], [10]], 2, prior ? qualified : metadata)
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    expect(section.state).toBe('partial')
    expect(section.data!.rows[0].metrics.engagement_rate.current.value).toBe(50)
    expect(section.data!.rows[0].metrics.engagement_rate.previous?.value).toBeNull()
    expect(section.data!.rows[0].metrics.sessions.previous?.coverage.state).toBe('partial')
    expect(section.data!.events[0].metrics.event_count.current.coverage.state).toBe('complete')
    expect(section.data!.events[0].metrics.event_count.previous?.coverage.state).toBe('partial')
    expect(section.data!.metadata).toMatchObject({ sampled: false, dataLossFromOtherRow: false })
    expect(section.data!.metrics.engagement_rate.previous?.value).toBe(40)
  })

  it.each(['timezone', 'duplicate', 'sanitized', 'dimension'])('withholds an invalid comparison %s population while retaining current evidence', async invalid => {
    runReport.mockImplementation(async request => {
      const first = request.dimensions?.[0]?.name
      const prior = request.dateRanges[0].startDate === context.comparison.from
      if (!first) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (first === 'landingPage') {
        const tuples = prior && invalid === 'duplicate' ? [['/current', 'mobile', 'Paid Social'], ['/current', 'mobile', 'Paid Social']]
          : [[prior && invalid === 'sanitized' ? '/current?private=discarded' : '/current', prior && invalid === 'dimension' ? '' : 'mobile', 'Paid Social']]
        return response(tuples, tuples.map(() => [6, 3, 0.5, 5, 9]), tuples.length,
          prior && invalid === 'timezone' ? { ...metadata, timeZone: 'UTC' } : metadata)
      }
      return response([['page_view', 'mobile', 'Direct']], [[10]])
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    expect(section.state).toBe('partial')
    expect(section.data!.rows[0].metrics.sessions.current.value).toBe(6)
    expect(section.data!.rows[0].metrics.sessions.previous?.value ?? null).toBeNull()
    expect(section.notes.join(' ')).toMatch(/ga4_comparison_journey/)
    expect(JSON.stringify(section)).not.toContain('private=discarded')
  })

  it('keeps malformed comparison fields unavailable without borrowing current values or obscuring valid prior fields', async () => {
    runReport.mockImplementation(async request => {
      const first = request.dimensions?.[0]?.name
      const prior = request.dateRanges[0].startDate === context.comparison.from
      if (!first) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (first === 'landingPage') return response([['/current', 'mobile', 'Paid Social']],
        prior ? [['unknown', 3, 0.5, -1, 2.5]] : [[6, 3, 0.5, 5, 9]])
      return response([['appointment_confirmed', 'mobile', 'Paid Social'], ['page_view', 'mobile', 'Direct']],
        [[prior ? 'unknown' : 3], [10]])
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    expect(section.state).toBe('partial')
    expect(section.data!.rows[0].metrics.sessions.current.value).toBe(6)
    expect(section.data!.rows[0].metrics.sessions.previous?.value).toBeNull()
    expect(section.data!.rows[0].metrics.engaged_sessions.previous?.value).toBe(3)
    expect(section.data!.rows[0].metrics.users.previous?.value).toBeNull()
    expect(section.data!.rows[0].metrics.page_views.previous?.value).toBeNull()
    expect(section.data!.events[0].metrics.event_count.previous?.value).toBeNull()
    expect(section.data!.metrics.confirmation_events.previous?.value).toBeNull()
  })

  it.each(['', ' ', 'not-a-count', 0])('keeps malformed comparison rowCount %j unknown instead of asserting a zero-row population', async rowCount => {
    runReport.mockImplementation(async request => {
      const first = request.dimensions?.[0]?.name
      if (!first) return response([[]], [[10, 4, 0.4, 8, 16]], 1)
      if (first === 'landingPage') {
        const result = response([['/current', 'mobile', 'Paid Social']], [[6, 3, 0.5, 5, 9]])
        return request.dateRanges[0].startDate === context.comparison.from ? [{ ...result[0], rowCount }] : result
      }
      return response([['page_view', 'mobile', 'Direct']], [[10]])
    })
    const { readWebsiteReport } = await import('@/lib/reporting/website-reader')
    const section = await readWebsiteReport(context)
    expect(section.data!.rows[0].metrics.sessions.previous?.coverage).toEqual({ state: 'unknown', numerator: null, denominator: null })
    expect(section.data!.rows[0].metrics.sessions.current.coverage.state).toBe('complete')
    expect(section.data!.metadata).toMatchObject({ returnedRows: 2, totalRows: 2 })
  })
})
