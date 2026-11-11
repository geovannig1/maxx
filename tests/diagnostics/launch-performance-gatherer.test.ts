import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminClient: vi.fn(),
  fetchDatasetEventVolume: vi.fn(),
  getGa4ConfirmationTelemetryBySource: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: mocks.getAdminClient }))
vi.mock('@/lib/platforms/meta/fetch-dataset-stats', () => ({
  fetchDatasetEventVolume: mocks.fetchDatasetEventVolume,
  eventPerWeek: (stats: { events: Array<{ event: string; perWeek: number }> }, event: string) =>
    stats.events.find((row) => row.event === event)?.perWeek ?? null,
}))
vi.mock('@/lib/ga4/client', () => ({
  getGa4ConfirmationTelemetryBySource: mocks.getGa4ConfirmationTelemetryBySource,
}))

import {
  diagnoseLaunchPerformance,
  LaunchPerformanceUnavailableError,
} from '@/lib/diagnostics/launch-performance'

type QueryResult = { data: unknown; error: { code?: string | null; message: string } | null }

function query(result: QueryResult) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'limit', 'gte', 'lte', 'in']) {
    builder[method] = vi.fn(() => builder)
  }
  builder.maybeSingle = vi.fn(async () => result)
  builder.then = (
    resolve: (value: QueryResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject)
  return builder
}

function dbFor(results: Record<string, QueryResult>) {
  return {
    from: vi.fn((table: string) => {
      const result = results[table]
      if (!result) throw new Error(`Unexpected table: ${table}`)
      return query(result)
    }),
  }
}

function dbForSequence(results: Record<string, QueryResult | QueryResult[]>) {
  const remaining = new Map(Object.entries(results).map(([table, rows]) => [
    table,
    Array.isArray(rows) ? [...rows] : [rows],
  ]))
  return {
    from: vi.fn((table: string) => {
      const tableResults = remaining.get(table)
      if (!tableResults?.length) throw new Error(`Unexpected table: ${table}`)
      return query(tableResults.shift()!)
    }),
  }
}

const activeAdset = {
  id: 'adset-db-1',
  campaign_id: 'campaign-db-1',
  adset_id: 'meta-adset-1',
  adset_name: 'Active ad set',
  optimization_goal: 'OFFSITE_CONVERSIONS',
  promoted_object: { custom_event_str: 'AppointmentConfirmed' },
  learning_stage: 'LEARNING',
  learning_conversions: 0,
  last_sig_edit_ts: null,
  targeting: null,
  targeting_last_synced_at: null,
  targeting_optimization_types: null,
  delivery_sub_status: null,
  delivery_sub_status_read_available: false,
  delivery_sub_status_synced_at: null,
  daily_budget: 27,
  lifetime_budget: null,
  effective_status: 'ACTIVE',
}

describe('diagnoseLaunchPerformance required-read health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.META_ACCESS_TOKEN
    mocks.fetchDatasetEventVolume.mockResolvedValue({
      available: false,
      reason: 'not configured',
      datasetId: null,
      windowDays: 0,
      events: [],
    })
    mocks.getGa4ConfirmationTelemetryBySource.mockResolvedValue({ available: false })
  })

  it('throws a deterministic unavailable error when active-account resolution fails', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      ad_accounts: { data: null, error: { message: 'database offline' } },
    }))

    await expect(diagnoseLaunchPerformance()).rejects.toEqual(
      expect.objectContaining<Partial<LaunchPerformanceUnavailableError>>({
        name: 'LaunchPerformanceUnavailableError',
        code: 'LAUNCH_PERFORMANCE_UNAVAILABLE',
        source: 'ad_accounts',
      }),
    )
  })

  it('throws a deterministic unavailable error when the active-ad-set read fails', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      ad_accounts: { data: { id: 'account-1', platform: 'meta' }, error: null },
      adsets: { data: null, error: { message: 'adsets unavailable' } },
    }))

    await expect(diagnoseLaunchPerformance()).rejects.toMatchObject({
      code: 'LAUNCH_PERFORMANCE_UNAVAILABLE',
      source: 'adsets',
    })
  })

  it('falls back when production lacks optional ad-set delivery_sub_status columns', async () => {
    const baselineAdset = { ...activeAdset }
    delete (baselineAdset as Record<string, unknown>).delivery_sub_status
    delete (baselineAdset as Record<string, unknown>).delivery_sub_status_read_available
    delete (baselineAdset as Record<string, unknown>).delivery_sub_status_synced_at
    mocks.getAdminClient.mockReturnValue(dbForSequence({
      // The account-id lookup finds no Meta id; the platform read finds a Meta account.
      ad_accounts: [{ data: null, error: null }, { data: { platform: 'meta' }, error: null }],
      adsets: [
        {
          data: null,
          error: {
            code: '42703',
            message: 'column adsets.delivery_sub_status does not exist',
          },
        },
        { data: [baselineAdset], error: null },
      ],
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1',
          date_start: '2026-07-31',
          spend: 30,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          link_clicks: 10,
          bookings: 0,
        }],
        error: null,
      },
      campaigns: { data: [{ id: 'campaign-db-1', daily_budget: null, lifetime_budget: null }], error: null },
    }))

    const diagnosis = await diagnoseLaunchPerformance({ adAccountDbId: 'account-1', windowDays: 30 })

    expect(diagnosis.adsets_detail[0]?.delivery_sub_status).toEqual({
      read_available: false,
      payload: null,
      synced_at: null,
    })
  })

  it('throws a deterministic unavailable error when the required insights read fails', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      ad_accounts: { data: { id: 'account-1', platform: 'meta' }, error: null },
      adsets: { data: [activeAdset], error: null },
      daily_insights: { data: null, error: { message: 'insights unavailable' } },
    }))

    await expect(diagnoseLaunchPerformance()).rejects.toMatchObject({
      code: 'LAUNCH_PERFORMANCE_UNAVAILABLE',
      source: 'daily_insights',
    })
  })

  it('keeps a successful empty active-ad-set read as a healthy no-delivery diagnosis', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      ad_accounts: { data: { id: 'account-1', platform: 'meta' }, error: null },
      adsets: { data: [], error: null },
    }))

    const diagnosis = await diagnoseLaunchPerformance()

    expect(diagnosis.verdict).toBe('too_early')
    expect(diagnosis.launch.first_spend_date).toBeNull()
    expect(diagnosis.launch.days_delivering).toBe(0)
    expect(diagnosis.caveats).not.toEqual(expect.arrayContaining([expect.stringMatching(/gather failed/i)]))
    expect(mocks.fetchDatasetEventVolume).toHaveBeenCalledWith({ adAccountDbId: 'account-1' })
  })

  it('does not turn a thrown dataset-stats read into an empty diagnosis', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      ad_accounts: { data: { id: 'account-1', platform: 'meta' }, error: null },
      adsets: { data: [], error: null },
    }))
    mocks.fetchDatasetEventVolume.mockRejectedValue(new Error('dataset transport failed'))

    await expect(diagnoseLaunchPerformance()).rejects.toMatchObject({
      code: 'LAUNCH_PERFORMANCE_UNAVAILABLE',
      source: 'dataset_stats',
    })
  })

  it('carries reporting coverage and budget ownership into the diagnosis', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      ad_accounts: { data: { platform: 'meta' }, error: null },
      adsets: {
        data: [{
          ...activeAdset,
          learning_conversions: 1,
          last_sig_edit_ts: '2026-06-01T00:00:00Z',
        }],
        error: null,
      },
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1',
          date_start: '2026-07-31',
          spend: 30,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          link_clicks: 10,
          bookings: 0,
        }],
        error: null,
      },
      campaigns: {
        data: [{ id: 'campaign-db-1', daily_budget: 100, lifetime_budget: null }],
        error: null,
      },
    }))

    const diagnosis = await diagnoseLaunchPerformance({ adAccountDbId: 'account-1', windowDays: 30 })

    expect(diagnosis.window_settle).not.toBeNull()
    expect(diagnosis.structure.spend_concentration.budget_control).toBe('campaign')
    expect(diagnosis.adsets_detail[0]?.learning_exit_feasibility).toMatchObject({
      reachable_at_current_budget: null,
      basis: expect.stringMatching(/coverage is incomplete/i),
    })
  })

  it('loads one complete audience snapshot and freezes a selected failed lookalike', async () => {
    const snapshotAt = new Date().toISOString()
    mocks.getAdminClient.mockReturnValue(dbFor({
      adsets: {
        data: [{
          ...activeAdset,
          adset_name: 'Warm Audience',
          targeting: {
            custom_audiences: [{ id: 'website-180' }, { id: 'lal-1' }],
            targeting_automation: { advantage_audience: 1 },
          },
          targeting_last_synced_at: new Date().toISOString(),
        }],
        error: null,
      },
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1', date_start: '2026-08-15', spend: 30,
          impressions: 1_000, reach: 800, clicks: 20, link_clicks: 10, bookings: 0,
        }],
        error: null,
      },
      custom_audiences: {
        data: [
          {
            audience_id: 'website-180', name: 'Website Visitors 180 Days', subtype: 'WEBSITE',
            meta_account_id: '100000000000777', source_audience_id: null, source_audience_name: null,
            approximate_count_lower_bound: 20, approximate_count_upper_bound: 20, retention_days: 180,
            operation_status: { code: 200 }, delivery_status: { code: 200 }, last_synced_at: snapshotAt,
          },
          {
            audience_id: 'lal-1', name: 'Website 1% Lookalike', subtype: 'LOOKALIKE',
            meta_account_id: '100000000000777', source_audience_id: 'website-180',
            source_audience_name: 'Website Visitors 180 Days', approximate_count_lower_bound: -1,
            approximate_count_upper_bound: -1, retention_days: 180,
            operation_status: { code: 433 }, delivery_status: { code: 300 },
            last_synced_at: snapshotAt,
          },
        ],
        error: null,
      },
      app_settings: {
        data: { value: JSON.stringify({ complete: true, completed_at: snapshotAt, meta_account_id: '100000000000777', row_count: 2 }) },
        error: null,
      },
      campaigns: {
        data: [{ id: 'campaign-db-1', daily_budget: null, lifetime_budget: null }],
        error: null,
      },
    }))

    const diagnosis = await diagnoseLaunchPerformance({
      adAccountDbId: 'account-1',
      metaAccountId: '100000000000777',
      windowDays: 30,
      includeLiveEnrichment: false,
    })

    // The snapshot is COMPLETE and the lookalike's subtype is known — what failed is Meta's build of
    // it. That is reported as a health finding; it does not make the configuration unknowable.
    expect(diagnosis.audiences[0]?.resolution).toMatchObject({ composition: 'mixed', frozen: false })
    expect(diagnosis.audiences[0]?.resolution.unhealthyIncludedAudienceIds).toEqual(['lal-1'])
    expect(diagnosis.audiences[0]?.resolution.audienceReadinessFindings).toEqual([{
      audienceId: 'lal-1', role: 'included', state: 'unhealthy',
      failureStatus: 'operation', operationStatusCode: 433, deliveryStatusCode: 300,
      observedAt: snapshotAt,
    }])
    expect(diagnosis.audiences[0]?.resolution.evidence.join(' ')).toMatch(/operation status 433/i)
    expect(diagnosis.audience_inventory).toEqual({
      read_available: true,
      schema: 'rich',
      row_count: 2,
      reason_code: null,
      reason: null,
    })
  })

  // Regression: `today` is the America/New_York date, but the audience clock parsed it as UTC, so from
  // 20:00 ET until midnight "now" resolved BEHIND real time. A row synced seconds earlier then produced a
  // negative age and was frozen as "stale or invalid" — the clock was wrong, not the data. The window is
  // pinned here because the surrounding tests use the real clock and so only caught this in the evening.
  it('does not treat a just-synced audience as stale when NY-evening pushes the UTC day-end behind now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // 22:12 ET on 2026-08-18 — NY date is the 18th, so the old end-of-day-UTC clock sat 2.2h in the past.
      vi.setSystemTime(new Date('2026-08-19T02:12:00Z'))
      const snapshotAt = new Date().toISOString()
      mocks.getAdminClient.mockReturnValue(dbFor({
        adsets: {
          data: [{
            ...activeAdset,
            adset_name: 'Warm Audience',
            targeting: { custom_audiences: [{ id: 'website-180' }], targeting_automation: { advantage_audience: 1 } },
            targeting_last_synced_at: snapshotAt,
          }],
          error: null,
        },
        daily_insights: {
          data: [{
            adset_id: 'adset-db-1', date_start: '2026-08-15', spend: 30,
            impressions: 1_000, reach: 800, clicks: 20, link_clicks: 10, bookings: 0,
          }],
          error: null,
        },
        custom_audiences: {
          data: [{
            audience_id: 'website-180', name: 'Website Visitors 180 Days', subtype: 'WEBSITE',
            meta_account_id: '100000000000777', source_audience_id: null, source_audience_name: null,
            approximate_count_lower_bound: 20, approximate_count_upper_bound: 20, retention_days: 180,
            operation_status: { code: 200 }, delivery_status: { code: 200 }, last_synced_at: snapshotAt,
          }],
          error: null,
        },
        app_settings: {
          data: { value: JSON.stringify({ complete: true, completed_at: snapshotAt, meta_account_id: '100000000000777', row_count: 1 }) },
          error: null,
        },
        campaigns: { data: [{ id: 'campaign-db-1', daily_budget: null, lifetime_budget: null }], error: null },
      }))

      const diagnosis = await diagnoseLaunchPerformance({
        adAccountDbId: 'account-1',
        metaAccountId: '100000000000777',
        windowDays: 30,
        includeLiveEnrichment: false,
      })

      expect(diagnosis.audiences[0]?.resolution.evidence.join(' ')).not.toMatch(/stale or invalid/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a successful zero-row custom-audience read distinct from an unavailable read', async () => {
    const snapshotAt = new Date().toISOString()
    mocks.getAdminClient.mockReturnValue(dbFor({
      adsets: {
        data: [{
          ...activeAdset,
          targeting: { custom_audiences: [], targeting_automation: { advantage_audience: 1 } },
          targeting_last_synced_at: new Date().toISOString(),
        }],
        error: null,
      },
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1', date_start: '2026-08-15', spend: 30,
          impressions: 1_000, reach: 800, clicks: 20, link_clicks: 10, bookings: 0,
        }],
        error: null,
      },
      custom_audiences: { data: [], error: null },
      app_settings: {
        data: { value: JSON.stringify({ complete: true, completed_at: snapshotAt, meta_account_id: '100000000000777', row_count: 0 }) },
        error: null,
      },
      campaigns: { data: [{ id: 'campaign-db-1', daily_budget: null, lifetime_budget: null }], error: null },
    }))

    const diagnosis = await diagnoseLaunchPerformance({
      adAccountDbId: 'account-1',
      metaAccountId: '100000000000777',
      windowDays: 30,
      includeLiveEnrichment: false,
    })

    expect(diagnosis.audience_inventory).toEqual({
      read_available: true,
      schema: 'rich',
      row_count: 0,
      reason_code: null,
      reason: null,
    })
    expect(diagnosis.caveats).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/custom-audience inventory.*unavailable/i),
    ]))
  })

  it('surfaces rich and baseline custom-audience read failures as unavailable instead of empty inventory', async () => {
    mocks.getAdminClient.mockReturnValue(dbForSequence({
      adsets: [{ data: [activeAdset], error: null }],
      daily_insights: [{
        data: [{
          adset_id: 'adset-db-1', date_start: '2026-08-15', spend: 30,
          impressions: 1_000, reach: 800, clicks: 20, link_clicks: 10, bookings: 0,
        }],
        error: null,
      }],
      custom_audiences: [
        { data: null, error: { message: 'rich audience columns unavailable' } },
        { data: null, error: { message: 'baseline audience read unavailable' } },
      ],
      campaigns: [{ data: [{ id: 'campaign-db-1', daily_budget: null, lifetime_budget: null }], error: null }],
    }))

    const diagnosis = await diagnoseLaunchPerformance({
      adAccountDbId: 'account-1',
      metaAccountId: '100000000000777',
      windowDays: 30,
      includeLiveEnrichment: false,
    })

    expect(diagnosis.audience_inventory).toEqual({
      read_available: false,
      schema: null,
      row_count: null,
      reason_code: 'custom_audiences_read_failed',
      reason: expect.stringMatching(/rich and baseline/i),
    })
    expect(diagnosis.caveats).toEqual(expect.arrayContaining([
      expect.stringMatching(/custom-audience inventory.*unavailable/i),
    ]))
    expect(diagnosis.audiences[0]?.resolution).toMatchObject({
      composition: 'unknown',
      frozen: true,
    })
    expect(diagnosis.prescriptions).toEqual([])
    expect(diagnosis.action_authority.tier).toBe('diagnostic_only')
  })

  it('uses an explicit reporting window instead of silently replacing historical bounds with today', async () => {
    const db = dbFor({
      ad_accounts: { data: { platform: 'meta' }, error: null },
      adsets: { data: [activeAdset], error: null },
      daily_insights: { data: [], error: null },
      campaigns: { data: [{ id: 'campaign-db-1', daily_budget: 100, lifetime_budget: null }], error: null },
    })
    mocks.getAdminClient.mockReturnValue(db)

    const opts = {
      adAccountDbId: 'account-1',
      windowDays: 30,
      window: { from: '2026-06-01', to: '2026-06-30' },
    }
    const diagnosis = await diagnoseLaunchPerformance(opts)
    const dailyInsightsCall = db.from.mock.calls.findIndex(([table]) => table === 'daily_insights')
    const dailyInsightsQuery = db.from.mock.results[dailyInsightsCall]?.value as {
      gte: ReturnType<typeof vi.fn>
      lte: ReturnType<typeof vi.fn>
    }

    expect(dailyInsightsQuery.gte).toHaveBeenCalledWith('date_start', '2026-06-01')
    expect(dailyInsightsQuery.lte).toHaveBeenCalledWith('date_start', '2026-06-30')
    expect(diagnosis.window_settle).toMatchObject({ state: 'settled', unsettled_days: 0 })
  })

  it('can surface warehouse diagnostics without adding live Meta or GA4 calls to owner pages', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      adsets: { data: [activeAdset], error: null },
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1',
          date_start: '2026-06-15',
          spend: 30,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          link_clicks: 10,
          bookings: 0,
        }],
        error: null,
      },
      campaigns: { data: [{ id: 'campaign-db-1', daily_budget: 100, lifetime_budget: null }], error: null },
    }))

    const opts = {
      adAccountDbId: 'account-1',
      window: { from: '2026-06-01', to: '2026-06-30' },
      includeLiveEnrichment: false,
    }
    const diagnosis = await diagnoseLaunchPerformance(opts)

    expect(mocks.fetchDatasetEventVolume).not.toHaveBeenCalled()
    expect(mocks.getGa4ConfirmationTelemetryBySource).not.toHaveBeenCalled()
    expect(diagnosis.optimization_signal).toMatchObject({
      available: false,
      reason_code: 'event_volume_unavailable',
    })
  })

  it('degrades spend ownership to unknown when campaign budgets cannot be read', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      ad_accounts: { data: { platform: 'meta' }, error: null },
      adsets: { data: [activeAdset], error: null },
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1',
          date_start: '2026-07-31',
          spend: 30,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          link_clicks: 10,
          bookings: 0,
        }],
        error: null,
      },
      campaigns: { data: null, error: { message: 'campaign budgets unavailable' } },
    }))

    const diagnosis = await diagnoseLaunchPerformance({ adAccountDbId: 'account-1', windowDays: 30 })

    expect(diagnosis.structure.spend_concentration.budget_control).toBe('unknown')
    expect(diagnosis.structure.spend_concentration.detail).toMatch(/cannot be attributed/i)
  })

  it('reads exact-account delivery sub-status evidence into the ad-set diagnosis', async () => {
    const db = dbFor({
      adsets: {
        data: [{
          ...activeAdset,
          delivery_sub_status: {
            status: 'warning',
            substatuses: ['budget_limited_learning_fail'],
          },
          delivery_sub_status_read_available: true,
          delivery_sub_status_synced_at: '2026-08-01T20:00:00.000Z',
        }],
        error: null,
      },
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1',
          date_start: '2026-07-31',
          spend: 30,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          link_clicks: 10,
          bookings: 0,
        }],
        error: null,
      },
      campaigns: {
        data: [{ id: 'campaign-db-1', daily_budget: 100, lifetime_budget: null }],
        error: null,
      },
    })
    mocks.getAdminClient.mockReturnValue(db)

    const diagnosis = await diagnoseLaunchPerformance({
      adAccountDbId: 'account-1',
      window: { from: '2026-07-01', to: '2026-07-31' },
      includeLiveEnrichment: false,
    })
    const adsetsCall = db.from.mock.calls.findIndex(([table]) => table === 'adsets')
    const adsetsQuery = db.from.mock.results[adsetsCall]?.value as {
      select: ReturnType<typeof vi.fn>
      eq: ReturnType<typeof vi.fn>
    }

    expect(adsetsQuery.select).toHaveBeenCalledWith(expect.stringContaining('delivery_sub_status'))
    expect(adsetsQuery.eq).toHaveBeenCalledWith('ad_account_id', 'account-1')
    expect(diagnosis.adsets_detail[0]?.delivery_sub_status).toEqual({
      read_available: true,
      payload: {
        status: 'warning',
        substatuses: ['budget_limited_learning_fail'],
      },
      synced_at: '2026-08-01T20:00:00.000Z',
    })
  })

  it('does not fail the diagnosis when optional delivery sub-status columns are not deployed', async () => {
    const db = dbForSequence({
      adsets: [
        {
          data: null,
          error: {
            code: '42703',
            message: 'column adsets.delivery_sub_status does not exist',
          },
        },
        {
          data: [activeAdset],
          error: null,
        },
      ],
      daily_insights: [{
        data: [{
          adset_id: 'adset-db-1',
          date_start: '2026-07-31',
          spend: 30,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          link_clicks: 10,
          bookings: 0,
        }],
        error: null,
      }],
      campaigns: [{
        data: [{ id: 'campaign-db-1', daily_budget: 100, lifetime_budget: null }],
        error: null,
      }],
    })
    mocks.getAdminClient.mockReturnValue(db)

    const diagnosis = await diagnoseLaunchPerformance({
      adAccountDbId: 'account-1',
      window: { from: '2026-07-01', to: '2026-07-31' },
      includeLiveEnrichment: false,
    })
    const adsetSelects = db.from.mock.results
      .map((result) => result.value as { select?: ReturnType<typeof vi.fn> })
      .filter((value) => value.select)
      .map((value) => value.select!.mock.calls[0]?.[0])

    expect(adsetSelects[0]).toContain('delivery_sub_status')
    expect(adsetSelects[1]).not.toContain('delivery_sub_status')
    expect(diagnosis.adsets_detail[0]?.delivery_sub_status).toEqual({
      read_available: false,
      payload: null,
      synced_at: null,
    })
    expect(diagnosis.prescriptions).toEqual([])
  })

  it('degrades malformed stored delivery sub-status evidence to unavailable', async () => {
    mocks.getAdminClient.mockReturnValue(dbFor({
      adsets: {
        data: [{
          ...activeAdset,
          delivery_sub_status: { status: 9, substatuses: ['invalid'] },
          delivery_sub_status_read_available: true,
          delivery_sub_status_synced_at: '2026-08-01T20:00:00.000Z',
        }],
        error: null,
      },
      daily_insights: {
        data: [{
          adset_id: 'adset-db-1',
          date_start: '2026-07-31',
          spend: 30,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          link_clicks: 10,
          bookings: 0,
        }],
        error: null,
      },
      campaigns: {
        data: [{ id: 'campaign-db-1', daily_budget: 100, lifetime_budget: null }],
        error: null,
      },
    }))

    const diagnosis = await diagnoseLaunchPerformance({
      adAccountDbId: 'account-1',
      window: { from: '2026-07-01', to: '2026-07-31' },
      includeLiveEnrichment: false,
    })

    expect(diagnosis.adsets_detail[0]?.delivery_sub_status).toEqual({
      read_available: false,
      payload: null,
      synced_at: null,
    })
  })
})
