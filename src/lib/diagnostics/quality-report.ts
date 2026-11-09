import { roundMoney } from '@/lib/utils/format-currency'
import { getAdminClient } from '@/lib/supabase/admin'
import { aggregateMetrics, emptyMetrics, INSIGHT_METRIC_COLUMNS, type EntityMetrics } from '@/lib/metrics/aggregate'
import { computePacing } from '@/lib/insights/pacing'
import { rangeLengthDays } from '@/lib/insights/compare'
import { isRatedRanking, normalizeRanking, qualityVerdict, rollupTier, type RankingTier } from '@/lib/diagnostics/rankings'
import { computeDeliveryDiagnostic } from '@/lib/diagnostics/opportunity'
import { computeTrust } from '@/lib/trust/trust'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

// AUCTION-QUALITY + DELIVERY GATHERER — the body of /api/diagnostics/quality, extracted so the MCP
// tools (get_auction_diagnostics / get_diagnosis_bundle) can share it. The route keeps its Supabase
// auth gate and delegates here; this function requires exactly one active database account.
//
// Labeling rule for consumers: the per-ad rankings are META'S OWN relative tiers. The per-ad-set
// delivery diagnostic describes pacing, frequency, and ranking evidence only; it has no action authority.

type Row = Record<string, unknown>

export interface QualityReportArgs {
  from: string
  to: string
}

export class QualityReportUnavailableError extends Error {
  readonly code = 'QUALITY_REPORT_UNAVAILABLE'

  constructor(readonly reason: string) {
    super(`QUALITY_REPORT_UNAVAILABLE: ${reason}`)
    this.name = 'QualityReportUnavailableError'
  }
}

function requireHealthyRead(label: string, result: { error?: { message?: string } | null }): void {
  if (result.error) throw new QualityReportUnavailableError(`${label}_read_failed`)
}

export async function buildQualityReport({ from, to }: QualityReportArgs) {
  const days = rangeLengthDays(from, to)
  const db = getAdminClient()
  const resolution = await resolveOnlyActiveAccount(db)
  if (!resolution.ok) throw new QualityReportUnavailableError(activeAccountErrorCode(resolution.reason))
  const accountId = resolution.account.id

  const [adsRes, adsetsRes, adInsightsRes, adsetInsightsRes, accountRow] = await Promise.all([
    db.from('ads').select('id, ad_id, ad_name, adset_id').eq('ad_account_id', accountId),
    db.from('adsets').select('id, adset_id, adset_name, daily_budget').eq('ad_account_id', accountId),
    db.from('daily_insights').select('ad_id, date_start, spend, impressions, quality_ranking, engagement_rate_ranking, conversion_rate_ranking').eq('ad_account_id', accountId).eq('entity_level', 'ad').gte('date_start', from).lte('date_stop', to),
    db.from('daily_insights').select(`adset_id, ${INSIGHT_METRIC_COLUMNS}`).eq('ad_account_id', accountId).eq('entity_level', 'adset').gte('date_start', from).lte('date_stop', to),
    db.from('ad_accounts').select('last_synced_at').eq('id', accountId).maybeSingle(),
  ])

  requireHealthyRead('ads', adsRes)
  requireHealthyRead('adsets', adsetsRes)
  requireHealthyRead('ad_insights', adInsightsRes)
  requireHealthyRead('adset_insights', adsetInsightsRes)
  requireHealthyRead('account_freshness', accountRow)
  if (!accountRow.data) throw new QualityReportUnavailableError('account_freshness_missing')
  const adInsightRows = (adInsightsRes.data ?? []) as Row[]
  const adsetInsightRows = (adsetInsightsRes.data ?? []) as Row[]
  if (adInsightRows.length === 0 && adsetInsightRows.length === 0) throw new QualityReportUnavailableError('quality_window_missing')

  const adName = new Map<string, string>()
  const adToAdset = new Map<string, string>()
  for (const a of (adsRes.data ?? []) as Row[]) {
    adName.set(a.id as string, (a.ad_name as string) ?? (a.ad_id as string) ?? 'Unknown')
    if (a.adset_id) adToAdset.set(a.id as string, a.adset_id as string)
  }

  const dataAgeHours = accountRow.data && (accountRow.data as { last_synced_at?: string }).last_synced_at
    ? (Date.now() - Date.parse((accountRow.data as { last_synced_at: string }).last_synced_at)) / 3_600_000
    : null

  // ── Per-ad rankings: keep the latest row per ad, plus window spend/impressions ──
  interface AdAcc { latestDate: string; quality: string | null; engagement: string | null; conversion: string | null; spend: number; impressions: number }
  const adAcc = new Map<string, AdAcc>()
  for (const r of adInsightRows) {
    const id = r.ad_id as string
    if (!id) continue
    const cur = adAcc.get(id) ?? { latestDate: '', quality: null, engagement: null, conversion: null, spend: 0, impressions: 0 }
    cur.spend += Number(r.spend ?? 0)
    cur.impressions += Number(r.impressions ?? 0)
    const d = String(r.date_start ?? '')
    // Take rankings from the most recent row that actually has them (they're point-in-time).
    if (isRatedRanking(r.quality_ranking as string | null) && d >= cur.latestDate) {
      cur.latestDate = d
      cur.quality = r.quality_ranking as string
      cur.engagement = (r.engagement_rate_ranking as string) ?? null
      cur.conversion = (r.conversion_rate_ranking as string) ?? null
    }
    adAcc.set(id, cur)
  }

  const ads = [...adAcc.entries()]
    .filter(([, a]) => a.spend > 0 || a.quality != null)
    .map(([id, a]) => ({
      ad_id: id,
      ad_name: adName.get(id) ?? 'Unknown',
      spend: roundMoney(a.spend),
      impressions: a.impressions,
      quality_ranking: a.quality,
      engagement_rate_ranking: a.engagement,
      conversion_rate_ranking: a.conversion,
      verdict: qualityVerdict({ quality: a.quality, engagement: a.engagement, conversion: a.conversion }),
    }))
    .sort((x, y) => y.spend - x.spend)

  const ratedAds = ads.filter((a) => isRatedRanking(a.quality_ranking)).length

  // Quality tier per ad set (rolled up from its ads).
  const adsetTier = new Map<string, RankingTier>()
  const adsetTiers = new Map<string, RankingTier[]>()
  for (const a of ads) {
    const adsetDbId = adToAdset.get(a.ad_id)
    if (!adsetDbId || !isRatedRanking(a.quality_ranking)) continue
    if (!adsetTiers.has(adsetDbId)) adsetTiers.set(adsetDbId, [])
    adsetTiers.get(adsetDbId)!.push(normalizeRanking(a.quality_ranking))
  }
  for (const [id, tiers] of adsetTiers) adsetTier.set(id, rollupTier(tiers))

  // ── Ad-set auction/delivery evidence ──
  const rowsByAdset = new Map<string, Row[]>()
  for (const r of adsetInsightRows) {
    const id = r.adset_id as string
    if (!id) continue
    if (!rowsByAdset.has(id)) rowsByAdset.set(id, [])
    rowsByAdset.get(id)!.push(r)
  }

  const adsets = ((adsetsRes.data ?? []) as Row[])
    .map((a) => {
      const id = a.id as string
      const rows = rowsByAdset.get(id)
      const m: EntityMetrics = rows ? aggregateMetrics(rows) : emptyMetrics()
      if (m.spend <= 0) return null
      const daysDelivering = (rows ?? []).filter((r) => Number(r.spend ?? 0) > 0).length
      const pacing = computePacing(m.spend, a.daily_budget as number | null, days, daysDelivering)
      const trust = computeTrust({ spend: m.spend, clicks: m.clicks, impressions: m.impressions, windowDays: days, dataAgeHours, revenueClaim: false, dataSourcesCount: 1 })
      const deliveryDiagnostic = computeDeliveryDiagnostic({
        frequency: m.frequency,
        pacing: { status: pacing.status === 'none' ? null : pacing.status, pct: pacing.status === 'none' ? null : pacing.pct },
        qualityTier: adsetTier.get(id),
        trust,
      })
      return {
        adset_id: a.adset_id,
        adset_name: (a.adset_name as string) ?? (a.adset_id as string),
        spend: roundMoney(m.spend),
        delivery_diagnostic: deliveryDiagnostic,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((x, y) => y.spend - x.spend)

  return {
    window: { from, to, days },
    ads,
    adsets,
    coverage: { total_ads_with_spend: ads.length, rated_ads: ratedAds },
    data_age_hours: dataAgeHours,
  }
}
