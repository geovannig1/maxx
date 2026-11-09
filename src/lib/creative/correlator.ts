import { roundMoney } from '@/lib/utils/format-currency'
import { getAdminClient } from '@/lib/supabase/admin'
import type { VisionAnalysis } from './vision-analyzer'

export interface CorrelationResult {
  field: string
  value: string
  count: number
  avg_ctr: number | null
  avg_cpa: number | null
  avg_bookings: number
  vs_baseline_ctr: number | null
  vs_baseline_cpa: number | null
  signal: 'positive' | 'negative' | 'neutral'
}

// Fields from VisionAnalysis that are useful for correlation
const CORRELATION_FIELDS: Array<keyof VisionAnalysis> = [
  'format',
  'has_text_overlay',
  'shows_price',
  'talent_type',
  'setting',
  'color_mood',
  'cta_visible',
]

interface CreativeAggregate {
  creative_id: string
  vision_analysis: VisionAnalysis
  total_spend: number
  total_bookings: number
  avg_ctr: number | null
  implied_cpa: number | null
}

function computeSignal(
  avgCtr: number | null,
  avgCpa: number | null,
  baselineCtr: number | null,
  baselineCpa: number | null
): 'positive' | 'negative' | 'neutral' {
  let positive = false
  let negative = false

  if (avgCtr !== null && baselineCtr !== null && baselineCtr > 0) {
    const diff = (avgCtr - baselineCtr) / baselineCtr
    if (diff >= 0.1) positive = true
    if (diff <= -0.1) negative = true
  }

  if (avgCpa !== null && baselineCpa !== null && baselineCpa > 0) {
    const diff = (avgCpa - baselineCpa) / baselineCpa
    // Lower CPA is better — negative diff means this segment is cheaper
    if (diff <= -0.1) positive = true
    if (diff >= 0.1) negative = true
  }

  if (positive && !negative) return 'positive'
  if (negative && !positive) return 'negative'
  return 'neutral'
}

function pctDiff(value: number | null, baseline: number | null): number | null {
  if (value === null || baseline === null || baseline === 0) return null
  return Math.round(((value - baseline) / baseline) * 10000) / 100
}

export async function getCreativeCorrelations(
  adAccountDbId: string,
  range: { start: string; end: string },
): Promise<CorrelationResult[]> {
  const supabase = getAdminClient()

  // Query creatives with vision_analysis, joined via ads to daily_insights
  // We use a two-step approach: fetch creatives then join insights in JS
  const { data: creatives, error: creativeErr } = await supabase
    .from('creatives')
    .select('id, vision_analysis')
    .eq('ad_account_id', adAccountDbId)
    .not('vision_analysis', 'is', null)

  if (creativeErr) {
    throw new Error(`Creative correlation source read failed: ${creativeErr.message}`)
  }

  if (!creatives || creatives.length === 0) return []

  // Build map: creative DB id → vision_analysis
  const creativeMap = new Map<string, VisionAnalysis>()
  for (const c of creatives) {
    creativeMap.set(c.id as string, c.vision_analysis as VisionAnalysis)
  }

  // Fetch ad-level insights for those creatives' linked ads
  const { data: insightRows, error: insightErr } = await supabase
    .from('daily_insights')
    .select('ad_id, spend, bookings, ctr, ads!inner(creative_id, ad_account_id)')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'ad')
    .eq('ads.ad_account_id', adAccountDbId)
    .gte('date_start', range.start)
    .lte('date_start', range.end)
    .not('ad_id', 'is', null)

  if (insightErr) {
    throw new Error(`Creative correlation insight read failed: ${insightErr.message}`)
  }

  if (!insightRows || insightRows.length === 0) return []

  // Aggregate per creative
  const aggregates = new Map<
    string,
    { spend: number; bookings: number; ctrValues: number[]; creative_id: string }
  >()

  for (const row of insightRows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ad = row.ads as any
    const creativeDbId = ad?.creative_id as string | null
    if (!creativeDbId || !creativeMap.has(creativeDbId)) continue

    const existing = aggregates.get(creativeDbId)
    if (!existing) {
      aggregates.set(creativeDbId, {
        spend: row.spend ?? 0,
        bookings: row.bookings ?? 0,
        ctrValues: row.ctr != null ? [row.ctr] : [],
        creative_id: creativeDbId,
      })
    } else {
      existing.spend += row.spend ?? 0
      existing.bookings += row.bookings ?? 0
      if (row.ctr != null) existing.ctrValues.push(row.ctr)
    }
  }

  // Build final creative aggregates list
  const aggregateList: CreativeAggregate[] = []
  for (const [creativeDbId, agg] of aggregates.entries()) {
    const vision = creativeMap.get(creativeDbId)
    if (!vision) continue

    const avgCtr =
      agg.ctrValues.length > 0
        ? agg.ctrValues.reduce((a, b) => a + b, 0) / agg.ctrValues.length
        : null

    const impliedCpa =
      agg.spend > 0 && agg.bookings > 0 ? agg.spend / agg.bookings : null

    aggregateList.push({
      creative_id: creativeDbId,
      vision_analysis: vision,
      total_spend: agg.spend,
      total_bookings: agg.bookings,
      avg_ctr: avgCtr,
      implied_cpa: impliedCpa,
    })
  }

  if (aggregateList.length === 0) return []

  // Compute baseline metrics (all creatives combined)
  const validCtrValues = aggregateList.filter((a) => a.avg_ctr !== null)
  const validCpaValues = aggregateList.filter((a) => a.implied_cpa !== null)

  const baselineCtr =
    validCtrValues.length > 0
      ? validCtrValues.reduce((s, a) => s + a.avg_ctr!, 0) / validCtrValues.length
      : null

  const baselineCpa =
    validCpaValues.length > 0
      ? validCpaValues.reduce((s, a) => s + a.implied_cpa!, 0) / validCpaValues.length
      : null

  // Build correlation results per field/value
  const results: CorrelationResult[] = []

  for (const field of CORRELATION_FIELDS) {
    // Group aggregates by field value
    const groups = new Map<string, CreativeAggregate[]>()
    for (const agg of aggregateList) {
      const raw = agg.vision_analysis[field]
      const val = String(raw ?? '')
      const group = groups.get(val)
      if (!group) {
        groups.set(val, [agg])
      } else {
        group.push(agg)
      }
    }

    for (const [value, group] of groups.entries()) {
      const ctrGroup = group.filter((a) => a.avg_ctr !== null)
      const cpaGroup = group.filter((a) => a.implied_cpa !== null)

      const groupAvgCtr =
        ctrGroup.length > 0
          ? ctrGroup.reduce((s, a) => s + a.avg_ctr!, 0) / ctrGroup.length
          : null

      const groupAvgCpa =
        cpaGroup.length > 0
          ? cpaGroup.reduce((s, a) => s + a.implied_cpa!, 0) / cpaGroup.length
          : null

      const groupAvgBookings =
        group.reduce((s, a) => s + a.total_bookings, 0) / group.length

      results.push({
        field,
        value,
        count: group.length,
        avg_ctr: groupAvgCtr !== null ? Math.round(groupAvgCtr * 1000000) / 1000000 : null,
        avg_cpa: groupAvgCpa !== null ? roundMoney(groupAvgCpa) : null,
        avg_bookings: Math.round(groupAvgBookings * 100) / 100,
        vs_baseline_ctr: pctDiff(groupAvgCtr, baselineCtr),
        vs_baseline_cpa: pctDiff(groupAvgCpa, baselineCpa),
        signal: computeSignal(groupAvgCtr, groupAvgCpa, baselineCtr, baselineCpa),
      })
    }
  }

  // Sort by absolute CTR difference from baseline, descending
  results.sort((a, b) => {
    const aDiff = Math.abs(a.vs_baseline_ctr ?? 0)
    const bDiff = Math.abs(b.vs_baseline_ctr ?? 0)
    return bDiff - aDiff
  })

  return results.slice(0, 20)
}
