import { roundMoney } from '@/lib/utils/format-currency'
import { getSupabaseClient } from '../lib/supabase'
import { sanitizeObject } from '../lib/sanitize'
import { checkRateLimit } from '../lib/rate-limit'
import { projectDiagnosticAlert } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { aggregateMetrics, INSIGHT_METRIC_COLUMNS } from '@/lib/metrics/aggregate'
import { resolveClosedDateRange } from '@/lib/dashboard/closed-date-range'
import { outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export async function getAccountSummary(args: {
  start_date?: string
  end_date?: string
}) {
  checkRateLimit('get_account_summary')
  const range = resolveClosedDateRange(args.start_date, args.end_date)
  const { start, end } = range
  const db = getSupabaseClient()

  // Resolve ownership before any evidence read. Choosing the first active row would silently combine
  // accounts in every aggregate below; ambiguity is an unavailable result, not a best-effort summary.
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    throw new Error(`${activeAccountErrorCode(activeAccount.reason)}: active account ownership is ${activeAccount.reason}`)
  }
  const adAccountDbId = activeAccount.account.id

  // Get account info after binding the exact row selected by the shared resolver.
  const { data: account, error: accountError } = await db
    .from('ad_accounts')
    .select('account_id, account_name, currency, timezone_name, is_active, last_synced_at')
    .eq('id', adAccountDbId)
    .maybeSingle()

  if (accountError || !account) {
    throw new Error(
      'No active ad account found. Ensure META_AD_ACCOUNT_ID is configured and a sync has run.'
    )
  }

  // Get insights aggregate for date range
  const { data: insights, error: insightsError } = await db
    .from('daily_insights')
    .select(INSIGHT_METRIC_COLUMNS)
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'account')
    .gte('date_start', start)
    .lte('date_stop', end)

  if (insightsError) throw new Error(`Failed to query insights: ${insightsError.message}`)

  const totals = aggregateMetrics((insights || []) as Array<Record<string, unknown>>)
  const singleDay = start === end

  // Get active/paused campaign counts
  const { data: campaignCounts, error: campaignError } = await db
    .from('campaigns')
    .select('status')
    .eq('ad_account_id', adAccountDbId)
  if (campaignError) throw new Error(`Failed to query campaigns: ${campaignError.message}`)

  const activeCampaigns = (campaignCounts || []).filter((c) => c.status === 'ACTIVE').length
  const pausedCampaigns = (campaignCounts || []).filter((c) => c.status === 'PAUSED').length

  // Get unresolved alerts
  const { data: alerts, error: alertsError } = await db
    .from('alerts')
    .select('severity, title, alert_type, detected_at')
    .eq('ad_account_id', adAccountDbId)
    .eq('is_resolved', false)
    .gte('alert_date', start)
    .order('detected_at', { ascending: false })
    .limit(10)
  if (alertsError) throw new Error(`Failed to query alerts: ${alertsError.message}`)

  return {
    account: sanitizeObject({
      account_id: account.account_id,
      account_name: account.account_name,
      currency: account.currency,
      timezone: account.timezone_name,
      last_synced: account.last_synced_at,
    }),
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
    summary: {
      total_spend: roundMoney(totals.spend),
      total_leads: totals.leads,
      total_bookings: totals.bookings,
      total_impressions: totals.impressions,
      total_reach: null,
      peak_daily_reach: totals.reach,
      frequency: singleDay ? totals.frequency : null,
      unique_clicks: totals.unique_clicks,
      link_clicks: totals.link_clicks,
      landing_page_views: totals.landing_page_views,
      avg_cpl: totals.cpl ? roundMoney(totals.cpl) : null,
      avg_cpb: totals.cpa ? roundMoney(totals.cpa) : null,
      avg_ctr: totals.ctr ? Math.round(totals.ctr * 10000) / 10000 : null,
      avg_cpm: totals.cpm ? roundMoney(totals.cpm) : null,
      active_campaigns: activeCampaigns,
      paused_campaigns: pausedCampaigns,
    },
    // The payload self-describes its provenance so the agent cannot read a Meta modelled estimate as a business fact
    // or treat account-level figures as campaign-level paid ROAS, even if the system prompt is truncated.
    _provenance: {
      granularity: 'account-level',
      total_bookings: `Meta MODELLED attribution (${EVENT}) — can under- or over-attribute vs business truth; NOT GA4-confirmed`,
      avg_cpb: `Meta ESTIMATE (spend ÷ estimated ${OW.many})`,
      total_spend: 'Meta actual (delivery)',
      total_reach: 'DEPRECATED. Always null because daily Meta reach is non-additive and cannot be summed into selected-period reach.',
      peak_daily_reach: 'Highest exact daily Meta reach observed in the effective range; NOT selected-period reach.',
      frequency: 'Exact Meta frequency only for a single closed day; null for multi-day windows.',
      unique_clicks: 'Additive Meta unique_clicks from daily account rows.',
      range: 'Requested today/future dates are clamped to the last closed account day (account timezone) and exposed in period metadata.',
      roas: `NOT included. Meta modelled ${EVENT} value remains diagnostic-only; paid ROAS requires complete exact ${OW.one} identity and spend mapping.`,
      note: 'Account-level Meta-modelled figures. Do NOT present as paid campaign ROAS or measured revenue. Outcome source supplies all-source business totals; GA supplies session-channel telemetry; paid money requires the complete exact join.',
    },
    alerts: (alerts || []).map((source) => {
      const a = projectDiagnosticAlert(source as Record<string, unknown>)
      return sanitizeObject({
        severity: a.severity,
        type: a.alert_type,
        title: a.title,
        action_authority_tier: a.action_authority_tier,
        detected_at: a.detected_at,
      })
    }),
  }
}
