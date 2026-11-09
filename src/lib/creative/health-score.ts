import { classifyVideoLength, type VideoLengthClass } from './video-metrics'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { getTargetRange, hasTarget } from '@/lib/targets/target-ranges'
import { formatMoneyAmount } from '@/lib/utils/format-currency'
import { SPEND_FLOORS } from '@/config/spend-floors'

// Min-data gate: below this delivery the grade is provisional — the result says so via
// `dataSufficient` instead of implying certainty on a near-empty entity.
const MIN_IMPRESSIONS_FOR_HEALTH = 500
const minSpendForHealth = () => SPEND_FLOORS.judge // account currency
const HEALTH_WINDOW_DAYS = 7

export interface HealthScoreInput {
  spend: number
  bookings: number
  ctr: number | null
  cpa: number | null
  /** Exact single-day or native-scope frequency only. Multi-day daily-row rollups must pass null. */
  frequency: number | null
  impressions: number
  entity_age_days: number
  /** Retention at the 25% milestone, as a FRACTION. NOT a three-second hook. */
  hook_rate: number | null
  /** Creative length. NULL is first-class: an unknown length scores neutral instead of being judged
   *  against a guessed ladder. */
  video_duration_seconds?: number | null
}

/**
 * Length-aware retention bands as FRACTIONS: [excellent, good, fair, weak].
 * Reaching the 25% milestone of a 125-second video is a far higher bar than 25% of a 15-second one,
 * so the same raw rate must not earn the same score. 'unknown' is null on purpose — no ladder is
 * applied to a creative whose length we do not know.
 */
const RETENTION_BANDS: Record<VideoLengthClass, [number, number, number, number] | null> = {
  short: [0.45, 0.30, 0.20, 0.10],
  medium: [0.30, 0.20, 0.12, 0.06],
  long: [0.18, 0.12, 0.07, 0.03],
  unknown: null,
}

export interface HealthScoreResult {
  score: number | null
  grade: 'unavailable' | 'critical' | 'attention' | 'healthy' | 'excellent'
  color: string
  breakdown: {
    cpa_score: number
    ctr_score: number
    frequency_score: number | null
    freshness_score: number
    /** RENAMED from hook_score: this is LENGTH-AWARE p25 RETENTION, never a three-second hook. */
    retention_score: number
  }
  signal: string
  /** False when delivery is too thin (impressions/spend/age) to trust the grade. */
  dataSufficient: boolean
}

interface HealthFrequencyRow {
  frequency?: unknown
  [column: string]: unknown
}

interface HealthFrequencyScope {
  requestedWindowDays: number
}

/**
 * Daily reach is non-additive, so several daily rows cannot reconstruct Meta's deduplicated
 * selected-period reach or frequency. A stored daily frequency is scope-compatible only when the
 * caller explicitly requested one day and received exactly one row. Row count never shrinks the
 * requested scope: one sparse row from a seven-day request is still a seven-day request.
 */
export function frequencyForHealthWindow(
  rows: readonly HealthFrequencyRow[],
  scope: HealthFrequencyScope,
): number | null {
  if (scope.requestedWindowDays !== 1 || rows.length !== 1) return null
  const raw = rows[0]?.frequency
  if (raw === null || raw === undefined || raw === '') return null
  const frequency = Number(raw)
  return Number.isFinite(frequency) && frequency > 0 ? frequency : null
}

export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  // Derive band breakpoints from the override-aware target RANGES instead of hard-coded scalars.
  // With the DEFAULT ranges these breakpoints equal the previous constants exactly (excellent/healthy/
  // watch edges + their midpoints), so default-config scores are unchanged; an owner who edits the
  // Performance Targets now re-bands health scores too — no more parallel hard-coded ladder.
  const cpaR = getTargetRange('cpa') // lower_is_better
  const ctrR = getTargetRange('ctr') // higher_is_better
  const freqR = getTargetRange('frequency') // lower_is_better

  // CPA score (30pts)
  // No owner CPA target scores the same neutral 15 as an unknown CPA: there is nothing to judge against.
  let cpa_score: number
  if (input.cpa === null || !hasTarget(cpaR)) {
    cpa_score = 15
  } else if (cpaR.excellent !== null && input.cpa <= cpaR.excellent) {
    cpa_score = 30
  } else if (input.cpa <= cpaR.healthy) {
    cpa_score = 24
  } else if (input.cpa <= (cpaR.healthy + cpaR.watch) / 2) {
    cpa_score = 15
  } else if (input.cpa <= cpaR.watch) {
    cpa_score = 7
  } else {
    cpa_score = 0
  }

  // CTR score (25pts)
  let ctr_score: number
  if (input.ctr === null) {
    ctr_score = 12
  } else if (input.ctr >= ctrR.excellent) {
    ctr_score = 25
  } else if (input.ctr >= (ctrR.excellent + ctrR.healthy) / 2) {
    ctr_score = 20
  } else if (input.ctr >= ctrR.healthy) {
    ctr_score = 15
  } else if (input.ctr >= ctrR.watch) {
    ctr_score = 7
  } else {
    ctr_score = 0
  }

  // Frequency score (20pts)
  let frequency_score: number | null
  if (input.frequency === null) {
    // Frequency is required for this composite. Missing scope authority withholds the whole grade;
    // it must never be converted into invented neutral or passing points.
    frequency_score = null
  } else if (input.frequency <= freqR.excellent) {
    frequency_score = 20
  } else if (input.frequency <= (freqR.excellent + freqR.healthy) / 2) {
    frequency_score = 16
  } else if (input.frequency <= freqR.healthy) {
    frequency_score = 11
  } else if (input.frequency <= (freqR.healthy + freqR.watch) / 2) {
    frequency_score = 5
  } else if (input.frequency <= freqR.watch) {
    frequency_score = 1
  } else {
    frequency_score = 0
  }

  // Freshness score (15pts, based on entity_age_days)
  let freshness_score: number
  if (input.entity_age_days <= 7) {
    freshness_score = 15
  } else if (input.entity_age_days <= 14) {
    freshness_score = 15
  } else if (input.entity_age_days <= 21) {
    freshness_score = 11
  } else if (input.entity_age_days <= 30) {
    freshness_score = 6
  } else {
    freshness_score = 2
  }

  // RETENTION score (10pts) — LENGTH-AWARE.
  // This used to be a "hook score" fed total_p25 / total_impressions. p25 is 25% OF THE VIDEO LENGTH,
  // so on a 125s creative it represented ~31 seconds of watch time, and the same raw rate meant
  // something entirely different on a 15s creative. The band ladder is now selected by video length,
  // and an UNKNOWN length scores the neutral 5 rather than being judged on a guessed ladder.
  // NOTE unit trap: hook_rate here is a FRACTION (~0.05-0.20), not a percent.
  const lengthClass = classifyVideoLength(input.video_duration_seconds ?? null)
  const bands = RETENTION_BANDS[lengthClass]
  let hook_score: number
  if (input.hook_rate === null || bands === null) {
    // No retention signal, or no known length to judge it against -> neutral, never invented.
    hook_score = 5
  } else if (input.hook_rate >= bands[0]) {
    hook_score = 10
  } else if (input.hook_rate >= bands[1]) {
    hook_score = 8
  } else if (input.hook_rate >= bands[2]) {
    hook_score = 6
  } else if (input.hook_rate >= bands[3]) {
    hook_score = 3
  } else {
    hook_score = 0
  }

  if (frequency_score === null) {
    return {
      score: null,
      grade: 'unavailable',
      color: 'var(--text-tertiary)',
      breakdown: {
        cpa_score,
        ctr_score,
        frequency_score: null,
        freshness_score,
        retention_score: hook_score,
      },
      signal: 'Health grade withheld — required frequency is unavailable for this requested scope. Daily warehouse rows cannot reconstruct native period frequency.',
      dataSufficient: false,
    }
  }

  const score = Math.min(cpa_score + ctr_score + frequency_score + freshness_score + hook_score, 100)

  let grade: HealthScoreResult['grade']
  let color: string
  if (score >= 86) {
    grade = 'excellent'
    color = 'var(--success)'
  } else if (score >= 66) {
    grade = 'healthy'
    color = 'var(--accent)'
  } else if (score >= 41) {
    grade = 'attention'
    color = 'var(--warning)'
  } else {
    grade = 'critical'
    color = 'var(--danger)'
  }

  let signal: string
  if (grade === 'excellent') {
    signal = 'Top performer — CPA well below target, strong engagement.'
  } else if (grade === 'healthy') {
    signal = 'Performing well — continue monitoring delivery and response.'
  } else if (grade === 'critical') {
    signal = 'Underperforming — review immediately before more budget is spent.'
  } else {
    // attention: find lowest scoring component
    const components = [
      { key: 'cpa', score: cpa_score },
      { key: 'ctr', score: ctr_score },
      { key: 'frequency', score: frequency_score },
      { key: 'freshness', score: freshness_score },
    ]
    const lowest = components.reduce((a, b) => (a.score <= b.score ? a : b))
    if (lowest.key === 'cpa') {
      signal = 'CPA above target — check landing page and audience match.'
    } else if (lowest.key === 'ctr') {
      signal = 'CTR is weak — the hook may not be stopping the scroll.'
    } else if (lowest.key === 'frequency') {
      signal = 'High daily frequency observed — review delivery context; no cause can be established from this metric alone.'
    } else {
      signal = 'Ad is aging past peak window — plan a creative refresh.'
    }
  }

  // Is there enough delivery to TRUST this grade? If not, say so up front instead of implying it.
  const dataSufficient =
    input.impressions >= MIN_IMPRESSIONS_FOR_HEALTH && input.spend >= minSpendForHealth() && input.entity_age_days >= 1
  const finalSignal = dataSufficient
    ? signal
    : `Limited data — grade is provisional until this ad delivers more (needs ≥ ${MIN_IMPRESSIONS_FOR_HEALTH} impressions and ≥ ${formatMoneyAmount(minSpendForHealth())} spend). ${signal}`

  return {
    score,
    grade,
    color,
    breakdown: {
      cpa_score,
      ctr_score,
      frequency_score,
      freshness_score,
      retention_score: hook_score,
    },
    signal: finalSignal,
    dataSufficient,
  }
}

export async function runHealthScoresForAccount(adAccountDbId: string): Promise<number> {
  const db = getAdminClient()

  const { data: ads, error: adsError } = await db
    .from('ads')
    .select('id, ad_id, created_at, effective_status')
    .eq('ad_account_id', adAccountDbId)
    .in('effective_status', ['ACTIVE', 'PAUSED'])

  if (adsError) throw new Error(`Failed to fetch ads: ${adsError.message}`)
  if (!ads || ads.length === 0) return 0

  // Video length per ad, for length-aware retention scoring. A missing duration stays NULL and the
  // retention band is skipped entirely (neutral score) rather than judged on an assumed length.
  const durationById = new Map<string, number | null>()
  const { data: creativeRows } = await db
    .from('creatives')
    .select('ad_id, video_duration_seconds')
    .eq('ad_account_id', adAccountDbId)
  for (const c of (creativeRows ?? []) as Array<{ ad_id: string | null; video_duration_seconds: number | null }>) {
    if (c.ad_id) durationById.set(c.ad_id, c.video_duration_seconds ?? null)
  }

  const sevenDaysAgoStr = nyDaysAgo(HEALTH_WINDOW_DAYS)

  let scoredCount = 0

  for (const ad of ads as Array<{ id: string; ad_id: string; created_at: string; effective_status: string }>) {
    const { data: insights } = await db
      .from('daily_insights')
      .select('spend, bookings, impressions, clicks, frequency, video_p25_watched, video_plays')
      .eq('ad_id', ad.id)
      .eq('entity_level', 'ad')
      .gte('date_start', sevenDaysAgoStr)

    let total_spend = 0
    let total_bookings = 0
    let total_impressions = 0
    let total_clicks = 0
    let total_p25 = 0
    let total_plays: number | null = null

    for (const row of insights ?? []) {
      total_spend += Number(row.spend ?? 0)
      total_bookings += Number(row.bookings ?? 0)
      total_impressions += Number(row.impressions ?? 0)
      total_clicks += Number(row.clicks ?? 0)
      total_p25 += Number(row.video_p25_watched ?? 0)
      if (row.video_plays != null) total_plays = (total_plays ?? 0) + Number(row.video_plays)
    }

    // Recompute rate metrics from summed totals, never average daily rates.
    const avg_ctr = total_impressions > 0 ? (total_clicks / total_impressions) * 100 : null
    // Frequency is not recomputable from daily reach. The requested scope is seven days even when
    // sparse delivery returns only one row, so this daily-row reader always fails closed until a
    // native period-frequency source is added.
    const frequency = frequencyForHealthWindow(insights ?? [], {
      requestedWindowDays: HEALTH_WINDOW_DAYS,
    })
    const cpa = total_bookings > 0 ? total_spend / total_bookings : null
    // RETENTION at the 25% milestone, as a FRACTION. Denominator is video STARTS when known — the
    // share-of-plays question — falling back to impressions only when starts were never returned.
    // Null for non-video ads, which scores the neutral 5 by design. This is NOT a 3-second hook.
    const retentionDenominator = total_plays !== null && total_plays > 0 ? total_plays : total_impressions
    const hook_rate = total_p25 > 0 && retentionDenominator > 0 ? total_p25 / retentionDenominator : null

    const createdAt = new Date(ad.created_at)
    const now = new Date()
    const entity_age_days = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24))

    const result = computeHealthScore({
      spend: total_spend,
      bookings: total_bookings,
      ctr: avg_ctr,
      cpa,
      frequency,
      impressions: total_impressions,
      entity_age_days,
      hook_rate,
      video_duration_seconds: durationById.get(ad.id) ?? null,
    })

    await db
      .from('ads')
      .update({
        health_score: result.score,
        health_score_computed_at: new Date().toISOString(),
      })
      .eq('id', ad.id)

    scoredCount++
  }

  return scoredCount
}
