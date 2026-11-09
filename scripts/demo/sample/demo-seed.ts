// SQL for the demo database's fictional Example Studio account, generated from the same sample as the
// reports (./demo-delivery.ts and ./demo-account.ts), so the database pages and the reports agree:
// campaigns, ad sets, creatives and ads; 56 days of daily insights at every level; segment breakdowns;
// outcomes from two sources; competitors and their ads; a few alerts and flags; Copy studio sample
// variants in the copy bank (./demo-copy.ts). Dates are relative to
// the demo's anchor day. Nothing here is a real business, person or account.
import {
  DEMO_ADS, DEMO_ADSETS, DEMO_CAMPAIGNS, addDays, datesOf, deliveryFor, draw, sumTotals, type DayTotals,
} from './demo-delivery'
import { DEMO_ACCOUNT, outcomesOn, type DemoCalendar } from './demo-account'
import { demoCopyRows } from './demo-copy'

const ACCOUNT = DEMO_ACCOUNT.id
const META_ACCOUNT = DEMO_ACCOUNT.metaAccountId
const HISTORY_DAYS = 56
const uuid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`
export const DEMO_SOURCE_IDS = { webhook: uuid('5e', 1), csv: uuid('5e', 2) }
const campaignUuid = (i: number) => uuid('c', i + 1)
const adsetUuid = (i: number) => uuid('a', i + 1)
const adUuid = (i: number) => uuid('ad', i + 1)
const creativeUuid = (i: number) => uuid('ce', i + 1)
const competitorUuid = (i: number) => uuid('cc', i + 1)
const creativeMetaId = (i: number) => `12000000000000040${i + 1}`

type Value = string | number | boolean | null | object
function sql(value: Value): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = typeof value === 'object' ? JSON.stringify(value) : value
  return `'${text.replace(/'/g, "''")}'`
}
function insert(table: string, rows: Array<Record<string, Value>>): string {
  if (rows.length === 0) return ''
  const columns = Object.keys(rows[0])
  return `INSERT INTO public.${table} (${columns.join(', ')}) VALUES\n${rows.map((row) => `(${columns.map((c) => sql(row[c])).join(', ')})`).join(',\n')};\n`
}

function insightRow(t: DayTotals, date: string, level: 'account' | 'campaign' | 'adset' | 'ad', ids: Record<string, string | null>, synced: string): Record<string, Value> {
  const bookings = t.bookings_click + t.bookings_view
  const reach = Math.max(t.impressions > 0 ? 1 : 0, Math.round(t.impressions / 1.08))
  const ratio = (a: number, b: number, scale = 1) => (b > 0 ? Math.round((a / b) * scale * 10_000) / 10_000 : null)
  return {
    date_start: date, date_stop: date, entity_level: level, ad_account_id: ACCOUNT, meta_account_id: META_ACCOUNT,
    campaign_id: ids.campaign ?? null, adset_id: ids.adset ?? null, ad_id: ids.ad ?? null,
    meta_campaign_id: ids.metaCampaign ?? null, meta_adset_id: ids.metaAdset ?? null, meta_ad_id: ids.metaAd ?? null,
    impressions: t.impressions, reach, frequency: ratio(t.impressions, reach), spend: t.spend, clicks: t.clicks, unique_clicks: Math.round(t.clicks * 0.9),
    link_clicks: t.link_clicks, landing_page_views: t.landing_page_views, ctr: ratio(t.link_clicks, t.impressions, 100), cpc: ratio(t.spend, t.link_clicks),
    cpm: ratio(t.spend, t.impressions, 1000), bookings, cost_per_booking: ratio(t.spend, bookings), appointment_value: t.appointment_value,
    bookings_view_through: t.bookings_view, video_plays: t.video_plays || null, video_thru_plays: t.video_thruplay || null,
    video_p25_watched: t.video_p25 || null, video_p50_watched: t.video_p50 || null, video_p75_watched: t.video_p75 || null, video_p100_watched: t.video_p100 || null,
    actions: [{ action_type: 'landing_page_view', value: String(t.landing_page_views) }, { action_type: 'link_click', value: String(t.link_clicks) },
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: String(bookings) }],
    synced_at: synced,
  }
}

const ABO_ADSET_BUDGETS: Record<string, number> = { '120000000000000203': 9, '120000000000000204': 6 }

function deliverySql(calendar: DemoCalendar): string {
  const range = { from: addDays(calendar.today, -HISTORY_DAYS), to: addDays(calendar.today, -1) }
  const days = deliveryFor(range, calendar.today)
  const dates = datesOf(range)
  const synced = calendar.asOf
  const created = `${range.from}T14:00:00Z`
  const campaigns = DEMO_CAMPAIGNS.map((c, i) => ({ id: campaignUuid(i), ad_account_id: ACCOUNT, campaign_id: c.id, campaign_name: c.name,
    // Retargeting budgets its ad sets (ABO: 9 + 6 a day), so its ad-set budgets can be changed in the demo.
    objective: i === 1 ? 'OUTCOME_ENGAGEMENT' : 'OUTCOME_TRAFFIC', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: [45, null, 12][i],
    audience_type: 'consumer', meta_created_time: created, last_synced_at: synced }))
  const adsets = DEMO_ADSETS.map((s, i) => ({ id: adsetUuid(i), ad_account_id: ACCOUNT, campaign_id: campaignUuid(DEMO_CAMPAIGNS.findIndex((c) => c.id === s.campaignId)),
    daily_budget: ABO_ADSET_BUDGETS[s.id] ?? null,
    adset_id: s.id, adset_name: s.name, status: 'ACTIVE', effective_status: 'ACTIVE', optimization_goal: 'LANDING_PAGE_VIEWS', billing_event: 'IMPRESSIONS',
    audience_type: 'consumer', meta_created_time: created, last_synced_at: synced }))
  const creatives = DEMO_ADS.map((a, i) => ({ id: creativeUuid(i), ad_account_id: ACCOUNT, creative_id: creativeMetaId(i), creative_name: a.name, body: a.body,
    title: a.headline, call_to_action_type: 'BOOK_NOW', link_url: 'https://example.test/book', asset_type: a.format,
    video_duration_seconds: a.durationSeconds, last_synced_at: synced }))
  const ads = DEMO_ADS.map((a, i) => {
    const set = DEMO_ADSETS.findIndex((s) => s.id === a.adsetId)
    return { id: adUuid(i), ad_account_id: ACCOUNT, campaign_id: adsets[set].campaign_id, adset_id: adsetUuid(set), creative_id: creativeUuid(i),
      ad_id: a.id, ad_name: a.name, status: a.status, effective_status: a.status, meta_creative_id: creativeMetaId(i),
      destination_url: 'https://example.test/book', cta_type: 'BOOK_NOW', meta_created_time: created, last_synced_at: synced }
  })
  const insights: Array<Record<string, Value>> = []
  for (const date of dates) {
    const ofAds = (ids: string[]) => sumTotals(ids.map((id) => days.get(id)!.get(date)!))
    insights.push(insightRow(ofAds(DEMO_ADS.map((a) => a.id)), date, 'account', {}, synced))
    DEMO_CAMPAIGNS.forEach((c, ci) => insights.push(insightRow(ofAds(DEMO_ADS.filter((a) => DEMO_ADSETS.find((s) => s.id === a.adsetId)!.campaignId === c.id).map((a) => a.id)),
      date, 'campaign', { campaign: campaignUuid(ci), metaCampaign: c.id }, synced)))
    DEMO_ADSETS.forEach((s, si) => insights.push(insightRow(ofAds(DEMO_ADS.filter((a) => a.adsetId === s.id).map((a) => a.id)), date, 'adset',
      { campaign: adsets[si].campaign_id, adset: adsetUuid(si), metaCampaign: s.campaignId, metaAdset: s.id }, synced)))
    DEMO_ADS.forEach((a, ai) => insights.push(insightRow(days.get(a.id)!.get(date)!, date, 'ad', { campaign: ads[ai].campaign_id, adset: ads[ai].adset_id,
      ad: adUuid(ai), metaCampaign: DEMO_ADSETS.find((s) => s.id === a.adsetId)!.campaignId, metaAdset: a.adsetId, metaAd: a.id }, synced)))
  }
  return insert('campaigns', campaigns) + insert('adsets', adsets) + insert('creatives', creatives) + insert('ads', ads)
    + insert('daily_insights', insights) + breakdownSql(dates, days)
}

/** Each day's account delivery split across segments by fixed shares (the shares of a dimension sum to 1). */
const SEGMENTS: Record<string, Array<[string, number]>> = {
  publisher_platform: [['instagram', 0.68], ['facebook', 0.27], ['audience_network', 0.05]],
  platform_position: [['instagram_reels', 0.34], ['instagram_stories', 0.22], ['feed', 0.31], ['facebook_reels', 0.08], ['marketplace', 0.05]],
  device_platform: [['mobile_app', 0.88], ['desktop', 0.09], ['mobile_web', 0.03]],
  age: [['18-24', 0.14], ['25-34', 0.41], ['35-44', 0.27], ['45-54', 0.12], ['55-64', 0.06]],
  gender: [['female', 0.63], ['male', 0.35], ['unknown', 0.02]],
  region: [['New York', 0.52], ['New Jersey', 0.24], ['Connecticut', 0.11], ['Pennsylvania', 0.08], ['Massachusetts', 0.05]],
}

function breakdownSql(dates: string[], days: ReturnType<typeof deliveryFor>): string {
  const rows: Array<Record<string, Value>> = []
  for (const date of dates) {
    const t = sumTotals(DEMO_ADS.map((a) => days.get(a.id)!.get(date)!))
    for (const [type, shares] of Object.entries(SEGMENTS)) {
      for (const [value, share] of shares) {
        const impressions = Math.round(t.impressions * share), clicks = Math.round(t.link_clicks * share)
        const bookings = Math.round((t.bookings_click + t.bookings_view) * share)
        rows.push({ ad_account_id: ACCOUNT, date_start: date, entity_level: 'account', meta_entity_id: META_ACCOUNT, breakdown_type: type, breakdown_value: value,
          spend: Math.round(t.spend * share * 100) / 100, impressions, clicks, leads: 0, bookings,
          ctr: impressions > 0 ? Math.round((clicks / impressions) * 1_000_000) / 10_000 : null, cpa: bookings > 0 ? Math.round((t.spend * share / bookings) * 100) / 100 : null })
      }
    }
  }
  return insert('insight_breakdowns', rows)
}

function outcomeSql(calendar: DemoCalendar): string {
  const sources = [
    { id: DEMO_SOURCE_IDS.webhook, ad_account_id: ACCOUNT, kind: 'webhook', label: 'Booking system webhook (sample)', enabled: true,
      created_at: `${addDays(calendar.today, -HISTORY_DAYS - 30)}T12:00:00Z`, last_success_at: calendar.asOf },
    { id: DEMO_SOURCE_IDS.csv, ad_account_id: ACCOUNT, kind: 'csv', label: 'Spring sales export (sample)', enabled: false,
      created_at: `${addDays(calendar.today, -HISTORY_DAYS - 10)}T09:30:00Z`, last_success_at: null },
  ]
  const outcomes = datesOf({ from: addDays(calendar.today, -HISTORY_DAYS), to: addDays(calendar.today, -1) }).flatMap((date) => outcomesOn(date, calendar.today)
    .map((row, i) => {
      const seed = Number(date.replace(/-/g, '')) + i
      const paid = draw(seed) < 0.45
      const website = draw(seed + 1) < 0.83
      return { ad_account_id: ACCOUNT, source_id: DEMO_SOURCE_IDS.webhook, external_id: `sample-${row.id}`, outcome_type: 'booking',
        outcome_label: row.appointment_type, status: row.canceled ? 'cancelled' : 'confirmed', currency: 'USD', gross_value: row.price,
        collected_value: row.amount_paid, occurred_at: `${date}T${String(14 + i).padStart(2, '0')}:20:00Z`, business_date: date,
        origin: website ? 'website' : 'staff_or_manual', utm_source: paid ? 'facebook' : null, utm_medium: paid ? 'paid_social' : null,
        landing_page: website ? 'https://example.test/book' : null, first_seen_at: `${date}T${String(14 + i).padStart(2, '0')}:21:00Z` }
    }))
  return insert('outcome_sources', sources) + insert('outcomes', outcomes)
}

const COMPETITORS = [
  { name: 'Brooklyn Loft Studio (sample)', location: 'Brooklyn, NY', low: 75, high: 120, sqft: 1800, notes: 'Two cyc walls; pushes monthly memberships.' },
  { name: 'Jersey City Photo Studio (sample)', location: 'Jersey City, NJ', low: 60, high: 95, sqft: 1200, notes: 'Cheaper hourly rate; ads lead with late hours.' },
  { name: 'Midtown Product Studio (sample)', location: 'Manhattan, NY', low: 110, high: 180, sqft: 2400, notes: 'Premium sets; product photography packages.' },
]
const COMPETITOR_ADS = [
  [0, 'Members book the cyc first. Join for $299 a month and skip the wait.', 'Become a member'],
  [0, 'Golden-hour light, every hour. Tour the loft this weekend.', 'Tour the loft'],
  [1, 'Studio from $60 an hour, open until midnight.', 'Book an hour'],
  [2, 'Product photos for your next launch, shot in a day.', 'Get a quote'],
  [2, 'Three sets, one team, one invoice.', 'See packages'],
] as const

function competitorSql(calendar: DemoCalendar): string {
  const sources = COMPETITORS.map((c, i) => ({ id: competitorUuid(i), ad_account_id: ACCOUNT, name: c.name, location: c.location,
    website_url: `https://competitor-${i + 1}.example.test`, hourly_rate_low: c.low, hourly_rate_high: c.high, size_sqft: c.sqft, notes: c.notes,
    is_active: true, last_researched_at: calendar.asOf }))
  const ads = COMPETITOR_ADS.map(([who, body, caption], i) => ({ competitor_id: competitorUuid(who), ad_archive_id: `sample-archive-${i + 1}`,
    page_name: COMPETITORS[who].name, ad_creative_bodies: [body], ad_creative_link_captions: [caption],
    ad_delivery_start_time: `${addDays(calendar.today, -(12 + i * 9))}T00:00:00Z`, is_active: i !== 3, estimated_days_running: 12 + i * 9 }))
  return insert('competitor_sources', sources) + insert('competitor_ads', ads)
}

function attentionSql(calendar: DemoCalendar): string {
  const yesterday = addDays(calendar.today, -1)
  const alerts: Array<Record<string, Value>> = [
    { ad_account_id: ACCOUNT, alert_date: yesterday, entity_level: 'ad', campaign_id: campaignUuid(2), adset_id: adsetUuid(4), ad_id: adUuid(7),
      meta_campaign_id: '120000000000000103', meta_adset_id: '120000000000000205', meta_ad_id: '120000000000000308', alert_type: 'campaign_paused', severity: 'info',
      title: 'Packages from $395 is paused', message: 'Paused two weeks ago after a weak start; its budget now goes to the flat-lay ad.',
      metric_name: null, metric_value: null, threshold_value: null, detected_at: calendar.asOf },
    { ad_account_id: ACCOUNT, alert_date: yesterday, entity_level: 'adset', campaign_id: campaignUuid(1), adset_id: adsetUuid(2), ad_id: null,
      meta_campaign_id: '120000000000000102', meta_adset_id: '120000000000000203', meta_ad_id: null, alert_type: 'frequency_high', severity: 'warning',
      title: 'Website visitors are seeing the same ad often', message: 'Frequency in the retargeting ad set passed 3 this week; rotate in a new creative.',
      metric_name: 'frequency', metric_value: 3.2, threshold_value: 3, detected_at: calendar.asOf },
  ]
  return insert('alerts', alerts)
}

const COMMERCIAL_OBJECTIVE = 'maximize_incremental_contribution_from_ad_attributed_collected_revenue'
export const DEMO_DECISION_IDS = { budget: uuid('de', 1), pause: uuid('de', 2) }

/** Two current owner-review decisions the owner can turn into changes on /changes (ADR-059): raise the
 *  website-visitors ad set's budget, and pause the weakest prospecting ad. Meta-modelled evidence in
 *  pragmatic media-buyer mode, so neither is execution-eligible on the engine's own authority. */
function decisionSql(calendar: DemoCalendar): string {
  const common = {
    ad_account_id: ACCOUNT, evidence_plane: 'meta_modelled', evidence_basis: 'meta_modelled_association', authority_tier: 'owner_review',
    direction_ceiling: 'owner_review', policy_version: 5, objective: COMMERCIAL_OBJECTIVE, pragmatic_media_buyer: true,
    source_kind: 'recommendation', evaluated_at: calendar.asOf, window_start: addDays(calendar.today, -28), window_end: addDays(calendar.today, -1),
  }
  return insert('action_decisions', [
    { ...common, id: DEMO_DECISION_IDS.budget, action_kind: 'budget_scale', target_level: 'adset', target_id: '120000000000000203',
      authority_reason: 'Meta-modelled association only: worth your decision, not execution-eligible.',
      owner_copy: 'FOR OWNER REVIEW. Website visitors · 30 days has the lowest cost per booking in the account (Meta-modelled estimate). Raising its budget is worth your decision.',
      direction_reason: 'Meta-modelled association supports owner review only.', source_id: 'sample-recommendation-budget', dedupe_key: 'sample-decision-budget' },
    { ...common, id: DEMO_DECISION_IDS.pause, action_kind: 'pause', target_level: 'ad', target_id: '120000000000000302',
      authority_reason: 'Meta-modelled association only: worth your decision, not execution-eligible.',
      owner_copy: 'FOR OWNER REVIEW. Before and after portrait has the weakest click-through and booking rate in its ad set (Meta-modelled estimate). Pausing it is worth your decision.',
      direction_reason: 'Meta-modelled association supports owner review only.', source_id: 'sample-recommendation-pause', dedupe_key: 'sample-decision-pause' },
  ])
}

/** The demo account, sync log and everything above, for the given anchor day. */
export function demoSeedSql(calendar: DemoCalendar): string {
  const account = insert('ad_accounts', [{ id: ACCOUNT, account_id: META_ACCOUNT, account_name: DEMO_ACCOUNT.name, business_name: 'Example Studio',
    currency: 'USD', timezone_name: 'America/New_York', account_status: 1, is_active: true, last_synced_at: calendar.asOf }])
  // The sync that produced the sample delivery: its window covers every seeded day (the cockpit only
  // trusts spend from a successful sync whose range covers the request), and it records the decision
  // gate the way a real run does. The sample has no paid cohort, so that gate is honestly closed.
  const sync = insert('api_sync_logs', [{ ad_account_id: ACCOUNT, sync_type: 'full', status: 'success', triggered_by: 'cron',
    started_at: calendar.asOf.replace('13:00:00', '12:59:00'), completed_at: calendar.asOf, created_at: calendar.asOf.replace('13:00:00', '12:59:00'),
    date_range_start: addDays(calendar.today, -HISTORY_DAYS), date_range_end: addDays(calendar.today, -1), insights_fetched: HISTORY_DAYS,
    decision_gate: { verdict: 'frozen', gates: { lifecycleRun: true, insightLevelsComplete: true, metaOutcomeMetricsComplete: true, paidCohortPublished: false },
      closedBy: ['paidCohortPublished'], metaOutcomeBlockerCodes: [], evaluatedAt: calendar.asOf } }])
  return account + deliverySql(calendar) + outcomeSql(calendar) + competitorSql(calendar) + attentionSql(calendar)
    + decisionSql(calendar) + insert('copy_variations', demoCopyRows(calendar, ACCOUNT)) + sync
}
