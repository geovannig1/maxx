import { parseAdName, type AdNameTaxonomyConfig, UNPARSED_GROUP } from '@/lib/creative/ad-name-taxonomy'
import { formatMoney, roundMoney } from '@/lib/utils/format-currency'
import { outcomeNoun, outcomeWords } from '@/config/outcome-nouns'
import { SPEND_FLOORS } from '@/config/spend-floors'

/**
 * Judging at the altitude where signal exists.
 *
 * Judged per ad, a small account's recommendations are almost all hold, investigate, or keep. The
 * cause is not the gate — it is the unit. When a dozen or more ads share a few thousand dollars,
 * every sample is too thin to call, so the honest answer really is "insufficient data". Judged per
 * audience, the same data can be decisive: one audience can book at a quarter of another's cost.
 *
 * WHY COMPARISONS ARE RELATIVE, NOT ABSOLUTE. Cost per result here is built on Meta's *modelled*
 * results, and `tests/dashboard-money-authority.test.ts` exists to stop modelled CPA being dressed
 * up as a money verdict. Comparing one group to another on the identical basis cancels that
 * modelling bias out; comparing it to a dollar target does not. So this module ranks groups
 * against each other and never against a target, and the zero-result finding — which needs no
 * cost model at all — outranks every ratio.
 */

export interface AdRow {
  adName: string
  status: string | null
  spend: number
  results: number
  clicks: number
  impressions: number
}

export interface GroupPerformance {
  key: string
  audience: string | null
  concept: string | null
  parsed: boolean
  ads: number
  liveAds: number
  spend: number
  results: number
  clicks: number
  impressions: number
  /** Meta-modelled cost per result. Null when there are no results — never Infinity, never 0. */
  costPerResult: number | null
  linkCtrPct: number | null
  liveSpend: number
  liveResults: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const isLive = (status: string | null) => status === 'ACTIVE'

function fold(rows: readonly AdRow[], keyOf: (row: AdRow) => { key: string; audience: string | null; concept: string | null; parsed: boolean }) {
  const map = new Map<string, GroupPerformance>()
  for (const row of rows) {
    const id = keyOf(row)
    let group = map.get(id.key)
    if (!group) {
      group = {
        key: id.key, audience: id.audience, concept: id.concept, parsed: id.parsed,
        ads: 0, liveAds: 0, spend: 0, results: 0, clicks: 0, impressions: 0,
        costPerResult: null, linkCtrPct: null, liveSpend: 0, liveResults: 0,
      }
      map.set(id.key, group)
    }
    group.ads += 1
    group.spend += row.spend
    group.results += row.results
    group.clicks += row.clicks
    group.impressions += row.impressions
    if (isLive(row.status)) { group.liveAds += 1; group.liveSpend += row.spend; group.liveResults += row.results }
  }
  for (const group of map.values()) {
    group.spend = roundMoney(group.spend)
    group.liveSpend = roundMoney(group.liveSpend)
    group.costPerResult = group.results > 0 ? roundMoney(group.spend / group.results) : null
    group.linkCtrPct = group.impressions > 0 ? round2((100 * group.clicks) / group.impressions) : null
  }
  return [...map.values()]
}

export function byAudience(rows: readonly AdRow[], config?: AdNameTaxonomyConfig): GroupPerformance[] {
  return fold(rows, (row) => {
    const t = parseAdName(row.adName, config)
    const audience = t.parsed ? t.audience : null
    return { key: audience ?? UNPARSED_GROUP, audience, concept: null, parsed: t.parsed }
  }).sort((a, b) => (a.parsed === b.parsed ? b.spend - a.spend : a.parsed ? -1 : 1))
}

export function byConcept(rows: readonly AdRow[], config?: AdNameTaxonomyConfig): GroupPerformance[] {
  return fold(rows, (row) => {
    const t = parseAdName(row.adName, config)
    if (!t.parsed) return { key: UNPARSED_GROUP, audience: null, concept: null, parsed: false }
    return { key: t.groupKey, audience: t.audience, concept: t.concept, parsed: true }
  }).sort((a, b) => (a.parsed === b.parsed ? b.spend - a.spend : a.parsed ? -1 : 1))
}

// ── The read ──────────────────────────────────────────────────────────────────

export type ReadKind = 'live_spend_no_results' | 'relative_efficiency' | 'insufficient'

export interface TodayRead {
  kind: ReadKind
  /** One sentence, owner-facing. No enums, no jargon, no dollar-target verdicts. */
  headline: string
  evidence: string[]
}

/** Groups below this are too thin to compare on cost at all. */
const minSpendToCompare = () => SPEND_FLOORS.audienceCompare // account currency
const MIN_RESULTS_TO_COMPARE = 3
/** A live group must have spent this much with nothing to show before we call it out. */
const minLiveSpendToFlag = () => SPEND_FLOORS.audienceLiveNoResults

/**
 * The single strongest thing that is true about the account right now.
 *
 * Ordered by how little it depends on a model:
 *   1. Live money spent with zero results — arithmetic, no cost model, no attribution assumption.
 *   2. One group costing materially more than another on an identical basis.
 *   3. Nothing conclusive — said plainly, with what is still missing.
 */
export function buildTodayRead(audiences: readonly GroupPerformance[]): TodayRead {
  const money = (n: number) => `${formatMoney(n)}`
  const W = outcomeWords()
  const count = (n: number) => `${n} ${outcomeNoun({ count: n })}`

  const burning = audiences
    .filter((g) => g.parsed && g.liveSpend >= minLiveSpendToFlag() && g.liveResults === 0)
    .sort((a, b) => b.liveSpend - a.liveSpend)[0]

  const comparable = audiences
    .filter((g) => g.parsed && g.costPerResult !== null && g.spend >= minSpendToCompare() && g.results >= MIN_RESULTS_TO_COMPARE)
    .sort((a, b) => (a.costPerResult ?? 0) - (b.costPerResult ?? 0))
  const best = comparable[0]
  const worst = comparable[comparable.length - 1]

  if (burning) {
    const alt = best && best.key !== burning.key ? best : null
    return {
      kind: 'live_spend_no_results',
      headline: alt && alt.liveResults > 0 && alt.liveSpend > 0
        ? `${burning.audience} has spent ${money(burning.liveSpend)} on live ads with no ${W.many}. ${alt.audience} is at ${money(roundMoney(alt.liveSpend / alt.liveResults))} per ${W.one}.`
        : `${burning.audience} has spent ${money(burning.liveSpend)} on live ads with no ${W.many}.`,
      evidence: [
        `${burning.audience} lifetime ${burning.costPerResult === null ? `no ${W.many}` : `${money(burning.costPerResult)} per ${W.one}`}`,
        alt ? `${alt.audience} lifetime ${money(alt.costPerResult ?? 0)} per ${W.one}` : `${burning.liveAds} live ad${burning.liveAds === 1 ? '' : 's'}`,
        `${burning.liveAds} live ad${burning.liveAds === 1 ? '' : 's'} in ${burning.audience}`,
      ],
    }
  }

  if (best && worst && best.key !== worst.key && (worst.costPerResult ?? 0) >= (best.costPerResult ?? 0) * 1.5) {
    const multiple = ((worst.costPerResult ?? 0) / (best.costPerResult ?? 1)).toFixed(1)
    return {
      kind: 'relative_efficiency',
      headline: `${worst.audience} costs ${multiple}× what ${best.audience} costs per ${W.one} — ${money(worst.costPerResult ?? 0)} against ${money(best.costPerResult ?? 0)}.`,
      evidence: [
        `${worst.audience} ${money(worst.spend)} for ${count(worst.results)}`,
        `${best.audience} ${money(best.spend)} for ${count(best.results)}`,
        'Same Meta-modelled basis on both sides',
      ],
    }
  }

  const spent = roundMoney(audiences.reduce((sum, g) => sum + g.spend, 0))
  const got = audiences.reduce((sum, g) => sum + g.results, 0)
  return {
    kind: 'insufficient',
    headline: `No group has separated yet — ${money(spent)} across ${count(got)} is not enough to tell them apart.`,
    evidence: [`Comparison needs ${MIN_RESULTS_TO_COMPARE}+ ${W.many} and ${money(minSpendToCompare())}+ in a group`],
  }
}
