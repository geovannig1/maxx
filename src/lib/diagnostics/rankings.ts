// Interpreting Meta's auction quality rankings. Meta returns three RELATIVE tiers per ad (vs the ads
// competing for the same audience): quality, engagement-rate, and conversion-rate ranking. Each comes
// back as 'above_average' | 'average' | 'below_average_10/20/35' | 'unknown' (or null on thin ads).
// We collapse the below_average_* gradations to one tier for display but keep the raw string.

export type RankingTier = 'above_average' | 'average' | 'below_average' | 'unknown'

export interface RankingInfo {
  tier: RankingTier
  label: string
  tone: 'good' | 'neutral' | 'bad'
  raw: string | null
}

export function normalizeRanking(raw: string | null | undefined): RankingTier {
  if (!raw) return 'unknown'
  const v = raw.toLowerCase().trim()
  if (v === 'above_average') return 'above_average'
  if (v.startsWith('below_average')) return 'below_average'
  if (v === 'average') return 'average'
  return 'unknown'
}

export function isRatedRanking(raw: string | null | undefined): boolean {
  return normalizeRanking(raw) !== 'unknown'
}

export function rankingInfo(raw: string | null | undefined): RankingInfo {
  const tier = normalizeRanking(raw)
  const label = tier === 'above_average' ? 'Above average' : tier === 'average' ? 'Average' : tier === 'below_average' ? 'Below average' : 'Not rated'
  const tone = tier === 'above_average' ? 'good' : tier === 'below_average' ? 'bad' : 'neutral'
  return { tier, label, tone, raw: raw ?? null }
}

/** Worst-first rollup of an ad set's ad rankings into one tier. */
export function rollupTier(tiers: RankingTier[]): RankingTier {
  if (tiers.some((t) => t === 'below_average')) return 'below_average'
  if (tiers.some((t) => t === 'above_average')) return 'above_average'
  if (tiers.some((t) => t === 'average')) return 'average'
  return 'unknown'
}

export type QualityVerdict = 'strong' | 'ok' | 'weak' | 'unrated'

/** A one-word read across the three rankings for an ad. */
export function qualityVerdict(input: { quality?: string | null; engagement?: string | null; conversion?: string | null }): QualityVerdict {
  const tiers = [normalizeRanking(input.quality), normalizeRanking(input.engagement), normalizeRanking(input.conversion)]
  const rated = tiers.filter((t) => t !== 'unknown')
  if (rated.length === 0) return 'unrated'
  const below = rated.filter((t) => t === 'below_average').length
  const above = rated.filter((t) => t === 'above_average').length
  if (below >= 1) return below >= 2 ? 'weak' : 'ok'
  if (above >= 1) return 'strong'
  return 'ok'
}
