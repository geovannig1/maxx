import { roundMoney } from '@/lib/utils/format-currency'
import type { getAdminClient } from '@/lib/supabase/admin'
import type {
  ModelledDirectionalEvidence,
  ModelledPerformanceWindow,
  ModelledSourceGeneration,
} from '@/lib/authority/directional-policy'

/**
 * META-MODELLED PERFORMANCE READER
 *
 * Builds the two non-overlapping windows the modelled money direction requires, per entity, from
 * `daily_insights`. `spend` and `frequency` are what Meta billed and served; `bookings` is Meta's
 * own MODELLED result count (it includes view-through and modelled conversions). The two are never
 * blended into a single "contribution" number — that separation is the whole point of keeping this
 * out of ContributionWindowEvidence.
 *
 * Why this exists: the deterministic planes cannot answer money questions at a small account's volume.
 * Only a minority of bookings carry any paid signal, fewer still link, and the capture numerator can
 * be duplicate-inflated, so governance alone can produce no money recommendations for months. A
 * labeled estimate the owner can act on beats silence that reads as a measured zero.
 */

export const MODELLED_WINDOW_DAYS = 14

export type ModelledEntityLevel = 'ad' | 'adset' | 'campaign'

function isoDaysBefore(anchor: string, days: number): string {
  const d = new Date(`${anchor}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN
  return Number.isFinite(n) ? n : 0
}

interface InsightRow {
  date_start: string
  spend: unknown
  bookings: unknown
  frequency: unknown
  synced_at: string | null
}

interface SyncGenerationRow {
  id: string
  status: string
  date_range_start: string | null
  date_range_end: string | null
  started_at: string | null
  completed_at: string | null
}

function inclusiveDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)
  const days = Math.floor(ms / 86_400_000) + 1
  return Number.isFinite(days) && days > 0 ? days : 0
}

function foldWindow(
  rows: InsightRow[],
  start: string,
  end: string,
): ModelledPerformanceWindow | null {
  const inWindow = rows.filter((r) => r.date_start >= start && r.date_start <= end)
  if (inWindow.length === 0) return null
  const spend = inWindow.reduce((t, r) => t + num(r.spend), 0)
  const modelledBookings = Math.round(inWindow.reduce((t, r) => t + num(r.bookings), 0))
  const latestSyncedAt = inWindow
    .map((r) => typeof r.synced_at === 'string' ? r.synced_at : null)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1) ?? null
  const earliestSyncedAt = inWindow
    .map((r) => typeof r.synced_at === 'string' ? r.synced_at : null)
    .filter((v): v is string => v !== null)
    .sort()
    .at(0) ?? null
  // Frequency is a ratio, not a sum, so the daily readings are not added. Keep the peak as a correctly
  // labelled daily diagnostic only. Daily reach and whole-window reach have different deduplication
  // scopes, so peak-daily and window frequency do not bound one another. Only native whole-window
  // frequency may be judged against the window fatigue band; see `windowFrequency` below.
  const freqs = inWindow.map((r) => num(r.frequency)).filter((f) => f > 0)
  return {
    windowStart: start,
    windowEnd: end,
    source: 'daily_insights',
    observedDays: new Set(inWindow.map((r) => r.date_start)).size,
    expectedDays: inclusiveDays(start, end),
    earliestSyncedAt,
    latestSyncedAt,
    spend,
    modelledBookings,
    modelledCpa: modelledBookings > 0 && spend > 0
      ? roundMoney((spend / modelledBookings))
      : null,
    peakDailyFrequency: freqs.length ? Math.max(...freqs) : null,
    // Not derivable here. `daily_insights.reach` is deduplicated within a day only, so summing it
    // overcounts the window's reach and taking the max undercounts it, and the true window value can
    // sit far from either bound. Meta's window-level
    // reach is the only honest source, and `fetchNativePeriodDelivery` already reads it for the
    // cockpit; wiring that into generation is what fills this in. Until then the scale rule refuses
    // rather than clearing on a reading that cannot establish what it is asked to establish.
    windowFrequency: null,
  }
}

/**
 * The two non-overlapping windows the modelled basis compares, derived from the as-of date alone —
 * they do not depend on the entity, so a caller that needs the WINDOWS (rather than an entity's rows)
 * can resolve them without a read. Exported so structural continuity is proven over exactly the
 * periods the direction rules judge; deriving them twice is how the two silently drift apart.
 */
export function modelledWindowBounds(asOfDate: string): {
  recentStart: string; recentEnd: string; priorStart: string; priorEnd: string
} {
  const recentEnd = isoDaysBefore(asOfDate, 1)
  const recentStart = isoDaysBefore(recentEnd, MODELLED_WINDOW_DAYS - 1)
  const priorEnd = isoDaysBefore(recentStart, 1)
  const priorStart = isoDaysBefore(priorEnd, MODELLED_WINDOW_DAYS - 1)
  return { recentStart, recentEnd, priorStart, priorEnd }
}

/**
 * Read both windows for one entity. `asOfDate` is the cohort as-of; the recent window ends the day
 * before it (matching the paid-cohort convention that a window closes on completed account days).
 */
export async function readModelledPerformance(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  entityLevel: ModelledEntityLevel,
  metaEntityId: string,
  asOfDate: string,
): Promise<{
  recent: ModelledPerformanceWindow | null
  prior: ModelledPerformanceWindow | null
  sourceGeneration: ModelledSourceGeneration | null
}> {
  const { recentStart, recentEnd, priorStart, priorEnd } = modelledWindowBounds(asOfDate)

  const column = entityLevel === 'ad' ? 'meta_ad_id'
    : entityLevel === 'adset' ? 'meta_adset_id'
    : 'meta_campaign_id'

  const { data, error } = await db
    .from('daily_insights')
    .select('date_start, spend, bookings, frequency, synced_at')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', entityLevel)
    .eq(column, metaEntityId)
    .gte('date_start', priorStart)
    .lte('date_start', recentEnd)
  if (error) return { recent: null, prior: null, sourceGeneration: null }

  const rows = (data ?? []) as InsightRow[]
  const { data: generationData, error: generationError } = await db
    .from('api_sync_logs')
    .select('id, status, date_range_start, date_range_end, started_at, completed_at')
    .eq('ad_account_id', adAccountDbId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const generation = generationError ? null : generationData as SyncGenerationRow | null
  return {
    recent: foldWindow(rows, recentStart, recentEnd),
    prior: foldWindow(rows, priorStart, priorEnd),
    sourceGeneration: generation ? {
      id: generation.id,
      status: generation.status,
      dateRangeStart: generation.date_range_start,
      dateRangeEnd: generation.date_range_end,
      startedAt: generation.started_at,
      completedAt: generation.completed_at,
    } : null,
  }
}

/**
 * Deterministic paid-touch linkage coverage: linked bookings ÷ fbclid-carrying bookings.
 *
 * This is the guard that stops a cohort near-zero from being read as a loss. For example, 3 of 10
 * (0.30) is well under the 0.60 bar, so the exact-join cohort is UNDER-MEASURED and its zeros
 * describe our tracking, not the ads.
 */
export async function readLinkageCoverage(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  windowStart: string,
  windowEnd: string,
): Promise<number | null> {
  const { data, error } = await db
    .from('v_business_outcomes')
    .select('id, fbclid, occurred_at')
    .eq('ad_account_id', adAccountDbId)
    .eq('source_enabled', true)
    .gte('occurred_at', `${windowStart}T00:00:00.000Z`)
    .lte('occurred_at', `${windowEnd}T23:59:59.999Z`)
    .not('fbclid', 'is', null)
  if (error) return null
  const withFbclid = (data ?? []).filter((r) => {
    const v = (r as { fbclid: string | null }).fbclid
    return typeof v === 'string' && v.trim().length > 0
  })
  if (withFbclid.length === 0) return null

  const ids = withFbclid.map((r) => (r as { id: string }).id)
  const { data: links, error: linkErr } = await db
    .from('outcome_touch_links')
    .select('outcome_id')
    .eq('ad_account_id', adAccountDbId)
    .in('outcome_id', ids)
  if (linkErr) return null
  return (links ?? []).length / withFbclid.length
}

/** Assemble the evidence the directional policy consumes. */
export function buildModelledDirectionalEvidence(input: {
  recent: ModelledPerformanceWindow | null
  prior: ModelledPerformanceWindow | null
  sourceGeneration: ModelledSourceGeneration | null
  targetCpa: number | null
  watchCpa: number | null
  linkageCoverage: number | null
  blendedRoas: number | null
}): ModelledDirectionalEvidence {
  return {
    recent: input.recent,
    prior: input.prior,
    sourceGeneration: input.sourceGeneration,
    targetCpa: input.targetCpa,
    watchCpa: input.watchCpa,
    linkageCoverage: input.linkageCoverage,
    blendedRoas: input.blendedRoas,
  }
}
