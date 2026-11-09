// FORWARD-ONLY ATTRIBUTION COVERAGE.
//
// THE DEFECT THIS REPLACES: measuring capture coverage as "rows with fbclid ÷ ALL the outcome source rows".
// The outcome ledger holds the full booking history (hundreds of rows), while link decoration, the
// hidden intake fields, and server CAPI went live far later. Most rows PREDATE the instrumentation
// and could never have carried an fbclid. Dividing by them produces a coverage figure that says
// nothing about whether the current implementation works — it mostly measures how old the ledger is,
// and it gets WORSE the longer the business has existed.
//
// Coverage is therefore measured only over a COHORT that began at a recorded go-live boundary, and
// the boundary is reported with every figure. A row before the boundary is not a failure; it is
// simply not eligible.

export interface CoverageBoundary {
  /** ISO timestamp when the capture implementation went live. */
  goLiveAt: string
  /** What established this boundary — a deploy, a GTM publish, an owner statement. Never inferred. */
  provenance: string
}

export interface CoverageBooking {
  appointmentId: number
  /** Booking moment (the attribution instant). */
  createdAtMs: number
  hasFbclid: boolean
  hasFbc: boolean
  hasFbp: boolean
  /** A server CAPI delivery that Meta ACCEPTED (events_received = 1, no error). */
  capiAccepted: boolean
  /** A delivery was attempted but not accepted. */
  capiFailed: boolean
  hasUtmSource: boolean
  hasUtmCampaign: boolean
  /** True when the row's capture state could not be determined at all. */
  unknownState: boolean
}

export interface ForwardCoverageResult {
  boundary: CoverageBoundary
  window: { startMs: number; endMs: number; startIso: string; endIso: string }
  /** Bookings ON OR AFTER the boundary AND inside the window — the only fair denominator. */
  eligible: number
  /** Bookings excluded for predating the instrumentation. Reported, never silently dropped. */
  excludedPreBoundary: number
  withFbclidOrFbc: number
  withFbp: number
  withAcceptedCapi: number
  withFailedCapi: number
  withUtmSource: number
  withUtmCampaign: number
  unknownState: number
  /** Rates over `eligible`, or null when the cohort is empty (never 0%). */
  clickIdCoverage: number | null
  fbpCoverage: number | null
  capiAcceptanceRate: number | null
  utmCoverage: number | null
  notes: string[]
}

/**
 * PURE: coverage over the forward cohort only.
 * `endMs` defaults to the caller's clock; both bounds are reported so a figure is never quoted
 * without the window it came from.
 */
export function computeForwardCoverage(
  bookings: CoverageBooking[],
  boundary: CoverageBoundary,
  window: { startMs?: number; endMs: number },
): ForwardCoverageResult {
  const boundaryMs = Date.parse(boundary.goLiveAt)
  const notes: string[] = []

  if (!Number.isFinite(boundaryMs)) {
    // No usable boundary => no honest coverage figure. Fail closed rather than fall back to "all rows".
    notes.push('the go-live boundary is not a valid timestamp — forward coverage cannot be computed, and the full ledger must NOT be used as a substitute denominator')
    return {
      boundary,
      window: { startMs: 0, endMs: window.endMs, startIso: 'invalid', endIso: new Date(window.endMs).toISOString() },
      eligible: 0, excludedPreBoundary: bookings.length,
      withFbclidOrFbc: 0, withFbp: 0, withAcceptedCapi: 0, withFailedCapi: 0,
      withUtmSource: 0, withUtmCampaign: 0, unknownState: 0,
      clickIdCoverage: null, fbpCoverage: null, capiAcceptanceRate: null, utmCoverage: null,
      notes,
    }
  }

  // The cohort starts at the LATER of the boundary and any explicit window start: a row before the
  // instrumentation existed can never be counted against it.
  const startMs = Math.max(boundaryMs, window.startMs ?? boundaryMs)
  const endMs = window.endMs

  const eligibleRows = bookings.filter((b) => b.createdAtMs >= startMs && b.createdAtMs <= endMs)
  const excludedPreBoundary = bookings.filter((b) => b.createdAtMs < boundaryMs).length

  if (excludedPreBoundary > 0) {
    notes.push(
      `${excludedPreBoundary} booking(s) predate the capture go-live (${boundary.goLiveAt}) and are EXCLUDED from the denominator — they could not have carried attribution and are not a capture failure`,
    )
  }
  notes.push(`cohort provenance: ${boundary.provenance}`)

  const n = eligibleRows.length
  const count = (pred: (b: CoverageBooking) => boolean) => eligibleRows.filter(pred).length
  const rate = (k: number) => (n > 0 ? k / n : null)

  const withFbclidOrFbc = count((b) => b.hasFbclid || b.hasFbc)
  const withFbp = count((b) => b.hasFbp)
  const withAcceptedCapi = count((b) => b.capiAccepted)
  const withFailedCapi = count((b) => b.capiFailed)
  const withUtmSource = count((b) => b.hasUtmSource)
  const withUtmCampaign = count((b) => b.hasUtmCampaign)
  const unknownState = count((b) => b.unknownState)

  if (n === 0) {
    notes.push('the forward cohort is EMPTY — coverage is unknown, not 0%')
  }
  if (unknownState > 0) {
    notes.push(`${unknownState} eligible booking(s) have an UNKNOWN capture state — counted separately, never as captured or as missing`)
  }

  return {
    boundary,
    window: { startMs, endMs, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() },
    eligible: n,
    excludedPreBoundary,
    withFbclidOrFbc, withFbp, withAcceptedCapi, withFailedCapi, withUtmSource, withUtmCampaign, unknownState,
    clickIdCoverage: rate(withFbclidOrFbc),
    fbpCoverage: rate(withFbp),
    capiAcceptanceRate: rate(withAcceptedCapi),
    utmCoverage: rate(withUtmSource),
    notes,
  }
}

/** PURE: the sentence a report may use. Never claims a historical table measures current capture. */
export function renderForwardCoverage(r: ForwardCoverageResult): string[] {
  const pct = (v: number | null) => (v === null ? 'unknown' : `${Math.round(v * 100)}%`)
  return [
    '=== ATTRIBUTION CAPTURE — FORWARD COHORT ONLY ===',
    `  Go-live boundary: ${r.boundary.goLiveAt} (${r.boundary.provenance})`,
    `  Window: ${r.window.startIso} .. ${r.window.endIso}`,
    `  Eligible bookings (on/after go-live): ${r.eligible}` +
      (r.excludedPreBoundary > 0 ? `; ${r.excludedPreBoundary} pre-instrumentation booking(s) EXCLUDED — not a capture failure` : ''),
    `  Click id (fbclid/fbc): ${r.withFbclidOrFbc}/${r.eligible} = ${pct(r.clickIdCoverage)}`,
    `  Browser id (fbp): ${r.withFbp}/${r.eligible} = ${pct(r.fbpCoverage)}`,
    `  Accepted server CAPI: ${r.withAcceptedCapi}/${r.eligible} = ${pct(r.capiAcceptanceRate)}  (failed: ${r.withFailedCapi})`,
    `  UTM source / campaign: ${r.withUtmSource} / ${r.withUtmCampaign}`,
    `  Unknown capture state: ${r.unknownState}`,
    '  RULE: never state that the full historical ledger measures the current capture implementation —',
    '  most of it predates the instrumentation and is not an eligible denominator.',
    '',
  ]
}
