import { getAdminClient } from '@/lib/supabase/admin'
import { aggregateMetrics, emptyMetrics, INSIGHT_METRIC_COLUMNS, type EntityMetrics } from '@/lib/metrics/aggregate'
import { priorPeriod, rangeLengthDays } from '@/lib/insights/compare'
import { summarizeAnomalies, explainMetricChange, ANOMALY_METRIC_SPECS, type MetricChangeInput, type EntityMovement } from '@/lib/diagnostics/anomaly'

// METRIC-ANOMALY GATHERER — the body of /api/diagnostics/anomalies, extracted so the MCP tools
// (get_metric_anomalies / get_diagnosis_bundle) can share it. Explains which efficiency metrics
// worsened vs the prior equal-length window, decomposing each into the arithmetic driver
// (numerator vs denominator) and the campaign that drove it — each with a trust score.

type Row = Record<string, unknown>

export interface AnomalyReportArgs {
  from: string
  to: string
  adAccountId: string
}

export async function buildAnomalyReport({ from, to, adAccountId }: AnomalyReportArgs) {
  const prior = priorPeriod(from, to)
  const days = rangeLengthDays(from, to)
  const db = getAdminClient()

  // Account-level rows across both windows + campaign list + per-campaign rows + sync freshness.
  const [accountWin, campaigns, campaignWin, accountRow] = await Promise.all([
    db.from('daily_insights').select(`date_start, ${INSIGHT_METRIC_COLUMNS}`).eq('ad_account_id', adAccountId).eq('entity_level', 'account').gte('date_start', prior.from).lte('date_stop', to),
    db.from('campaigns').select('id, campaign_id, campaign_name').eq('ad_account_id', adAccountId),
    db.from('daily_insights').select(`campaign_id, date_start, ${INSIGHT_METRIC_COLUMNS}`).eq('ad_account_id', adAccountId).eq('entity_level', 'campaign').gte('date_start', prior.from).lte('date_stop', to),
    db.from('ad_accounts').select('last_synced_at').eq('id', adAccountId).eq('is_active', true).maybeSingle(),
  ])

  const failedRead = [accountWin, campaigns, campaignWin, accountRow].find((result) => result.error)
  if (failedRead?.error) throw new Error(`Anomaly report read failed: ${failedRead.error.message}`)
  if (!accountRow.data) throw new Error('Active ad account not found')

  const inWindow = (r: Row, start: string, end: string) => {
    const d = String(r.date_start ?? '')
    return d >= start && d <= end
  }

  // Account current vs prior.
  const accRows = (accountWin.data ?? []) as Row[]
  const curRows = accRows.filter((r) => inWindow(r, from, to))
  if (curRows.length === 0) {
    throw new Error('Anomaly report unavailable: current_account_window_missing')
  }
  const curAgg = aggregateMetrics(curRows)
  const prevAgg = aggregateMetrics(accRows.filter((r) => inWindow(r, prior.from, prior.to)))

  // Per-campaign current vs prior.
  const nameByUuid = new Map<string, string>()
  for (const c of (campaigns.data ?? []) as Row[]) nameByUuid.set(c.id as string, (c.campaign_name as string) ?? (c.campaign_id as string) ?? 'Unknown')

  const curByCamp = new Map<string, Row[]>()
  const prevByCamp = new Map<string, Row[]>()
  for (const r of (campaignWin.data ?? []) as Row[]) {
    const id = r.campaign_id as string
    if (!id) continue
    const bucket = inWindow(r, from, to) ? curByCamp : prevByCamp
    if (!bucket.has(id)) bucket.set(id, [])
    bucket.get(id)!.push(r)
  }
  const campIds = new Set<string>([...curByCamp.keys(), ...prevByCamp.keys()])
  const campAgg = new Map<string, { cur: EntityMetrics; prev: EntityMetrics }>()
  for (const id of campIds) {
    campAgg.set(id, {
      cur: curByCamp.has(id) ? aggregateMetrics(curByCamp.get(id)!) : emptyMetrics(),
      prev: prevByCamp.has(id) ? aggregateMetrics(prevByCamp.get(id)!) : emptyMetrics(),
    })
  }
  const totalCampCurSpend = [...campAgg.values()].reduce((s, c) => s + c.cur.spend, 0)

  const dataAgeHours = accountRow.data && (accountRow.data as { last_synced_at?: string }).last_synced_at
    ? (Date.now() - Date.parse((accountRow.data as { last_synced_at: string }).last_synced_at)) / 3_600_000
    : null

  // Build a MetricChangeInput per spec.
  const inputs: MetricChangeInput[] = ANOMALY_METRIC_SPECS.map((s) => {
    const entities: EntityMovement[] = [...campAgg.entries()].map(([id, c]) => ({
      id,
      name: nameByUuid.get(id) ?? 'Unknown',
      spendShare: totalCampCurSpend > 0 ? c.cur.spend / totalCampCurSpend : 0,
      metricCurrent: s.pick(c.cur),
      metricPrevious: s.pick(c.prev),
    }))
    return {
      key: s.key,
      label: s.label,
      current: s.pick(curAgg),
      previous: s.pick(prevAgg),
      direction: s.direction,
      unit: s.unit,
      ratio: {
        numerator: { label: s.num.label, current: s.num.pick(curAgg), previous: s.num.pick(prevAgg) },
        denominator: { label: s.den.label, current: s.den.pick(curAgg), previous: s.den.pick(prevAgg) },
      },
      entities,
      trustCtx: {
        spend: curAgg.spend,
        bookings: curAgg.bookings,
        clicks: curAgg.clicks,
        impressions: curAgg.impressions,
        windowDays: days,
        dataAgeHours,
        revenueClaim: s.revenueClaim,
      },
    }
  })

  const anomalies = summarizeAnomalies(inputs)
  const movements = inputs.map(explainMetricChange) // all metrics, for the full movement view

  return {
    window: { from, to, days },
    prior,
    anomalies,
    movements,
    data_age_hours: dataAgeHours,
  }
}
