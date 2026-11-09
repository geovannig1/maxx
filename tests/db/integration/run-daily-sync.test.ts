import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import pg from 'pg'
import { purgeExecutiveEvidence, purgePaidMeasurement } from './paid-measurement-purge'
import {
  ACCT,
  insightRowsForLevel,
  ADSET,
  ADSETB,
  CAMPAIGN_A_META,
  CAMPAIGN_B_META,
  CAMP,
  CAMPB,
  conn,
  daysBefore,
  flagHead,
  META_ACCT,
  publicationSnapshot,
  recHead,
  seedBase,
} from './run-daily-sync-fixture'

// the COMPLETE runDailySync orchestration matrix: TEN independent scenarios driving the
// REAL orchestration against a running LOCAL Supabase with the Meta API mocked at the fetch layer.
// Campaign metadata flows through the REAL ingest (fetchCampaigns mock -> upsertCampaigns stamps genuine
// last_synced_at), so freshness is never manufactured. Requires `supabase start` (migrations thru 049).
//
// SAFETY: loopback-guarded on BOTH the API URL and the raw Postgres URL before any grant/delete.

vi.mock('@/lib/platforms/meta/fetch-accounts', () => ({ fetchAdAccount: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-campaigns', () => ({ fetchCampaigns: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-adsets', () => ({ fetchAdSets: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-custom-audiences', () => ({ fetchCustomAudiences: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-ads', () => ({ fetchAds: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-creatives', () => ({ fetchCreatives: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-insights', () => ({ fetchInsights: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/acuity/reconcile', () => ({ reconcileAcuityLedger: vi.fn() }))
vi.mock('@/lib/sync/executive-placement-evidence', () => ({
  refreshExecutivePlacementEvidence: vi.fn(async () => ({
    windowStart: '2026-08-09', windowEnd: '2026-08-15', rowCount: 0,
  })),
}))
import { fetchAdAccount } from '@/lib/platforms/meta/fetch-accounts'
import { fetchCampaigns } from '@/lib/platforms/meta/fetch-campaigns'
import { fetchAdSets } from '@/lib/platforms/meta/fetch-adsets'
import { fetchCustomAudiences } from '@/lib/platforms/meta/fetch-custom-audiences'
import { fetchAds } from '@/lib/platforms/meta/fetch-ads'
import { fetchCreatives } from '@/lib/platforms/meta/fetch-creatives'
import { fetchInsights } from '@/lib/platforms/meta/fetch-insights'
import { reconcileAcuityLedger } from '@/lib/outcomes/adapters/acuity/reconcile'

describe('runDailySync — full orchestration matrix (real code, local Supabase, mocked Meta)', () => {
  let DATE: string
  let c: pg.Client
  beforeEach(async () => {
    const { yesterday } = await import('@/lib/utils/date-utils')
    DATE = yesterday() // lifecycleRun === (dateEnd === yesterday())
    c = await conn()
    await seedBase(c, DATE)
    // REAL-INGEST defaults: campaign A flows through upsertCampaigns each run (genuine last_synced_at).
    vi.mocked(fetchAdAccount).mockReset().mockResolvedValue(null as never)
    vi.mocked(fetchCampaigns).mockReset().mockResolvedValue([CAMPAIGN_A_META])
    vi.mocked(fetchAdSets).mockReset().mockResolvedValue([])
    vi.mocked(fetchCustomAudiences).mockReset().mockResolvedValue([])
    vi.mocked(fetchAds).mockReset().mockResolvedValue([])
    vi.mocked(fetchCreatives).mockReset().mockResolvedValue([])
    vi.mocked(fetchInsights).mockReset().mockImplementation(async (params) =>
      insightRowsForLevel(
        DATE,
        { spend: 42, impressions: 3_000, clicks: 30, leads: 5 },
        params.level,
      ).filter((row) =>
        (!params.since || row.date_start >= params.since) &&
        (!params.until || row.date_start <= params.until),
      ),
    )
    vi.mocked(reconcileAcuityLedger).mockReset().mockImplementation(async () => ({
      available: true,
      completedAt: new Date(Date.now() + 1_000).toISOString(),
      sourceWindowBasis: 'booking_date_et',
      windowStartDate: '2026-01-01',
      windowEndDate: '2027-12-31',
      fetched: 1,
      upserted: 1,
      truncated: false,
      webhookMisses: 0,
      capi: { mode: 'live', ran: true, sent: 1, skipped: 0, errors: 0, markedMissed: 0 },
    }))
  })

  // This suite runs the REAL orchestrator, so it commits immutable paid-cohort generations for ACCT.
  // Purging only in seedBase left them behind for whoever ran next: confirmation-facts.test.ts reuses
  // this same account id and deletes ad_accounts, which the schema correctly RESTRICTs. Each test
  // closes its own connection, so cleanup opens a fresh one.
  afterAll(async () => {
    const cleanup = await conn()
    try {
      await purgeExecutiveEvidence(cleanup, [ACCT])
      await purgePaidMeasurement(cleanup, [ACCT])
    } finally {
      await cleanup.end()
    }
  })

  it('scenario 1 — happy path: lineage current end-to-end, canonical Acuity, status success', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const { getDailyReport } = await import('@/mcp/tools/daily-report')

    const r1 = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    expect(r1.success).toBe(true)

    const fHead = await flagHead(c), rHead = await recHead(c)
    const recMan = (await c.query(`SELECT parent_generation_id FROM decision_generations WHERE id=$1`, [rHead])).rows[0]
    expect(recMan?.parent_generation_id).toBe(fHead) // cross-stage lineage F1<-R1
    const rep = (await c.query(`SELECT recommendation_generation_id, total_spend, business_outcomes, business_revenue, report_json FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, DATE])).rows[0]
    expect(rep?.recommendation_generation_id).toBe(rHead)
    expect(Number(rep?.total_spend)).toBe(42)
    expect(Number(rep?.business_outcomes)).toBe(1) // canonical Acuity path, not fallback
    expect(Number(rep?.business_revenue)).toBe(250)
    expect(rep?.report_json).not.toHaveProperty('ownerDiagnostics')
    expect(rep?.report_json).not.toHaveProperty('accountInsights')
    expect(rep?.report_json).not.toHaveProperty('openRecommendations')
    expect(rep?.report_json?.dailyDigest).toMatchObject({
      contract_version: 3,
      action_authority_tier: 'diagnostic_only',
    })
    // Genuinely clean run (real-ingest refreshed campaign A): success, no degradation telemetry.
    const log = (await c.query(`SELECT status FROM api_sync_logs WHERE id=$1`, [r1.logId])).rows[0]
    expect(log?.status).toBe('success')
    const man = (await c.query(`SELECT structural_closures, orphan_closures, unknown_metadata_flags, budget_decisions_frozen FROM decision_generations WHERE id=$1`, [fHead])).rows[0]
    expect(man).toMatchObject({ structural_closures: 0, orphan_closures: 0, unknown_metadata_flags: 0, budget_decisions_frozen: false })
    // OUTPUT level: the MCP consumer returns the structured FIVE-state lineage.
    const mcp = await getDailyReport({ date: DATE }) as { recommendation_lineage?: { state: string; notice: string | null } }
    expect(mcp.recommendation_lineage?.state).toBe('current')
    expect(mcp.recommendation_lineage?.notice).toBeNull()
    await c.end()
  })

  it('scenario 2 — recommendation commit failure: fail-stop, partial, last_known_complete at MCP + narrative', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const { getDailyReport } = await import('@/mcp/tools/daily-report')
    const { generateDailyReport } = await import('@/lib/report/generator')

    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' }) // establish F1/R1 + report
    const fHead1 = await flagHead(c), rHead1 = await recHead(c)

    // The recommendation+decision publisher is SECURITY DEFINER, so revoking table INSERT no longer
    // reaches the failure seam. Revoke the atomic RPC itself to prove the live caller fail-stops when
    // publication is unavailable.
    await c.query(`REVOKE EXECUTE ON FUNCTION replace_recommendation_generation_with_claims_and_decisions(uuid,uuid,uuid,uuid,date,jsonb,jsonb,jsonb) FROM service_role`)
    try {
      const r2 = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
      expect(r2.success).toBe(true) // non-fatal continuation
      expect(await flagHead(c)).not.toBe(fHead1) // flag stage advanced (F1 -> F2)
      expect(await recHead(c)).toBe(rHead1)      // rec head did NOT (commit failed)
      const rep = (await c.query(`SELECT recommendation_generation_id FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, DATE])).rows[0]
      expect(rep?.recommendation_generation_id).toBe(rHead1) // prior report stands
      const log2 = (await c.query(`SELECT status, error_message FROM api_sync_logs WHERE id=$1`, [r2.logId])).rows[0]
      expect(log2?.status).toBe('partial') // honest, not green
      expect(String(log2?.error_message ?? '')).toMatch(/recommendations/)
      // OUTPUT level: MCP structured lineage is last_known_complete with the deterministic notice.
      const mcp = await getDailyReport({ date: DATE }) as { recommendation_lineage?: { state: string; notice: string | null } }
      expect(mcp.recommendation_lineage?.state).toBe('last_known_complete')
      expect(mcp.recommendation_lineage?.notice).toMatch(/Last-known-complete/)
      // STORAGE level: regenerating the diagnostic report persists only the containment notice. The
      // source recommendation and its budget/action text never enter the current report payload.
      const regen = await generateDailyReport(ACCT, DATE, rHead1, {
        sourceNotBefore: '2000-01-01T00:00:00.000Z',
        metaOutcomePlane: {
          status: 'complete',
          blockerCodes: [],
          sourceNotBefore: '2000-01-01T00:00:00.000Z',
          checkedLevels: ['campaign', 'adset', 'ad'],
        },
      })
      expect(regen.committed).toBe(true)
      const stored = (await c.query(`SELECT report_json FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, DATE])).rows[0]
      expect(stored?.report_json).not.toHaveProperty('openRecommendations')
      expect(JSON.stringify(stored?.report_json ?? {})).not.toMatch(/Last-known-complete recommendations/)
    } finally {
      await c.query(`GRANT EXECUTE ON FUNCTION replace_recommendation_generation_with_claims_and_decisions(uuid,uuid,uuid,uuid,date,jsonb,jsonb,jsonb) TO service_role`)
    }
    await c.end()
  })

  it('scenario 3 — flag commit failure: rec + report skipped, prior report stands, partial', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    const rHead1 = await recHead(c)

    await c.query(`REVOKE INSERT ON flags FROM service_role`)
    try {
      const r2 = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
      expect(r2.success).toBe(true)
      expect(await recHead(c)).toBe(rHead1) // rec stage skipped after flag failure
      const rep = (await c.query(`SELECT recommendation_generation_id FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, DATE])).rows[0]
      expect(rep?.recommendation_generation_id).toBe(rHead1) // prior report stands
      const log2 = (await c.query(`SELECT status, error_message FROM api_sync_logs WHERE id=$1`, [r2.logId])).rows[0]
      expect(log2?.status).toBe('partial')
      expect(String(log2?.error_message ?? '')).toMatch(/flags/)
    } finally {
      await c.query(`GRANT INSERT ON flags TO service_role`)
    }
    await c.end()
  })

  it('scenario 3b — paid cohort commit failure stops flags, recommendations, and report', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    const beforeFlag = await flagHead(c)
    const beforeRec = await recHead(c)
    const beforeReport = await publicationSnapshot(c, DATE)

    await c.query(
      `REVOKE EXECUTE ON FUNCTION commit_paid_cohort_pair(uuid,uuid,date,integer,integer,integer,jsonb) FROM service_role`,
    )
    try {
      const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
      expect(result.success).toBe(true)
      expect(await flagHead(c)).toBe(beforeFlag)
      expect(await recHead(c)).toBe(beforeRec)
      expect(await publicationSnapshot(c, DATE)).toEqual(beforeReport)
      const log = (await c.query(
        `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
        [result.logId],
      )).rows[0]
      expect(log?.status).toBe('partial')
      expect(String(log?.error_message ?? '')).toMatch(/paid-cohort/i)
    } finally {
      await c.query(
        `GRANT EXECUTE ON FUNCTION commit_paid_cohort_pair(uuid,uuid,date,integer,integer,integer,jsonb) TO service_role`,
      )
    }
    await c.end()
  })

  it('scenario 3c — one failed insight level publishes no paid cohort or downstream decision state', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    vi.mocked(fetchInsights).mockImplementation(async (params) => {
      if (params.level === 'adset') throw new Error('injected-adset-insight-failure')
      return []
    })

    const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })

    expect(result.success).toBe(true)
    expect(vi.mocked(reconcileAcuityLedger)).toHaveBeenCalledTimes(1)
    expect((await c.query(
      `SELECT count(*)::int c FROM paid_cohort_generations WHERE ad_account_id=$1`,
      [ACCT],
    )).rows[0]?.c).toBe(0)
    expect(await flagHead(c)).toBeUndefined()
    expect(await recHead(c)).toBeUndefined()
    expect((await c.query(
      `SELECT count(*)::int c FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`,
      [ACCT, DATE],
    )).rows[0]?.c).toBe(0)
    const log = (await c.query(
      `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
      [result.logId],
    )).rows[0]
    expect(log?.status).toBe('partial')
    expect(String(log?.error_message ?? '')).toMatch(/insights:adset.*injected-adset-insight-failure/i)
    await c.end()
  })

  it('scenario 4 — single-flight: a second run is REJECTED EARLY while one is active', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    await c.query(`INSERT INTO api_sync_logs (ad_account_id, sync_type, triggered_by, status, created_at) VALUES ($1,'full','other','running', now())`, [ACCT])
    const res = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('sync_already_running')
    expect(await flagHead(c)).toBeUndefined() // aborted before ingest/flag stages
    await c.end()
  })

  it('scenario 5 — historical lifecycle gating: ingest-only, no current evidence or generations', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const hist = daysBefore(DATE, 5)
    const res = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test', dateRangeStart: hist, dateRangeEnd: hist })
    expect(res.success).toBe(true)
    expect(await flagHead(c)).toBeUndefined()
    expect(await recHead(c)).toBeUndefined()
    expect((await c.query(
      `SELECT count(*)::int c FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`,
      [ACCT, hist],
    )).rows[0]?.c).toBe(0)
    await c.end()
  })

  it('scenario 5b — historical sync never consults current decision state or creates a report', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const { getAdminClient } = await import('@/lib/supabase/admin')
    const hist = daysBefore(DATE, 5)
    const client = getAdminClient()
    const realFrom = client.from.bind(client)
    const spy = vi.spyOn(client as unknown as { from: (t: string) => unknown }, 'from').mockImplementation(((table: string) => {
      if (table !== 'decision_generations') return realFrom(table)
      const query = {
        eq: () => query,
        is: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: null, error: { message: 'injected-generation-read-failure' } }),
      }
      return { select: () => query }
    }) as never)

    try {
      const res = await runDailySync({
        adAccountId: META_ACCT,
        triggeredBy: 'test',
        dateRangeStart: hist,
        dateRangeEnd: hist,
      })

      expect(res.success).toBe(true)
      expect((await c.query(
        `SELECT count(*)::int c FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`,
        [ACCT, hist],
      )).rows[0]?.c).toBe(0)
      const log = (await c.query(
        `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
        [res.logId],
      )).rows[0]
      expect(log?.status).toBe('success')
      expect(log?.error_message ?? null).toBeNull()
    } finally {
      spy.mockRestore()
      await c.end()
    }
  })

  it('scenario 5c — a core Meta delivery read error publishes neither report nor tasks and leaves the prior report standing', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const { getAdminClient } = await import('@/lib/supabase/admin')

    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    const before = await publicationSnapshot(c, DATE)
    expect(before.report).toBeTruthy()

    const client = getAdminClient()
    const realFrom = client.from.bind(client)
    const realRpc = client.rpc.bind(client)
    const reportRpcCalls: string[] = []
    const insightSelect = 'ad_account_id,entity_level,campaign_id,adset_id,ad_id,date_start,date_stop,spend,synced_at,impressions,reach,clicks,link_clicks,landing_page_views,leads,bookings,bookings_view_through,appointment_value'

    const fromSpy = vi.spyOn(client as unknown as { from: (table: string) => unknown }, 'from')
      .mockImplementation(((table: string) => {
        const realBuilder = realFrom(table)
        if (table !== 'daily_insights') return realBuilder
        return new Proxy(realBuilder as object, {
          get(target, property, receiver) {
            if (property !== 'select') return Reflect.get(target, property, receiver)
            return (columns: string, options?: unknown) => {
              if (columns !== insightSelect) {
                return (realBuilder.select as (c: string, o?: unknown) => unknown)(columns, options)
              }
              const failed = Promise.resolve({
                data: null,
                error: { message: 'injected-report-meta-delivery-read-failure' },
              })
              const query = {
                eq: () => query,
                gte: () => query,
                lte: () => query,
                lt: () => query,
                order: () => query,
                limit: () => failed,
                maybeSingle: () => failed,
                then: failed.then.bind(failed),
              }
              return query
            }
          },
        })
      }) as never)
    const rpcSpy = vi.spyOn(client as unknown as { rpc: (name: string, args?: unknown) => unknown }, 'rpc')
      .mockImplementation(((name: string, args?: unknown) => {
        if (name === 'commit_daily_report_generation') reportRpcCalls.push(name)
        return (realRpc as unknown as (n: string, a?: unknown) => unknown)(name, args)
      }) as never)

    try {
      const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
      expect(result.success).toBe(true)
      expect(reportRpcCalls).toEqual([])
      expect(await publicationSnapshot(c, DATE)).toEqual(before)
      const log = (await c.query(
        `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
        [result.logId],
      )).rows[0]
      expect(log?.status).toBe('partial')
      expect(String(log?.error_message ?? '')).toMatch(/meta delivery.*injected-report-meta-delivery-read-failure/i)
    } finally {
      rpcSpy.mockRestore()
      fromSpy.mockRestore()
      await c.end()
    }
  })

  it('scenario 5d — an Acuity business-ledger read error publishes neither report nor tasks and leaves the prior report standing', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const { getAdminClient } = await import('@/lib/supabase/admin')

    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    const before = await publicationSnapshot(c, DATE)
    expect(before.report).toBeTruthy()

    const client = getAdminClient()
    const realFrom = client.from.bind(client)
    const realRpc = client.rpc.bind(client)
    const reportRpcCalls: string[] = []

    const fromSpy = vi.spyOn(client as unknown as { from: (table: string) => unknown }, 'from')
      .mockImplementation(((table: string) => {
        if (table !== 'v_business_outcomes') return realFrom(table)
        const query = {
          eq: () => query,
          gte: () => query,
          lte: () => query,
          order: () => query,
          range: async () => ({
            data: null,
            error: { message: 'injected-report-acuity-ledger-read-failure' },
          }),
        }
        return { select: () => query }
      }) as never)
    const rpcSpy = vi.spyOn(client as unknown as { rpc: (name: string, args?: unknown) => unknown }, 'rpc')
      .mockImplementation(((name: string, args?: unknown) => {
        if (name === 'commit_daily_report_generation') reportRpcCalls.push(name)
        return (realRpc as unknown as (n: string, a?: unknown) => unknown)(name, args)
      }) as never)

    try {
      const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
      expect(result.success).toBe(true)
      expect(reportRpcCalls).toEqual([])
      expect(await publicationSnapshot(c, DATE)).toEqual(before)
      const log = (await c.query(
        `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
        [result.logId],
      )).rows[0]
      expect(log?.status).toBe('partial')
      expect(String(log?.error_message ?? '')).toMatch(/outcome business ledger.*injected-report-acuity-ledger-read-failure/i)
    } finally {
      rpcSpy.mockRestore()
      fromSpy.mockRestore()
      await c.end()
    }
  })

  it('scenario 5e — missing account-level core-plane row skips report instead of publishing false zero', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')

    await c.query(`DELETE FROM daily_insights WHERE ad_account_id=$1 AND date_start=$2`, [ACCT, DATE])
    await purgePaidMeasurement(c, [ACCT])
    await c.query(`DELETE FROM outcomes WHERE ad_account_id=$1 AND business_date=$2`, [ACCT, DATE])
    vi.mocked(fetchInsights).mockResolvedValue([])

    const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    expect(result.success).toBe(true)
    const log = (await c.query(
      `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
      [result.logId],
    )).rows[0]
    expect(log?.status).toBe('partial')
    expect(String(log?.error_message ?? '')).toMatch(/no authoritative account-level row was returned/i)
    const report = (await c.query(
      `SELECT id
         FROM daily_reports
        WHERE ad_account_id=$1 AND report_date=$2`,
      [ACCT, DATE],
    )).rows[0]
    expect(report).toBeUndefined()
    await c.end()
  })

  it('scenario 5f — a fresh partial account response cannot mask a stale last-day row', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    vi.mocked(fetchInsights).mockImplementation(async (params) => {
      const rows = insightRowsForLevel(
        DATE,
        { spend: 42, impressions: 3_000, clicks: 30, leads: 5 },
        params.level,
      )
      return params.level === 'account'
        ? rows.filter((row) => row.date_start !== DATE)
        : rows
    })

    const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    expect(result.success).toBe(true)
    expect(await flagHead(c)).toBeUndefined()
    expect(await recHead(c)).toBeUndefined()
    expect((await c.query(
      `SELECT count(*)::int c FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`,
      [ACCT, DATE],
    )).rows[0]?.c).toBe(0)
    const log = (await c.query(
      `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
      [result.logId],
    )).rows[0]
    expect(log?.status).toBe('partial')
    expect(String(log?.error_message ?? '')).toMatch(/did not reconcile by date to account delivery/i)
    await c.end()
  })

  it('scenario 5g — positive account delivery with an empty lower level blocks decisions and report', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    vi.mocked(fetchInsights).mockImplementation(async (params) =>
      params.level === 'adset'
        ? []
        : insightRowsForLevel(
            DATE,
            { spend: 42, impressions: 3_000, clicks: 30, leads: 5 },
            params.level,
          ),
    )

    const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    expect(result.success).toBe(true)
    expect(await flagHead(c)).toBeUndefined()
    expect(await recHead(c)).toBeUndefined()
    expect((await c.query(
      `SELECT count(*)::int c FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`,
      [ACCT, DATE],
    )).rows[0]?.c).toBe(0)
    const log = (await c.query(
      `SELECT status, error_message FROM api_sync_logs WHERE id=$1`,
      [result.logId],
    )).rows[0]
    expect(log?.status).toBe('partial')
    expect(String(log?.error_message ?? '')).toMatch(/insights:adset.*positive account delivery/i)
    await c.end()
  })

  it('scenario 6 — campaign-metadata failure/freeze: stale preserves + counted, FRESH impossible unit closes, partial + telemetry', async () => {
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const { getAdminClient } = await import('@/lib/supabase/admin')
    const old = daysBefore(DATE, 10)

    // Campaign B (CBO) + its ad set + a structurally IMPOSSIBLE adset budget flag under it. B flows
    // through the REAL ingest this scenario (fetchCampaigns returns B), so its last_synced_at is stamped
    // GENUINELY fresh by upsertCampaigns — no manufactured timestamps.
    await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id, created_at) VALUES ($1,$2,'m-cb-sync',$3)`, [CAMPB, ACCT, old])
    await c.query(`INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id, created_at) VALUES ($1,$2,$3,'m-asb-sync',$4)`, [ADSETB, ACCT, CAMPB, old])
    const bFlag = '00000000-0000-4000-8000-00000000fb01'
    await c.query(`INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, flag_type, reason, is_active)
      VALUES ($1,$2,$3,7,'adset',$4,$5,'loser','impossible unit', true)`, [bFlag, ACCT, DATE, CAMPB, ADSETB])
    // A VALID adset loser under STALE campaign A (A is NOT returned by fetchCampaigns this scenario) +
    // healthy-ish adset insight ($10 -> too_early) so the loser is evaluated-but-not-reproven: ONLY the
    // freeze protects it this run.
    const aFlag = '00000000-0000-4000-8000-00000000fa01'
    await c.query(`INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, flag_type, reason, is_active)
      VALUES ($1,$2,$3,7,'adset',$4,$5,'loser','valid but frozen', true)`, [aFlag, ACCT, DATE, CAMP, ADSET])
    await c.query(`INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, campaign_id, adset_id, impressions, spend, clicks, leads, bookings)
      VALUES ($1,$1,'adset',$2,$3,$4, 200, 10, 3, 0, 0)`, [DATE, ACCT, CAMP, ADSET])

    vi.mocked(fetchCampaigns).mockResolvedValue([CAMPAIGN_B_META]) // B refreshed; A goes stale

    // Fail ONLY the ENGINE's campaign-metadata read (its select includes daily_budget); the names query,
    // the ingest upsert, and the RPC's SQL-side join are untouched.
    const client = getAdminClient()
    const realFrom = client.from.bind(client)
    const spy = vi.spyOn(client as unknown as { from: (t: string) => unknown }, 'from').mockImplementation(((table: string) => {
      const b = realFrom(table) as { select: (c: string) => unknown; upsert: (...a: unknown[]) => unknown }
      if (table !== 'campaigns') return b
      return {
        select: (cols: string) => String(cols).includes('daily_budget')
          ? { in: async () => ({ data: null, error: { message: 'injected-campaign-meta-failure' } }) }
          : b.select(cols),
        upsert: (...a: unknown[]) => b.upsert(...a),
      }
    }) as never)

    try {
      const r = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
      expect(r.success).toBe(true) // non-fatal continuation
      const fHead = await flagHead(c)
      // The VALID flag under stale A is PRESERVED (freeze + stale agree) ...
      expect((await c.query(`SELECT is_active FROM flags WHERE id=$1`, [aFlag])).rows[0]?.is_active).toBe(true)
      // ... while B's structurally impossible flag CLOSES: the DB independently observed the genuinely
      // fresh row even though the APPLICATION could not read campaign metadata at all.
      const b = (await c.query(`SELECT is_active, superseded_reason FROM flags WHERE id=$1`, [bFlag])).rows[0]
      expect(b?.is_active).toBe(false)
      expect(b?.superseded_reason).toBe('structural_unit_change')
      // No NEW budget decisions were produced under the freeze.
      const newBudget = (await c.query(`SELECT count(*)::int c FROM flags WHERE ad_account_id=$1 AND generation_id=$2 AND flag_type IN ('loser','scale_candidate') AND entity_level IN ('adset','campaign')`, [ACCT, fHead])).rows[0]
      expect(newBudget?.c).toBe(0)
      // Honest partial + persisted freeze/closure telemetry.
      const log = (await c.query(`SELECT status, error_message FROM api_sync_logs WHERE id=$1`, [r.logId])).rows[0]
      expect(log?.status).toBe('partial')
      expect(String(log?.error_message ?? '')).toMatch(/frozen/)
      const man = (await c.query(`SELECT structural_closures, unknown_metadata_flags, budget_decisions_frozen FROM decision_generations WHERE id=$1`, [fHead])).rows[0]
      expect(man?.budget_decisions_frozen).toBe(true)
      expect(Number(man?.structural_closures)).toBeGreaterThanOrEqual(1)
      expect(Number(man?.unknown_metadata_flags)).toBeGreaterThanOrEqual(1) // A's preserved loser, counted
    } finally {
      spy.mockRestore()
    }

    // CONTROL: freeze lifted and A refreshed -> the valid-but-unproven loser now closes normally.
    vi.mocked(fetchCampaigns).mockResolvedValue([CAMPAIGN_A_META, CAMPAIGN_B_META])
    const r2 = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'test' })
    expect(r2.success).toBe(true)
    const a2 = (await c.query(`SELECT is_active, superseded_reason FROM flags WHERE id=$1`, [aFlag])).rows[0]
    expect(a2?.is_active).toBe(false)
    expect(a2?.superseded_reason).toBe('not_reproven')
    await c.end()
  })
})
