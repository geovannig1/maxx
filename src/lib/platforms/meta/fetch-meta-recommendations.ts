import { fetchMetaGraph, metaGet, MetaApiError } from './client'
import { reportContractViolation, followPages, requireDataArray, type MetaContractViolation, type PagingAudit } from './contract'
import { parseRecommendationsPage, type MetaRecommendation } from './parse-recommendations'

// META'S OWN RECOMMENDATION ENGINE — GET /act_{id}/recommendations returns the suggestions that power
// Ads Manager's opportunity score. An EMPTY list is a real, meaningful state ("no pending
// recommendations"), not a failure. Read-only.
//
// The response is NESTED (verified against Meta's Performance Recommendations docs, 2026-07-26):
// data[].recommendations[]. The previous mapper read title/message/code/importance at the TOP level,
// where those keys do not exist, so every record parsed to all-nulls and the caller reported a
// successful list of empty objects. Parsing now lives in a pure, validated parser that FAILS CLOSED
// on an unknown schema rather than manufacturing empty records.
//
const ENDPOINT_LABEL = '/act_{account}/recommendations'

// Meta recommendations are ADVISORY EVIDENCE. They are never automatic instructions; recommendation
// time is preserved so consumers can discount stale ones.

export type { MetaRecommendation } from './parse-recommendations'
export { isStaleRecommendation } from './parse-recommendations'

export type MetaRecommendationsResult =
  | {
      available: true
      recommendations: MetaRecommendation[]
      groupCount: number
      /** Non-fatal per-record rejections, surfaced so a partial parse is never silent. */
      violations: MetaContractViolation[]
      /** Bounded, cycle-safe paging record. Cursor FINGERPRINTS only — never a signed URL. */
      paging: PagingAudit
      fetchedAt: string
    }
  | {
      available: false
      reason: string
      violation?: MetaContractViolation
      /** Present only on an INCOMPLETE paging walk. */
      paging?: PagingAudit
      /** Diagnostics ONLY. Marked partial by `available: false`; never a complete list. */
      partialRecommendations?: MetaRecommendation[]
    }

export async function fetchMetaRecommendations(): Promise<MetaRecommendationsResult> {
  const raw = process.env.META_AD_ACCOUNT_ID
  if (!raw) return { available: false, reason: 'META_AD_ACCOUNT_ID not configured.' }
  const accountId = raw.replace(/^act_/, '')

  let page: unknown
  let paging: PagingAudit = { pagesFollowed: 1, cursorFingerprints: [], stoppedBecause: 'exhausted', complete: true, violations: [] }
  try {
    page = await metaGet<unknown>(`/act_${accountId}/recommendations`)
    // Follow every page. Without this a multi-page account reported only its first page as if that
    // were the whole truth.
    const walked = await followPages<unknown>(
      ENDPOINT_LABEL,
      page,
      (pg) => (typeof pg === 'object' && pg !== null ? ((pg as Record<string, unknown>).paging as { next?: string } | undefined)?.next : undefined),
      async (url) => {
        const res = await fetchMetaGraph(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      },
    )
    paging = walked.audit
    for (const v of paging.violations) reportContractViolation(v)
    // Validate EACH page's envelope BEFORE merging. Flattening first would turn a malformed page
    // into an empty array and produce a valid-looking empty envelope.
    const merged: unknown[] = []
    for (const pg of walked.pages) {
      const env = requireDataArray(ENDPOINT_LABEL, pg)
      if (!env.ok) {
        reportContractViolation(env.violation)
        return {
          available: false,
          reason: `Meta recommendations page did not match the expected contract (${env.violation.errorClass}: ${env.violation.detail}).`,
          violation: env.violation,
        }
      }
      merged.push(...env.value)
    }
    page = { data: merged }
  } catch (err) {
    const reason =
      err instanceof MetaApiError
        ? `Meta recommendations error (code ${err.code}): ${err.message}`
        : `Recommendations fetch failed: ${err instanceof Error ? err.message : String(err)}`
    return { available: false, reason }
  }

  const parsed = parseRecommendationsPage(page)
  if (!parsed.ok) {
    // Auditable, redacted alert: endpoint + version + error class. A schema break must never become
    // an all-null "successful" record.
    reportContractViolation(parsed.violation)
    return {
      available: false,
      reason: `Meta recommendations response did not match the expected contract (${parsed.violation.errorClass}: ${parsed.violation.detail}).`,
      violation: parsed.violation,
    }
  }

  for (const v of parsed.value.violations) reportContractViolation(v)

  // COMPLETENESS: an incomplete walk must NEVER be reported as "no pending recommendations" or as a
  // full list. A truncated read that looks complete is worse than no read at all, because the caller
  // acts on an absence that was never established.
  if (!paging.complete) {
    return {
      available: false,
      reason:
        `Meta recommendations paging was INCOMPLETE (${paging.stoppedBecause} after ${paging.pagesFollowed} page(s)). ` +
        `${parsed.value.recommendations.length} record(s) were read but the set is PARTIAL — it cannot be presented as the ` +
        `full list, and an empty or short result here does NOT mean "no pending recommendations".`,
      violation: paging.violations[0],
      paging,
      partialRecommendations: parsed.value.recommendations,
    }
  }

  return {
    available: true,
    paging,
    recommendations: parsed.value.recommendations,
    groupCount: parsed.value.groupCount,
    violations: parsed.value.violations,
    fetchedAt: new Date().toISOString(),
  }
}
