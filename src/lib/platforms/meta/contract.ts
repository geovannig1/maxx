import { createHash } from 'node:crypto'
import { META_API_VERSION } from './api-version'
import { redactSecretText } from '@/lib/security/redact-secrets'

// FAIL-CLOSED SCHEMA CONTRACTS for Meta responses.
//
// The failure mode this exists to stop: a parser that maps an unrecognised payload field-by-field
// with `?? null` and returns a "successful" record in which every field is null. Downstream that is
// indistinguishable from "Meta has nothing to say", so a silent contract break reads as a clean,
// empty result — and the system keeps reporting confidently on nothing.
//
// Rules:
//   • An unknown response schema is a FAILURE, not an empty success.
//   • The failure is auditable: endpoint, API version, and a REDACTED error class. Never a token, a
//     signed paging URL, or customer data.
//   • Callers surface `available: false` with the reason; they never fabricate a value.

/** Redacted classes only — safe to log, store, and show. */
export type MetaContractErrorClass =
  | 'not_an_object'
  | 'missing_data_array'
  | 'unexpected_data_shape'
  | 'no_valid_records'
  | 'unsupported_aggregation'
  | 'api_error'
  | 'transport_error'
  | 'paging_cycle'
  | 'paging_cap_exceeded'
  | 'missing_numeric_count'

export interface MetaContractViolation {
  endpoint: string
  apiVersion: string
  errorClass: MetaContractErrorClass
  /** Short, redacted detail. Must not embed a URL, token, or customer value. */
  detail: string
  observedAt: string
}

export type MetaParseResult<T> =
  | { ok: true; value: T; violations: MetaContractViolation[] }
  | { ok: false; violation: MetaContractViolation }

// Anything that looks like a credential or a signed URL is stripped before a detail string is stored
// or logged (the shared patterns in src/lib/security/redact-secrets.ts).

/** PURE: strip credentials, signed URLs, and e-mail addresses from a diagnostic string. */
export function redactDetail(raw: string, maxLen = 200): string {
  return redactSecretText(raw, maxLen)
}

export function contractViolation(
  endpoint: string,
  errorClass: MetaContractErrorClass,
  detail: string,
  nowIso?: string,
): MetaContractViolation {
  return {
    endpoint,
    apiVersion: META_API_VERSION,
    errorClass,
    detail: redactDetail(detail),
    observedAt: nowIso ?? new Date().toISOString(),
  }
}

/** Emit an auditable alert for a contract break. Redacted by construction. */
export function reportContractViolation(v: MetaContractViolation): void {
  console.error(
    `[MetaContract] ${v.endpoint} (${v.apiVersion}) FAILED CLOSED — ${v.errorClass}: ${v.detail}`,
  )
}

/** PURE: the `data` array of a Graph response, or a violation. Fails closed on anything else. */
export function requireDataArray(endpoint: string, payload: unknown): MetaParseResult<unknown[]> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, violation: contractViolation(endpoint, 'not_an_object', `response was ${payload === null ? 'null' : typeof payload}`) }
  }
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) {
    return { ok: false, violation: contractViolation(endpoint, 'missing_data_array', `"data" was ${data === undefined ? 'absent' : typeof data}`) }
  }
  return { ok: true, value: data, violations: [] }
}

// ── BOUNDED, AUDITED PAGING ─────────────────────────────────────────────────────────────────────
// Neither the recommendations nor the dataset-stats fetcher paged at all, so a multi-page account
// silently reported only its first page as if that were the whole truth. Paging must be BOUNDED
// (a cursor loop that never terminates is an outage), CYCLE-SAFE (Meta can return a cursor that
// points back at a page already seen), and AUDITED — and a signed paging URL must NEVER be logged
// or stored, because it embeds an access token in its query string.

/** Hard ceiling on pages followed for any single edge. Exceeding it is a contract violation. */
export const MAX_PAGES = 25

export interface PagingAudit {
  pagesFollowed: number
  /** Redacted cursor fingerprints only — never the signed URL itself. */
  cursorFingerprints: string[]
  stoppedBecause: 'exhausted' | 'scope_satisfied' | 'cycle_detected' | 'cap_exceeded' | 'page_error'
  /**
   * COMPLETENESS is first-class. An exhausted walk or a caller-proven scope boundary is complete;
   * a cap, a cycle or a page error means the result is PARTIAL and must never be presented as the
   * whole truth ("no pending recommendations", "coverage is N%").
   */
  complete: boolean
  violations: MetaContractViolation[]
}

/**
 * PURE-ish: fingerprint a paging URL for cycle detection WITHOUT retaining it. Keeps only the
 * `after`/`before` cursor value, which is opaque and token-free; the rest of the URL (including
 * access_token) is discarded.
 */
export function cursorFingerprint(url: string): string {
  try {
    const u = new URL(url)
    const after = u.searchParams.get('after') ?? u.searchParams.get('before') ?? ''
    // HASH the COMPLETE cursor. Storing its first 24 raw characters was wrong twice over: two
    // distinct cursors sharing a prefix collided into a false "cycle detected", and a raw cursor
    // fragment is opaque platform state we have no reason to retain. A hash is fixed-length,
    // collision-safe for this purpose, and carries nothing back.
    return after ? `cursor:${createHash('sha256').update(after).digest('hex').slice(0, 16)}` : `path:${u.pathname}`
  } catch {
    return 'cursor:unparseable'
  }
}

export interface PagedResult<T> {
  pages: T[]
  audit: PagingAudit
}

/**
 * Follow `nextUrl` up to MAX_PAGES with cycle detection. `fetchPage` returns the parsed body; a
 * thrown error stops the walk and is recorded as a violation rather than silently truncating.
 */
export async function followPages<T>(
  endpoint: string,
  firstPage: T,
  nextUrlOf: (page: T) => string | undefined,
  fetchPage: (url: string) => Promise<T>,
  maxPages: number = MAX_PAGES,
  scopeSatisfied?: (page: T) => boolean,
): Promise<PagedResult<T>> {
  const pages: T[] = [firstPage]
  const seen = new Set<string>()
  const violations: MetaContractViolation[] = []
  let stoppedBecause: PagingAudit['stoppedBecause'] = 'exhausted'
  const fingerprints: string[] = []

  if (scopeSatisfied?.(firstPage)) stoppedBecause = 'scope_satisfied'
  let url = stoppedBecause === 'scope_satisfied' ? undefined : nextUrlOf(firstPage)
  while (url) {
    if (pages.length >= maxPages) {
      // A truncated read must never look like a complete one.
      violations.push(contractViolation(endpoint, 'paging_cap_exceeded', `stopped after ${maxPages} pages with a further cursor still present — the result is INCOMPLETE`))
      stoppedBecause = 'cap_exceeded'
      break
    }
    const fp = cursorFingerprint(url)
    if (seen.has(fp)) {
      violations.push(contractViolation(endpoint, 'paging_cycle', `paging cursor repeated (${fp}) — cycle detected, walk aborted`))
      stoppedBecause = 'cycle_detected'
      break
    }
    seen.add(fp)
    fingerprints.push(fp)

    let page: T
    try {
      page = await fetchPage(url)
    } catch (err) {
      violations.push(contractViolation(endpoint, 'transport_error', `page fetch failed: ${err instanceof Error ? err.message : String(err)}`))
      stoppedBecause = 'page_error'
      break
    }
    pages.push(page)
    if (scopeSatisfied?.(page)) {
      stoppedBecause = 'scope_satisfied'
      break
    }
    url = nextUrlOf(page)
  }

  return {
    pages,
    audit: {
      pagesFollowed: pages.length,
      cursorFingerprints: fingerprints,
      stoppedBecause,
      complete: stoppedBecause === 'exhausted' || stoppedBecause === 'scope_satisfied',
      violations,
    },
  }
}
