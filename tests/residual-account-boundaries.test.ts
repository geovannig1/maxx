import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  ownerAllowed: true,
  resolution: {
    ok: true as const,
    account: { id: 'account-a', accountId: 'act_A', accountName: 'Studio A' },
  } as
    | { ok: true; account: { id: string; accountId: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  adminCalls: 0,
  eqCalls: [] as Array<{ table: string; column: string; value: unknown }>,
  updates: [] as Array<{ table: string; patch: Row }>,
  rows: {} as Record<string, Row[]>,
  errors: {} as Record<string, { message: string } | null>,
  ga4: vi.fn(async () => ({ available: true, confirmationEvents: 1 })),
  anomaly: vi.fn(async () => ({ available: true })),
  reconciliation: vi.fn(async () => ({ available: true })),
  videoStatus: vi.fn(async () => ({ status: 'processing' })),
}))

function filteredBuilder(table: string) {
  let rows = [...(state.rows[table] ?? [])]
  let limit = Number.POSITIVE_INFINITY
  const response = () => ({ data: rows.slice(0, limit), error: state.errors[table] ?? null })
  const builder: Record<string, unknown> = {}
  builder.select = () => builder
  builder.update = (patch: Row) => {
    state.updates.push({ table, patch })
    return builder
  }
  builder.eq = (column: string, value: unknown) => {
    state.eqCalls.push({ table, column, value })
    rows = rows.filter((row) => row[column] === value)
    return builder
  }
  builder.gte = () => builder
  builder.lte = () => builder
  builder.order = () => builder
  builder.in = (column: string, values: unknown[]) => {
    rows = rows.filter((row) => values.includes(row[column]))
    return builder
  }
  builder.limit = (value: number) => {
    limit = value
    return builder
  }
  builder.maybeSingle = async () => {
    const result = response()
    return { data: result.data[0] ?? null, error: result.error }
  }
  builder.then = (
    resolve: (value: ReturnType<typeof response>) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(response()).then(resolve, reject)
  return builder
}

const fakeDb = { from: (table: string) => filteredBuilder(table) }

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com' } } }) },
  })),
}))

vi.mock('@/lib/auth/require-owner', () => ({
  ownerOnly: vi.fn(() => state.ownerAllowed ? null : Response.json({ error: 'Forbidden' }, { status: 403 })),
}))

vi.mock('@/lib/accounts/active-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounts/active-account')>()
  return { ...actual, resolveOnlyActiveAccount: vi.fn(async () => state.resolution) }
})

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: vi.fn(() => {
    state.adminCalls += 1
    return fakeDb
  }),
}))

vi.mock('@/mcp/lib/supabase', () => ({ getSupabaseClient: () => fakeDb }))
vi.mock('@/lib/ga4/client', () => ({ getGa4Bookings: state.ga4 }))
vi.mock('@/lib/diagnostics/anomaly-report', () => ({ buildAnomalyReport: state.anomaly }))
vi.mock('@/lib/diagnostics/reconciliation-report', () => ({ buildReconciliationReport: state.reconciliation }))
vi.mock('@/lib/creative/video-generator', () => ({ checkVideoStatus: state.videoStatus }))

describe('residual owner and account boundaries', () => {
  beforeEach(() => {
    state.ownerAllowed = true
    state.resolution = {
      ok: true,
      account: { id: 'account-a', accountId: 'act_A', accountName: 'Studio A' },
    }
    state.adminCalls = 0
    state.eqCalls = []
    state.updates = []
    state.rows = {}
    state.errors = {}
    state.ga4.mockClear()
    state.anomaly.mockClear()
    state.reconciliation.mockClear()
    state.videoStatus.mockClear()
  })

  it.each([
    ['conversions', async () => {
      const { GET } = await import('@/app/api/conversions/route')
      return GET(new NextRequest('http://localhost/api/conversions?from=2026-07-01&to=2026-07-02'))
    }],
    ['GA4 bookings', async () => {
      const { GET } = await import('@/app/api/ga4/bookings/route')
      return GET(new NextRequest('http://localhost/api/ga4/bookings'))
    }],
    ['insights', async () => {
      const { GET } = await import('@/app/api/insights/route')
      return GET(new NextRequest('http://localhost/api/insights?account_id=act_A&entity_level=account&date_start=2026-07-01&date_end=2026-07-02'))
    }],
    ['segments', async () => {
      const { GET } = await import('@/app/api/segments/route')
      return GET(new NextRequest('http://localhost/api/segments?dimension=platform&from=2026-07-01&to=2026-07-02'))
    }],
    ['ad trend', async () => {
      const { GET } = await import('@/app/api/ads/trend/route')
      return GET(new NextRequest('http://localhost/api/ads/trend?ad_id=ad-A&from=2026-07-01&to=2026-07-02'))
    }],
    ['anomaly report', async () => {
      const { GET } = await import('@/app/api/diagnostics/anomalies/route')
      return GET(new NextRequest('http://localhost/api/diagnostics/anomalies?from=2026-07-01&to=2026-07-02'))
    }],
    ['reconciliation report', async () => {
      const { GET } = await import('@/app/api/diagnostics/reconciliation/route')
      return GET(new NextRequest('http://localhost/api/diagnostics/reconciliation?from=2026-07-01&to=2026-07-02'))
    }],
  ] as const)('denies a non-owner before %s reaches admin or a metered/external reader', async (_name, call) => {
    state.ownerAllowed = false
    const response = await call()

    expect(response.status).toBe(403)
    expect(state.adminCalls).toBe(0)
    expect(state.ga4).not.toHaveBeenCalled()
    expect(state.anomaly).not.toHaveBeenCalled()
    expect(state.reconciliation).not.toHaveBeenCalled()
  })

  it('passes an explicit governed range through the reconciliation tool unchanged', async () => {
    const { getReconciliation } = await import('@/mcp/tools/reconciliation')
    // Relative to today so the range never ages past the tool's 90-day lookback limit.
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
    const from = day(40), to = day(11)
    await getReconciliation({ start_date: from, end_date: to })

    expect(state.reconciliation).toHaveBeenCalledWith({
      from,
      to,
      adAccountId: 'account-a',
    })
  })

  it('rejects a half-specified explicit reconciliation range', async () => {
    const { getReconciliation } = await import('@/mcp/tools/reconciliation')
    await expect(getReconciliation({ end_date: '2026-08-25' })).rejects.toThrow(/provided together/i)
  })

  it('rejects a caller-selected second Meta account before reading insights', async () => {
    const { GET } = await import('@/app/api/insights/route')
    const response = await GET(new NextRequest(
      'http://localhost/api/insights?account_id=act_B&entity_level=account&date_start=2026-07-01&date_end=2026-07-02',
    ))

    expect(response.status).toBe(404)
    expect(state.eqCalls.filter((call) => call.table === 'daily_insights')).toEqual([])
  })

  it('fails closed on ambiguous active ownership before a diagnostic gatherer runs', async () => {
    state.resolution = { ok: false, reason: 'ambiguous' }
    const { GET } = await import('@/app/api/diagnostics/anomalies/route')
    const response = await GET(new NextRequest(
      'http://localhost/api/diagnostics/anomalies?from=2026-07-01&to=2026-07-02',
    ))

    expect(response.status).toBe(409)
    expect(state.anomaly).not.toHaveBeenCalled()
  })

  it('fails closed on ambiguous ownership before the GA metered read', async () => {
    state.resolution = { ok: false, reason: 'ambiguous' }
    const { GET } = await import('@/app/api/ga4/bookings/route')
    const response = await GET(new NextRequest('http://localhost/api/ga4/bookings'))

    expect(response.status).toBe(409)
    expect(state.ga4).not.toHaveBeenCalled()
  })

  it('scopes conversion and segment reads to the exact active account', async () => {
    const { GET: getConversions } = await import('@/app/api/conversions/route')
    const { GET: getSegments } = await import('@/app/api/segments/route')
    await getConversions(new NextRequest('http://localhost/api/conversions?from=2026-07-01&to=2026-07-02'))
    await getSegments(new NextRequest('http://localhost/api/segments?dimension=platform&from=2026-07-01&to=2026-07-02'))

    expect(state.eqCalls).toContainEqual({ table: 'daily_insights', column: 'ad_account_id', value: 'account-a' })
    expect(state.eqCalls).toContainEqual({ table: 'insight_breakdowns', column: 'ad_account_id', value: 'account-a' })
  })

  it('keeps an empty segment read unmeasured instead of synthesizing zero totals', async () => {
    state.rows.insight_breakdowns = []
    const { GET } = await import('@/app/api/segments/route')

    const response = await GET(new NextRequest('http://localhost/api/segments?dimension=platform&from=2026-07-01&to=2026-07-02'))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      dimension: 'platform',
      segments: [],
      totals: null,
      metrics_status: 'unavailable',
      total: 0,
    })
  })

  it('preserves measured zero segment metrics when breakdown rows exist', async () => {
    state.rows.insight_breakdowns = [
      {
        ad_account_id: 'account-a',
        breakdown_type: 'publisher_platform',
        breakdown_value: 'facebook',
        spend: 0,
        impressions: 0,
        clicks: 0,
        leads: 0,
        bookings: 0,
      },
    ]
    const { GET } = await import('@/app/api/segments/route')

    const response = await GET(new NextRequest('http://localhost/api/segments?dimension=platform&from=2026-07-01&to=2026-07-02'))
    const body = await response.json() as { segments: Array<{ metrics: Record<string, unknown> }>; totals: Record<string, unknown>; metrics_status: string }

    expect(response.status).toBe(200)
    expect(body.metrics_status).toBe('available')
    expect(body.segments[0].metrics).toMatchObject({ spend: 0, impressions: 0, bookings: 0 })
    expect(body.totals).toMatchObject({ spend: 0, impressions: 0, bookings: 0 })
  })

  it('does not expose raw database messages when the segment breakdown read fails', async () => {
    state.errors.insight_breakdowns = { message: 'relation insight_breakdowns internal detail' }
    const { GET } = await import('@/app/api/segments/route')

    const response = await GET(new NextRequest('http://localhost/api/segments?dimension=platform&from=2026-07-01&to=2026-07-02'))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      code: 'SEGMENTS_READ_UNAVAILABLE',
      error: 'Segment performance is unavailable because the scoped breakdown read failed.',
    })
    expect(JSON.stringify(body)).not.toContain('internal detail')
  })

  it('does not turn a failed conversion read into a plausible empty result', async () => {
    state.errors.daily_insights = { message: 'conversion read offline' }
    const { GET } = await import('@/app/api/conversions/route')
    const response = await GET(new NextRequest(
      'http://localhost/api/conversions?from=2026-07-01&to=2026-07-02',
    ))

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'CONVERSIONS_READ_FAILED' })
  })

  it('binds the Meta ad lookup and its trend rows to the same active account', async () => {
    state.rows.ads = [
      { id: 'ad-row-a', ad_id: 'same-meta-id', ad_account_id: 'account-a' },
      { id: 'ad-row-b', ad_id: 'same-meta-id', ad_account_id: 'account-b' },
    ]
    state.rows.daily_insights = [
      { ad_account_id: 'account-a', ad_id: 'ad-row-a', entity_level: 'ad', date_start: '2026-07-01' },
      { ad_account_id: 'account-b', ad_id: 'ad-row-b', entity_level: 'ad', date_start: '2026-07-01' },
    ]
    const { GET } = await import('@/app/api/ads/trend/route')
    const response = await GET(new NextRequest(
      'http://localhost/api/ads/trend?ad_id=same-meta-id&from=2026-07-01&to=2026-07-02',
    ))

    expect(response.status).toBe(200)
    expect(state.eqCalls).toContainEqual({ table: 'ads', column: 'ad_account_id', value: 'account-a' })
    expect(state.eqCalls).toContainEqual({ table: 'daily_insights', column: 'ad_account_id', value: 'account-a' })
  })

  it('scopes every MCP flag reader and excludes another account rows', async () => {
    state.rows.flags = [
      { ad_account_id: 'account-a', is_active: true, flag_type: 'winner', recommended_action: 'legacy A' },
      { ad_account_id: 'account-b', is_active: true, flag_type: 'winner', recommended_action: 'legacy B' },
    ]
    const { getWinnerLoserFlags, getScaleCandidates, getWatchlist } = await import('@/mcp/tools/flags')
    const winner = await getWinnerLoserFlags({}) as { flags: Row[] }
    await getScaleCandidates({})
    await getWatchlist({})

    expect(winner.flags).toHaveLength(1)
    expect(state.eqCalls.filter((call) => call.table === 'flags' && call.column === 'ad_account_id')).toEqual([
      { table: 'flags', column: 'ad_account_id', value: 'account-a' },
      { table: 'flags', column: 'ad_account_id', value: 'account-a' },
      { table: 'flags', column: 'ad_account_id', value: 'account-a' },
    ])
  })

  it('404s a guessed cross-account video job before the provider call', async () => {
    state.rows.generated_creatives = [
      { id: 'creative-b', ad_account_id: 'account-b', meta_ad_id: 'job-b' },
    ]
    const { GET } = await import('@/app/api/generate/video/[jobId]/route')
    const response = await GET(new Request('http://localhost/api/generate/video/job-b'), {
      params: Promise.resolve({ jobId: 'job-b' }),
    })

    expect(response.status).toBe(404)
    expect(state.videoStatus).not.toHaveBeenCalled()
    expect(state.updates).toEqual([])
  })

  it('denies video status before account resolution or provider access', async () => {
    state.ownerAllowed = false
    const { GET } = await import('@/app/api/generate/video/[jobId]/route')
    const response = await GET(new Request('http://localhost/api/generate/video/job-a'), {
      params: Promise.resolve({ jobId: 'job-a' }),
    })

    expect(response.status).toBe(403)
    expect(state.adminCalls).toBe(0)
    expect(state.videoStatus).not.toHaveBeenCalled()
  })

  it('404s a guessed cross-account generated creative before update', async () => {
    state.rows.generated_creatives = [
      { id: 'creative-b', ad_account_id: 'account-b', meta_ad_id: 'job-b' },
    ]
    const { PATCH } = await import('@/app/api/generate/creatives/[id]/route')
    const response = await PATCH(new NextRequest('http://localhost/api/generate/creatives/creative-b', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ is_approved: true }),
    }), { params: Promise.resolve({ id: 'creative-b' }) })

    expect(response.status).toBe(404)
    expect(state.updates).toEqual([])
  })

  it('denies a creative review before the service-role client is created', async () => {
    state.ownerAllowed = false
    const { PATCH } = await import('@/app/api/generate/creatives/[id]/route')
    const response = await PATCH(new NextRequest('http://localhost/api/generate/creatives/creative-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ is_approved: true }),
    }), { params: Promise.resolve({ id: 'creative-a' }) })

    expect(response.status).toBe(403)
    expect(state.adminCalls).toBe(0)
    expect(state.updates).toEqual([])
  })
})
