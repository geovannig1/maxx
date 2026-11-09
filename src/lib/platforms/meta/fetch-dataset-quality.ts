import { fetchMetaGraph, metaGet, MetaApiError } from './client'
import { getAdminClient } from '@/lib/supabase/admin'
import { META_API_VERSION } from './api-version'
import { requireDataArray, reportContractViolation, contractViolation, followPages, MAX_PAGES, type MetaContractViolation, type PagingAudit } from './contract'

// SIGNAL-QUALITY DIAGNOSTICS from the dataset `stats` edge.
//
// WHAT WAS WRONG: this fetcher requested `aggregation=event_match_quality`. That is NOT a supported
// value. Verified against Meta's official Ads Pixel `stats` reference (Marketing API v25.0, checked
// 2026-07-26), the supported enum is exactly:
//
//   browser_type, custom_data_field, device_os, device_type, event, host, match_keys, had_pii,
//   pixel_fire, event_detection_method, url, event_value_count, url_by_rule, event_total_counts,
//   event_source, event_processing_results
//
// `event_match_quality` is absent. The request therefore could never return a real EMQ score, and the
// code that read `d.match_quality` was reading a field the edge does not produce — a fabricated
// metric waiting to happen.
//
// EMQ POLICY (binding): Meta exposes Event Match Quality in the Events Manager UI. No verified API
// equivalent exists on this edge. EMQ is therefore OWNER-OBSERVED ONLY. This module must never
// manufacture a 0-10 score out of unrelated stats, and never presents coverage as EMQ.
//
// WHAT IT DOES INSTEAD: deterministic coverage + processing diagnostics from SUPPORTED aggregations
// only — match-key coverage, PII presence, event source, and processing results. Provenance
// (API version, request time, window) is persisted with every reading. No tokens, signed paging URLs,
// or raw PII are logged.

/** The four supported aggregations this module reads. Each is in the verified enum above. */
export const SUPPORTED_QUALITY_AGGREGATIONS = ['match_keys', 'had_pii', 'event_source', 'event_processing_results'] as const
export type QualityAggregation = (typeof SUPPORTED_QUALITY_AGGREGATIONS)[number]

/** Aggregations Meta documents but this module deliberately does not request. Kept so a future change
 *  is a conscious choice rather than a guess. */
export const OTHER_DOCUMENTED_AGGREGATIONS = [
  'browser_type', 'custom_data_field', 'device_os', 'device_type', 'event', 'host', 'pixel_fire',
  'event_detection_method', 'url', 'event_value_count', 'url_by_rule', 'event_total_counts',
] as const

/** PURE: is this a documented aggregation? Anything else must never reach the API. */
export function isSupportedAggregation(name: string): boolean {
  return (SUPPORTED_QUALITY_AGGREGATIONS as readonly string[]).includes(name) ||
    (OTHER_DOCUMENTED_AGGREGATIONS as readonly string[]).includes(name)
}

export interface DimensionBucket {
  /** The dimension value verbatim from Meta (e.g. a match key name, 'true'/'false', a source). */
  value: string
  count: number
  /** Share of the aggregation's total, 0..1. */
  share: number
}

export interface DatasetQualityProvenance {
  datasetId: string
  apiVersion: string
  requestedAt: string
  respondedAt: string
  windowStart: string
  windowEnd: string
  aggregationsRequested: QualityAggregation[]
  aggregationsReturned: QualityAggregation[]
  /** Per-aggregation paging record. Cursor FINGERPRINTS only — never a signed URL. */
  paging: Partial<Record<QualityAggregation, PagingAudit>>
}

export interface DatasetQualityDiagnostics {
  /** Coverage per match key (em, ph, fbp, fbc, ...) as Meta reports it. */
  matchKeys: DimensionBucket[]
  /** Whether events arrived carrying PII, by Meta's own had_pii dimension. */
  piiPresence: DimensionBucket[]
  /** Browser vs server vs other, per Meta's event_source dimension. */
  eventSources: DimensionBucket[]
  /** Meta's processing verdicts (accepted / dropped / deduplicated, as Meta labels them). */
  processingResults: DimensionBucket[]
}

export type DatasetQualityResult =
  | {
      available: true
      provenance: DatasetQualityProvenance
      diagnostics: DatasetQualityDiagnostics
      /** ALWAYS null. EMQ has no verified API source; it is owner-observed in Events Manager. */
      eventMatchQuality: null
      eventMatchQualityNote: string
      violations: MetaContractViolation[]
    }
  | { available: false; reason: string; datasetId: string | null; violation?: MetaContractViolation }

export const EMQ_NOTE =
  'Event Match Quality is NOT available from the Marketing API dataset stats edge (no such aggregation exists in the documented enum). Treat any EMQ figure as OWNER-OBSERVED from Events Manager. Never derive one from coverage or processing stats.'

const DAY_SECONDS = 86_400
const DEFAULT_WINDOW_DAYS = 7

function statsBucketStartSeconds(bucket: unknown): number | null {
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) return null
  const raw = (bucket as Record<string, unknown>).start_time
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string' || raw.trim() === '') return null
  if (/^\d+$/.test(raw)) return Number(raw)
  const millis = Date.parse(raw)
  return Number.isFinite(millis) ? millis / 1000 : null
}

function statsPageCoversStart(payload: unknown, startSec: number): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) return false
  if (data.length === 0) return false
  const starts = data.map(statsBucketStartSeconds)
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
 * PURE: fold a `/stats` page into ranked dimension buckets. The verified result node is
 * { aggregation, data: [{ value, count }], start_time } — hourly buckets, so counts are summed
 * across the window. Returns null when the envelope does not match, so the caller fails closed.
 */
export function foldStatsPage(endpoint: string, payload: unknown): { buckets: DimensionBucket[]; violation?: MetaContractViolation } {
  const envelope = requireDataArray(endpoint, payload)
  if (!envelope.ok) return { buckets: [], violation: envelope.violation }

  const totals = new Map<string, number>()
  for (const [i, bucket] of envelope.value.entries()) {
    if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
      return { buckets: [], violation: contractViolation(endpoint, 'unexpected_data_shape', `data[${i}] was ${bucket === null ? 'null' : typeof bucket}`) }
    }
    const inner = (bucket as Record<string, unknown>).data
    if (inner === undefined) continue
    if (!Array.isArray(inner)) {
      return { buckets: [], violation: contractViolation(endpoint, 'unexpected_data_shape', `data[${i}].data was ${typeof inner}`) }
    }
    for (const d of inner) {
      if (typeof d !== 'object' || d === null) continue
      const rec = d as Record<string, unknown>
      const value = typeof rec.value === 'string' ? rec.value.trim() : null
      if (!value) continue
      // A MISSING numeric count is a contract violation, not zero. Coercing it to 0 turned an
      // unreadable payload into a confident "this dimension had no events".
      if (typeof rec.count !== 'number' || !Number.isFinite(rec.count)) {
        return {
          buckets: [],
          violation: contractViolation(endpoint, 'missing_numeric_count', `data[${i}].data entry "${value}" has no numeric count (${typeof rec.count})`),
        }
      }
      totals.set(value, (totals.get(value) ?? 0) + rec.count)
    }
  }

  const sum = [...totals.values()].reduce((a, b) => a + b, 0)
  const buckets = [...totals.entries()]
    .map(([value, count]) => ({ value, count, share: sum > 0 ? count / sum : 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  return { buckets }
}

/**
 * Read deterministic coverage + processing diagnostics for the pixel/dataset from SUPPORTED
 * aggregations only. Degrades to { available: false, reason } — never to a fabricated score.
 */
export async function fetchDatasetQuality(opts?: {
  adAccountDbId?: string
  datasetId?: string
  windowDays?: number
  nowSec?: number
}): Promise<DatasetQualityResult> {
  const datasetId = opts?.datasetId ?? (await resolveDatasetId(opts?.adAccountDbId))
  if (!datasetId) {
    return { available: false, reason: 'No pixel/dataset id configured — set META_PIXEL_ID or sync ad_accounts.pixel_id.', datasetId: null }
  }

  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000)
  const startSec = nowSec - windowDays * DAY_SECONDS
  const requestedAt = new Date().toISOString()

  const diagnostics: DatasetQualityDiagnostics = { matchKeys: [], piiPresence: [], eventSources: [], processingResults: [] }
  const violations: MetaContractViolation[] = []
  const returned: QualityAggregation[] = []
  const pagingByAggregation: Partial<Record<QualityAggregation, PagingAudit>> = {}
  const target: Record<QualityAggregation, keyof DatasetQualityDiagnostics> = {
    match_keys: 'matchKeys',
    had_pii: 'piiPresence',
    event_source: 'eventSources',
    event_processing_results: 'processingResults',
  }

  for (const agg of SUPPORTED_QUALITY_AGGREGATIONS) {
    const endpoint = `/{dataset}/stats?aggregation=${agg}`
    try {
      const first = await metaGet<unknown>(`/${datasetId}/stats`, {
        aggregation: agg,
        start: String(startSec),
        end: String(nowSec),
      })
      // The /stats edge pages OLDER via paging.previous. Bounded + cycle-safe; cursor fingerprints
      // only, never the signed URL (it embeds the access token).
      const walked = await followPages<unknown>(
        endpoint, first,
        (pg) => (typeof pg === 'object' && pg !== null ? ((pg as Record<string, unknown>).paging as { previous?: string } | undefined)?.previous : undefined),
        async (url) => {
          const res = await fetchMetaGraph(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        },
        MAX_PAGES,
        (page) => statsPageCoversStart(page, startSec),
      )
      pagingByAggregation[agg] = walked.audit
      for (const v of walked.audit.violations) { violations.push(v); reportContractViolation(v) }
      // Validate EACH page's envelope BEFORE merging. Flattening first would turn a malformed page
      // (no `data` key) into an empty array and produce a valid-looking empty envelope — losing the
      // very contract break this fetcher exists to surface.
      let envelopeViolation: MetaContractViolation | undefined
      const merged: unknown[] = []
      for (const pg of walked.pages) {
        const env = requireDataArray(endpoint, pg)
        if (!env.ok) { envelopeViolation = env.violation; break }
        for (const bucket of env.value) {
          const bucketStart = statsBucketStartSeconds(bucket)
          if (bucketStart === null) {
            envelopeViolation = contractViolation(
              endpoint, 'unexpected_data_shape', 'stats bucket had no parseable start_time',
            )
            break
          }
          if (bucketStart >= startSec && bucketStart < nowSec) merged.push(bucket)
        }
        if (envelopeViolation) break
      }
      if (envelopeViolation) {
        violations.push(envelopeViolation)
        reportContractViolation(envelopeViolation)
        continue
      }
      const { buckets, violation } = foldStatsPage(endpoint, { data: merged })
      if (violation) {
        violations.push(violation)
        reportContractViolation(violation)
        continue
      }
      diagnostics[target[agg]] = buckets
      if (buckets.length > 0) returned.push(agg)
    } catch (err) {
      const detail =
        err instanceof MetaApiError ? `code ${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
      const v = contractViolation(endpoint, err instanceof MetaApiError ? 'api_error' : 'transport_error', detail)
      violations.push(v)
      reportContractViolation(v)
    }
  }

  // COMPLETENESS: a coverage conclusion drawn from truncated pages is a confident statement about
  // data we did not read. Any incomplete aggregation invalidates the whole diagnostics block.
  const incomplete = (Object.entries(pagingByAggregation) as Array<[QualityAggregation, PagingAudit]>)
    .filter(([, a]) => !a.complete)
  if (incomplete.length > 0) {
    return {
      available: false,
      reason:
        `Dataset paging was INCOMPLETE for ${incomplete.map(([agg, a]) => `${agg} (${a.stoppedBecause})`).join(', ')}. ` +
        `Coverage and processing shares computed from a truncated read would understate the true totals, so the ` +
        `diagnostics are UNAVAILABLE rather than partial.`,
      datasetId,
      violation: incomplete[0][1].violations[0] ?? violations[0],
    }
  }

  if (returned.length === 0) {
    return {
      available: false,
      reason: `No supported dataset-stats aggregation returned data for the ${windowDays}-day window (tried ${SUPPORTED_QUALITY_AGGREGATIONS.join(', ')}). Signal-quality diagnostics are UNAVAILABLE — do not substitute an estimate.`,
      datasetId,
      violation: violations[0],
    }
  }

  return {
    available: true,
    provenance: {
      datasetId,
      apiVersion: META_API_VERSION,
      requestedAt,
      respondedAt: new Date().toISOString(),
      windowStart: new Date(startSec * 1000).toISOString(),
      windowEnd: new Date(nowSec * 1000).toISOString(),
      aggregationsRequested: [...SUPPORTED_QUALITY_AGGREGATIONS],
      aggregationsReturned: returned,
      paging: pagingByAggregation,
    },
    diagnostics,
    eventMatchQuality: null,
    eventMatchQualityNote: EMQ_NOTE,
    violations,
  }
}
