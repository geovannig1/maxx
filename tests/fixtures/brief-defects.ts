import type { AnswerBrief, AnswerBriefClaim } from '@/lib/maxx/answer-brief'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import { MetricClaimSchema } from '@/lib/cockpit/contracts'
import type { BriefExpectation, BriefGateId } from '@/lib/eval/brief-rubric'

/**
 * Seeded-defect fixtures for the AnswerBrief rubric.
 *
 * Each case is the SAME correct brief with exactly one thing wrong, and names the gate that must catch
 * it. That shape is deliberate: a rubric validated only against good input proves nothing, and the
 * previous instrument in this repo passed its own tests while being unable to fail — `toContain('npm
 * run test:db')` also matched `npm run test:db:integration`. A gate is only real once something known
 * to be broken has been shown to trip it and nothing else.
 *
 * Claims are built through the live schema rather than as bare object literals, so a fixture cannot
 * drift away from the contract it claims to exercise.
 */

const AS_OF = '2026-08-21T12:00:00.000Z'

type ClaimOverrides = {
  metric_key?: string
  level?: MetricClaim['entity']['level']
  plane?: MetricClaim['source']['evidencePlane']
  system?: MetricClaim['source']['system']
  role?: MetricClaim['source']['role']
  lane?: MetricClaim['measurementKind']
  start?: string
  end?: string
  availability?: 'available' | 'unavailable'
}

/**
 * Every claim any fixture citation refers to, keyed by claimId.
 *
 * `scoreBrief` requires the governed claim set, because a brief carries only ids — every property a
 * gate reads (plane, level, window, lane, availability) now comes from the CLAIM. Fixtures therefore
 * have to supply one, and inventing a claim per citation at score time would be exactly the "test the
 * inputs you authored" failure: the map would agree with the citations because both came from the
 * same guess.
 */
const CLAIM_REGISTRY = new Map<string, AnswerBriefClaim>()

/** Scopes a plane can honestly carry, so fixture claims are not arbitrary. */
const SCOPE_BY_PLANE = {
  meta_delivery: 'meta_platform_modelled',
  outcome_business: 'all_sources',
  ga4_telemetry: 'ga4_session_classified',
  paid_association: 'meta_click_associated_noncausal',
  capi_delivery: 'capi_event_delivery',
  decision: 'none',
} as const

/**
 * Register a governed claim and return the ID that cites it.
 *
 * A brief now carries ids, so a fixture cannot drift from the contract by transcribing a field
 * wrongly — there are no fields to transcribe. What it CAN still do is register two different claims
 * under one id, which is why the id below is built from every dimension a case varies on: the
 * registry is a Map, so a colliding id silently keeps the last writer and every gate then reads a
 * claim the case did not intend. Measured under the previous three-field id: 6 of 16 ids resolved to
 * a claim disagreeing on availability, window, measurement lane or entity.
 */
export function citation(over: ClaimOverrides = {}): string {
  const plane = over.plane ?? 'meta_delivery'
  const unavailable = over.availability === 'unavailable'
  const claim = MetricClaimSchema.parse({
    // EVERY dimension a case can vary on, for the collision reason in the doc comment above.
    claimId: [
      over.metric_key ?? 'meta_results', plane, over.level ?? 'account', over.system ?? 'meta',
      over.role ?? 'delivery_truth', over.lane ?? 'modelled', over.start ?? '2026-08-01',
      over.end ?? '2026-08-20', over.availability ?? 'available',
    ].join('|'),
    metricKey: over.metric_key ?? 'meta_results',
    label: over.metric_key ?? 'meta_results',
    value: unavailable ? null : 1,
    unit: 'count',
    formula: null,
    definitionVersion: 1,
    source: {
      system: over.system ?? 'meta',
      role: over.role ?? 'delivery_truth',
      head: 'head',
      evidencePlane: plane,
    },
    entity: { level: over.level ?? 'account', id: 'active' },
    attributionScope: SCOPE_BY_PLANE[plane as keyof typeof SCOPE_BY_PLANE],
    window: {
      start: over.start ?? '2026-08-01',
      end: over.end ?? '2026-08-20',
      basis: 'closed_account_days',
      timezone: 'America/New_York',
    },
    comparison: { method: 'none', window: null },
    asOf: AS_OF,
    availability: unavailable
      ? { state: 'unavailable', blockerCodes: ['paid_manifest_missing'] }
      : { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 1, denominator: 1 },
    maturity: { state: 'settled', matureThrough: '2026-08-20' },
    freshness: { state: 'fresh', observedAt: AS_OF, maxAgeHours: 24 },
    setupFingerprint: 'sf',
    authority: { state: 'context', policyVersion: 'v1' },
    measurementKind: over.lane ?? 'modelled',
    inputClaimIds: [],
  })
  const existing = CLAIM_REGISTRY.get(claim.claimId)
  if (existing && JSON.stringify(existing) !== JSON.stringify(claim)) {
    throw new Error(`fixture claim id collision on ${claim.claimId} — widen the id to cover the varied field`)
  }
  CLAIM_REGISTRY.set(claim.claimId, claim)
  return claim.claimId
}

/** The governed claim set to pass to scoreBrief. Every fixture citation resolves in it. */
export function fixtureClaims(): ReadonlyMap<string, AnswerBriefClaim> {
  return new Map(CLAIM_REGISTRY)
}

export function brief(
  observed: string[],
  unavailable: string[] = [],
  actionIds: string[] = [],
): AnswerBrief {
  return {
    summary: 'governed_claims',
    observations: observed.length > 0 ? [{ claim_ids: observed }] : [],
    action_decision_ids: actionIds,
    unavailable_claim_ids: unavailable,
    next_check: null,
  }
}

/** The question these fixtures answer: reconcile Meta, Acuity and GA4 for the account over one period. */
export const RECONCILIATION_EXPECTATION: BriefExpectation = {
  id: 'reconciliation',
  requiredPlanes: ['meta_delivery', 'outcome_business', 'ga4_telemetry'],
  businessTruthMetrics: ['bookings'],
  mustDeclareUnavailable: ['exact_paid_cpa'],
  // Meta delivery answers at account level; the Acuity ledger only ever answers at business level,
  // because commonClaim stamps that plane 'business'. Both must be declared or the correct
  // multi-plane answer is inadmissible — the defect these fixtures now cover.
  entityLevels: { meta_delivery: ['account'], outcome_business: ['business'], ga4_telemetry: ['account'], paid_association: ['account'] },
  window: { start: '2026-08-01', end: '2026-08-20' },
  actionDecisions: 'either',
}

const META = citation({ metric_key: 'meta_results' })
const ACUITY = citation({
  metric_key: 'bookings', plane: 'outcome_business', system: 'outcomes', role: 'business_truth', lane: 'measured', level: 'business',
})
const GA4 = citation({
  metric_key: 'sessions', plane: 'ga4_telemetry', system: 'ga4', role: 'measurement_qa', lane: 'telemetry',
})
const PAID_CPA_UNAVAILABLE = citation({
  metric_key: 'exact_paid_cpa', plane: 'paid_association', system: 'first_party_attribution',
  role: 'association_truth', lane: 'associated_noncausal', availability: 'unavailable',
})

/** The brief a correct answer produces. Every defect below is this, minus or plus one thing. */
export const CORRECT_BRIEF = brief([META, ACUITY, GA4], [PAID_CPA_UNAVAILABLE])

export interface DefectCase {
  name: string
  /** The single gate that must fail. Every other gate must still pass — a defect that trips two gates
   *  is not localised, and a rubric that fires everywhere is as useless as one that never fires. */
  expected: BriefGateId
  brief: AnswerBrief
  expectation?: BriefExpectation
}

const REQUIRES_DECISION: BriefExpectation = { ...RECONCILIATION_EXPECTATION, actionDecisions: 'required' }
const FORBIDS_DECISION: BriefExpectation = { ...RECONCILIATION_EXPECTATION, actionDecisions: 'forbidden' }

export const DEFECT_CASES: readonly DefectCase[] = [
  // ── G1: the answer never reaches a plane the question needs ────────────────────────────────────
  { name: 'drops the business plane entirely', expected: 'G1_evidence_planes',
    brief: brief([META, GA4], [PAID_CPA_UNAVAILABLE]) },
  { name: 'drops the telemetry plane', expected: 'G1_evidence_planes',
    brief: brief([META, ACUITY], [PAID_CPA_UNAVAILABLE]) },
  { name: 'drops the delivery plane', expected: 'G1_evidence_planes',
    brief: brief([ACUITY, GA4], [PAID_CPA_UNAVAILABLE]) },
  { name: 'cites three claims from one plane — volume, not reconciliation', expected: 'G1_evidence_planes',
    brief: brief([
      META,
      citation({ metric_key: 'meta_spend' }),
      citation({ metric_key: 'meta_impressions' }),
    ], [PAID_CPA_UNAVAILABLE]) },
  { name: 'cites nothing at all', expected: 'G1_evidence_planes',
    brief: brief([], [PAID_CPA_UNAVAILABLE]) },

  // ── G2: Meta's model wearing the business answer's clothes ─────────────────────────────────────
  { name: 'reports bookings from the modelled lane with no business claim', expected: 'G2_no_modelled_substitution',
    brief: brief([
      citation({ metric_key: 'bookings', lane: 'modelled' }),
      GA4,
      citation({ metric_key: 'other', plane: 'outcome_business', system: 'outcomes', role: 'business_truth', lane: 'measured', level: 'business' }),
    ], [PAID_CPA_UNAVAILABLE]) },
  { name: 'grounds a DIFFERENT metric in the business plane and calls it cover', expected: 'G2_no_modelled_substitution',
    brief: brief([
      citation({ metric_key: 'bookings', lane: 'associated_noncausal' }),
      GA4,
      citation({ metric_key: 'revenue', plane: 'outcome_business', system: 'outcomes', role: 'business_truth', lane: 'measured', level: 'business' }),
    ], [PAID_CPA_UNAVAILABLE]) },

  // ── G3: silence about the unmeasurable reads as a complete answer ──────────────────────────────
  { name: 'omits the unmeasurable metric instead of declaring it', expected: 'G3_unavailable_declared',
    brief: brief([META, ACUITY, GA4], []) },
  { name: 'declares a different metric unavailable and leaves the real one unmentioned', expected: 'G3_unavailable_declared',
    brief: brief([META, ACUITY, GA4], [citation({
      metric_key: 'something_else', plane: 'paid_association', system: 'first_party_attribution',
      role: 'association_truth', lane: 'associated_noncausal', availability: 'unavailable',
    })]) },

  // ── G4: a number about the wrong thing ─────────────────────────────────────────────────────────
  { name: 'answers an account question with an adset number', expected: 'G4_entity_level',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'meta_cpa', level: 'adset' })], [PAID_CPA_UNAVAILABLE]) },
  { name: 'answers with a campaign-level number', expected: 'G4_entity_level',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'meta_cpa', level: 'campaign' })], [PAID_CPA_UNAVAILABLE]) },
  { name: 'answers with an ad-level number', expected: 'G4_entity_level',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'meta_ctr', level: 'ad' })], [PAID_CPA_UNAVAILABLE]) },
  { name: 'passes off a business-level number as a Meta delivery metric', expected: 'G4_entity_level',
    // The plane decides the level. A meta_delivery claim at business level is not a roll-up, it is a
    // claim about the wrong object entirely.
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'ltv', level: 'business' })], [PAID_CPA_UNAVAILABLE]) },
  { name: 'cites a plane the question never declares an entity level for', expected: 'G4_entity_level',
    // Fail-closed on an undeclared plane: a new plane must be declared, not silently exempted.
    brief: brief([META, ACUITY, GA4, citation({
      metric_key: 'capi.events', plane: 'capi_delivery', system: 'capi', role: 'delivery_transport', lane: 'operational',
    })], [PAID_CPA_UNAVAILABLE]) },

  // ── G5: a claim measured over another period is another claim ──────────────────────────────────
  { name: 'reaches back before the asked period', expected: 'G5_window_respected',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'meta_spend', start: '2026-07-01' })], [PAID_CPA_UNAVAILABLE]) },
  { name: 'runs past the asked period', expected: 'G5_window_respected',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'meta_spend', end: '2026-08-31' })], [PAID_CPA_UNAVAILABLE]) },
  { name: 'cites a window that brackets the asked period on both sides', expected: 'G5_window_respected',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'meta_spend', start: '2026-07-01', end: '2026-08-31' })], [PAID_CPA_UNAVAILABLE]) },
  { name: 'cites a wholly different month', expected: 'G5_window_respected',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'meta_spend', start: '2026-06-01', end: '2026-06-30' })], [PAID_CPA_UNAVAILABLE]) },

  // ── G6: claims about what the system has decided ───────────────────────────────────────────────
  { name: 'references a governed decision where none is expected', expected: 'G6_action_decisions',
    expectation: FORBIDS_DECISION, brief: brief([META, ACUITY, GA4], [PAID_CPA_UNAVAILABLE], ['ad-1']) },
  { name: 'references two decisions where none is expected', expected: 'G6_action_decisions',
    expectation: FORBIDS_DECISION, brief: brief([META, ACUITY, GA4], [PAID_CPA_UNAVAILABLE], ['ad-1', 'ad-2']) },
  { name: 'omits the governed decision the question turns on', expected: 'G6_action_decisions',
    expectation: REQUIRES_DECISION, brief: brief([META, ACUITY, GA4], [PAID_CPA_UNAVAILABLE]) },
]

/**
 * Briefs that are CORRECT and must be admitted. Without these the suite cannot distinguish a working
 * rubric from one that rejects everything — the failure mode opposite to the one above, and the easier
 * of the two to ship by accident when tightening gates.
 */
export const ADMISSIBLE_CASES: ReadonlyArray<{ name: string; brief: AnswerBrief; expectation?: BriefExpectation }> = [
  { name: 'the correct brief', brief: CORRECT_BRIEF },
  { name: 'correct, with the business metric measured rather than modelled',
    brief: brief([META, citation({ metric_key: 'bookings', plane: 'outcome_business', system: 'outcomes', role: 'business_truth', lane: 'measured', level: 'business' }), GA4], [PAID_CPA_UNAVAILABLE]) },
  { name: 'correct, and the unmeasurable metric became available',
    brief: brief([META, ACUITY, GA4, citation({ metric_key: 'exact_paid_cpa', plane: 'paid_association', system: 'first_party_attribution', role: 'association_truth', lane: 'associated_noncausal' })], []) },
  { name: 'correct, citing a governed decision where one is required',
    expectation: REQUIRES_DECISION, brief: brief([META, ACUITY, GA4], [PAID_CPA_UNAVAILABLE], ['ad-1']) },
  { name: 'correct, declining to cite a decision where none is permitted',
    expectation: FORBIDS_DECISION, brief: CORRECT_BRIEF },
  { name: 'correct, with the business plane reached only by an unavailable declaration',
    brief: brief([META, GA4], [PAID_CPA_UNAVAILABLE, citation({ metric_key: 'bookings', plane: 'outcome_business', system: 'outcomes', role: 'business_truth', lane: 'measured', level: 'business', availability: 'unavailable' })]) },
]

/** Exported so the anti-exploit regression can build the "refuses to cite" counterpart brief. */
export const META_ONLY = META
export const PAID_CPA_UNAVAILABLE_FIXTURE = PAID_CPA_UNAVAILABLE
export const BOOKINGS_UNAVAILABLE_FIXTURE = citation({
  metric_key: 'bookings', plane: 'outcome_business', system: 'outcomes', role: 'business_truth',
  lane: 'measured', level: 'business', availability: 'unavailable',
})
