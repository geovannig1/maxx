import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// CONVERSION ACTIONABILITY — source-specific trust.
//
// The problem with one blended trust score: Meta DELIVERY facts (spend, impressions, reach,
// frequency) and Meta MODELLED CONVERSIONS (bookings, CPA, ROAS, revenue) are not the same kind of
// claim. Spend fetched successfully from the API is close to ground truth. A modelled conversion
// count is an inference — and it can be overwhelmingly view-through, which is not evidence of
// incremental impact.
//
// So delivery facts stay trustworthy when the fetch succeeded, while conversion claims carry their
// own ceiling with the REASONS attached. Three Meta-attributed bookings are never "verified business
// truth", and a view-through-heavy conversion set is never an incrementality claim.

export type EvidenceClass =
  | 'measurement'        // directly observed (spend, impressions, first-party ledger rows)
  | 'modeled_attribution' // inferred by a platform model (Meta conversions, GA4 attribution)
  | 'business_truth'      // first-party outcome (outcome ledger)
  | 'experiment'          // causal evidence from a controlled test
  | 'owner_decision'      // a human decision on record

export type ActionabilityLevel = 'actionable' | 'directional' | 'insufficient'

export interface ConversionEvidence {
  /** Conversions Meta attributes in the window. */
  metaConversions: number | null
  /** Of those, how many are view-through. null = unknown breakdown (NOT zero). */
  viewThroughConversions: number | null
  /** First-party business outcomes in the same window (the outcome source). */
  firstPartyBookings: number | null
  /** GA paid-channel confirmation events in the same window; telemetry, not bookings. */
  ga4PaidConfirmationEvents: number | null
  /** Share of first-party bookings carrying click attribution (fbclid/fbc), 0..1. null = unknown. */
  firstPartyClickCoverage: number | null
  /** Meta learning state for the unit. */
  inLearning: boolean | null
  /** Resolved audience composition for the unit. */
  audienceComposition: 'retargeting_only' | 'lookalike' | 'broad_advantage' | 'mixed' | 'unknown'
  /** Is there a completed controlled test supporting the causal claim? */
  hasCausalEvidence: boolean
}

export interface ActionabilityCap {
  reason: string
  /** The ceiling this reason imposes, 0..100. */
  ceiling: number
}

export interface ConversionActionability {
  level: ActionabilityLevel
  /** 0..100 after all ceilings. */
  score: number
  /** Every cap that applied, in order — displayed, never just the number. */
  caps: ActionabilityCap[]
  /** Share of conversions that are view-through, 0..1, or null when unknown. */
  viewThroughShare: number | null
  evidenceClass: EvidenceClass
  /** Plain statement of what may and may not be claimed. */
  statement: string
}

/** At or above this view-through share the set is view-through-heavy. */
export const VIEW_THROUGH_HEAVY = 0.5
/** Below this first-party click-attribution coverage, per-unit attribution is weak. */
export const LOW_CLICK_COVERAGE = 0.5
/** A factor-of-N gap between the web-attributed and modelled planes is a conflict, not noise. */
export const PLANE_CONFLICT_RATIO = 3
/** Each cap beyond the first multiplies the score by this — independent weaknesses compound. */
export const COMPOUNDING_DISCOUNT = 0.85

/**
 * PURE: delivery facts (spend, impressions, reach) remain trustworthy when the fetch succeeded.
 * They are measurements, not inferences, and a conversion-side problem must not drag them down.
 */
export function deliveryFactActionability(fetchSucceeded: boolean, dataAgeHours: number | null): ConversionActionability {
  const caps: ActionabilityCap[] = []
  let score = 100
  if (!fetchSucceeded) {
    caps.push({ reason: 'the Meta delivery fetch did not succeed — nothing is measured', ceiling: 0 })
    score = 0
  } else if (dataAgeHours === null) {
    caps.push({ reason: 'data age is unknown — treated as stale', ceiling: 70 })
    score = 70
  } else if (dataAgeHours > 48) {
    caps.push({ reason: `delivery data is ${Math.round(dataAgeHours)}h old`, ceiling: 80 })
    score = 80
  }
  return {
    level: score >= 80 ? 'actionable' : score > 0 ? 'directional' : 'insufficient',
    score,
    caps,
    viewThroughShare: null,
    evidenceClass: 'measurement',
    statement:
      score >= 80
        ? 'Meta delivery facts (spend, impressions, reach, frequency) are measurements and may be stated directly.'
        : 'Meta delivery facts are available but degraded — state them with the caveat shown.',
  }
}

/**
 * PURE: modelled conversions, CPA, ROAS and revenue get their OWN actionability, capped by every
 * applicable weakness with the reason attached.
 */
export function conversionActionability(e: ConversionEvidence): ConversionActionability {
  const caps: ActionabilityCap[] = []

  const total = e.metaConversions
  const viewThroughShare =
    total !== null && total > 0 && e.viewThroughConversions !== null ? e.viewThroughConversions / total : null

  if (total === null) {
    caps.push({ reason: 'no conversion count is available', ceiling: 0 })
  } else {
    caps.push({
      reason: `${total} Meta-attributed conversion(s) are modelled attribution, not an exact paid business-outcome cohort; volume cannot promote this plane into action authority`,
      ceiling: 60,
    })
  }

  if (viewThroughShare === null && total !== null && total > 0) {
    caps.push({ reason: 'the view/click attribution breakdown is UNKNOWN — an unknown mix is not evidence of click-driven conversions', ceiling: 45 })
  } else if (viewThroughShare !== null && viewThroughShare >= VIEW_THROUGH_HEAVY) {
    caps.push({
      reason: `${Math.round(viewThroughShare * 100)}% of attributed conversions are VIEW-THROUGH — view-through attribution is not evidence of incremental impact, only of an impression preceding an outcome`,
      ceiling: 35,
    })
  }

  // GA4 vs Meta conflict. Deliberately NOT a zero-only test: GA4 reporting 1 where Meta reports 10
  // is a 10x disagreement and is exactly as unresolved as 0 vs 10. Any factor-of-N gap counts.
  if (e.ga4PaidConfirmationEvents !== null && total !== null && !(e.ga4PaidConfirmationEvents === 0 && total === 0)) {
    const conflict =
      (e.ga4PaidConfirmationEvents === 0 && total > 0) ||
      (e.ga4PaidConfirmationEvents > 0 && total / e.ga4PaidConfirmationEvents >= PLANE_CONFLICT_RATIO) ||
      (total > 0 && e.ga4PaidConfirmationEvents / total >= PLANE_CONFLICT_RATIO)
    if (conflict) {
      caps.push({
        reason: `GA paid-channel confirmation telemetry (${e.ga4PaidConfirmationEvents}) and Meta modelled attribution (${total}) disagree by ${e.ga4PaidConfirmationEvents === 0 ? 'an unbounded factor' : `~${(total / e.ga4PaidConfirmationEvents).toFixed(1)}x`} — the planes conflict and neither is a confirmed business outcome`,
        ceiling: 40,
      })
    }
  }

  // firstPartyBookings previously entered the function and influenced NOTHING — business
  // truth was accepted as an argument and then ignored. A modelled count that diverges from the
  // first-party record is exactly the case where the modelled plane must not be acted on.
  if (e.firstPartyBookings === null) {
    caps.push({ reason: 'first-party business outcomes are unavailable — the modelled count cannot be checked against business truth', ceiling: 55 })
  } else if (total !== null) {
    if (e.firstPartyBookings === 0 && total > 0) {
      caps.push({
        reason: `Meta attributes ${total} conversion(s) in a window with ZERO first-party ${OW.many} — the modelled plane claims outcomes business truth does not record`,
        ceiling: 20,
      })
    } else if (e.firstPartyBookings > 0 && total > 0) {
      const ratio = Math.max(total / e.firstPartyBookings, e.firstPartyBookings / total)
      if (ratio >= PLANE_CONFLICT_RATIO) {
        caps.push({
          reason: `Meta modelled attribution (${total}) and first-party business truth (${e.firstPartyBookings}) differ by ~${ratio.toFixed(1)}x — the planes disagree and the modelled figure is not confirmed by the business record`,
          ceiling: 45,
        })
      }
    }
  }

  if (e.firstPartyClickCoverage === null) {
    caps.push({ reason: 'first-party click-attribution coverage is unknown', ceiling: 50 })
  } else if (e.firstPartyClickCoverage < LOW_CLICK_COVERAGE) {
    caps.push({
      reason: `only ${Math.round(e.firstPartyClickCoverage * 100)}% of first-party ${OW.many} carry click attribution — per-unit attribution is weak`,
      ceiling: 50,
    })
  }

  if (e.audienceComposition === 'mixed') {
    caps.push({ reason: 'audience composition is MIXED — a per-unit conversion claim cannot be attributed to a single audience kind', ceiling: 45 })
  } else if (e.audienceComposition === 'unknown') {
    caps.push({ reason: 'audience composition is UNKNOWN — the inventory behind these conversions is unresolved', ceiling: 35 })
  }

  if (!e.hasCausalEvidence) {
    caps.push({
      reason: 'no completed controlled test supports a causal claim — modelled attribution alone cannot establish incrementality',
      ceiling: 60,
    })
  }

  // Ceilings COMPOUND. Taking the minimum alone would score one severe weakness identically to five
  // independent ones — but a set that is simultaneously view-through-heavy, thinly attributed, still
  // learning, of mixed composition AND causally unevidenced is materially less actionable than a set
  // with any one of those. Each additional cap beyond the first applies a further discount.
  const lowest = caps.reduce((s, c) => Math.min(s, c.ceiling), 100)
  const extraCaps = Math.max(0, caps.length - 1)
  const score = Math.round(lowest * Math.pow(COMPOUNDING_DISCOUNT, extraCaps))
  const level: ActionabilityLevel = score >= 70 ? 'actionable' : score >= 35 ? 'directional' : 'insufficient'

  return {
    level,
    score,
    caps,
    viewThroughShare,
    evidenceClass: 'modeled_attribution',
    statement:
      level === 'directional'
          ? 'Modelled conversion metrics are DIRECTIONAL only. Do not present them as verified business outcomes, and do not prescribe a direct spend change from them alone.'
          : 'Modelled conversion metrics are INSUFFICIENT to act on. Do not present them as verified business outcomes or prescribe a spend change; state the missing evidence or route to owner review. A test requires its own governed contract.',
  }
}

// ── OPTIMIZATION-EVENT SIGNAL HIERARCHY ────────────────────────────────────────────────────────
// GA paid+non-paid confirmation-event volume is a WEB-OBSERVED lens. It is not the authoritative count of the
// events Meta's optimizer actually receives, and describing it that way overstates what GA4 knows.

export type SignalTier =
  | 'accepted_server_capi'
  | 'browser_server_coverage'
  | 'meta_dataset_event_counts'
  | 'exact_paid_outcomes'
  | 'first_party_outcomes'
  | 'ga4_web_observed'
  | 'meta_modeled_attribution'

/** Ordered strongest -> weakest as evidence of the optimizer's event volume.
 * `exact_paid_outcomes` is intentionally absent: it is the strongest paid BUSINESS-outcome lens,
 * but only a subset of the events Meta may have received and therefore not an optimizer-volume lens. */
export const SIGNAL_HIERARCHY: SignalTier[] = [
  'accepted_server_capi',
  'browser_server_coverage',
  'meta_dataset_event_counts',
  'first_party_outcomes',
  'ga4_web_observed',
  'meta_modeled_attribution',
]

export interface SignalReading {
  tier: SignalTier
  count: number | null
  windowDays: number
  /** How the number was obtained, for audit. */
  provenance: string
  /** Only meaningful for combined browser+server readings. */
  dedupEvidence?: 'shared_event_id_verified' | 'none'
}

export interface OptimizationEventEvidence {
  /** The best available reading, by hierarchy order. */
  best: SignalReading | null
  readings: SignalReading[]
  /** Per-week rate from `best`, or null. */
  perWeek: number | null
  /** True when no reading could be trusted as an event-volume estimate. */
  unresolved: boolean
  notes: string[]
}

/**
 * PURE: pick the strongest available evidence of optimizer event volume, and REFUSE to add browser
 * and server counts together without dedup evidence — the browser pixel and the server CAPI event
 * intentionally describe the SAME booking, so summing them double-counts.
 */
export function resolveOptimizationEventEvidence(readings: SignalReading[]): OptimizationEventEvidence {
  const notes: string[] = []
  const usable = readings.filter((r) => r.count !== null)

  for (const r of usable) {
    if (r.tier === 'browser_server_coverage' && r.dedupEvidence !== 'shared_event_id_verified') {
      notes.push(
        `a combined browser+server reading was supplied WITHOUT dedup evidence — browser and server events describe the same ${OW.one} by design, so they are not summed; the reading is excluded`,
      )
    }
  }
  const admissible = usable.filter(
    (r) => r.tier !== 'exact_paid_outcomes'
      && !(r.tier === 'browser_server_coverage' && r.dedupEvidence !== 'shared_event_id_verified'),
  )

  if (usable.some((r) => r.tier === 'exact_paid_outcomes')) {
    notes.push(
      'exact paid outcomes are retained as the paid business-outcome lens but excluded from optimizer-event volume because they are only a paid, value-bearing subset of possible received events',
    )
  }

  const best =
    SIGNAL_HIERARCHY.map((t) => admissible.find((r) => r.tier === t)).find((r) => r !== undefined) ?? null

  if (best && (best.tier === 'ga4_web_observed' || best.tier === 'meta_modeled_attribution')) {
    notes.push(
      `the strongest available reading is ${best.tier}, which is a ${best.tier === 'ga4_web_observed' ? 'WEB-OBSERVED lens' : 'MODELLED attribution'} — it is NOT the authoritative count of events Meta's optimizer received. Report the optimizer-event volume as UNCERTAIN.`,
    )
  }
  if (best) notes.push(`coverage window: ${best.windowDays} day(s); provenance: ${best.provenance}`)

  return {
    best,
    readings,
    perWeek: best && best.count !== null && best.windowDays > 0 ? (best.count * 7) / best.windowDays : null,
    unresolved: best === null,
    notes,
  }
}
