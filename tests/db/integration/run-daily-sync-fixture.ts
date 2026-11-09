import pg from 'pg'
import { purgeExecutiveEvidence, purgePaidMeasurement } from './paid-measurement-purge'
import { insertOutcomeOutcome } from './outcome-fixture'
import type { MetaCampaign, MetaInsightRow } from '@/types/meta-api'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
export const ACCT = '00000000-0000-4000-8000-0000000000f1'
export const META_ACCT = 'act_e2e_sync'
export const CAMP = '00000000-0000-4000-8000-0000000000f2'
export const ADSET = '00000000-0000-4000-8000-0000000000f3'
const AD = '00000000-0000-4000-8000-0000000000f4'
export const CAMPB = '00000000-0000-4000-8000-0000000000f5'
export const ADSETB = '00000000-0000-4000-8000-0000000000f6'

export const CAMPAIGN_A_META = {
  id: 'm-c-sync',
  name: 'Sync A',
  status: 'ACTIVE',
  effective_status: 'ACTIVE',
} as MetaCampaign
export const CAMPAIGN_B_META = {
  id: 'm-cb-sync',
  name: 'Sync B',
  status: 'ACTIVE',
  effective_status: 'ACTIVE',
  daily_budget: '100',
} as MetaCampaign

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

function hostOf(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export async function conn() {
  const client = new pg.Client({ connectionString: DB })
  await client.connect()
  return client
}

export function daysBefore(dateStr: string, days: number) {
  const date = new Date(`${dateStr}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

export function accountInsightRows(
  date: string,
  latest: {
    spend: number
    impressions: number
    clicks: number
    leads: number
    bookings?: number
    viewBookings?: number
    appointmentValue?: number
  },
): MetaInsightRow[] {
  return Array.from({ length: 30 }, (_, index) => {
    const day = daysBefore(date, 29 - index)
    const current = day === date
    const bookings = current ? (latest.bookings ?? 0) : 0
    const viewBookings = current ? (latest.viewBookings ?? 0) : 0
    return {
      date_start: day,
      date_stop: day,
      impressions: String(current ? latest.impressions : 0),
      reach: String(current ? Math.max(0, latest.impressions - 100) : 0),
      spend: String(current ? latest.spend : 0),
      clicks: String(current ? latest.clicks : 0),
      actions: [
        { action_type: 'lead', value: String(current ? latest.leads : 0) },
        { action_type: 'link_click', value: String(current ? latest.clicks : 0) },
        { action_type: 'landing_page_view', value: String(current ? latest.clicks : 0) },
      ],
      results: [{
        indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
        values: [
          { value: String(bookings), attribution_windows: ['default'] },
          { value: String(Math.max(0, bookings - viewBookings)), attribution_windows: ['7d_click'] },
          { value: String(viewBookings), attribution_windows: ['1d_view'] },
        ],
      }],
      action_values: latest.appointmentValue && current
        ? [{ action_type: 'offsite_conversion.fb_pixel_custom', value: String(latest.appointmentValue) }]
        : [],
    }
  })
}

export function insightRowsForLevel(
  date: string,
  latest: Parameters<typeof accountInsightRows>[1],
  level: 'account' | 'campaign' | 'adset' | 'ad',
  ids: { campaignId: string; adsetId: string; adId: string } = {
    campaignId: 'm-c-sync',
    adsetId: 'm-as-sync',
    adId: 'm-ad-sync',
  },
): MetaInsightRow[] {
  return accountInsightRows(date, latest).map((row) => ({
    ...row,
    ...(level === 'account' ? {} : { campaign_id: ids.campaignId }),
    ...(level === 'adset' || level === 'ad' ? { adset_id: ids.adsetId } : {}),
    ...(level === 'ad' ? { ad_id: ids.adId } : {}),
  }))
}

export async function seedBase(client: pg.Client, date: string) {
  for (const url of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(url))) {
      throw new Error(`refusing to run against non-loopback host: ${url}`)
    }
  }
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role')
  await purgeExecutiveEvidence(client, [ACCT])
  await purgePaidMeasurement(client, [ACCT])
  for (const table of ['recommendations', 'flags', 'decision_generations', 'daily_reports', 'audit_tasks', 'daily_insights', 'outcomes', 'outcome_sources', 'api_sync_logs', 'ads', 'adsets', 'campaigns']) {
    await client.query(`DELETE FROM ${table} WHERE ad_account_id=$1`, [ACCT])
  }
  await client.query('DELETE FROM ad_accounts WHERE id=$1', [ACCT])
  // Other integration suites may leave isolated fixture accounts in the shared local database.
  await client.query('UPDATE ad_accounts SET is_active=false WHERE id<>$1', [ACCT])
  await client.query('DELETE FROM outcomes WHERE business_date=$1', [date])

  const old = daysBefore(date, 10)
  await client.query('INSERT INTO ad_accounts (id, account_id, is_active) VALUES ($1,$2,true)', [ACCT, META_ACCT])
  await client.query("INSERT INTO campaigns (id, ad_account_id, campaign_id, created_at) VALUES ($1,$2,'m-c-sync',$3)", [CAMP, ACCT, old])
  await client.query("INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id, created_at) VALUES ($1,$2,$3,'m-as-sync',$4)", [ADSET, ACCT, CAMP, old])
  await client.query("INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id, created_at) VALUES ($1,$2,$3,$4,'m-ad-sync',$5)", [AD, ACCT, CAMP, ADSET, old])
  await client.query("INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, campaign_id, adset_id, ad_id, impressions, spend, clicks, leads, bookings) VALUES ($1,$1,'ad',$2,$3,$4,$5, 3000, 150, 30, 0, 0)", [date, ACCT, CAMP, ADSET, AD])
  await client.query(
    `INSERT INTO daily_insights (
       date_start,date_stop,entity_level,ad_account_id,impressions,spend,clicks,leads,bookings)
     SELECT day::date,day::date,'account',$2,
       CASE WHEN day::date=$1::date THEN 3000 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 42 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 30 ELSE 0 END,
       CASE WHEN day::date=$1::date THEN 5 ELSE 0 END,
       0
     FROM generate_series($1::date - interval '29 days',$1::date,interval '1 day') day`,
    [date, ACCT],
  )
  await insertOutcomeOutcome(client, ACCT, 990301, {
    business_date: date, gross_value: 250, collected_value: 250, status: 'confirmed',
  })
}

export async function flagHead(client: pg.Client) {
  return (await client.query(
    "SELECT id FROM decision_generations WHERE ad_account_id=$1 AND kind='flag' AND is_current",
    [ACCT],
  )).rows[0]?.id
}

export async function recHead(client: pg.Client) {
  return (await client.query(
    "SELECT id FROM decision_generations WHERE ad_account_id=$1 AND kind='recommendation' AND is_current",
    [ACCT],
  )).rows[0]?.id
}

export async function publicationSnapshot(client: pg.Client, date: string) {
  const report = (await client.query(
    `SELECT id, recommendation_generation_id, summary_text, full_report_md, report_json
       FROM daily_reports
      WHERE ad_account_id=$1 AND report_date=$2`,
    [ACCT, date],
  )).rows[0]
  const taskIds = (await client.query(
    'SELECT id FROM audit_tasks WHERE ad_account_id=$1 ORDER BY id',
    [ACCT],
  )).rows.map((row) => row.id)
  return { report, taskIds }
}
