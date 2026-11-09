import { roundMoney } from '@/lib/utils/format-currency'
// CREATIVE FORMAT MIX — the "your ads are all one format" check Meta's chat narrates (its own
// creative-diversity tool can fail). Pure classification over synced creative rows:
// creatives.asset_type comes from Meta's object_type (VIDEO / PHOTO / SHARE / CAROUSEL...), with
// video_id as the reliable video signal when object_type is a generic SHARE.

export type CreativeFormat = 'video' | 'static' | 'carousel' | 'unknown'

export interface FormatMixInput {
  asset_type: string | null
  video_id: string | null
  spend: number
}

export interface FormatShare {
  format: CreativeFormat
  count: number
  spend: number
  count_share: number // 0..1
  spend_share: number // 0..1
}

export interface FormatMix {
  total_creatives: number
  total_spend: number
  shares: FormatShare[]
  /** Fires when ≥2 creatives all share ONE known format — the diversification conversation-starter.
   *  A single-creative account is "too small to judge", not a warning. */
  single_format_warning: string | null
}

export function classifyFormat(row: { asset_type: string | null; video_id: string | null }): CreativeFormat {
  if (row.video_id) return 'video'
  const t = (row.asset_type ?? '').toUpperCase()
  if (t.includes('VIDEO')) return 'video'
  if (t.includes('CAROUSEL')) return 'carousel'
  if (t === 'PHOTO' || t === 'IMAGE') return 'static'
  return 'unknown'
}

/** PURE: format shares by creative count and by spend, plus the single-format warning. */
export function computeFormatMix(rows: FormatMixInput[]): FormatMix {
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0)
  const byFormat = new Map<CreativeFormat, { count: number; spend: number }>()
  for (const r of rows) {
    const f = classifyFormat(r)
    const cur = byFormat.get(f) ?? { count: 0, spend: 0 }
    cur.count += 1
    cur.spend += r.spend
    byFormat.set(f, cur)
  }

  const shares: FormatShare[] = [...byFormat.entries()]
    .map(([format, v]) => ({
      format,
      count: v.count,
      spend: roundMoney(v.spend),
      count_share: rows.length > 0 ? Math.round((v.count / rows.length) * 1000) / 1000 : 0,
      spend_share: totalSpend > 0 ? Math.round((v.spend / totalSpend) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.count - a.count)

  const known = shares.filter((s) => s.format !== 'unknown')
  let single_format_warning: string | null = null
  if (rows.length >= 2 && known.length === 1 && known[0].count === rows.length) {
    single_format_warning = `All ${rows.length} creatives are ${known[0].format}-format — no format diversity. Meta's delivery system matches formats to placement/user preference, so a single-format account leaves cheaper auctions untested. Worth ONE labeled format test (e.g. a static/carousel variant of the proven concept), not a fleet.`
  }

  return {
    total_creatives: rows.length,
    total_spend: roundMoney(totalSpend),
    shares,
    single_format_warning,
  }
}
