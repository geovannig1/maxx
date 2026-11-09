import {
  requireDataArray, contractViolation, type MetaParseResult, type MetaContractViolation,
} from './contract'

// PURE PARSER for GET /act_{id}/recommendations.
//
// VERIFIED SHAPE (Meta docs, Marketing API "Performance Recommendations", checked 2026-07-26): each
// element of `data` carries a NESTED `recommendations` array, and each recommendation carries
// object_ids, type, recommendation_stage, recommendation_time, url, opportunity_score_lift, and a
// nested recommendation_content { lift_estimate, body, opportunity_score_lift }. Business-level
// responses substitute recommendation_name + level for `type`; both are accepted.
//
// The previous implementation mapped the TOP level with `(r.title as string) ?? null` etc. Those keys
// do not exist at that level, so every recommendation parsed to an all-null record and the caller
// reported `available: true` with a list of empty objects — a silent contract break that read as a
// clean success. This parser flattens the real nesting, validates, and REJECTS rather than inventing.
//
// Meta recommendations are ADVISORY EVIDENCE. Nothing here marks one as an instruction; staleness is
// preserved via recommendation_time so a consumer can discount an old suggestion.

const ENDPOINT = '/act_{account}/recommendations'

export interface MetaRecommendation {
  /** Entity ids the recommendation applies to. Empty array when Meta supplied none. */
  objectIds: string[]
  /** Machine type (ad-account level) — null on business-level payloads, which use `name` instead. */
  type: string | null
  /** Human-readable name (business level) — null on ad-account-level payloads. */
  name: string | null
  /** Entity level the recommendation targets, when Meta states it. */
  level: string | null
  stage: string | null
  /** ISO timestamp; preserved so STALE recommendations can be detected. Null when absent/invalid. */
  recommendationTime: string | null
  url: string | null
  /** Narrative body from recommendation_content. Null when Meta gave none. */
  body: string | null
  /** Meta's own lift estimate, verbatim. Null when absent — never defaulted to 0. */
  liftEstimate: number | null
  /** Opportunity-score lift; read from recommendation_content first, then the top level. */
  opportunityScoreLift: number | null
}

export interface ParsedRecommendations {
  recommendations: MetaRecommendation[]
  /** Groups seen in `data`. An empty page is a REAL state, not a failure. */
  groupCount: number
  /** Per-record rejections. Non-fatal, but surfaced so a partial parse is never silent. */
  violations: MetaContractViolation[]
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  // Meta returns some numerics as strings; accept only a clean numeric string.
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

const ids = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => str(x) ?? String(x ?? '')).filter((x) => x !== '')
  const one = str(v)
  return one ? [one] : []
}

/** ISO-normalise a timestamp, or null. Never substitutes "now" for a missing time. */
const isoTime = (v: unknown): string | null => {
  const s = str(v)
  if (s === null) return null
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** PURE: one raw recommendation object -> a validated record, or null when it carries no substance. */
function parseOne(raw: unknown): MetaRecommendation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const content =
    typeof r.recommendation_content === 'object' && r.recommendation_content !== null && !Array.isArray(r.recommendation_content)
      ? (r.recommendation_content as Record<string, unknown>)
      : {}

  const rec: MetaRecommendation = {
    objectIds: ids(r.object_ids),
    type: str(r.type),
    name: str(r.recommendation_name),
    level: str(r.level),
    stage: str(r.recommendation_stage),
    recommendationTime: isoTime(r.recommendation_time),
    url: str(r.url),
    body: str(content.body),
    liftEstimate: num(content.lift_estimate),
    // recommendation_content wins; Meta also exposes it at the top level on some payloads.
    opportunityScoreLift: num(content.opportunity_score_lift) ?? num(r.opportunity_score_lift),
  }

  // An "identity" is the minimum that makes a recommendation actionable as evidence: it must say
  // WHAT it is. A record with neither type nor name nor body is indistinguishable from noise, and
  // emitting it as an all-null row is exactly the defect being fixed.
  if (rec.type === null && rec.name === null && rec.body === null) return null
  return rec
}

/**
 * PURE: parse a recommendations page. Fails closed on an unknown envelope; an EMPTY page is a valid,
 * meaningful result ("no pending recommendations"), not an error.
 */
export function parseRecommendationsPage(payload: unknown): MetaParseResult<ParsedRecommendations> {
  const envelope = requireDataArray(ENDPOINT, payload)
  if (!envelope.ok) return envelope

  const out: MetaRecommendation[] = []
  const violations: MetaContractViolation[] = []
  let rejected = 0

  for (const [i, group] of envelope.value.entries()) {
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      violations.push(contractViolation(ENDPOINT, 'unexpected_data_shape', `data[${i}] was ${group === null ? 'null' : typeof group}`))
      continue
    }
    const nested = (group as Record<string, unknown>).recommendations
    if (nested === undefined) {
      // Some payloads put the recommendation directly in `data`. Accept it, but only if it validates.
      const direct = parseOne(group)
      if (direct) out.push(direct)
      else {
        rejected++
        violations.push(contractViolation(ENDPOINT, 'unexpected_data_shape', `data[${i}] has no "recommendations" array and is not itself a recommendation`))
      }
      continue
    }
    if (!Array.isArray(nested)) {
      violations.push(contractViolation(ENDPOINT, 'unexpected_data_shape', `data[${i}].recommendations was ${typeof nested}`))
      continue
    }
    for (const [j, item] of nested.entries()) {
      const parsed = parseOne(item)
      if (parsed) out.push(parsed)
      else {
        rejected++
        violations.push(contractViolation(ENDPOINT, 'unexpected_data_shape', `data[${i}].recommendations[${j}] carried no type, name, or body`))
      }
    }
  }

  // Groups were present and EVERY record failed to validate => the shape changed under us. Reporting
  // "0 recommendations" here would be a lie dressed as an empty account state.
  if (out.length === 0 && rejected > 0) {
    return {
      ok: false,
      violation: contractViolation(ENDPOINT, 'no_valid_records', `${rejected} record(s) present but none matched the expected recommendation shape`),
    }
  }

  return { ok: true, value: { recommendations: out, groupCount: envelope.value.length, violations }, violations }
}

/** PURE: a recommendation is stale when Meta issued it more than `maxAgeDays` ago, or gave no time. */
export function isStaleRecommendation(rec: MetaRecommendation, nowMs: number, maxAgeDays = 14): boolean {
  if (rec.recommendationTime === null) return true // unknown age is treated as stale, never as fresh
  return nowMs - Date.parse(rec.recommendationTime) > maxAgeDays * 86_400_000
}
