import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { nyToday, nyHoursElapsed } from '@/lib/utils/date-utils'
import { detectStaleData, detectWriteModeTripwire } from '@/lib/monitoring/detectors'
import { emitAlert } from '@/lib/monitoring/alerts'
import { ownerOnly } from '@/lib/auth/require-owner'
import { insertAlertsDeduped } from '@/lib/alerts/insert'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import { checkCronAuthorization } from '@/lib/auth/cron-secret'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { apiErrorResponse } from '@/lib/security/api-error'
import { formatMoney } from '@/lib/utils/format-currency'

export const runtime = 'nodejs'
export const maxDuration = 60

// Shape returned for each campaign
interface CampaignPacingResult {
  campaign_id: string
  campaign_name: string | null
  spend_today: number
  pacing_pct: number | null
  status: 'ok' | 'over_paced' | 'under_paced' | 'no_data'
}

/**
 * GET /api/sync/midday
 *
 * Lightweight midday pacing check. Called by cron at noon or on-demand.
 * Fetches today's spend per campaign from Meta and compares to expected pacing.
 * Inserts alerts for campaigns that are significantly over or under-paced.
 *
 * Auth: accepts Bearer CRON_SECRET header (cron job) OR logged-in user session.
 */
export async function GET(req: Request) {
  // Auth — support cron secret OR authenticated user session
  const isCronAuth = checkCronAuthorization(req.headers.get('authorization')) === 'authorized'

  if (!isCronAuth) {
    // Fall back to session auth — a manual trigger must be the OWNER (not just any authed user), since
    // this hits the Meta API and writes alerts. The cron path (CRON_SECRET) is unaffected.
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const forbidden = ownerOnly(user)
    if (forbidden) return forbidden
    // A session-triggered GET changes state, so it must come from this app, not from another site.
    const crossOrigin = rejectCrossOriginMutation(req)
    if (crossOrigin) return crossOrigin

    const limited = await enforceApiRateLimit({
      bucket: 'midday_sync', actorKey: user.id, limit: 1, windowSeconds: 300,
    })
    if (limited) return limited
  }

  // Wave C: resilient freshness + write-mode tripwire from a SECOND daily entry point (17:00), so these
  // don't depend on the daily-sync cron (10:00) succeeding. Non-fatal — never blocks the pacing run.
  try {
    const mdb = getAdminClient()
    const { data: lastSync } = await mdb
      .from('api_sync_logs')
      .select('completed_at')
      .eq('status', 'success')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const hoursSinceSync = lastSync?.completed_at
      ? (Date.now() - new Date(lastSync.completed_at as string).getTime()) / 3_600_000
      : null
    for (const f of [detectStaleData(hoursSinceSync), detectWriteModeTripwire(process.env.WRITE_MODE_ENABLED === 'true')]) {
      if (f) emitAlert({ area: f.area, severity: f.severity, message: f.message, dedupeKey: f.dedupeKey })
    }
  } catch {
    /* monitoring is best-effort — never block the midday pacing run */
  }

  const accessToken = process.env.META_ACCESS_TOKEN
  const metaAccountId = process.env.META_AD_ACCOUNT_ID

  if (!accessToken || !metaAccountId) {
    return Response.json(
      { error: 'META_ACCESS_TOKEN or META_AD_ACCOUNT_ID not configured' },
      { status: 500 }
    )
  }

  try {
    const db = getAdminClient()

    // Get ad account DB record
    const cleanId = metaAccountId.replace('act_', '')
    const { data: account } = await db
      .from('ad_accounts')
      .select('id')
      .or(`account_id.eq.${metaAccountId},account_id.eq.act_${cleanId}`)
      .maybeSingle()

    if (!account) {
      return Response.json({ error: 'Ad account not found — run a sync first' }, { status: 400 })
    }

    const adAccountDbId = account.id as string
    const pacing = requireCapability(getAdPlatform('meta'), 'pacing')
    const accountIdForApi = cleanId

    // Fetch today's spend via Meta Insights API (every page)
    const todaySpend = await pacing.fetchTodaySpendByCampaign(accountIdForApi)
    if (!todaySpend.ok) {
      return apiErrorResponse('GET /api/sync/midday', 'META_INSIGHTS_FAILED', todaySpend.error, 502)
    }
    const insightRows = todaySpend.rows

    // Build a map of campaign_id → spend_today
    const spendMap = new Map<string, number>()
    const nameMap = new Map<string, string>()
    for (const row of insightRows) {
      if (!row.campaign_id) continue
      spendMap.set(row.campaign_id, parseFloat(row.spend ?? '0') || 0)
      if (row.campaign_name) nameMap.set(row.campaign_id, row.campaign_name)
    }

    // Fetch daily budgets from Meta Campaigns API (best-effort — budget may not be set)
    const budgetMap = new Map<string, number>()
    try {
      for (const c of await pacing.fetchActiveCampaignBudgets(accountIdForApi)) {
        if (c.id && c.daily_budget) {
          // Meta returns daily_budget in its own offset unit (currency-offset.ts)
          budgetMap.set(c.id, getAdPlatform('meta').budgetUnits.fromMinor(parseFloat(c.daily_budget)))
        }
        if (c.id && c.name && !nameMap.has(c.id)) {
          nameMap.set(c.id, c.name)
        }
      }
    } catch {
      // Budget fetch is best-effort — pacing % will be null if unavailable
    }

    // ABO (ad-set-budget) campaigns carry no campaign-level daily_budget, so the pacing check would skip
    // them entirely (dailyBudget null). Fetch active ad sets and sum their daily budgets per campaign,
    // filling only campaigns we don't already have a CBO budget for — so ABO accounts also get pacing.
    try {
      const abBudgetByCampaign = new Map<string, number>()
      for (const a of await pacing.fetchActiveAdSetBudgets(accountIdForApi)) {
        if (a.campaign_id && a.daily_budget) {
          // Meta returns daily_budget in its own offset unit (currency-offset.ts)
          const dollars = getAdPlatform('meta').budgetUnits.fromMinor(parseFloat(a.daily_budget))
          abBudgetByCampaign.set(a.campaign_id, (abBudgetByCampaign.get(a.campaign_id) ?? 0) + dollars)
        }
      }
      // Never overwrite a real campaign-level (CBO) budget — only fill ABO campaigns that had none.
      for (const [campaignId, sum] of abBudgetByCampaign) {
        if (!budgetMap.has(campaignId) && sum > 0) budgetMap.set(campaignId, sum)
      }
    } catch {
      // Ad-set budget fetch is best-effort — ABO pacing stays null if unavailable
    }

    // Calculate pacing for each campaign
    const hoursElapsed = nyHoursElapsed()
    const expectedPacingPct = hoursElapsed > 0 ? (hoursElapsed / 24) * 100 : null

    const campaigns: CampaignPacingResult[] = []
    const alertsToInsert: Record<string, unknown>[] = []
    const today = nyToday()

    // Union of IDs: those with spend today + those we have budgets for
    const allCampaignIds = new Set([...spendMap.keys(), ...budgetMap.keys()])

    for (const campaignId of allCampaignIds) {
      const spendToday = spendMap.get(campaignId) ?? 0
      const dailyBudget = budgetMap.get(campaignId) ?? null
      const campaignName = nameMap.get(campaignId) ?? null

      let pacingPct: number | null = null
      let status: CampaignPacingResult['status'] = 'ok'

      if (dailyBudget !== null && dailyBudget > 0 && expectedPacingPct !== null) {
        pacingPct = (spendToday / dailyBudget) * 100
        const ratio = pacingPct / expectedPacingPct

        if (ratio > 1.5) {
          status = 'over_paced'
        } else if (ratio < 0.3) {
          status = 'under_paced'
        }
      } else if (spendToday === 0 && budgetMap.size > 0) {
        status = 'no_data'
      }

      campaigns.push({ campaign_id: campaignId, campaign_name: campaignName, spend_today: spendToday, pacing_pct: pacingPct, status })

      // Create alerts for pacing issues
      if (status === 'over_paced' && dailyBudget !== null) {
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: today,
          entity_level: 'campaign',
          campaign_id: null,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: campaignId,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'spend_spike',
          severity: 'warning',
          title: 'Campaign is over-paced for the day',
          message: `${campaignName ?? campaignId} has spent ${formatMoney(spendToday)} (${pacingPct?.toFixed(0)}% of daily budget) by ${hoursElapsed.toFixed(0)} hours into the day. Expected: ~${expectedPacingPct?.toFixed(0)}%.`,
          metric_name: 'spend',
          metric_value: spendToday,
          threshold_value: dailyBudget,
          baseline_value: null,
          is_resolved: false,
          why_it_matters: 'Over-pacing early in the day can exhaust daily budget before peak hours, causing ads to stop delivering when conversion rates are highest.',
          recommended_actions: [
            'Check Meta Ads Manager to verify no accidental budget increase',
            'Monitor delivery through the end of day — Meta may self-correct',
            'Consider reducing daily budget temporarily if ROAS is declining',
          ],
          amount_at_risk: null,
          action_label: 'Review Campaign Budget',
          action_url: null,
        })
      }

      if (status === 'under_paced' && spendToday === 0 && hoursElapsed > 6) {
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: today,
          entity_level: 'campaign',
          campaign_id: null,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: campaignId,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'spend_drop',
          severity: 'warning',
          title: 'Campaign has no spend today — possible delivery issue',
          message: `${campaignName ?? campaignId} has $0 spend after ${hoursElapsed.toFixed(0)} hours. Expected ~${expectedPacingPct?.toFixed(0)}% of daily budget by now.`,
          metric_name: 'spend',
          metric_value: 0,
          threshold_value: null,
          baseline_value: null,
          is_resolved: false,
          why_it_matters: 'Zero spend after several hours likely indicates a delivery problem: disapproved ads, billing issue, or audience exhaustion.',
          recommended_actions: [
            'Check Meta Ads Manager for disapproved ads or billing alerts',
            'Verify payment method is current in Business Settings',
            'Check if campaign is still in ACTIVE status',
          ],
          amount_at_risk: null,
          action_label: 'Check Delivery Status',
          action_url: null,
        })
      }
    }

    // Insert any pacing alerts — deduped so a re-run doesn't duplicate rows for the same campaign+day+type.
    const alertRes = await insertAlertsDeduped(db, alertsToInsert)
    if (alertRes.error) {
      console.error('[MiddaySync] Alert insert error:', alertRes.error)
    }

    return Response.json({
      checked_at: new Date().toISOString(),
      campaigns,
      alerts_created: alertRes.inserted,
      alerts_skipped_duplicate: alertRes.skipped,
    })
  } catch (err) {
    return apiErrorResponse('GET /api/sync/midday', 'MIDDAY_SYNC_FAILED', err, 500)
  }
}
