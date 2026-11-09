import { roundMoney } from '@/lib/utils/format-currency'
import { getSupabaseClient } from '../lib/supabase'
import { sanitizeObject } from '../lib/sanitize'
import { checkRateLimit } from '../lib/rate-limit'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { aggregateMetrics, INSIGHT_METRIC_COLUMNS } from '@/lib/metrics/aggregate'
import { resolveClosedDateRange } from '@/lib/dashboard/closed-date-range'
import { outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export async function getCampaignPerformance(args: {
  campaign_id?: string
  start_date?: string
  end_date?: string
}) {
  checkRateLimit('get_campaign_performance')
  const range = resolveClosedDateRange(args.start_date, args.end_date)
  const { start, end } = range
  const db = getSupabaseClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    throw new Error(`${activeAccountErrorCode(activeAccount.reason)}: campaign performance is unavailable because active account ownership is ${activeAccount.reason}`)
  }
  const adAccountDbId = activeAccount.account.id

  let campaignQuery = db
    .from('campaigns')
    .select(
      'id, campaign_id, campaign_name, status, effective_status, objective, daily_budget, lifetime_budget'
    )
    .eq('ad_account_id', adAccountDbId)
    .in('status', ['ACTIVE', 'PAUSED'])
    .order('campaign_name')

  if (args.campaign_id) {
    campaignQuery = campaignQuery.eq('campaign_id', args.campaign_id)
  }

  const { data: campaigns, error } = await campaignQuery
  if (error) throw new Error(`Campaign query failed: ${error.message}`)

  const campaignRows = (campaigns || []) as Array<Record<string, unknown>>
  const campaignIds = campaignRows.map((campaign) => campaign.id as string)
  const rowsByCampaign = new Map<string, Array<Record<string, unknown>>>()
  if (campaignIds.length > 0) {
    const { data: insights, error: insightsError } = await db
      .from('daily_insights')
      .select(`campaign_id, ${INSIGHT_METRIC_COLUMNS}`)
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'campaign')
      .in('campaign_id', campaignIds)
      .gte('date_start', start)
      .lte('date_stop', end)
    if (insightsError) throw new Error(`Campaign insights query failed: ${insightsError.message}`)
    for (const row of (insights || []) as Array<Record<string, unknown>>) {
      const campaignId = row.campaign_id as string
      if (!rowsByCampaign.has(campaignId)) rowsByCampaign.set(campaignId, [])
      rowsByCampaign.get(campaignId)!.push(row)
    }
  }

  const singleDay = start === end
  const results = campaignRows.map((campaign) => {
    const totals = aggregateMetrics(rowsByCampaign.get(campaign.id as string) ?? [])
    const frequency = singleDay ? totals.frequency : null

    return sanitizeObject({
      campaign_id: campaign.campaign_id,
      campaign_name: campaign.campaign_name,
      status: campaign.status,
      effective_status: campaign.effective_status,
      objective: campaign.objective,
      daily_budget: campaign.daily_budget,
      spend: roundMoney(totals.spend),
      leads: totals.leads,
      bookings: totals.bookings,
      impressions: totals.impressions,
      reach: null,
      peak_daily_reach: totals.reach,
      unique_clicks: totals.unique_clicks,
      link_clicks: totals.link_clicks,
      landing_page_views: totals.landing_page_views,
      avg_cpl: totals.cpl ? roundMoney(totals.cpl) : null,
      avg_cpb: totals.cpa ? roundMoney(totals.cpa) : null,
      avg_frequency: frequency ? Math.round(frequency * 100) / 100 : null,
      frequency,
    })
  })

  return {
    period: {
      start,
      end,
      requested_start_date: range.requested_start_date,
      requested_end_date: range.requested_end_date,
      effective_start_date: range.effective_start_date,
      effective_end_date: range.effective_end_date,
      clamped_to_closed_day: range.clamped_to_closed_day,
      last_closed_date: range.last_closed_date,
    },
    campaigns: results,
    total_campaigns: results.length,
    // Per-campaign `bookings`/`avg_cpb` are Meta pixel MODELLED ESTIMATES. There is no
    // no per-campaign ROAS in this payload — that requires complete paid-interaction identity and an
    // exact appointment-id ledger join for the same campaign/window, not GA confirmation telemetry.
    _provenance: {
      granularity: 'campaign-level',
      bookings: `Meta MODELLED attribution (${EVENT}) — can under- or over-attribute vs business truth; NOT GA4-confirmed`,
      avg_cpb: `Meta ESTIMATE (spend ÷ estimated ${OW.many})`,
      reach: 'DEPRECATED. Always null because daily Meta reach is non-additive and cannot be summed into selected-period reach.',
      peak_daily_reach: 'Highest exact daily Meta reach observed in the effective range; NOT selected-period reach.',
      frequency: 'Exact Meta frequency only for a single-day window; null/unavailable for multi-day windows.',
      unique_clicks: 'Additive Meta unique_clicks from daily campaign rows.',
      range: 'Requested today/future dates are clamped to the last closed account day (account timezone) and exposed in period metadata.',
      roas: `NOT included here — per-campaign ROAS requires complete paid-interaction identity plus the exact ${OW.one}-id ledger join for this campaign and window.`,
      note: 'Do NOT derive a paid campaign ROAS from these Meta estimates, and do NOT attribute account-level GA4/MER revenue to any single campaign.',
    },
  }
}
