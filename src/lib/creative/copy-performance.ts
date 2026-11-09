import { getAdminClient } from '@/lib/supabase/admin'
import { formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'
import { SPEND_FLOORS } from '@/config/spend-floors'

// Pure copy/hook performance analysis — grounds the copy bank in what actually RAN.
//
// The copy_variations bank stores DRAFTED copy with no performance linkage; meanwhile every live
// ad's actual primary text (creatives.body) and headline (creatives.title) are synced daily along
// with ad-level delivery metrics. This module groups delivered ads by the copy they ran and scores
// each hook/headline — so "which hooks actually work?" is answered from measured delivery, not a
// static library.
//
// Honesty rules (house style):
// - CTR / CPC / spend / impressions come from the Meta API — authoritative for DELIVERY.
// - `bookings` at ad level is the Meta pixel count — an ESTIMATE, always labeled, never revenue.
// - Below the min-data gate a copy group is 'insufficient' and never ranked.

export interface AdCopyRow {
  meta_ad_id: string
  body: string | null // creatives.body — primary text; first line is the hook
  title: string | null // creatives.title — headline
  spend: number
  impressions: number
  link_clicks: number
  bookings: number // Meta pixel estimate
  hook_strength_score?: number | null // Claude-vision score (1-5) for the ad's creative, when analyzed
}

export interface CopyGroupPerformance {
  /** The hook — first line of the primary text (what stops the scroll). */
  hook: string
  headline: string | null
  ads: number
  ad_ids: string[]
  spend: number
  impressions: number
  link_clicks: number
  /** Link CTR (link_clicks / impressions), Meta-authoritative delivery. */
  link_ctr: number | null
  /** Cost per link click, Meta-authoritative. */
  cpc: number | null
  /** Meta pixel count — ESTIMATE ONLY, labeled at the surface. */
  meta_bookings_estimate: number
  /** Average Claude-vision hook_strength_score (1-5) across the group's ads that were analyzed; null if none. */
  avg_hook_strength: number | null
  verdict: 'ranked' | 'insufficient'
  verdict_reason: string
}

// Minimum evidence before a copy group may be ranked: enough spend OR enough impressions that the
// CTR is meaningful. The spend floor is REC_THRESHOLDS' minimum spend to judge, at the copy grain.
export const copyMinSpend = () => SPEND_FLOORS.judge
export const COPY_MIN_IMPRESSIONS = 1000

/** PURE: the hook is the first non-empty line (or sentence) of the primary text, trimmed. */
export function extractHook(body: string | null | undefined): string | null {
  const text = (body ?? '').trim()
  if (!text) return null
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  // A one-paragraph body: cut at the first sentence end so the "hook" is the opener, not the essay.
  const sentenceEnd = firstLine.search(/[.!?]\s/)
  const hook = sentenceEnd > 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine
  return hook.slice(0, 160) || null
}

/** PURE: group delivered ads by (hook, headline) and score each group with min-data gating. */
export function analyzeCopyPerformance(rows: AdCopyRow[]): CopyGroupPerformance[] {
  const groups = new Map<string, CopyGroupPerformance>()
  const vision = new Map<string, { sum: number; count: number }>() // parallel vision-score accumulator

  for (const r of rows) {
    const hook = extractHook(r.body)
    if (!hook) continue // no primary text captured — nothing to learn about copy
    const key = `${hook}|${r.title ?? ''}`
    let g = groups.get(key)
    if (!g) {
      g = {
        hook,
        headline: r.title ?? null,
        ads: 0,
        ad_ids: [],
        spend: 0,
        impressions: 0,
        link_clicks: 0,
        link_ctr: null,
        cpc: null,
        meta_bookings_estimate: 0,
        avg_hook_strength: null,
        verdict: 'insufficient',
        verdict_reason: '',
      }
      groups.set(key, g)
    }
    g.ads++
    g.ad_ids.push(r.meta_ad_id)
    g.spend += r.spend
    g.impressions += r.impressions
    g.link_clicks += r.link_clicks
    g.meta_bookings_estimate += r.bookings
    if (typeof r.hook_strength_score === 'number' && Number.isFinite(r.hook_strength_score)) {
      const v = vision.get(key) ?? { sum: 0, count: 0 }
      v.sum += r.hook_strength_score
      v.count++
      vision.set(key, v)
    }
  }

  const out = [...groups.values()]
  for (const g of out) {
    g.spend = roundMoney(g.spend)
    g.link_ctr = g.impressions > 0 ? g.link_clicks / g.impressions : null
    g.cpc = g.link_clicks > 0 ? roundMoney((g.spend / g.link_clicks)) : null
    const v = vision.get(`${g.hook}|${g.headline ?? ''}`)
    g.avg_hook_strength = v && v.count > 0 ? Math.round((v.sum / v.count) * 10) / 10 : null
    const enough = g.spend >= copyMinSpend() || g.impressions >= COPY_MIN_IMPRESSIONS
    g.verdict = enough ? 'ranked' : 'insufficient'
    g.verdict_reason = enough
      ? `≥ ${formatMoneyAmount(copyMinSpend())} spend or ≥ ${COPY_MIN_IMPRESSIONS} impressions — delivery metrics are meaningful.`
      : `Below ${formatMoneyAmount(copyMinSpend())} spend AND ${COPY_MIN_IMPRESSIONS} impressions — too little delivery to judge this copy.`
  }

  // Ranked groups first, by link CTR desc (delivery-truth ordering — never by estimated bookings);
  // insufficient groups follow, by spend desc, so near-threshold copy is visible but unranked.
  out.sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict === 'ranked' ? -1 : 1
    if (a.verdict === 'ranked') return (b.link_ctr ?? 0) - (a.link_ctr ?? 0)
    return b.spend - a.spend
  })
  return out
}

/** LIVE copy performance: group delivered ads by the hook/headline they actually ran (synced
 *  creatives.body/title) and score each on ad-level delivery, attaching the ad's Claude-vision
 *  hook_strength_score. Returns [] on any error / no delivery. Shared by the copy-bank MCP tool and
 *  the /hooks page so both read the SAME measured truth (no duplicate scoring). */
export async function getRanCopyPerformance(
  accountDbId: string,
  start: string,
  end: string
): Promise<CopyGroupPerformance[]> {
  const db = getAdminClient()

  const [{ data: ads }, { data: insights }] = await Promise.all([
    db.from('ads').select('ad_id, vision_analysis, creatives(body, title)').eq('ad_account_id', accountDbId),
    db
      .from('daily_insights')
      .select('meta_ad_id, spend, impressions, link_clicks, bookings')
      .eq('ad_account_id', accountDbId)
      .eq('entity_level', 'ad')
      .gte('date_start', start)
      .lte('date_start', end),
  ])
  if (!ads?.length || !insights?.length) return []

  const agg = new Map<string, { spend: number; impressions: number; link_clicks: number; bookings: number }>()
  for (const r of insights) {
    const id = r.meta_ad_id as string | null
    if (!id) continue
    const a = agg.get(id) ?? { spend: 0, impressions: 0, link_clicks: 0, bookings: 0 }
    a.spend += Number(r.spend ?? 0)
    a.impressions += Number(r.impressions ?? 0)
    a.link_clicks += Number(r.link_clicks ?? 0)
    a.bookings += Number(r.bookings ?? 0)
    agg.set(id, a)
  }

  const rows: AdCopyRow[] = []
  for (const ad of ads) {
    const a = ad as unknown as {
      ad_id: string
      vision_analysis: { hook_strength_score?: number } | null
      creatives: { body: string | null; title: string | null } | null
    }
    const delivery = agg.get(a.ad_id)
    if (!delivery || !a.creatives) continue // never delivered in window / no creative captured
    const vs = a.vision_analysis?.hook_strength_score
    rows.push({
      meta_ad_id: a.ad_id,
      body: a.creatives.body,
      title: a.creatives.title,
      hook_strength_score: typeof vs === 'number' ? vs : null,
      ...delivery,
    })
  }
  return analyzeCopyPerformance(rows)
}
