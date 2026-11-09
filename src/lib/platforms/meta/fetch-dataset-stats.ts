import { fetchMetaGraph, metaGet, MetaApiError } from './client'
import { getAdminClient } from '@/lib/supabase/admin'
import { followPages, reportContractViolation } from './contract'

// SITE-WIDE pixel/dataset event volume — the input Maxx never collected. This is what lets the
// optimization-signal classifier answer "does the conversion event fire often enough to ever exit
// learning?" (e.g. a low-volume account firing ~10/wk vs the ~50/wk/ad-set Meta needs). It reads the dataset `stats`
// edge directly (all sources), independent of which campaign is running — so it measures the true
// firing rate, not just ad-attributed conversions.
//
// Read-only. Degrades gracefully to { available: false, reason } on any error (no pixel id, API failure,
// empty window) so callers can report the event volume as UNVERIFIED rather than crash or fabricate.

export interface DatasetEventVolume {
  event: string
  /** Total firings across the window (all sources). */
  count: number
  /** Firings normalized to a 7-day rate over the window. */
  perWeek: number
}

export interface DatasetStatsResult {
  available: boolean
  reason: string | null
  datasetId: string | null
  windowDays: number
  /** Per-event totals, sorted by count desc. */
  events: DatasetEventVolume[]
}

interface StatBucket {
  start_time?: number | string
  timestamp?: string
  data?: Array<{ value?: string; count?: number }>
}
interface StatsPage {
  data?: StatBucket[]
  paging?: { next?: string; previous?: string }
}

const DAY_SECONDS = 86_400
/** The dataset stats edge only retains ~28 days. */
export const MAX_DATASET_LOOKBACK_DAYS = 28
// The /stats edge caps at ~20 hourly buckets/page and pages OLDER via `paging.previous` (`next` goes
// forward into empty). ~28d of hourly buckets ≈ 34 pages; cap generously so we always cover the window.
const MAX_STATS_PAGES = 50

function bucketStartSeconds(bucket: StatBucket): number | null {
  const raw = bucket.start_time ?? bucket.timestamp
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string' || raw.trim() === '') return null
  if (/^\d+$/.test(raw)) return Number(raw)
  const millis = Date.parse(raw)
  return Number.isFinite(millis) ? millis / 1000 : null
}

function pageCoversWindowStart(page: StatsPage, startSec: number): boolean {
  if (!Array.isArray(page.data)) return false
  if (page.data.length === 0) return false
  const starts = page.data.map(bucketStartSeconds)
  return starts.every((value): value is number => value !== null)
    && Math.min(...starts) <= startSec
}

async function resolveDatasetId(adAccountDbId?: string): Promise<string | null> {
  const fromEnv = process.env.META_PIXEL_ID
  if (fromEnv) return fromEnv
  try {
    const db = getAdminClient()
    const q = db.from('ad_accounts').select('pixel_id')
    const { data } = adAccountDbId
      ? await q.eq('id', adAccountDbId).maybeSingle()
      : await q.eq('is_active', true).limit(1).maybeSingle()
    return (data?.pixel_id as string | null | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * Fetch site-wide per-event firing volume for the pixel/dataset over the last `windowDays` (≤28).
 * `nowSec` is injectable for deterministic tests; defaults to the wall clock.
 */
export async function fetchDatasetEventVolume(opts?: {
  adAccountDbId?: string
  windowDays?: number
  datasetId?: string
  nowSec?: number
}): Promise<DatasetStatsResult> {
  const windowDays = Math.min(opts?.windowDays ?? MAX_DATASET_LOOKBACK_DAYS, MAX_DATASET_LOOKBACK_DAYS)

  const datasetId = opts?.datasetId ?? (await resolveDatasetId(opts?.adAccountDbId))
  if (!datasetId) {
    return {
      available: false,
      reason: 'No pixel/dataset id configured — set META_PIXEL_ID or sync ad_accounts.pixel_id.',
      datasetId: null,
      windowDays,
      events: [],
    }
  }

  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000)
  const startSec = nowSec - windowDays * DAY_SECONDS

  try {
    // Page 1 (newest ~20 hourly buckets), then walk OLDER via paging.previous until empty / cap / no cursor.
    const totals = new Map<string, number>()
    const seen = new Set<string>()
    let invalidBucketTime = false
    const absorb = (page: StatsPage): void => {
      for (const b of page.data ?? []) {
        const bucketStart = bucketStartSeconds(b)
        if (bucketStart === null) {
          invalidBucketTime = true
          continue
        }
        if (bucketStart < startSec || bucketStart >= nowSec) continue
        const key = String(b.start_time ?? b.timestamp ?? '')
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        for (const d of b.data ?? []) {
          if (!d.value) continue
          const name = normalizeEventName(d.value)
          totals.set(name, (totals.get(name) ?? 0) + Number(d.count ?? 0))
        }
      }
    }

    const firstPage = await metaGet<StatsPage>(`/${datasetId}/stats`, { aggregation: 'event', start: String(startSec), end: String(nowSec) })
    const walked = await followPages(
      '/{dataset}/stats?aggregation=event', firstPage, (page) => page.paging?.previous,
      async (url) => {
        const res = await fetchMetaGraph(url)
        const json = (await res.json().catch(() => null)) as StatsPage | null
        if (!res.ok || !json || !Array.isArray(json.data)) {
          throw new Error(`dataset event-volume page failed with HTTP ${res.status}`)
        }
        return json
      },
      MAX_STATS_PAGES,
      (page) => pageCoversWindowStart(page, startSec),
    )
    for (const violation of walked.audit.violations) reportContractViolation(violation)
    if (!walked.audit.complete) {
      return {
        available: false,
        reason: `Dataset event-volume paging was INCOMPLETE (${walked.audit.stoppedBecause}); no partial firing rate was published.`,
        datasetId,
        windowDays,
        events: [],
      }
    }
    for (const page of walked.pages) absorb(page)
    if (invalidBucketTime) {
      return {
        available: false,
        reason: 'Dataset stats returned a bucket without a parseable start_time; no firing rate was published.',
        datasetId,
        windowDays,
        events: [],
      }
    }

    const weeks = windowDays / 7
    const events = [...totals.entries()]
      .map(([event, count]) => ({ event, count, perWeek: weeks > 0 ? count / weeks : 0 }))
      .sort((a, b) => b.count - a.count)

    if (events.length === 0) {
      return { available: false, reason: 'Dataset stats returned no events for the window.', datasetId, windowDays, events: [] }
    }
    return { available: true, reason: null, datasetId, windowDays, events }
  } catch (err) {
    const reason =
      err instanceof MetaApiError
        ? `Meta dataset stats error (code ${err.code}): ${err.message}`
        : `Dataset stats fetch failed: ${err instanceof Error ? err.message : String(err)}`
    return { available: false, reason, datasetId, windowDays, events: [] }
  }
}

/** Normalize a dataset event name: the SAME custom event can arrive under URL-encoded variants (e.g.
 *  'Quote Request_Click' and 'Quote%20Request_Click' — one event split in two,
 *  fragmenting its true volume). Decode + trim so variants collapse to one canonical name at ingestion. */
export function normalizeEventName(raw: string): string {
  try {
    return decodeURIComponent(raw).trim()
  } catch {
    return raw.trim() // malformed %-sequence — keep as-is
  }
}

/** Per-week firing rate of a single named event (0 when unavailable/absent). Name is normalized the same
 *  way ingestion normalizes, so lookups match regardless of encoding. */
export function eventPerWeek(stats: DatasetStatsResult, eventName: string): number {
  const want = normalizeEventName(eventName)
  return stats.events.find((e) => e.event === want)?.perWeek ?? 0
}

/** Combined per-week rate across candidate event names — handles the same action logged under multiple
 *  names (e.g. "Quote Request_Click" vs the URL-encoded "Quote%20Request_Click"). */
export function sumEventsPerWeek(stats: DatasetStatsResult, eventNames: string[]): number {
  const want = new Set(eventNames)
  return stats.events.filter((e) => want.has(e.event)).reduce((s, e) => s + e.perWeek, 0)
}
