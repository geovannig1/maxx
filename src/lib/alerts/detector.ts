import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { getAdminClient } from '@/lib/supabase/admin'
import type { AlertType } from '@/types/db'
import { cpaTarget } from '@/lib/targets/target-ranges'
import { runTrajectoriesForAccount } from '@/lib/analytics/predictor'
import {
  checkFrequencyAlert,
  checkCtrDrop,
  checkCplSpike,
  checkSpendSpike,
  checkSpendDrop,
  checkCpmSpike,
  checkZeroConversions,
} from './thresholds'
import { insertAlertsDeduped } from './insert'
import { formatMoney, formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'
import { SPEND_FLOORS } from '@/config/spend-floors'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

interface CampaignInsightRow {
  campaign_id: string | null
  meta_campaign_id: string | null
  spend: number
  leads: number
  bookings: number
  ctr: number | null
  cpm: number | null
  frequency: number | null
  cost_per_lead: number | null
}

interface AlertInsert {
  ad_account_id: string
  alert_date: string
  entity_level: 'campaign' | 'ad'
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null
  alert_type: AlertType
  severity: string
  title: string
  message: string
  metric_name: string
  metric_value: number | null
  threshold_value: number | null
  baseline_value: number | null
  is_resolved: boolean
  // SCA fields
  why_it_matters: string | null
  recommended_actions: string[] | null
  amount_at_risk: number | null
  action_label: string | null
  action_url: string | null
}

export interface DailyAllClickRow {
  date_start: string
  clicks: number | null
  impressions: number | null
}

export type AllClickCtrTrend = {
  status: 'unavailable' | 'insufficient' | 'no_decline' | 'declined'
  recentDays: number
  priorDays: number
  recentCtr: number | null
  priorCtr: number | null
  declinePct: number | null
  recentImpressions: number
  priorImpressions: number
}

const CTR_COMPARISON_DAYS = 7
const MIN_CTR_WINDOW_IMPRESSIONS = 1_000
const MATERIAL_CTR_DECLINE_PCT = 20

function isoDayOffset(date: string, days: number): string | null {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime())) return null
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

/**
 * Compares all-click CTR over two complete seven-day windows. This is a descriptive delivery trend,
 * not a creative-fatigue verdict: daily insight rows cannot provide deduplicated period frequency.
 */
export function assessAllClickCtrTrend(rows: DailyAllClickRow[], endDate: string): AllClickCtrTrend {
  const recentStart = isoDayOffset(endDate, -(CTR_COMPARISON_DAYS - 1))
  const priorStart = isoDayOffset(endDate, -(CTR_COMPARISON_DAYS * 2 - 1))
  const priorEnd = isoDayOffset(endDate, -CTR_COMPARISON_DAYS)
  const unavailable: AllClickCtrTrend = {
    status: 'unavailable', recentDays: 0, priorDays: 0,
    recentCtr: null, priorCtr: null, declinePct: null,
    recentImpressions: 0, priorImpressions: 0,
  }
  if (!recentStart || !priorStart || !priorEnd) return unavailable

  const byDay = new Map<string, { clicks: number; impressions: number }>()
  for (const row of rows) {
    if (typeof row.date_start !== 'string') continue
    const clicks = Number(row.clicks ?? 0)
    const impressions = Number(row.impressions ?? 0)
    if (!Number.isFinite(clicks) || !Number.isFinite(impressions) || clicks < 0 || impressions < 0) continue
    const existing = byDay.get(row.date_start) ?? { clicks: 0, impressions: 0 }
    byDay.set(row.date_start, {
      clicks: existing.clicks + clicks,
      impressions: existing.impressions + impressions,
    })
  }

  const sumWindow = (start: string, end: string) => {
    let clicks = 0
    let impressions = 0
    let days = 0
    for (const [day, values] of byDay) {
      if (day < start || day > end) continue
      days += 1
      clicks += values.clicks
      impressions += values.impressions
    }
    return { clicks, impressions, days }
  }

  const recent = sumWindow(recentStart, endDate)
  const prior = sumWindow(priorStart, priorEnd)
  const base = {
    recentDays: recent.days,
    priorDays: prior.days,
    recentCtr: recent.impressions > 0 ? (recent.clicks / recent.impressions) * 100 : null,
    priorCtr: prior.impressions > 0 ? (prior.clicks / prior.impressions) * 100 : null,
    declinePct: null,
    recentImpressions: recent.impressions,
    priorImpressions: prior.impressions,
  }

  if (
    recent.days !== CTR_COMPARISON_DAYS || prior.days !== CTR_COMPARISON_DAYS ||
    recent.impressions < MIN_CTR_WINDOW_IMPRESSIONS || prior.impressions < MIN_CTR_WINDOW_IMPRESSIONS ||
    base.recentCtr === null || base.priorCtr === null || base.priorCtr <= 0
  ) {
    return { status: 'insufficient', ...base }
  }

  const declinePct = ((base.priorCtr - base.recentCtr) / base.priorCtr) * 100
  return {
    status: declinePct >= MATERIAL_CTR_DECLINE_PCT ? 'declined' : 'no_decline',
    ...base,
    declinePct,
  }
}

async function getSevenDayBaseline(
  supabase: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  campaignDbId: string,
  endDate: string
): Promise<{
  avgSpend: number
  avgCpl: number | null
  avgCtr: number | null
  avgCpm: number | null
  avgFrequency: number | null
  /** Actual number of prior days in the baseline (may be < 7 for a young campaign) — narrate honestly. */
  days: number
  /** Window totals — used to decide whether zero conversions today is a signal or structural. */
  totalLeads: number
  totalBookings: number
}> {
  const { data, error } = await supabase
    .from('daily_insights')
    .select('spend, leads, bookings, impressions, clicks, reach')
    .eq('ad_account_id', adAccountDbId)
    .eq('campaign_id', campaignDbId)
    .eq('entity_level', 'campaign')
    .lt('date_start', endDate)
    .order('date_start', { ascending: false })
    .limit(7)

  if (error || !data || data.length === 0) {
    return { avgSpend: 0, avgCpl: null, avgCtr: null, avgCpm: null, avgFrequency: null, days: 0, totalLeads: 0, totalBookings: 0 }
  }

  const sum = (key: string) =>
    data.reduce((a, r) => a + Number((r as Record<string, unknown>)[key] ?? 0), 0)
  const totalSpend = sum('spend')
  const totalLeads = sum('leads')
  const totalBookings = sum('bookings')
  const totalImpr = sum('impressions')
  const totalClicks = sum('clicks')

  return {
    days: data.length,
    totalLeads,
    totalBookings,
    // Typical-day spend (mean across available days) — today's spend is compared to this.
    avgSpend: totalSpend / data.length,
    // Blended baselines recomputed from summed totals, not an average of daily rates.
    avgCpl: totalLeads > 0 ? totalSpend / totalLeads : null,
    avgCtr: totalImpr > 0 ? (totalClicks / totalImpr) * 100 : null,
    avgCpm: totalImpr > 0 ? (totalSpend / totalImpr) * 1000 : null,
    // Daily reach is not additive, so this query cannot produce selected-period frequency.
    avgFrequency: null,
  }
}

export async function runAlertDetection(
  adAccountDbId: string,
  date: string
): Promise<number> {
  const supabase = getAdminClient()
  const alertsToInsert: AlertInsert[] = []

  // Step 1: Query yesterday's campaign-level insights
  const { data: campaignInsights, error: insightErr } = await supabase
    .from('daily_insights')
    .select('campaign_id, meta_campaign_id, spend, leads, bookings, ctr, cpm, frequency, cost_per_lead')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'campaign')
    .eq('date_start', date)

  if (insightErr) {
    throw new Error(`runAlertDetection: campaign insights query failed: ${insightErr.message}`)
  }

  const rows = (campaignInsights ?? []) as CampaignInsightRow[]

  // Step 2: For each campaign, check thresholds against 7-day baseline
  for (const row of rows) {
    if (!row.campaign_id) continue

    const baseline = await getSevenDayBaseline(
      supabase,
      adAccountDbId,
      row.campaign_id,
      date
    )

    const spend = Number(row.spend ?? 0)
    const leads = Number(row.leads ?? 0)
    const ctr = row.ctr !== null ? Number(row.ctr) : null
    const cpm = row.cpm !== null ? Number(row.cpm) : null
    const frequency = row.frequency !== null ? Number(row.frequency) : null
    const cpl = row.cost_per_lead !== null ? Number(row.cost_per_lead) : null

    // Min-sample guard (#3): skip noisy %-vs-baseline alerts for campaigns with trivially
    // small volume — a $2-vs-$1 swing should never fire a "critical" alert. zero_leads keeps
    // its own $20 floor; this skips spend/cpl/ctr/cpm/frequency checks for sub-threshold campaigns.
    const MIN_ALERT_SPEND = SPEND_FLOORS.judge // account currency
    if (spend < MIN_ALERT_SPEND && baseline.avgSpend < MIN_ALERT_SPEND) {
      continue
    }

    // Spend spike
    if (baseline.avgSpend > 0) {
      const spendSpike = checkSpendSpike(spend, baseline.avgSpend)
      if (spendSpike) {
        const pctOver = (((spend - baseline.avgSpend) / baseline.avgSpend) * 100).toFixed(0)
        const extraSpend = roundMoney(spend - baseline.avgSpend)
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: date,
          entity_level: 'campaign',
          campaign_id: row.campaign_id,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: row.meta_campaign_id,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'spend_spike',
          severity: spendSpike,
          title: 'Spend spike detected',
          message: `Campaign spent ${formatMoney(spend)} — ${pctOver}% above your ${baseline.days}-day average of ${formatMoney(baseline.avgSpend)}.`,
          metric_name: 'spend',
          metric_value: spend,
          threshold_value: null,
          baseline_value: baseline.avgSpend,
          is_resolved: false,
          why_it_matters: `You spent ${formatMoney(extraSpend)} more than normal yesterday. If this isn't intentional, budget may be running away from you. Unchecked spend spikes compound daily and can exhaust your monthly budget early.`,
          recommended_actions: [
            'Open Meta Ads Manager and check if a campaign budget was recently changed',
            'Verify no ad sets exited the learning phase simultaneously (which causes temporary overspend)',
            `Verify the active account total still respects the owner-approved ${formatMoneyAmount(MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling)}/day ceiling; this diagnostic alert never authorises an increase`,
          ],
          amount_at_risk: extraSpend,
          action_label: 'Review Budget Settings',
          action_url: null,
        })
      }

      // Spend drop
      const spendDrop = checkSpendDrop(spend, baseline.avgSpend)
      if (spendDrop) {
        const pctUnder = (((baseline.avgSpend - spend) / baseline.avgSpend) * 100).toFixed(0)
        const missedSpend = roundMoney(baseline.avgSpend - spend)
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: date,
          entity_level: 'campaign',
          campaign_id: row.campaign_id,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: row.meta_campaign_id,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'spend_drop',
          severity: spendDrop,
          title: 'Spend dropped significantly',
          message: `Campaign spent ${formatMoney(spend)} — ${pctUnder}% below your ${baseline.days}-day average of ${formatMoney(baseline.avgSpend)}.`,
          metric_name: 'spend',
          metric_value: spend,
          threshold_value: null,
          baseline_value: baseline.avgSpend,
          is_resolved: false,
          why_it_matters: `Your campaign delivered ${formatMoney(missedSpend)} less than normal. This usually means an ad was disapproved, the audience exhausted, or a billing issue paused delivery. Missed spend means missed leads.`,
          recommended_actions: [
            'Check Meta Ads Manager for disapproved ads or billing alerts',
            'Verify your payment method is current in Business Settings → Billing',
            'Look for ads with WITH_ISSUES or DISAPPROVED status',
            'Check if any ad sets entered Learning Limited status',
          ],
          amount_at_risk: null,
          action_label: 'Check Delivery Status',
          action_url: null,
        })
      }
    }

    // CTR drop
    if (ctr !== null && baseline.avgCtr !== null && baseline.avgCtr > 0) {
      const ctrDrop = checkCtrDrop(ctr, baseline.avgCtr)
      if (ctrDrop) {
        const pctDrop = (((baseline.avgCtr - ctr) / baseline.avgCtr) * 100).toFixed(0)
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: date,
          entity_level: 'campaign',
          campaign_id: row.campaign_id,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: row.meta_campaign_id,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'ctr_drop',
          severity: ctrDrop,
          title: 'Click-through rate dropped',
          message: `CTR fell to ${ctr.toFixed(2)}% — ${pctDrop}% below your ${baseline.days}-day average of ${baseline.avgCtr.toFixed(2)}%.`,
          metric_name: 'ctr',
          metric_value: ctr,
          threshold_value: null,
          baseline_value: baseline.avgCtr,
          is_resolved: false,
          why_it_matters: `This is a change in all-click CTR, not a diagnosis of its cause. Review link or outbound response, auction cost, paid outcomes, placements, and recent setup changes before drawing a conclusion.`,
          recommended_actions: [
            'Compare link or outbound CTR with this all-click CTR observation',
            'Review which individual ads contributed to the campaign-level change',
            'Compare CPM, paid outcomes, placements, and recent setup changes',
          ],
          // Fraction of today's spend that underperformed vs the normal click rate (bounded 0..spend).
          amount_at_risk: baseline.avgCtr ? Math.round(spend * Math.max(0, 1 - ctr / baseline.avgCtr)) : null,
          action_label: 'Review Delivery Evidence',
          action_url: null,
        })
      }
    }

    // CPL spike
    if (cpl !== null && baseline.avgCpl !== null && baseline.avgCpl > 0) {
      const cplSpike = checkCplSpike(cpl, baseline.avgCpl)
      if (cplSpike) {
        const pctOver = (((cpl - baseline.avgCpl) / baseline.avgCpl) * 100).toFixed(0)
        const extraCostPerLead = roundMoney(cpl - baseline.avgCpl)
        const extraTotalCost = leads > 0 ? roundMoney(leads * extraCostPerLead) : null
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: date,
          entity_level: 'campaign',
          campaign_id: row.campaign_id,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: row.meta_campaign_id,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'cpa_spike',
          severity: cplSpike,
          title: 'Cost per lead spiked',
          message: `CPL hit ${formatMoney(cpl)} — ${pctOver}% above your ${baseline.days}-day average of ${formatMoney(baseline.avgCpl)}.`,
          metric_name: 'cost_per_lead',
          metric_value: cpl,
          threshold_value: null,
          baseline_value: baseline.avgCpl,
          is_resolved: false,
          why_it_matters: `You're paying ${formatMoney(extraCostPerLead)} more per lead than normal${extraTotalCost !== null ? `, costing an extra ${formatMoney(extraTotalCost)} on yesterday's ${leads} lead${leads !== 1 ? 's' : ''}` : ''}. If the CPL stays this high, you'll exhaust budget without hitting your ${OW.one} targets.`,
          recommended_actions: [
            'Check which ad set is driving the spike — look for one with very high CPL dragging the average',
            'Verify your pixel is firing on the lead form confirmation page',
            'Check landing page load time — a slow page kills form completion rates',
            'Compare link or outbound response, CPM, paid outcomes, and recent setup changes',
          ],
          amount_at_risk: extraTotalCost,
          action_label: 'Diagnose CPL Spike',
          action_url: null,
        })
      }
    }

    // CPM spike
    if (cpm !== null && baseline.avgCpm !== null && baseline.avgCpm > 0) {
      const cpmSpike = checkCpmSpike(cpm, baseline.avgCpm)
      if (cpmSpike) {
        const pctOver = (((cpm - baseline.avgCpm) / baseline.avgCpm) * 100).toFixed(0)
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: date,
          entity_level: 'campaign',
          campaign_id: row.campaign_id,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: row.meta_campaign_id,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'cpm_spike',
          severity: cpmSpike,
          title: 'Auction costs rose sharply',
          message: `CPM hit ${formatMoney(cpm)} — ${pctOver}% above your ${baseline.days}-day average of ${formatMoney(baseline.avgCpm)}.`,
          metric_name: 'cpm',
          metric_value: cpm,
          threshold_value: null,
          baseline_value: baseline.avgCpm,
          is_resolved: false,
          why_it_matters: `CPM is what you pay per 1,000 impressions. A ${pctOver}% jump means the auction got more competitive — you're paying more to reach the same people. Higher CPM directly raises your cost per lead even if nothing else changed.`,
          recommended_actions: [
            'Check if CPM rose across all campaigns (market-wide) or just this one',
            'Review audience size and targeting breadth as possible contributors to auction cost',
            'Review if a competitor is heavily spending in your exact audience right now',
            'Compare CPM by delivery time as a diagnostic; this alert does not authorise a budget allocation',
          ],
          amount_at_risk: null,
          action_label: 'Review Audience Size',
          action_url: null,
        })
      }
    }

    // Frequency alert
    if (frequency !== null) {
      const freqAlert = checkFrequencyAlert(frequency)
      if (freqAlert) {
        const threshold = freqAlert === 'critical' ? 3.5 : 2.5
        alertsToInsert.push({
          ad_account_id: adAccountDbId,
          alert_date: date,
          entity_level: 'campaign',
          campaign_id: row.campaign_id,
          adset_id: null,
          ad_id: null,
          meta_campaign_id: row.meta_campaign_id,
          meta_adset_id: null,
          meta_ad_id: null,
          alert_type: 'frequency_high',
          severity: freqAlert,
          title: 'Daily frequency observation is elevated',
          message: `Campaign daily frequency was ${frequency.toFixed(2)}x for ${date}. This is a one-day delivery observation, not selected-period frequency.`,
          metric_name: 'frequency',
          metric_value: frequency,
          threshold_value: threshold,
          baseline_value: baseline.avgFrequency,
          is_resolved: false,
          why_it_matters: `A high daily frequency observation can result from audience size, delivery concentration, campaign configuration, or measurement. It does not establish creative fatigue or predict a future CTR change.`,
          recommended_actions: [
            'Review a correctly scoped Meta period-frequency metric before interpreting repetition',
            'Compare link or outbound response, CPM, paid outcomes, placements, and recent setup changes',
            'Inspect audience size, overlap, exclusions, and any Advantage+ expansion',
          ],
          amount_at_risk: null,
          action_label: 'Review Delivery Evidence',
          action_url: null,
        })
      }
    }

    // Zero-CONVERSION check — fires ONLY when today produced zero of BOTH conversion types while the
    // campaign NORMALLY converts (baseline > 0 on its dominant metric). Requiring both at zero prevents
    // the false alarm where the dominant-metric inference picks the wrong type and cries "zero bookings"
    // on a day the campaign produced 15 leads; requiring a baseline kills the structural-
    // zero noise (leads ≡ 0 on this bookings account; learning-phase never-converters).
    const bookings = Number(row.bookings ?? 0)
    const convMetric: 'bookings' | 'leads' = baseline.totalBookings >= baseline.totalLeads ? 'bookings' : 'leads'
    const baselineConv = convMetric === 'bookings' ? baseline.totalBookings : baseline.totalLeads
    const todayEitherConv = bookings + leads
    const zeroLeads = checkZeroConversions({ todayConversions: todayEitherConv, spend, baselineConversions: baselineConv })
    if (zeroLeads) {
      alertsToInsert.push({
        ad_account_id: adAccountDbId,
        alert_date: date,
        entity_level: 'campaign',
        campaign_id: row.campaign_id,
        adset_id: null,
        ad_id: null,
        meta_campaign_id: row.meta_campaign_id,
        meta_adset_id: null,
        meta_ad_id: null,
        alert_type: 'zero_leads',
        severity: zeroLeads,
        title: `Spending with zero ${convMetric}`,
        message: `Campaign spent ${formatMoney(spend)} yesterday but generated zero ${convMetric} (normally ${baselineConv} per ${baseline.days} days).`,
        metric_name: convMetric,
        metric_value: 0,
        threshold_value: null,
        baseline_value: null,
        is_resolved: false,
        why_it_matters: `The campaign spent ${formatMoney(spend)} while Meta recorded zero ${convMetric} today. That may reflect a real funnel problem, normal daily variance, delayed attribution, or missing measurement; this alert does not distinguish those causes.`,
        recommended_actions: [
          `Click your own ad and complete a ${convMetric === 'bookings' ? `test ${OW.one}` : 'test lead form'} — confirm it submits and the pixel fires on the confirmation page`,
          'Check the landing page is loading correctly (not returning an error or redirecting)',
          `Verify in Meta Events Manager that the ${convMetric === 'bookings' ? EVENT : 'Lead'} event is firing (check last 24h)`,
          'Look at the ad\'s effective_status — if it\'s WITH_ISSUES or DISAPPROVED, that explains no delivery',
          'If measurement is healthy, compare creative engagement and landing-page completion before forming a change proposal',
        ],
        amount_at_risk: spend,
        action_label: 'Check Pixel & Landing Page',
        action_url: null,
      })
    }
  }

  // Step 3: Ad-level all-click CTR comparison. Daily rows cannot supply deduplicated period reach
  // or frequency, so this detector deliberately emits no creative-fatigue verdict or prescription.
  const adWindowStart = isoDayOffset(date, -(CTR_COMPARISON_DAYS * 2 - 1))
  if (!adWindowStart) throw new Error('runAlertDetection: invalid alert date')
  const { data: adInsights, error: adErr } = await supabase
    .from('daily_insights')
    .select('ad_id, adset_id, campaign_id, meta_ad_id, meta_adset_id, meta_campaign_id, date_start, clicks, impressions')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'ad')
    .gte('date_start', adWindowStart)
    .lte('date_start', date)

  if (adErr) {
    throw new Error(`runAlertDetection: ad insights query failed: ${adErr.message}`)
  }

  const adGroups = new Map<string, Array<Record<string, unknown>>>()
  for (const adRow of adInsights ?? []) {
    const key = String(adRow.ad_id ?? adRow.meta_ad_id ?? '')
    if (!key) continue
    adGroups.set(key, [...(adGroups.get(key) ?? []), adRow as Record<string, unknown>])
  }

  for (const adRows of adGroups.values()) {
    const trend = assessAllClickCtrTrend(adRows.map((row) => ({
      date_start: String(row.date_start ?? ''),
      clicks: row.clicks == null ? null : Number(row.clicks),
      impressions: row.impressions == null ? null : Number(row.impressions),
    })), date)
    if (trend.status !== 'declined' || trend.recentCtr === null || trend.priorCtr === null || trend.declinePct === null) {
      continue
    }

    const latest = adRows.find((row) => row.date_start === date) ?? adRows[adRows.length - 1]
    alertsToInsert.push({
      ad_account_id: adAccountDbId,
      alert_date: date,
      entity_level: 'ad',
      campaign_id: latest.campaign_id as string | null,
      adset_id: latest.adset_id as string | null,
      ad_id: latest.ad_id as string | null,
      meta_campaign_id: latest.meta_campaign_id as string | null,
      meta_adset_id: latest.meta_adset_id as string | null,
      meta_ad_id: latest.meta_ad_id as string | null,
      alert_type: 'ctr_drop',
      severity: trend.declinePct >= 35 ? 'critical' : 'warning',
      title: 'Ad all-click CTR declined across complete windows',
      message: `All-click CTR was ${trend.recentCtr.toFixed(2)}% over the latest 7 days, ${trend.declinePct.toFixed(0)}% below the prior complete 7-day window (${trend.priorCtr.toFixed(2)}%).`,
      metric_name: 'ctr',
      metric_value: trend.recentCtr,
      threshold_value: null,
      baseline_value: trend.priorCtr,
      is_resolved: false,
      why_it_matters: 'This confirms a change in all-click response, not its cause. Daily frequency rows cannot establish selected-period repetition, and all-click CTR is not link or outbound CTR.',
      recommended_actions: [
        'Compare link or outbound CTR with this all-click CTR trend',
        `Review CPM, paid ${OW.many}, placements, and recent setup changes over the same windows`,
        'Obtain correctly scoped period frequency before evaluating repeated exposure',
      ],
      amount_at_risk: null,
      action_label: 'Review Delivery Evidence',
      action_url: null,
    })
  }

  // Step 4: Insert alerts
  if (alertsToInsert.length === 0) return 0

  const { inserted, error: insertErr } = await insertAlertsDeduped(supabase, alertsToInsert as unknown as Record<string, unknown>[])

  if (insertErr) {
    throw new Error(`runAlertDetection: alert insert failed: ${insertErr}`)
  }

  return inserted
}


interface AdsetNameRow {
  id: string
  adset_id: string | null
  adset_name: string | null
}

export async function detectTrajectoryAlerts(
  adAccountDbId: string,
  alertDate: string
): Promise<number> {
  // The owner's CPA target and maximum (override-aware). With none set there is no line to cross.
  const cpaT = cpaTarget()
  if (cpaT === null) return 0
  const supabase = getAdminClient()

  const trajectories = await runTrajectoriesForAccount(adAccountDbId)

  if (trajectories.length === 0) return 0

  // Fetch adset names for Meta adset_id → name mapping.
  const metaAdsetIds = trajectories.map((t) => t.meta_entity_id)
  const { data: adsetsRaw } = await supabase
    .from('adsets')
    .select('id, adset_id, adset_name')
    .in('adset_id', metaAdsetIds)

  const adsets = (adsetsRaw ?? []) as AdsetNameRow[]
  const nameByMetaId = new Map<string, string>()
  for (const a of adsets) {
    if (a.adset_id) {
      nameByMetaId.set(a.adset_id, a.adset_name ?? a.adset_id)
    }
  }

  const alertsToInsert: AlertInsert[] = []

  for (const result of trajectories) {
    const adsetName = nameByMetaId.get(result.meta_entity_id) ?? result.meta_entity_id

    // CPA breach alerts — days_until_breach <= 3
    if (result.days_until_breach !== null && result.days_until_breach <= 3) {
      const ceilDays = Math.ceil(result.days_until_breach)
      const severity = result.days_until_breach <= 1 ? 'critical' : 'warning'
      const dayLabel = `${ceilDays} day${ceilDays === 1 ? '' : 's'}`

      alertsToInsert.push({
        ad_account_id: adAccountDbId,
        alert_date: alertDate,
        entity_level: 'campaign',
        campaign_id: null,
        adset_id: result.entity_id,
        ad_id: null,
        meta_campaign_id: null,
        meta_adset_id: result.meta_entity_id,
        meta_ad_id: null,
        alert_type: 'cpa_spike',
        severity,
        title: `Modelled CPA trend crosses a provisional reference in ${dayLabel} — ${adsetName}`,
        message: `Current modelled CPA ${result.current_cpa == null ? 'N/A' : formatMoney(result.current_cpa)}. Linear scenario ${result.projected_cpa_3d == null ? 'N/A' : formatMoney(result.projected_cpa_3d)} in 3 days from ${result.data_points} data point(s); this is diagnostic, not a forecast or action instruction.`,
        metric_name: 'cpa',
        metric_value: result.current_cpa,
        threshold_value: cpaT.max,
        baseline_value: null,
        is_resolved: false,
        why_it_matters: `Meta-modelled CPA is trending across the provisional ${formatMoneyAmount(cpaT.max)} diagnostic reference. Verify the exact matured paid cohort, measurement continuity and plausible funnel causes before forming a money or creative decision.`,
        recommended_actions: ['Verify the exact paid-outcome cohort', 'Check measurement continuity', 'Inspect delivery and landing-page diagnostics'],
        amount_at_risk: null,
        action_label: 'Review CPA Trend',
        action_url: null,
      })
    }

    // Improving CPA alerts
    if (
      result.trend_direction === 'improving' &&
      result.projected_cpa_3d !== null &&
      result.projected_cpa_3d < cpaT.target &&
      result.current_cpa !== null &&
      result.current_cpa > cpaT.target
    ) {
      alertsToInsert.push({
        ad_account_id: adAccountDbId,
        alert_date: alertDate,
        entity_level: 'campaign',
        campaign_id: null,
        adset_id: result.entity_id,
        ad_id: null,
        meta_campaign_id: null,
        meta_adset_id: result.meta_entity_id,
        meta_ad_id: null,
        alert_type: 'cpa_spike',
        severity: 'info',
        title: `Modelled CPA trend moves below a provisional reference — ${adsetName}`,
        message: `Modelled CPA moved from ${formatMoney(result.current_cpa)} toward a linear 3-day scenario of ${formatMoney(result.projected_cpa_3d)}. The ${formatMoneyAmount(cpaT.target)} threshold is a provisional diagnostic reference, not an owner-governed target or proof of future performance.`,
        metric_name: 'cpa',
        metric_value: result.current_cpa,
        threshold_value: cpaT.target,
        baseline_value: null,
        is_resolved: false,
        why_it_matters: 'This is a delivery trend to monitor. It does not establish paid business impact or authorize maintaining, scaling or changing spend.',
        recommended_actions: [
          'Monitor the exact paid cohort after maturity',
          'Check whether the modelled trend agrees with paid outcomes',
        ],
        amount_at_risk: null,
        action_label: null,
        action_url: null,
      })
    }
  }

  if (alertsToInsert.length === 0) return 0

  const { inserted, error: insertErr } = await insertAlertsDeduped(supabase, alertsToInsert as unknown as Record<string, unknown>[])

  if (insertErr) {
    throw new Error(`detectTrajectoryAlerts: alert insert failed: ${insertErr}`)
  }

  return inserted
}

/**
 * Legacy entry point retained for cron compatibility. Optimization compatibility is not a universal
 * booking rule: it depends on the immutable CampaignPlan outcome, objective, conversion location,
 * performance goal, event, page, and funnel. No such repository exists yet, so the only honest result is
 * to emit no "wrong event" alert. The future plan-aware detector must load the plan account-scoped; it
 * must not accept caller-supplied expectations.
 */
export const detectWrongOptimizationEvent: (adAccountDbId: string, alertDate: string) => Promise<number> =
  async () => 0
