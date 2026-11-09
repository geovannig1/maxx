import { getAdminClient } from '@/lib/supabase/admin'
import { getTargetRange } from '@/lib/targets/target-ranges'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { SPEND_FLOORS } from '@/config/spend-floors'

export type TrendDirection = 'worsening' | 'improving' | 'flat'

export interface TrajectoryResult {
  entity_id: string
  entity_level: 'campaign' | 'adset' | 'ad'
  meta_entity_id: string
  current_cpa: number | null
  projected_cpa_3d: number | null
  projected_cpa_7d: number | null
  trend_direction: TrendDirection
  days_until_breach: number | null
  confidence: 'low' | 'medium' | 'high'
  data_points: number
}

// The owner's maximum acceptable CPA (override-aware); null until a CPA target is set.
const maxAcceptableCpa = () => getTargetRange('cpa').watch

interface DailyMetric {
  date: string
  spend: number
  bookings: number
}

interface ValidPoint {
  x: number // calendar-day offset from the first valid day
  cpa: number
}

// Don't extrapolate a breach estimate beyond ~the observed data horizon — far extrapolation
// of a linear fit is statistically unreliable.
const MAX_BREACH_HORIZON_DAYS = 30

interface TrajectoryCalcResult {
  current_cpa: number | null
  projected_cpa_3d: number | null
  projected_cpa_7d: number | null
  trend_direction: TrendDirection
  days_until_breach: number | null
  confidence: 'low' | 'medium' | 'high'
  data_points: number
}

export function calculateTrajectory(dailyMetrics: DailyMetric[]): TrajectoryCalcResult {
  // Keep only days with real spend AND a booking (a finite CPA), in date order.
  const sorted = dailyMetrics
    .filter((d) => d.spend > 0 && d.bookings > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))

  const n = sorted.length

  if (n < 3) {
    const lastValid = n > 0 ? sorted[n - 1].spend / sorted[n - 1].bookings : null
    return {
      current_cpa: lastValid,
      projected_cpa_3d: null,
      projected_cpa_7d: null,
      trend_direction: 'flat',
      days_until_breach: null,
      confidence: 'low',
      data_points: n,
    }
  }

  // x = calendar-day offset from the first valid day (NOT array index). Booking-days are
  // non-contiguous, so an index axis silently compresses time; using real days makes the
  // slope "CPA change per day" and the day-based projections/breach estimate correct.
  const day0 = Date.parse(sorted[0].date + 'T00:00:00Z')
  const points: ValidPoint[] = sorted.map((d) => ({
    x: Math.round((Date.parse(d.date + 'T00:00:00Z') - day0) / 86_400_000),
    cpa: d.spend / d.bookings,
  }))

  // Ordinary least-squares: cpa ≈ m·x + b, using centered sums.
  const meanX = points.reduce((a, p) => a + p.x, 0) / n
  const meanY = points.reduce((a, p) => a + p.cpa, 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of points) {
    sxx += (p.x - meanX) ** 2
    sxy += (p.x - meanX) * (p.cpa - meanY)
    syy += (p.cpa - meanY) ** 2
  }
  const m = sxx === 0 ? 0 : sxy / sxx
  const b = meanY - m * meanX
  // R² (coefficient of determination): fraction of CPA variance the trend explains.
  const r2 = sxx === 0 || syy === 0 ? 0 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)))

  const lastX = points[n - 1].x
  const current_cpa = points[n - 1].cpa
  const projected_cpa_3d = Math.max(0, m * (lastX + 3) + b)
  const projected_cpa_7d = Math.max(0, m * (lastX + 7) + b)

  // A direction must be both material (≥2%/day of mean CPA, and at least SPEND_FLOORS'
  // materialCpaSlopePerDay in the account currency: 1/day at the default) and an adequate
  // fit (R² ≥ 0.5); otherwise the slope is noise → flat.
  const materialSlope = Math.max(SPEND_FLOORS.materialCpaSlopePerDay, 0.02 * meanY)
  let trend_direction: TrendDirection = 'flat'
  if (r2 >= 0.5 && Math.abs(m) >= materialSlope) {
    trend_direction = m > 0 ? 'worsening' : 'improving'
  }

  // Calendar days until CPA crosses the ceiling — only when genuinely worsening and within a
  // sane horizon (extrapolating a linear fit far past the data is unreliable).
  // No ceiling is set without an owner CPA target, so there is nothing to breach.
  let days_until_breach: number | null = null
  const ceiling = maxAcceptableCpa()
  if (ceiling !== null && trend_direction === 'worsening' && m > 0 && current_cpa < ceiling) {
    const days = (ceiling - current_cpa) / m
    if (days >= 0 && days <= MAX_BREACH_HORIZON_DAYS) days_until_breach = days
  }

  // Confidence requires both sample size and fit quality.
  let confidence: 'low' | 'medium' | 'high' = 'low'
  if (n >= 7 && r2 >= 0.7) confidence = 'high'
  else if (n >= 5 && r2 >= 0.5) confidence = 'medium'

  return {
    current_cpa,
    projected_cpa_3d,
    projected_cpa_7d,
    trend_direction,
    days_until_breach,
    confidence,
    data_points: n,
  }
}

interface RawInsightRow {
  adset_id: string | null
  meta_adset_id: string | null
  date_start: string
  spend: number | null
  bookings: number | null
}

interface AdsetRow {
  id: string
  adset_id: string | null
}

export async function runTrajectoriesForAccount(adAccountDbId: string): Promise<TrajectoryResult[]> {
  const supabase = getAdminClient()

  // Build date 14 days ago (account timezone)
  const cutoffStr = nyDaysAgo(14)

  // Query daily_insights for adset-level rows
  const { data: insightsRaw, error: insightsErr } = await supabase
    .from('daily_insights')
    .select('adset_id, meta_adset_id, date_start, spend, bookings')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'adset')
    .gte('date_start', cutoffStr)
    .not('adset_id', 'is', null)

  if (insightsErr) {
    throw new Error(`runTrajectoriesForAccount: insights query failed: ${insightsErr.message}`)
  }

  const insights = (insightsRaw ?? []) as RawInsightRow[]

  // Group rows by adset_id
  const byAdset = new Map<string, RawInsightRow[]>()
  for (const row of insights) {
    if (!row.adset_id) continue
    const existing = byAdset.get(row.adset_id) ?? []
    existing.push(row)
    byAdset.set(row.adset_id, existing)
  }

  if (byAdset.size === 0) return []

  // Query adsets table to get the stored Meta ad set id for the internal DB id.
  const adsetIds = Array.from(byAdset.keys())
  const { data: adsetsRaw, error: adsetsErr } = await supabase
    .from('adsets')
    .select('id, adset_id')
    .in('id', adsetIds)

  if (adsetsErr) {
    throw new Error(`runTrajectoriesForAccount: adsets query failed: ${adsetsErr.message}`)
  }

  const adsets = (adsetsRaw ?? []) as AdsetRow[]
  const adsetMap = new Map<string, AdsetRow>()
  for (const a of adsets) {
    adsetMap.set(a.id, a)
  }

  const results: TrajectoryResult[] = []

  for (const [adsetDbId, rows] of byAdset.entries()) {
    // Skip adsets with fewer than 3 days of data
    if (rows.length < 3) continue

    const adsetInfo = adsetMap.get(adsetDbId)
    if (!adsetInfo || !adsetInfo.adset_id) continue

    const dailyMetrics: DailyMetric[] = rows.map((r) => ({
      date: r.date_start,
      spend: Number(r.spend ?? 0),
      bookings: Number(r.bookings ?? 0),
    }))

    const calc = calculateTrajectory(dailyMetrics)

    // Skip if trajectory couldn't produce enough data points
    if (calc.data_points < 3) continue

    results.push({
      entity_id: adsetDbId,
      entity_level: 'adset',
      meta_entity_id: adsetInfo.adset_id,
      current_cpa: calc.current_cpa,
      projected_cpa_3d: calc.projected_cpa_3d,
      projected_cpa_7d: calc.projected_cpa_7d,
      trend_direction: calc.trend_direction,
      days_until_breach: calc.days_until_breach,
      confidence: calc.confidence,
      data_points: calc.data_points,
    })
  }

  return results
}
