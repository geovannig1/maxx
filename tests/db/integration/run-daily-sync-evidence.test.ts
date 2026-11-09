import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import pg from 'pg'
import { yesterday as appYesterday } from '@/lib/utils/date-utils'
import { purgeExecutiveEvidence, purgePaidMeasurement } from './paid-measurement-purge'
import { insightRowsForLevel } from './run-daily-sync-fixture'
import { insertOutcomeOutcome } from './outcome-fixture'
import { EXAMPLE_OWNER_TARGETS } from '../../helpers/example-owner-targets'
import type { MetaCampaign } from '@/types/meta-api'

// The REAL runDailySync end-to-end, against the local Supabase with Meta mocked at
// the fetch layer (the existing harness pattern). The previous "pipeline" test never called
// runDailySync at all: it drove generateRecommendationsFromFlags directly, so nothing proved the
// evidence gate is reached through actual orchestration.
//
// This exercises: fetch/ingest -> flag generation -> evidence gathering -> recommendation generation
// -> persisted gated recommendation + test brief -> report pin.

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
// GA4 is mocked so a NONZERO Meta-paid value can be traced into the final decision record.
vi.mock('@/lib/ga4/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getGa4ConfirmationTelemetryBySource: vi.fn(),
}))
import { fetchAdAccount } from '@/lib/platforms/meta/fetch-accounts'
import { fetchCampaigns } from '@/lib/platforms/meta/fetch-campaigns'
import { fetchAdSets } from '@/lib/platforms/meta/fetch-adsets'
import { fetchCustomAudiences } from '@/lib/platforms/meta/fetch-custom-audiences'
import { fetchAds } from '@/lib/platforms/meta/fetch-ads'
import { fetchCreatives } from '@/lib/platforms/meta/fetch-creatives'
import { fetchInsights } from '@/lib/platforms/meta/fetch-insights'
import { reconcileAcuityLedger } from '@/lib/outcomes/adapters/acuity/reconcile'
import { getGa4ConfirmationTelemetryBySource } from '@/lib/ga4/client'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000f9'
const META_ACCT = 'act_e2e_evidence'
const OTHER_ACCT = '00000000-0000-4000-8000-0000000000fa'
const CAMP = '00000000-0000-4000-8000-0000000000fb'
const ADSET = '00000000-0000-4000-8000-0000000000fc'
const AD = '00000000-0000-4000-8000-0000000000fd'

const GA4_META_PAID_BOOKINGS = 3 // the distinctive value we trace end to end

const conn = async () => { const x = new pg.Client({ connectionString: DB }); await x.connect(); return x }
let c: pg.Client

const daysBefore = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10) }
// PRE-EXISTING DEFECT (found in review, present since this file was written): this computed
// "yesterday" in UTC while runDailySync computes it in NEW YORK time via nyDaysAgo(1). Between 8pm ET
// and midnight ET the two differ by a day, so the fixture seeded insights for a date the flag engine
// never queried — 0 flags, 0 recommendations, and two failures that look like a code regression. The
// suite must use the SAME clock as the code under test.
const yesterday = () => appYesterday()

const CAMPAIGN_META = { id: 'm-c-ev', name: 'E2E Campaign', status: 'ACTIVE', effective_status: 'ACTIVE' } as MetaCampaign

/** Targeting that resolves MIXED once its audiences are known. */
const MIXED_TARGETING = {
  custom_audiences: [{ id: 'CA_S' }, { id: 'LAL_S' }],
  targeting_automation: { advantage_audience: 1 },
  geo_locations: { cities: [{ name: 'Metro', radius: 20 }] },
}

async function seed(date: string) {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
  await purgeExecutiveEvidence(c, [ACCT, OTHER_ACCT])
  await purgePaidMeasurement(c, [ACCT, OTHER_ACCT])
  for (const t of ['recommendations', 'flags', 'decision_generations', 'daily_reports', 'audit_tasks',
                   'daily_insights', 'experiments', 'custom_audiences', 'creatives', 'ads', 'adsets', 'campaigns', 'api_sync_logs']) {
    await c.query(`DELETE FROM ${t} WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]]).catch(() => {})
  }
  await c.query(`DELETE FROM outcomes WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]])
  await c.query(`DELETE FROM outcome_sources WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]])
  await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]])
  await c.query(`UPDATE ad_accounts SET is_active=false WHERE id<>$1`, [ACCT])
  await c.query(
    `INSERT INTO ad_accounts (id, account_id, is_active) VALUES ($1,$2,true), ($3,'act_other_e2e',false)`,
    [ACCT, META_ACCT, OTHER_ACCT],
  )
  // Precondition: money metrics have no built-in target, so the zero-outcome loser tier needs an
  // owner-set CPA target. Store the example owner's targets where Settings -> Performance Targets does;
  // runDailySync loads them for the run.
  await c.query(
    `INSERT INTO app_settings (ad_account_id, key, value, setting_type) VALUES ($1, 'performance_targets', $2, 'json')
     ON CONFLICT (ad_account_id, key) DO UPDATE SET value=excluded.value`,
    [ACCT, JSON.stringify(EXAMPLE_OWNER_TARGETS)],
  )

  const old = daysBefore(date, 10)
  await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id, created_at) VALUES ($1,$2,'m-c-ev',$3)`, [CAMP, ACCT, old])
  await c.query(
    `INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id, adset_name, targeting, targeting_last_synced_at, daily_budget, learning_stage, created_at)
     VALUES ($1,$2,$3,'m-as-ev','Warm Engagers | Retargeting',$4::jsonb,now(),24,'LEARNING_LIMITED',$5)`,
    [ADSET, ACCT, CAMP, JSON.stringify(MIXED_TARGETING), old])
  await c.query(`INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id, created_at) VALUES ($1,$2,$3,$4,'m-ad-ev',$5)`, [AD, ACCT, CAMP, ADSET, old])
  await c.query(
    `INSERT INTO custom_audiences (ad_account_id, audience_id, name, subtype, meta_account_id)
     VALUES ($1,'CA_S','site visitors','WEBSITE',$2), ($1,'LAL_S','lal 1%','LOOKALIKE',$2)`, [ACCT, META_ACCT])

  // Ad-level day that produces a LOSER flag (spend, zero bookings, real impressions).
  await c.query(
    `INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, campaign_id, adset_id, ad_id, impressions, spend, clicks, leads, bookings)
     VALUES ($1,$1,'ad',$2,$3,$4,$5, 2600, 141, 27, 0, 0)`, [date, ACCT, CAMP, ADSET, AD])
  await c.query(
    `INSERT INTO daily_insights (
       date_start,date_stop,entity_level,ad_account_id,impressions,spend,clicks,leads,
       bookings,bookings_view_through)
     SELECT day::date,day::date,'account',$2,
       CASE WHEN day::date=$1::date THEN 31400 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 742 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 388 ELSE 0 END,
       0,
       CASE WHEN day::date=$1::date THEN 8 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 6 ELSE 0 END
     FROM generate_series($1::date - interval '29 days',$1::date,interval '1 day') day`,
    [date, ACCT],
  )

  // First-party bookings for BOTH accounts — account isolation must hold.
  for (const [account, outcomeId] of [[ACCT, 994000001], [OTHER_ACCT, 994000002]] as const) {
    await insertOutcomeOutcome(c, account, outcomeId, {
      gross_value: 265, collected_value: 265, status: 'confirmed',
      occurred_at: date, business_date: date, observation_source: 'webhook',
    })
  }
}

function mockMeta(date: string) {
  vi.mocked(fetchAdAccount).mockResolvedValue({ id: META_ACCT, name: 'E2E', account_status: 1, currency: 'USD', timezone_name: 'America/New_York' } as never)
  vi.mocked(fetchCampaigns).mockResolvedValue([CAMPAIGN_META])
  vi.mocked(fetchAdSets).mockResolvedValue([])
  vi.mocked(fetchCustomAudiences).mockResolvedValue([])
  vi.mocked(fetchAds).mockResolvedValue([])
  vi.mocked(fetchCreatives).mockResolvedValue([])
  vi.mocked(fetchInsights).mockImplementation(async (params) =>
    insightRowsForLevel(date, {
      spend: 742, impressions: 31_400, clicks: 388, leads: 0,
      bookings: params.level === 'account' ? 8 : 0,
      viewBookings: params.level === 'account' ? 6 : 0,
    }, params.level, {
      campaignId: 'm-c-ev',
      adsetId: 'm-as-ev',
      adId: 'm-ad-ev',
    }),
  )
  vi.mocked(getGa4ConfirmationTelemetryBySource).mockResolvedValue({
    available: true,
    paid: { confirmationEvents: 99, eventValue: 9900 },      // blended paid — must NOT be used
    organic: { confirmationEvents: 0, eventValue: 0 },
    metaPaid: { confirmationEvents: GA4_META_PAID_BOOKINGS, eventValue: 870 }, // the Meta-scoped value
    byChannel: [], zeroValueEvents: 0,
  } as never)
  void date
}

const recs = async () => (await c.query(
  `SELECT recommendation_type, grounding_json FROM recommendations WHERE ad_account_id=$1`, [ACCT])).rows as Array<{ recommendation_type: string; grounding_json: unknown }>
const briefs = async () => (await c.query(`SELECT * FROM experiments WHERE ad_account_id=$1`, [ACCT])).rows

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
  if (c) {
    for (const t of ['recommendations', 'flags', 'decision_generations', 'daily_reports', 'audit_tasks',
                     'daily_insights', 'experiments', 'custom_audiences', 'creatives', 'ads', 'adsets', 'campaigns', 'api_sync_logs']) {
      await c.query(`DELETE FROM ${t} WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]]).catch(() => {})
    }
    await purgeExecutiveEvidence(c, [ACCT, OTHER_ACCT])
    await purgePaidMeasurement(c, [ACCT, OTHER_ACCT])
    await c.query(`DELETE FROM outcomes WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]])
    await c.query(`DELETE FROM outcome_sources WHERE ad_account_id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]])
    await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT, OTHER_ACCT]])
    await c.end()
  }
})

describe('runDailySync — the evidence gate is reached through REAL orchestration', () => {
  it('ingest -> flags -> evidence -> gated recommendation -> no invented test -> report pin', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE)
    const { runDailySync } = await import('@/lib/sync/orchestrator')

    const r = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'rev-i-e2e' })
    expect(r.success).toBe(true)

    // Flags and recommendations were generated through the real chain.
    const fHead = (await c.query(`SELECT id FROM decision_generations WHERE ad_account_id=$1 AND kind='flag' AND is_current`, [ACCT])).rows[0]
    const rHead = (await c.query(`SELECT id, parent_generation_id FROM decision_generations WHERE ad_account_id=$1 AND kind='recommendation' AND is_current`, [ACCT])).rows[0]
    expect(fHead?.id).toBeTruthy()
    expect(rHead?.parent_generation_id).toBe(fHead.id) // cross-stage lineage survives

    const rows = await recs()
    expect(rows.length).toBeGreaterThan(0)
    // NO money-moving type survives the gate.
    for (const x of rows) {
      expect(['scale', 'scale_proposal', 'reduce_budget', 'pause', 'activate']).not.toContain(x.recommendation_type)
    }
    const grounding = rows.map((x) => JSON.stringify(x.grounding_json ?? {})).join(' ')
    expect(grounding).toMatch(/DECISION GATE: verdict/)

    // The report is pinned to the recommendation generation.
    const rep = (await c.query(
      `SELECT recommendation_generation_id FROM daily_reports WHERE ad_account_id=$1 ORDER BY report_date DESC LIMIT 1`, [ACCT])).rows[0]
    expect(rep?.recommendation_generation_id).toBe(rHead.id)

    // A blocked money move identifies missing evidence but cannot invent test floors or an owner
    // loss ceiling. CampaignPlan-driven test creation is intentionally unavailable.
    expect(await briefs()).toHaveLength(0)
  }, 120000)

  it('the NONZERO GA4 Meta-paid value reaches the final decision record', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE)
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'rev-i-e2e' })

    const grounding = (await recs()).map((x) => JSON.stringify(x.grounding_json ?? {})).join(' ')
    // The META-scoped 3, not the blended 99 — traced from the GA4 client to the persisted record.
    expect(grounding).toContain(`web-attributed (GA4) outcomes: ${GA4_META_PAID_BOOKINGS}`)
    expect(grounding).not.toContain('web-attributed (GA4) outcomes: 99')
    expect(grounding).toContain('ga4_meta_paid')
    // First-party is ACCOUNT-scoped and isolated: only THIS account's booking, not the other's.
    expect(grounding).toContain('first-party outcomes: 1 [scope=account')
    expect(grounding).toMatch(/scope=account/)
  }, 120000)

  it('ACCOUNT ISOLATION — the other account gets no recommendations from this run', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE)
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'rev-i-e2e' })

    const other = await c.query(`SELECT count(*)::int n FROM recommendations WHERE ad_account_id=$1`, [OTHER_ACCT])
    expect(other.rows[0].n).toBe(0)
    const otherGens = await c.query(`SELECT count(*)::int n FROM decision_generations WHERE ad_account_id=$1`, [OTHER_ACCT])
    expect(otherGens.rows[0].n).toBe(0)
  }, 120000)

  it('FAIL-STOP: a recommendation-publish failure leaves the prior report standing', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE)
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'rev-i-e2e' })
    const before = (await c.query(
      `SELECT recommendation_generation_id FROM daily_reports WHERE ad_account_id=$1 ORDER BY report_date DESC LIMIT 1`, [ACCT])).rows[0]

    // Fault the actual atomic publication boundary. Table INSERT revocation is bypassed by the
    // SECURITY DEFINER RPC and therefore cannot prove fail-stop behavior anymore.
    await c.query(`REVOKE EXECUTE ON FUNCTION replace_recommendation_generation_with_claims_and_decisions(uuid,uuid,uuid,uuid,date,jsonb,jsonb,jsonb) FROM service_role`)
    try {
      const r2 = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'rev-i-e2e-fail' })
      expect(r2.success).toBe(true) // non-fatal continuation, but...
      const after = (await c.query(
        `SELECT recommendation_generation_id FROM daily_reports WHERE ad_account_id=$1 ORDER BY report_date DESC LIMIT 1`, [ACCT])).rows[0]
      // ...the prior report's pin is NOT overwritten blind by a run whose rec stage failed.
      expect(after?.recommendation_generation_id).toBe(before?.recommendation_generation_id)
    } finally {
      await c.query(`GRANT EXECUTE ON FUNCTION replace_recommendation_generation_with_claims_and_decisions(uuid,uuid,uuid,uuid,date,jsonb,jsonb,jsonb) TO service_role`)
    }
  }, 180000)

  it('FAIL-STOP: an evidence-gathering failure does not produce a money-moving recommendation', async () => {
    const DATE = yesterday()
    await seed(DATE)
    mockMeta(DATE)
    // GA4 throwing is the most likely evidence failure; gathering must degrade, never open the gate.
    vi.mocked(getGa4ConfirmationTelemetryBySource).mockRejectedValue(new Error('GA4 quota exceeded'))
    const { runDailySync } = await import('@/lib/sync/orchestrator')
    const r = await runDailySync({ adAccountId: META_ACCT, triggeredBy: 'rev-i-e2e-ga4fail' })
    expect(r.success).toBe(true)
    for (const x of await recs()) {
      expect(['scale', 'scale_proposal', 'reduce_budget', 'pause', 'activate']).not.toContain(x.recommendation_type)
    }
  }, 120000)
})
