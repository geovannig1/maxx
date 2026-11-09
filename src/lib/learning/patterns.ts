import { getAdminClient } from '@/lib/supabase/admin'
import { getTargetRange } from '@/lib/targets/target-ranges'
import { decisiveCpaVsTarget } from '@/lib/learning/model'
import { formatMoney, formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'
import { SPEND_FLOORS } from '@/config/spend-floors'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

// Recompute distilled "what works" patterns across every avenue: targeting (audience/age/gender/placement),
// ad settings (optimization goal, bid strategy), spend level, time-of-day, and recommendation win-rates.

const WINDOW = 30
// Override-aware (active range = defaults + Performance-Targets overrides).
const targetCpa = () => getTargetRange('cpa').healthy
const maxCpa = () => getTargetRange('cpa').watch

interface Agg {
  spend: number
  bookings: number
  clicks: number
  impressions: number
}
const emptyAgg = (): Agg => ({ spend: 0, bookings: 0, clicks: 0, impressions: 0 })
function add(a: Agg, spend: unknown, bookings: unknown, clicks: unknown, impressions: unknown) {
  a.spend += Number(spend ?? 0)
  a.bookings += Number(bookings ?? 0)
  a.clicks += Number(clicks ?? 0)
  a.impressions += Number(impressions ?? 0)
}

export function breakdownBookingsComplete(rows: Array<{ bookings: unknown }>): boolean {
  return rows.every((row) => {
    if (row.bookings === null || row.bookings === '') return false
    const bookings = Number(row.bookings)
    return Number.isFinite(bookings) && bookings >= 0
  })
}

interface PatternRow {
  dimension: string
  segment: string
  sample_spend: number
  sample_bookings: number
  cpa: number | null
  ctr: number | null
  win_rate: number | null
  verdict: string
  recommendation: string
  confidence: string
}

export function judge(agg: Agg): Omit<PatternRow, 'dimension' | 'segment' | 'win_rate'> {
  const cpa = agg.bookings > 0 ? agg.spend / agg.bookings : null
  const ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : null
  const confidence = agg.bookings >= 5 ? 'high' : agg.bookings >= 2 ? 'medium' : 'low'

  // Variance-aware "scale here": a segment is only 'strong' (lean in / scale) when its CPA beats
  // target DECISIVELY given the booking count — a great point-CPA on 1–2 bookings is noise, not a scale
  // signal. Below decisive, a good point-CPA is 'mixed' (monitor / gather more), never surfaced as
  // "scale here" in the learning brief.
  const target = targetCpa()
  const max = maxCpa()
  const decisive = cpa !== null && target !== null ? decisiveCpaVsTarget(agg.spend, agg.bookings, target) : 'inconclusive'

  let verdict: string
  let recommendation: string
  if (agg.bookings === 0) {
    if (agg.spend >= SPEND_FLOORS.modelledZeroOutcome) { verdict = 'weak'; recommendation = `MODELLED data records ${formatMoney(agg.spend, { maximumFractionDigits: 0 })} spend with zero modelled bookings — diagnostic only, with no budget direction.` }
    else { verdict = 'insufficient'; recommendation = 'The sample is too small for a performance judgment.' }
  } else if (target === null || max === null) {
    // No owner CPA target: the modelled CPA is reported, never judged.
    verdict = 'mixed'
    recommendation = `MODELLED CPA ${cpa === null ? 'unavailable' : formatMoney(cpa, { maximumFractionDigits: 0 })}; no CPA target is set, so it is not judged.`
  } else if (cpa !== null && cpa <= target && decisive === 'better') {
    // These strings reach the report prompts, so an imperative here IS a money
    // instruction issued on Meta-MODELLED conversions, outside the authority layer. The measurement
    // survives verbatim; the instruction does not.
    verdict = 'strong'; recommendation = `Beats target on MODELLED data (${formatMoney(cpa, { maximumFractionDigits: 0 })} ≤ ${formatMoneyAmount(target)} across ${agg.bookings} modelled conversion(s)) — a diagnostic signal about this segment, NOT a budget instruction.`
  } else if (cpa !== null && cpa <= max) {
    verdict = 'mixed'
    recommendation = cpa <= target
      ? `Point MODELLED CPA ${formatMoney(cpa, { maximumFractionDigits: 0 })} beats target but on only ${agg.bookings} modelled booking(s); this is not yet a decisive win.`
      : `MODELLED CPA is within the acceptable range (${formatMoney(cpa, { maximumFractionDigits: 0 })}); its direction remains unresolved.`
  } else {
    verdict = 'weak'; recommendation = `Above max on MODELLED CPA (${cpa === null ? 'unavailable' : formatMoney(cpa, { maximumFractionDigits: 0 })}) — a diagnostic signal about this segment, NOT a budget instruction.`
  }
  return {
    sample_spend: roundMoney(agg.spend),
    sample_bookings: agg.bookings,
    cpa: cpa !== null ? roundMoney(cpa) : null,
    ctr: ctr !== null ? Math.round(ctr * 10000) / 10000 : null,
    verdict,
    recommendation,
    confidence,
  }
}

function spendBand(total: number): string {
  if (total < 100) return '<$100 (30d)'
  if (total < 300) return '$100-300 (30d)'
  if (total < 600) return '$300-600 (30d)'
  if (total < 1200) return '$600-1200 (30d)'
  return '$1200+ (30d)'
}

export async function recomputeLearnedPatterns(
  adAccountDbId: string,
  today: string
): Promise<{ patterns: number; dimensions: string[] }> {
  const db = getAdminClient()
  const since = new Date(today + 'T00:00:00Z')
  since.setUTCDate(since.getUTCDate() - WINDOW)
  const sinceStr = since.toISOString().slice(0, 10)

  const rows: PatternRow[] = []
  const dimensionsTouched = new Set<string>()

  // ── Targeting + settings + spend, from adset-level insights joined to adset metadata ──
  try {
    const { data: adsets } = await db
      .from('adsets')
      .select('adset_id, audience_type, optimization_goal, bid_strategy')
      .eq('ad_account_id', adAccountDbId)
    const meta = new Map<string, { audience: string; optGoal: string; bid: string }>()
    for (const a of adsets ?? []) {
      meta.set(a.adset_id as string, {
        audience: (a.audience_type as string) ?? 'unknown',
        optGoal: (a.optimization_goal as string) ?? 'unknown',
        bid: (a.bid_strategy as string) ?? 'unknown',
      })
    }

    const { data: insights } = await db
      .from('daily_insights')
      .select('meta_adset_id, spend, bookings, clicks, impressions')
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'adset')
      .gte('date_start', sinceStr)
      .lte('date_start', today)

    const perAdset = new Map<string, Agg>()
    const byAudience = new Map<string, Agg>()
    const byOptGoal = new Map<string, Agg>()
    const byBid = new Map<string, Agg>()

    for (const r of insights ?? []) {
      const id = r.meta_adset_id as string | null
      if (!id) continue
      if (!perAdset.has(id)) perAdset.set(id, emptyAgg())
      add(perAdset.get(id)!, r.spend, r.bookings, r.clicks, r.impressions)

      const m = meta.get(id)
      if (m) {
        for (const [map, key] of [[byAudience, m.audience], [byOptGoal, m.optGoal], [byBid, m.bid]] as const) {
          if (!map.has(key)) map.set(key, emptyAgg())
          add(map.get(key)!, r.spend, r.bookings, r.clicks, r.impressions)
        }
      }
    }

    // spend band — bucket each ad set by its actual 30d spend
    const bySpendBand = new Map<string, Agg>()
    for (const agg of perAdset.values()) {
      const band = spendBand(agg.spend)
      if (!bySpendBand.has(band)) bySpendBand.set(band, emptyAgg())
      add(bySpendBand.get(band)!, agg.spend, agg.bookings, agg.clicks, agg.impressions)
    }

    const pushAll = (dim: string, map: Map<string, Agg>) => {
      for (const [segment, agg] of map) {
        if (segment === 'unknown' && agg.spend < 1) continue
        rows.push({ dimension: dim, segment, win_rate: null, ...judge(agg) })
        dimensionsTouched.add(dim)
      }
    }
    pushAll('audience', byAudience)
    pushAll('optimization_goal', byOptGoal)
    pushAll('bid_strategy', byBid)
    pushAll('spend_band', bySpendBand)
  } catch (err) {
    console.warn('[learning] adset-join patterns failed:', err instanceof Error ? err.message : err)
  }

  // ── Targeting breakdowns: age / gender / placement ──
  try {
    const { data: bd } = await db
      .from('insight_breakdowns')
      .select('breakdown_type, breakdown_value, spend, bookings, clicks, impressions')
      .eq('ad_account_id', adAccountDbId)
      .gte('date_start', sinceStr)
      .lte('date_start', today)

    const breakdownRows = bd ?? []
    if (!breakdownBookingsComplete(breakdownRows)) {
      throw new Error('Meta breakdown outcome plane is incomplete')
    }
    const byKey = new Map<string, { dim: string; seg: string; agg: Agg }>()
    for (const r of breakdownRows) {
      const type = r.breakdown_type as string
      const dim = type === 'age' ? 'age' : type === 'gender' ? 'gender' : 'placement'
      const seg = (r.breakdown_value as string) ?? 'unknown'
      const key = `${dim}|${seg}`
      if (!byKey.has(key)) byKey.set(key, { dim, seg, agg: emptyAgg() })
      add(byKey.get(key)!.agg, r.spend, r.bookings, r.clicks, r.impressions)
    }
    for (const { dim, seg, agg } of byKey.values()) {
      rows.push({ dimension: dim, segment: seg, win_rate: null, ...judge(agg) })
      dimensionsTouched.add(dim)
    }
  } catch (err) {
    console.warn('[learning] breakdown patterns failed:', err instanceof Error ? err.message : err)
  }

  // ── Creative angle: which messaging/angle actually converts ──
  try {
    const { data: ads } = await db
      .from('ads')
      .select('ad_id, creative_angle')
      .eq('ad_account_id', adAccountDbId)
    const angleByAd = new Map<string, string>()
    for (const a of ads ?? []) {
      const angle = (a.creative_angle as string | null)?.trim()
      if (angle) angleByAd.set(a.ad_id as string, angle)
    }
    if (angleByAd.size > 0) {
      const { data: adInsights } = await db
        .from('daily_insights')
        .select('meta_ad_id, spend, bookings, clicks, impressions')
        .eq('ad_account_id', adAccountDbId)
        .eq('entity_level', 'ad')
        .gte('date_start', sinceStr)
        .lte('date_start', today)
      const byAngle = new Map<string, Agg>()
      for (const r of adInsights ?? []) {
        const angle = angleByAd.get(r.meta_ad_id as string)
        if (!angle) continue
        if (!byAngle.has(angle)) byAngle.set(angle, emptyAgg())
        add(byAngle.get(angle)!, r.spend, r.bookings, r.clicks, r.impressions)
      }
      for (const [seg, agg] of byAngle) {
        rows.push({ dimension: 'creative_angle', segment: seg, win_rate: null, ...judge(agg) })
        dimensionsTouched.add('creative_angle')
      }
    }
  } catch (err) {
    console.warn('[learning] creative_angle patterns failed:', err instanceof Error ? err.message : err)
  }

  // ── Time-of-day: by hour (day_of_week is unreliable upstream, so hour only) ──
  try {
    const { data: dp } = await db
      .from('daypart_insights')
      .select('hour_of_day, spend, bookings, clicks, impressions')
      .eq('ad_account_id', adAccountDbId)
      .gte('date_range_start', sinceStr)

    const byHour = new Map<string, Agg>()
    for (const r of dp ?? []) {
      const h = String(r.hour_of_day as number).padStart(2, '0') + ':00'
      if (!byHour.has(h)) byHour.set(h, emptyAgg())
      add(byHour.get(h)!, r.spend, r.bookings, r.clicks, r.impressions)
    }
    for (const [seg, agg] of byHour) {
      rows.push({ dimension: 'daypart_hour', segment: seg, win_rate: null, ...judge(agg) })
      dimensionsTouched.add('daypart_hour')
    }
  } catch (err) {
    console.warn('[learning] daypart patterns failed:', err instanceof Error ? err.message : err)
  }

  // ── Recommendation win-rates (from recommendation_outcomes) ──
  try {
    const { data: outcomes } = await db
      .from('recommendation_outcomes')
      .select('flag_type, metric_name, outcome, outcome_note, review_status')
      .eq('ad_account_id', adAccountDbId)
      .not('outcome', 'is', null)
    const byType = new Map<string, { worked: number; failed: number; inconclusive: number }>()
    for (const r of outcomes ?? []) {
      if (!isCausalContributionMetric(r.metric_name)) continue
      // Human review gate (`review_status`): only OWNER-APPROVED outcomes count toward a trusted win-rate.
      if (((r.review_status as string) ?? 'pending') !== 'approved') continue
      // An estimate-only decisive lesson (GA4 attribution < 50%) must NOT inflate a rec type's
      // win-rate — we could not GA4-confirm it. The marker travels in outcome_note.
      if (((r.outcome_note as string) ?? '').includes('estimate-only')) continue
      const t = (r.flag_type as string) ?? 'unknown'
      if (!byType.has(t)) byType.set(t, { worked: 0, failed: 0, inconclusive: 0 })
      const o = r.outcome as 'worked' | 'failed' | 'inconclusive'
      byType.get(t)![o]++
    }
    for (const [seg, c] of byType) {
      const decisive = c.worked + c.failed
      const winRate = decisive > 0 ? Math.round((c.worked / decisive) * 1000) / 10 : null
      let verdict: string, recommendation: string, confidence: string
      if (decisive < 3) { verdict = 'insufficient'; confidence = 'low'; recommendation = 'Too few evaluated to trust the win-rate yet.' }
      else if (winRate !== null && winRate >= 60) { verdict = 'strong'; confidence = decisive >= 6 ? 'high' : 'medium'; recommendation = `${seg.replaceAll('_', ' ')} calls were owner-approved as worked ${winRate}% of the time. Historical correlation only; no current action authority.` }
      else if (winRate !== null && winRate <= 40) { verdict = 'weak'; confidence = decisive >= 6 ? 'high' : 'medium'; recommendation = `${seg.replaceAll('_', ' ')} calls were owner-approved as worked only ${winRate}% of the time. Historical diagnostic; no current action authority.` }
      else { verdict = 'mixed'; confidence = 'medium'; recommendation = `${seg.replaceAll('_', ' ')} calls have a mixed owner-reviewed record (${winRate}%). Historical diagnostic; no current action authority.` }
      rows.push({
        dimension: 'recommendation_type', segment: seg,
        sample_spend: 0, sample_bookings: c.worked + c.failed + c.inconclusive,
        cpa: null, ctr: null, win_rate: winRate, verdict, recommendation, confidence,
      })
      dimensionsTouched.add('recommendation_type')
    }
  } catch (err) {
    console.warn('[learning] recommendation win-rate patterns failed:', err instanceof Error ? err.message : err)
  }

  // Only owner-reviewed recommendation outcomes are eligible to become model-facing learning.
  // Audience/age/gender/placement/daypart/creative averages above are Meta-modelled diagnostics;
  // retaining them in learned_patterns for audit compatibility must never make them learned policy.
  const trustedRows = rows.filter((row) => row.dimension === 'recommendation_type')
  if (trustedRows.length > 0) {
    const upsertRows = trustedRows.map((r) => ({
      ad_account_id: adAccountDbId,
      dimension: r.dimension,
      segment: r.segment,
      window_days: WINDOW,
      sample_spend: r.sample_spend,
      sample_bookings: r.sample_bookings,
      cpa: r.cpa,
      ctr: r.ctr,
      win_rate: r.win_rate,
      verdict: r.verdict,
      recommendation: r.recommendation,
      confidence: r.confidence,
      computed_at: new Date().toISOString(),
    }))
    const { error } = await db
      .from('learned_patterns')
      .upsert(upsertRows, { onConflict: 'ad_account_id,dimension,segment,window_days', ignoreDuplicates: false })
    if (error) console.warn('[learning] learned_patterns upsert failed:', error.message)
  }

  return {
    patterns: trustedRows.length,
    dimensions: trustedRows.length > 0 ? ['recommendation_type'] : [],
  }
}
