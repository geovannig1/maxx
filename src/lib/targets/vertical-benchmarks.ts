import { getAdminClient } from '@/lib/supabase/admin'
import { nyToday } from '@/lib/utils/date-utils'
import { filterUsableInsights } from '@/lib/recommendations/knowledge'
import type { MetricKey, MetricEvaluation } from './target-ranges'
import { formatMoneyAmount } from '@/lib/utils/format-currency'

// VERTICAL BENCHMARKS — the researched, CITED external ranges that let Maxx narrate "your CTR is above
// the vertical benchmark" the way Meta's chat does, WITHOUT inventing numbers. Governance (mirrors the
// expert-insight gate + the recorded seed-benchmark-priors decision):
//
//  1. Every row carries a real, named source (owner non-negotiable) — numbers come from the researched
//     table in docs/research/local-service-booking-2026-07.md (B5), not from training data.
//  2. A row is CITABLE only after the owner approves its matching expert_insights entry on /signals
//     (seeded PENDING by scripts/seed-vertical-benchmarks.ts; matched here by insight_title). Fail-closed.
//  3. CONTEXT ONLY: benchmarks are labeled external_heuristic, attach via annotateWithBenchmarks, and
//     NEVER change a metric's band/status. Account targets and the champion baseline always win.
//  4. NO booking-CPA benchmark: every researched cost row is cost-per-LEAD (semantic mismatch with this
//     account's cost-per-confirmed-BOOKING economics — the recorded owner decision). CPL rows say so.

export interface VerticalBenchmark {
  metric: MetricKey
  /** What the external number actually measures — 'cost_per_lead' is NOT booking CPA and must say so. */
  basis: 'ctr' | 'cpc' | 'cpm' | 'cost_per_lead'
  /** Bracketed by the two closest researched segment medians (Arts & Entertainment ↔ Personal Services). */
  range_low: number
  range_high: number
  unit: '$' | '%'
  vertical: string
  source_name: string
  source_url?: string
  /** Stable title of the matching expert_insights row — approval on /signals makes the row citable. */
  insight_title: string
}

// Researched 2026-07-10 (docs/research/local-service-booking-2026-07.md, section B5). Medians for Meta LEADS campaigns
// in the two segments bracketing a photo-studio rental business, plus the DTC-skewed all-industry CPM.
export const VERTICAL_BENCHMARKS: readonly VerticalBenchmark[] = [
  {
    metric: 'ctr',
    basis: 'ctr',
    range_low: 1.99,
    range_high: 3.92,
    unit: '%',
    vertical: 'Arts & Entertainment ↔ Personal Services (Meta Leads, segment medians)',
    source_name: 'WordStream/LocaliQ 2025 Facebook Ads benchmarks',
    source_url: 'https://www.wordstream.com/blog/facebook-ads-benchmarks',
    insight_title: 'Vertical benchmark: Meta Leads CTR 1.99–3.92% (Arts & Entertainment ↔ Personal Services medians)',
  },
  {
    metric: 'cpc',
    basis: 'cpc',
    range_low: 1.08,
    range_high: 2.08,
    unit: '$',
    vertical: 'Arts & Entertainment ↔ Personal Services (Meta Leads, segment medians)',
    source_name: 'WordStream/LocaliQ 2025 Facebook Ads benchmarks',
    source_url: 'https://www.wordstream.com/blog/facebook-ads-benchmarks',
    insight_title: 'Vertical benchmark: Meta Leads CPC $1.08–$2.08 (Arts & Entertainment ↔ Personal Services medians)',
  },
  {
    metric: 'cpm',
    basis: 'cpm',
    range_low: 13.48,
    range_high: 13.48,
    unit: '$',
    vertical: 'All-industry median (DTC-skewed panel; Q4 spikes >60%)',
    source_name: 'Sovran/Triple Whale 2025–26 CPM panel',
    insight_title: 'Vertical benchmark: Meta CPM ~$13.48 all-industry median (DTC-skewed; Q4 spikes >60%)',
  },
  {
    metric: 'cpl',
    basis: 'cost_per_lead',
    range_low: 18.17,
    range_high: 30.57,
    unit: '$',
    vertical: 'Arts & Entertainment ↔ Personal Services (Meta Leads, segment medians) — COST PER LEAD, not booking CPA',
    source_name: 'WordStream/LocaliQ 2025 Facebook Ads benchmarks',
    source_url: 'https://www.wordstream.com/blog/facebook-ads-benchmarks',
    insight_title: 'Vertical benchmark: Meta cost per LEAD $18.17–$30.57 (Arts & Entertainment ↔ Personal Services medians) — never comparable to booking CPA',
  },
]

export const BENCHMARK_LABEL = 'external_heuristic' as const

function formatRange(b: VerticalBenchmark): string {
  // Published benchmarks are USD medians (`unit: '$'`): shown as USD, never relabelled in the account currency.
  const fmt = (n: number) => (b.unit === '$' ? `${formatMoneyAmount(n, { currency: 'USD' })}` : `${n}%`)
  return b.range_low === b.range_high ? `~${fmt(b.range_low)} median` : `${fmt(b.range_low)}–${fmt(b.range_high)}`
}

/** PURE: the benchmark rows whose matching /signals insight the owner has APPROVED. Fail-closed. */
export function approvedVerticalBenchmarks(approvedTitles: Set<string>): VerticalBenchmark[] {
  return VERTICAL_BENCHMARKS.filter((b) => approvedTitles.has(b.insight_title))
}

/** PURE: attach approved benchmark CONTEXT to metric evaluations. Never touches status/band — a value
 *  outside the benchmark range stays whatever the account targets banded it as. */
export function annotateWithBenchmarks(evals: MetricEvaluation[], approvedTitles: Set<string>): MetricEvaluation[] {
  const byMetric = new Map(approvedVerticalBenchmarks(approvedTitles).map((b) => [b.metric, b]))
  return evals.map((e) => {
    const b = byMetric.get(e.metric)
    if (!b) return e
    return {
      ...e,
      benchmark: {
        range: `${formatRange(b)} (${b.vertical})${b.basis === 'cost_per_lead' ? ' — cost per LEAD, not booking CPA' : ''}`,
        label: BENCHMARK_LABEL,
        source: b.source_name,
      },
    }
  })
}

/** IMPURE: read the owner-approved insight titles (the /signals gate) for this account. Fail-closed:
 *  any error ⇒ empty set ⇒ no benchmark is citable. */
export async function fetchApprovedInsightTitles(adAccountDbId?: string): Promise<Set<string>> {
  try {
    const db = getAdminClient()
    let accountId = adAccountDbId ?? null
    if (!accountId) {
      const { data } = await db.from('ad_accounts').select('id').eq('is_active', true).limit(1).maybeSingle()
      accountId = (data?.id as string | undefined) ?? null
    }
    if (!accountId) return new Set()
    const { data, error } = await db
      .from('expert_insights')
      .select('title, applies_to_account, expires_at, review_status')
      .eq('ad_account_id', accountId)
      .limit(200)
    if (error) return new Set()
    const usable = filterUsableInsights(
      (data ?? []) as { title: string | null; applies_to_account: boolean | null; expires_at: string | null; review_status?: string | null }[],
      nyToday(),
    )
    return new Set(usable.map((r) => r.title).filter((t): t is string => !!t))
  } catch {
    return new Set()
  }
}

/** IMPURE convenience for the diagnosis tools: the approved benchmark rows, display-ready. */
export async function getApprovedVerticalBenchmarks(adAccountDbId?: string): Promise<
  { metric: MetricKey; range: string; label: typeof BENCHMARK_LABEL; source: string; basis: VerticalBenchmark['basis'] }[]
> {
  const titles = await fetchApprovedInsightTitles(adAccountDbId)
  return approvedVerticalBenchmarks(titles).map((b) => ({
    metric: b.metric,
    range: `${formatRange(b)} (${b.vertical})`,
    label: BENCHMARK_LABEL,
    source: b.source_name,
    basis: b.basis,
  }))
}
