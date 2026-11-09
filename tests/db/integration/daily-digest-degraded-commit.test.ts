import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import pg from 'pg'
import { yesterday as appYesterday } from '@/lib/utils/date-utils'
import { purgeExecutiveEvidence, purgePaidMeasurement } from './paid-measurement-purge'
import { insightRowsForLevel } from './run-daily-sync-fixture'
import { insertOutcomeOutcome } from './outcome-fixture'
import type { MetaCampaign, MetaInsightRow } from '@/types/meta-api'

/**
 * REGRESSION — the daily digest did not send, and the sync tail said
 * `report: stale_generation`.
 *
 * The real precondition is NOT "a daily report already exists for the date". It is the pair:
 *   1. this run produced NO recommendation generation (recGenerationId === null, which is exactly
 *      what an incomplete Meta outcome plane forces), AND
 *   2. some earlier, non-rolled-back recommendation generation already exists for the SAME
 *      reference_date.
 * commit_daily_report_generation's null-generation branch then returns `stale_generation`, the
 * orchestrator returns no committedReport, and the cron reports `report_not_committed`.
 *
 * These tests pin both halves against real Postgres through the REAL orchestrator:
 *  - a FRESH report date under a degraded (unavailable) Meta outcome plane still commits a V3
 *    digest bound to an immutable evidence generation, and that digest delivers exactly one email;
 *  - the same degraded run against a date that already carries a recommendation generation is
 *    refused with `stale_generation` and yields no committedReport (the incident, reproduced);
 *  - a retry of the same degraded run re-commits the same report row without mailing twice.
 */

vi.mock('@/lib/platforms/meta/fetch-accounts', () => ({ fetchAdAccount: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-campaigns', () => ({ fetchCampaigns: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-adsets', () => ({ fetchAdSets: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-custom-audiences', () => ({ fetchCustomAudiences: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-ads', () => ({ fetchAds: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-creatives', () => ({ fetchCreatives: vi.fn() }))
vi.mock('@/lib/platforms/meta/fetch-insights', () => ({ fetchInsights: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/acuity/reconcile', () => ({ reconcileAcuityLedger: vi.fn() }))
// Production hit `(#100) ... action_type, platform_position is invalid` on this exact call during the
// incident, so the suite proves the report path survives a failing placement refresh too.
vi.mock('@/lib/sync/executive-placement-evidence', () => ({
  refreshExecutivePlacementEvidence: vi.fn(async () => {
    throw new Error('(#100) Current combination of data breakdown columns is invalid')
  }),
}))

import { fetchAdAccount } from '@/lib/platforms/meta/fetch-accounts'
import { fetchCampaigns } from '@/lib/platforms/meta/fetch-campaigns'
import { fetchAdSets } from '@/lib/platforms/meta/fetch-adsets'
import { fetchCustomAudiences } from '@/lib/platforms/meta/fetch-custom-audiences'
import { fetchAds } from '@/lib/platforms/meta/fetch-ads'
import { fetchCreatives } from '@/lib/platforms/meta/fetch-creatives'
import { fetchInsights } from '@/lib/platforms/meta/fetch-insights'
import { reconcileAcuityLedger } from '@/lib/outcomes/adapters/acuity/reconcile'
import { isDailyDigestV3, readDailyDigestSnapshot } from '@/lib/report/daily-digest'
import { deliverDailyDigestSafely } from '@/lib/report/daily-digest-delivery'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000e1'
const META_ACCT = 'act_e2e_degraded_digest'
const CAMP = '00000000-0000-4000-8000-0000000000e2'
const ADSET = '00000000-0000-4000-8000-0000000000e3'
const AD = '00000000-0000-4000-8000-0000000000e4'

/** Gmail SMTP config the delivery layer accepts, injected — never read from the real environment.
 *  The @gmail.com sender is required: the delivery path rejects any other domain. */
const DELIVERY_ENV = {
  DAILY_DIGEST_EMAIL_PROVIDER: 'gmail_smtp',
  GMAIL_SMTP_USER: 'digest-sender-alt-fixture@gmail.com',
  GMAIL_SMTP_APP_PASSWORD: 'abcdefghijklmnop',
  OWNER_EMAIL: 'digest-sender-alt-fixture@gmail.com',
}

const conn = async () => { const x = new pg.Client({ connectionString: DB }); await x.connect(); return x }
let c: pg.Client

const daysBefore = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10)
}
// Same clock as the code under test: runDailySync derives its end date from nyDaysAgo(1).
const yesterday = () => appYesterday()

const CAMPAIGN_META = {
  id: 'm-c-deg', name: 'Degraded Campaign', status: 'ACTIVE', effective_status: 'ACTIVE',
} as MetaCampaign

async function seed(date: string) {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  await c.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role')
  await purgeExecutiveEvidence(c, [ACCT])
  await purgePaidMeasurement(c, [ACCT])
  for (const t of ['recommendations', 'flags', 'decision_generations', 'audit_tasks',
    'daily_insights', 'experiments', 'custom_audiences', 'creatives', 'ads', 'adsets',
    'campaigns', 'api_sync_logs']) {
    await c.query(`DELETE FROM ${t} WHERE ad_account_id = $1`, [ACCT]).catch(() => {})
  }
  await c.query('DELETE FROM outcomes WHERE ad_account_id = $1', [ACCT])
  await c.query('DELETE FROM outcome_sources WHERE ad_account_id = $1', [ACCT])
  await c.query('DELETE FROM ad_accounts WHERE id = $1', [ACCT])
  await c.query('UPDATE ad_accounts SET is_active=false WHERE id<>$1', [ACCT])
  await c.query('INSERT INTO ad_accounts (id, account_id, is_active) VALUES ($1,$2,true)', [ACCT, META_ACCT])

  const old = daysBefore(date, 10)
  await c.query("INSERT INTO campaigns (id, ad_account_id, campaign_id, created_at) VALUES ($1,$2,'m-c-deg',$3)", [CAMP, ACCT, old])
  await c.query(
    `INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id, adset_name, daily_budget, created_at)
     VALUES ($1,$2,$3,'m-as-deg','Cold | Prospecting',30,$4)`, [ADSET, ACCT, CAMP, old])
  await c.query("INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id, created_at) VALUES ($1,$2,$3,$4,'m-ad-deg',$5)", [AD, ACCT, CAMP, ADSET, old])
  await c.query(
    `INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, campaign_id, adset_id, ad_id, impressions, spend, clicks, leads, bookings)
     VALUES ($1,$1,'ad',$2,$3,$4,$5, 3000, 42, 30, 0, 0)`, [date, ACCT, CAMP, ADSET, AD])
  await c.query(
    `INSERT INTO daily_insights (
       date_start,date_stop,entity_level,ad_account_id,impressions,spend,clicks,leads,bookings)
     SELECT day::date,day::date,'account',$2,
       CASE WHEN day::date=$1::date THEN 3000 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 42 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 30 ELSE 0 END,
       0, 0
     FROM generate_series($1::date - interval '29 days',$1::date,interval '1 day') day`,
    [date, ACCT],
  )
  await insertOutcomeOutcome(c, ACCT, 993100001, {
    gross_value: 250, collected_value: 250, status: 'confirmed',
    occurred_at: date, business_date: date, observation_source: 'webhook',
  })
}

/** Ad-level outcome payloads Meta cannot be trusted on: an unparseable result value sets
 *  NormalizedOutcome.valid=false, producing `meta_outcome_ad_payload_invalid:<date>` — the EXACT
 *  blocker family behind the regression. Delivery scalars stay valid, so
 *  insightLevelsComplete (a delivery-only gate) is unaffected and the report path is still reached. */
function corruptAdOutcomes(rows: MetaInsightRow[]): MetaInsightRow[] {
  return rows.map((row) => ({
    ...row,
    results: [{
      indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
      values: [{ value: 'not-a-number', attribution_windows: ['default'] }],
    }],
  })) as MetaInsightRow[]
}

function mockMeta(date: string, options: { degradeOutcomePlane: boolean }) {
  vi.mocked(fetchAdAccount).mockResolvedValue({
    id: META_ACCT, name: 'Degraded E2E', account_status: 1, currency: 'USD', timezone_name: 'America/New_York',
  } as never)
  vi.mocked(fetchCampaigns).mockResolvedValue([CAMPAIGN_META])
  vi.mocked(fetchAdSets).mockResolvedValue([])
  vi.mocked(fetchCustomAudiences).mockResolvedValue([])
  vi.mocked(fetchAds).mockResolvedValue([])
  vi.mocked(fetchCreatives).mockResolvedValue([])
  vi.mocked(fetchInsights).mockImplementation(async (params) => {
    const rows = insightRowsForLevel(date, {
      spend: 42, impressions: 3_000, clicks: 30, leads: 0, bookings: 0, viewBookings: 0,
    }, params.level, { campaignId: 'm-c-deg', adsetId: 'm-as-deg', adId: 'm-ad-deg' })
    return options.degradeOutcomePlane && params.level === 'ad' ? corruptAdOutcomes(rows) : rows
  })
}

const reportRow = async (date: string) => (await c.query(
  `SELECT id, to_char(report_date, 'YYYY-MM-DD') AS report_date, recommendation_generation_id,
          executive_evidence_generation_id, report_json
     FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, date])).rows[0] as {
  id: string
  report_date: string
  recommendation_generation_id: string | null
  executive_evidence_generation_id: string | null
  report_json: Record<string, unknown> | null
} | undefined

const recGenCount = async (date: string) => Number((await c.query(
  `SELECT count(*)::int n FROM decision_generations
    WHERE ad_account_id=$1 AND kind='recommendation' AND reference_date=$2 AND rolled_back_at IS NULL`,
  [ACCT, date])).rows[0].n)

const attempts = async () => (await c.query(
  `SELECT a.id, a.status, a.payload_fingerprint FROM daily_digest_delivery_attempts a
     JOIN daily_reports r ON r.id = a.report_id WHERE r.ad_account_id=$1 ORDER BY a.claimed_at`,
  [ACCT])).rows as Array<{ id: string; status: string; payload_fingerprint: string }>

/** The cron's Step-18 read, verbatim: bind to the exact report this run committed and refuse anything
 *  that is not a current V3 snapshot for that date. Mirrors deliverCommittedDailyExecutive. */
function readCommittedDigest(row: NonNullable<Awaited<ReturnType<typeof reportRow>>>) {
  const digest = readDailyDigestSnapshot(
    (row.report_json as { dailyDigest?: unknown } | null)?.dailyDigest,
  )
  return digest && isDailyDigestV3(digest) && digest.report_date === row.report_date ? digest : null
}

beforeEach(async () => {
  if (!c) c = await conn()
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

afterAll(async () => {
  if (!c) return
  for (const t of ['recommendations', 'flags', 'decision_generations', 'audit_tasks',
    'daily_insights', 'experiments', 'custom_audiences', 'creatives', 'ads', 'adsets',
    'campaigns', 'api_sync_logs']) {
    await c.query(`DELETE FROM ${t} WHERE ad_account_id = $1`, [ACCT]).catch(() => {})
  }
  await purgeExecutiveEvidence(c, [ACCT])
  await purgePaidMeasurement(c, [ACCT])
  await c.query('DELETE FROM outcomes WHERE ad_account_id = $1', [ACCT])
  await c.query('DELETE FROM outcome_sources WHERE ad_account_id = $1', [ACCT])
  await c.query('DELETE FROM ad_accounts WHERE id = $1', [ACCT])
  await c.end()
})

describe('daily report commit + digest delivery under a degraded Meta outcome plane', () => {
  it('FRESH date + unavailable outcome plane: the report still commits a V3 digest bound to evidence', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE, { degradeOutcomePlane: true })
    const { runDailySync } = await import('@/lib/sync/orchestrator')

    const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'degraded-e2e' })

    // The precondition under test: the outcome plane really is unavailable this run.
    expect(result.success).toBe(true)
    expect(result.metaOutcomeMetricsComplete).toBe(false)
    expect(result.metaOutcomeBlockerCodes.some((code) => code.startsWith('meta_outcome_ad_payload_invalid'))).toBe(true)

    // Frozen decisions: no recommendation generation exists for the date, so the report is committed
    // through the RPC's null-generation branch.
    expect(await recGenCount(DATE)).toBe(0)

    // The report committed anyway, and the orchestrator handed the cron a committedReport.
    expect(result.committedReport).toBeTruthy()
    expect(result.committedReport?.reportDate).toBe(DATE)

    const row = await reportRow(DATE)
    expect(row).toBeTruthy()
    expect(row?.id).toBe(result.committedReport?.id)
    expect(row?.recommendation_generation_id).toBeNull()
    // A V3 digest cannot exist without its immutable evidence generation (baseline trigger).
    expect(row?.executive_evidence_generation_id).toBeTruthy()

    const digest = readCommittedDigest(row!)
    expect(digest).toBeTruthy()
    expect(digest?.contract_version).toBe(3)
    expect(digest?.subject).toBe(`Maxx daily digest — ${DATE}`)
    expect(digest!.markdown.length).toBeGreaterThan(0)

    const evidence = (await c.query(
      `SELECT report_date, contract_version FROM executive_evidence_generations WHERE id=$1`,
      [row!.executive_evidence_generation_id])).rows[0]
    expect(evidence?.report_date instanceof Date
      ? evidence.report_date.toISOString().slice(0, 10)
      : evidence?.report_date).toBe(DATE)
    expect(evidence?.contract_version).toBe(1)
  }, 180000)

  it('the committed degraded digest delivers exactly one email; a re-invocation is idempotent', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE, { degradeOutcomePlane: true })
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const result = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'degraded-e2e' })
    const row = await reportRow(DATE)
    const digest = readCommittedDigest(row!)
    expect(digest).toBeTruthy()

    const sent: Array<{ subject: string; text: string }> = []
    const sender = async (message: { subject: string; text: string }) => {
      sent.push({ subject: message.subject, text: message.text })
      return { messageId: 'local-test-message-id' }
    }

    const first = await deliverDailyDigestSafely({
      reportId: result.committedReport!.id,
      reportDate: digest!.report_date,
      subject: digest!.subject,
      markdown: digest!.markdown,
    }, { env: DELIVERY_ENV, gmailSmtpSender: sender as never })
    expect(first).toEqual({ status: 'sent', provider: 'gmail_smtp', provider_message_id: 'local-test-message-id' })
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe(`Maxx daily digest — ${DATE}`)

    // The durable ledger makes a retry of the SAME committed report a no-op, not a second email.
    const second = await deliverDailyDigestSafely({
      reportId: result.committedReport!.id,
      reportDate: digest!.report_date,
      subject: digest!.subject,
      markdown: digest!.markdown,
    }, { env: DELIVERY_ENV, gmailSmtpSender: sender as never })
    expect(second).toEqual({ status: 'skipped', reason: 'already_attempted' })
    expect(sent).toHaveLength(1)

    const ledger = await attempts()
    expect(ledger).toHaveLength(1)
    expect(ledger[0].status).toBe('sent')
  }, 180000)

  it('INCIDENT REPRODUCTION: a prior recommendation generation for the SAME date forces stale_generation', async () => {
    const DATE = yesterday()
    await seed(DATE)

    // Run 1 — healthy outcome plane. This is the pre-deploy 10:35Z cron: it publishes a
    // recommendation generation for the date and commits a report pinned to it.
    mockMeta(DATE, { degradeOutcomePlane: false })
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const healthy = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'degraded-e2e-healthy' })
    expect(healthy.metaOutcomeMetricsComplete).toBe(true)
    expect(await recGenCount(DATE)).toBe(1)
    const pinnedReport = await reportRow(DATE)
    expect(pinnedReport?.recommendation_generation_id).toBeTruthy()

    // Run 2 — same date, outcome plane now unavailable. Decisions freeze, so the report is offered
    // with a NULL recommendation generation while run 1's generation is still current for the date.
    mockMeta(DATE, { degradeOutcomePlane: true })
    const degraded = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'degraded-e2e-second' })
    expect(degraded.success).toBe(true)
    expect(degraded.metaOutcomeMetricsComplete).toBe(false)

    // The commit is refused, no committedReport is returned — the cron then reports
    // `daily_digest: { status: 'skipped', reason: 'report_not_committed' }` and sends nothing.
    expect(degraded.committedReport).toBeUndefined()

    const after = await reportRow(DATE)
    // The prior report stands, untouched and still pinned to run 1's generation.
    expect(after?.id).toBe(pinnedReport?.id)
    expect(after?.recommendation_generation_id).toBe(pinnedReport?.recommendation_generation_id)

    const log = (await c.query(
      `SELECT error_message FROM api_sync_logs WHERE ad_account_id=$1 AND triggered_by='degraded-e2e-second'`,
      [ACCT])).rows[0] as { error_message: string | null } | undefined
    expect(log?.error_message ?? '').toContain('report: stale_generation')
  }, 240000)

  it('RETRY: a second degraded run on the same fresh date re-commits the same row and mails once', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE, { degradeOutcomePlane: true })
    const { runDailySync } = await import('@/lib/sync/orchestrator')

    const first = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'degraded-e2e-retry-1' })
    expect(first.committedReport).toBeTruthy()
    const second = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'degraded-e2e-retry-2' })
    // No recommendation generation was ever created, so the null-generation branch stays open and
    // the retry commits again — onto the SAME (ad_account_id, report_date) row.
    expect(second.committedReport).toBeTruthy()
    expect(second.committedReport?.id).toBe(first.committedReport?.id)

    const sent: string[] = []
    const sender = async (message: { subject: string }) => { sent.push(message.subject); return { messageId: null } }
    const row = await reportRow(DATE)
    const digest = readCommittedDigest(row!)
    expect(digest).toBeTruthy()

    for (const attempt of [first, second]) {
      await deliverDailyDigestSafely({
        reportId: attempt.committedReport!.id,
        reportDate: digest!.report_date,
        subject: digest!.subject,
        markdown: digest!.markdown,
      }, { env: DELIVERY_ENV, gmailSmtpSender: sender as never })
    }
    // Identical committed facts ⇒ identical fingerprint ⇒ one claim, one email.
    expect(sent).toHaveLength(1)
    expect(await attempts()).toHaveLength(1)
  }, 240000)
})
