import { z } from 'zod'
import { formatMoney } from '@/lib/utils/format-currency'
import { isIanaTimeZone } from '@/config/business-config'
import { outcomeNoun } from '@/config/outcome-nouns'

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const isoTimestamp = z.string().datetime({ offset: true })
const blockerCodes = z.array(z.string().trim().min(1).max(160)).superRefine((codes, context) => {
  if (new Set(codes).size !== codes.length) {
    context.addIssue({ code: 'custom', message: 'blocker codes must be unique' })
  }
})

export const ClaimWindowSchema = z.object({
  start: dateOnly,
  end: dateOnly,
  // Impression date assigns Meta delivery/actions to the ad impression day in ET,
  // matching action_report_time=impression; it does not mean conversion occurrence date.
  basis: z.enum(['closed_account_days', 'booking_created_date_et', 'service_date_et', 'interaction_date_et', 'impression_date_et', 'partial_today']),
  timezone: z.string().refine(isIanaTimeZone),
}).strict().superRefine((window, context) => {
  if (window.start > window.end) {
    context.addIssue({ code: 'custom', message: 'window start must not follow window end' })
  }
})

const availabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), blockerCodes: z.tuple([]) }).strict(),
  z.object({ state: z.literal('unavailable'), blockerCodes: blockerCodes.min(1) }).strict(),
])

const coverageSchema = z.object({
  state: z.enum(['complete', 'partial', 'unknown', 'not_applicable']),
  numerator: z.number().int().nonnegative().nullable(),
  denominator: z.number().int().nonnegative().nullable(),
}).strict().superRefine((coverage, context) => {
  const hasPair = coverage.numerator !== null && coverage.denominator !== null
  if ((coverage.numerator === null) !== (coverage.denominator === null)) {
    context.addIssue({ code: 'custom', message: 'coverage numerator and denominator must be supplied together' })
  }
  if (hasPair && coverage.numerator! > coverage.denominator!) {
    context.addIssue({ code: 'custom', message: 'coverage numerator cannot exceed denominator' })
  }
  if (coverage.state === 'complete' && (!hasPair || coverage.numerator !== coverage.denominator)) {
    context.addIssue({ code: 'custom', message: 'complete coverage requires an equal numerator and denominator' })
  }
  if (coverage.state === 'not_applicable' && hasPair) {
    context.addIssue({ code: 'custom', message: 'not-applicable coverage cannot carry counts' })
  }
})

/**
 * The claim vocabularies, exported so tests can ENUMERATE them rather than sample them.
 *
 * Guards in this file branch on both of these. Every defect this codebase has shipped in that shape
 * came from testing the branches someone thought of instead of the branches that exist: the
 * cross-plane guard was written against `derived`, and relabelling the same blended claim
 * `associated_noncausal` or `causal_estimate` walked straight past it. A test that reads these arrays
 * cannot make that mistake.
 *
 * Adding a member here does NOT fail the totality suite — verified, not assumed. A new kind is
 * classified by rule as non-exempt, so it must not cross planes, and a new scope is classified as not
 * an honest crossing declaration. Both default fail-closed, which is the safe direction; what the
 * suite guarantees is that the new member is EXERCISED against every other value rather than silently
 * skipped. Deliberate exemption still requires editing the guard.
 */
export const ATTRIBUTION_SCOPES = [
  'none', 'all_sources', 'meta_platform_modelled', 'meta_click_associated_noncausal',
  'ga4_session_classified', 'capi_event_delivery', 'causal_estimate',
] as const

/**
 * How each attribution scope reads to a person. Exported so every surface says the same thing.
 *
 * Rendered raw, these tokens mislead. `claimLine` put `attributionScope` in a field labelled
 * `caveat:`, and `meta.spend` carries `'none'` — so the line read `caveat: none`, i.e. "no caveats",
 * on the metric that most needs one. `PerformanceScorecard` renders the same token in a field labelled
 * `scope`. Two surfaces, two wrong readings, one enum.
 *
 * `'none'` is the subtle one and the wording is deliberate: it does NOT mean "all sources". It means
 * the metric has no attribution dimension at all — spend, impressions and link clicks are not
 * attributed things. Every cost-per-X in the builder divides an unattributed cost by an attributed
 * count, which is why scope-mixing inside one claim's lineage is normal and correct.
 *
 * A Record over the enum, not a switch with a default: a default silently renders a fallback for the
 * member nobody thought about, and `all_sources` — the one that matters once business truth is
 * citable — has never been assigned anywhere in src.
 */
export const ATTRIBUTION_SCOPE_DESCRIPTIONS: Record<(typeof ATTRIBUTION_SCOPES)[number], string> = {
  none: 'not attributed',
  all_sources: 'all sources (paid + organic)',
  meta_platform_modelled: 'Meta modelled',
  meta_click_associated_noncausal: 'Meta click association (non-causal)',
  ga4_session_classified: 'GA4 session classification',
  capi_event_delivery: 'CAPI event delivery',
  causal_estimate: 'modelled causal estimate',
}

/**
 * Owner words for claim provenance, total Records over the MetricClaim enums — same rule as
 * ATTRIBUTION_SCOPE_DESCRIPTIONS: a Record, not a switch with a default, so a member nobody thought
 * about fails to compile rather than silently rendering a fallback. Exported so the cell flags and
 * the evidence drawer say the same thing (Ledger B′); they live here, beside the enums, and not in
 * the cockpit component because that surface's source is guarded against business-plane vocabulary.
 */
export const CLAIM_SOURCE_LABEL: Record<MetricClaim['source']['system'], string> = {
  meta: 'Meta Ads Manager',
  outcomes: `recorded ${outcomeNoun()}`,
  first_party_attribution: 'Maxx first-party',
  ga4: 'GA4',
  capi: 'Conversions API',
  maxx: 'Maxx',
}
export const MATURITY_LABEL: Record<MetricClaim['maturity']['state'], string> = {
  settled: 'Settled',
  settling: 'Still settling',
  partial: 'Partial data',
  not_applicable: 'Not applicable',
}
export const FRESHNESS_LABEL: Record<MetricClaim['freshness']['state'], string> = {
  fresh: 'Current',
  stale: 'Stale data',
  unknown: 'Data age unknown',
}
export const AVAILABILITY_LABEL: Record<MetricClaim['availability']['state'], string> = {
  available: 'Available',
  unavailable: 'Unavailable',
}
export const COVERAGE_LABEL: Record<MetricClaim['coverage']['state'], string> = {
  complete: 'Complete coverage',
  partial: 'Partial coverage',
  unknown: 'Coverage unknown',
  not_applicable: 'Coverage n/a',
}
/**
 * Ledger G. Owner words for an evidence plane. Lives beside the other label maps for the same reason
 * they do: the enum values are engineering vocabulary, and a surface that renders
 * `plane.replaceAll('_', ' ')` leaks a schema token into the owner's page.
 */
export const EVIDENCE_PLANE_LABEL: Record<MetricClaim['source']['evidencePlane'], string> = {
  meta_delivery: 'Meta delivery',
  outcome_business: `recorded ${outcomeNoun()}`,
  paid_association: 'Paid attribution',
  ga4_telemetry: 'GA4 telemetry',
  capi_delivery: 'Conversions API',
  decision: 'Maxx decisions',
}

/**
 * Evidence planes whose population is paid delivery.
 *
 * Used to detect the one adjacency that actually misleads: an all-source booking count rendered
 * beside a paid-only amount, where a reader divides one by the other and gets something that looks
 * like a paid CPA. No arithmetic occurs, so no lineage guard can see it.
 *
 * This replaced a set of attributionScopes, which was the wrong axis. Scope names a measurement
 * METHOD; the plane names the POPULATION. `'none'` means "no attribution dimension" — true of Meta
 * spend and equally true of an unattributed business total — so treating it as paid-only was correct
 * only by the accident that every `'none'` claim in src is meta_delivery. From the other side,
 * `ga4_session_classified` was excluded because GA4 classification can be organic, which made an
 * all-source count beside paid-social sessions render with no notice at all.
 *
 * This is NOT a rule against mixing scopes. That is ordinary, and the builder does it inside its own
 * blessed lineage: meta.cost_per_result divides `none` spend by `meta_platform_modelled` results.
 */
export const PAID_DELIVERY_PLANES: ReadonlySet<MetricClaim['source']['evidencePlane']> = new Set([
  'meta_delivery', 'paid_association', 'capi_delivery',
] as const)

export const MEASUREMENT_KINDS = [
  'measured', 'modelled', 'derived', 'operational', 'telemetry',
  'associated_noncausal', 'causal_estimate',
] as const

/** A claim id, and each input claim id: one rule, shared by MetricClaimSchema and reidentifyMetricClaim. */
const ClaimIdSchema = z.string().trim().min(1).max(240)

export const MetricClaimSchema = z.object({
  claimId: ClaimIdSchema,
  metricKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  value: z.union([z.number().finite(), z.string().trim().min(1), z.null()]),
  unit: z.enum(['money', 'count', 'ratio', 'percent', 'seconds', 'days', 'hours', 'state']),
  formula: z.string().trim().min(1).max(500).nullable(),
  definitionVersion: z.number().int().positive(),
  source: z.object({
    system: z.enum(['meta', 'outcomes', 'first_party_attribution', 'ga4', 'capi', 'maxx']),
    role: z.enum([
      'delivery_truth', 'business_truth', 'association_truth', 'measurement_qa',
      'delivery_transport', 'decision_context',
    ]),
    head: z.string().trim().min(1).max(160).nullable(),
    evidencePlane: z.enum([
      'meta_delivery', 'outcome_business', 'paid_association', 'ga4_telemetry',
      'capi_delivery', 'decision',
    ]),
  }).strict(),
  entity: z.object({
    level: z.enum(['account', 'campaign', 'adset', 'ad', 'business']),
    id: z.string().trim().min(1).max(160),
  }).strict(),
  attributionScope: z.enum(ATTRIBUTION_SCOPES),
  window: ClaimWindowSchema,
  comparison: z.object({
    method: z.enum(['none', 'prior_equal_period']),
    window: ClaimWindowSchema.nullable(),
  }).strict().superRefine((comparison, context) => {
    if ((comparison.method === 'none') !== (comparison.window === null)) {
      context.addIssue({ code: 'custom', message: 'comparison method and window must agree' })
    }
  }),
  asOf: isoTimestamp,
  availability: availabilitySchema,
  coverage: coverageSchema,
  maturity: z.object({
    state: z.enum(['settled', 'settling', 'partial', 'not_applicable']),
    matureThrough: dateOnly.nullable(),
  }).strict(),
  freshness: z.object({
    state: z.enum(['fresh', 'stale', 'unknown']),
    observedAt: isoTimestamp.nullable(),
    maxAgeHours: z.number().positive().nullable(),
  }).strict(),
  setupFingerprint: z.string().trim().min(1).max(256).nullable(),
  authority: z.object({
    state: z.enum(['authoritative', 'context', 'diagnostic', 'blocked']),
    policyVersion: z.string().trim().min(1).max(120),
  }).strict(),
  measurementKind: z.enum(MEASUREMENT_KINDS),
  inputClaimIds: z.array(ClaimIdSchema),
}).strict().superRefine((claim, context) => {
  if (claim.availability.state === 'available' && claim.value === null) {
    context.addIssue({ code: 'custom', message: 'available claims require a value', path: ['value'] })
  }
  if (claim.availability.state === 'unavailable' && claim.value !== null) {
    context.addIssue({ code: 'custom', message: 'unavailable claims cannot carry a value', path: ['value'] })
  }
  if (claim.measurementKind === 'derived' && claim.availability.state === 'available'
      && claim.inputClaimIds.length === 0) {
    context.addIssue({ code: 'custom', message: 'available derived claims require input claims', path: ['inputClaimIds'] })
  }
  if (new Set(claim.inputClaimIds).size !== claim.inputClaimIds.length) {
    context.addIssue({ code: 'custom', message: 'input claim IDs must be unique', path: ['inputClaimIds'] })
  }
  if (claim.availability.state === 'available' && (claim.unit === 'ratio' || claim.unit === 'percent')
      && claim.coverage.state !== 'complete') {
    context.addIssue({
      code: 'custom', message: 'available ratios require complete coverage', path: ['coverage'],
    })
  }
})

export type MetricClaimInput = z.input<typeof MetricClaimSchema>
export type MetricClaim = z.output<typeof MetricClaimSchema>

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

// Frozen claim objects already validated: a frozen object cannot change, so its validated claim is
// reused. createMetricClaim's claims, the claims a document parse returned, and the frozen claims of an
// expanded compact packet (src/lib/reporting/compact-json.ts) are recorded here.
const validatedFrozenClaims = new WeakMap<object, MetricClaim>()

/**
 * MetricClaimSchema for a claim that may occur many times in one document (a report packet): each
 * distinct FROZEN claim object is validated once, and every later occurrence, in this or a later parse,
 * reuses that result. Anything not frozen is validated in full every time, exactly as MetricClaimSchema.
 * Success, output (frozen when reused) and issues (same codes, messages and paths) are those of
 * MetricClaimSchema (tests/reporting-claim-validation-once.test.ts).
 */
export const DocumentMetricClaimSchema: z.ZodType<MetricClaim, unknown> = z.unknown().transform((value, context) => {
  const frozen = value !== null && typeof value === 'object' && Object.isFrozen(value)
  if (frozen) {
    const cached = validatedFrozenClaims.get(value)
    if (cached) return cached
  }
  const result = MetricClaimSchema.safeParse(value)
  if (!result.success) {
    for (const issue of result.error.issues) context.issues.push({ ...issue, input: value } as never)
    return z.NEVER
  }
  if (!frozen) return result.data
  const claim = deepFreeze(result.data)
  validatedFrozenClaims.set(value, claim)
  validatedFrozenClaims.set(claim, claim)
  return claim
})

/** The only supported constructor: validates the complete claim, then freezes it recursively. */
export function createMetricClaim(input: MetricClaimInput): MetricClaim {
  const claim = deepFreeze(MetricClaimSchema.parse(input))
  validatedFrozenClaims.set(claim, claim)
  return claim
}

const ClaimIdentitySchema = z.object({ claimId: ClaimIdSchema, inputClaimIds: z.array(ClaimIdSchema) }).superRefine((claim, context) => {
  if (new Set(claim.inputClaimIds).size !== claim.inputClaimIds.length) {
    context.addIssue({ code: 'custom', message: 'input claim IDs must be unique', path: ['inputClaimIds'] })
  }
})

/**
 * A validated claim under a new id and input ids, everything else unchanged. Equivalent to
 * createMetricClaim({ ...claim, claimId, inputClaimIds }) for a claim createMetricClaim produced: the
 * other fields already passed the schema and no rule but input-id uniqueness reads the ids, so only
 * the changed fields are validated (the same field rules and the same uniqueness rule).
 */
export function reidentifyMetricClaim(claim: MetricClaim, claimId: string, inputClaimIds: readonly string[]): MetricClaim {
  const ids = ClaimIdentitySchema.parse({ claimId, inputClaimIds: [...inputClaimIds] })
  const reidentified = deepFreeze({ ...claim, claimId: ids.claimId, inputClaimIds: ids.inputClaimIds })
  validatedFrozenClaims.set(reidentified, reidentified)
  return reidentified
}

/**
 * Evidence surfaced on a decision card for one recommendation.
 *
 * Each item is either a resolved MetricClaim snapshot (missing = false) or a placeholder for a
 * claim ID the recommendation asserted but which could not be found in the immutable snapshot
 * (missing = true). The window is the claim's own snapshot window, not the recommendation's
 * date range, because a recommendation can synthesize across windows and the owner must be able
 * to see that.
 */
export interface RecommendationEvidenceItem {
  claimId: string
  metricKey: string
  label: string
  value: number | string | null
  unit: MetricClaim['unit']
  window: { start: string; end: string }
  sourceSystem: MetricClaim['source']['system']
  maturity: MetricClaim['maturity']['state']
  freshness: MetricClaim['freshness']['state']
  availability: MetricClaim['availability']['state']
  missing: boolean
}

/**
 * Format an evidence value by unit. A total Record, not a switch with a default, so a unit nobody
 * thought about fails to compile rather than rendering a silent fallback on a metric where the
 * unit matters.
 */
export const RECOMMENDATION_EVIDENCE_VALUE_FORMATTER: Record<MetricClaim['unit'], (value: number | string | null) => string> = {
  money: (value) => typeof value === 'number' ? formatMoney(value) : 'Unavailable',
  count: (value) => typeof value === 'number' ? `${value}` : 'Unavailable',
  ratio: (value) => typeof value === 'number' ? `${value.toFixed(2)}×` : 'Unavailable',
  percent: (value) => typeof value === 'number' ? `${value.toFixed(1)}%` : 'Unavailable',
  seconds: (value) => typeof value === 'number' ? `${value.toFixed(1)} s` : 'Unavailable',
  days: (value) => typeof value === 'number' ? `${value.toFixed(1)} days` : 'Unavailable',
  hours: (value) => typeof value === 'number' ? `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} h` : 'Unavailable',
  state: (value) => typeof value === 'string' ? value : 'Unavailable',
}

/**
 * Refuse any derived claim computed across evidence planes.
 *
 * `MetricClaimSchema` cannot enforce this: `inputClaimIds` are strings, so the schema sees lineage but
 * never the planes behind it. It requires the inputs to be non-empty and unique and stops there. That
 * leaves the arithmetic wide open — `meta.cost_per_result` at builder.ts:174 is
 * `spend.value / results.value` with both ids in `inputClaimIds`, and copying that block with an
 * outcome-source booking count as the denominator produces a fully valid, deep-frozen claim that is
 * indistinguishable downstream from a governed Meta metric.
 *
 * That number is the one this account must never produce. Meta spend is paid-only; an outcome-source booking
 * count is all sources, organic and paid together. Dividing one by the other yields something that
 * looks exactly like a paid CPA and is not one — an error Meta's own AI chat has been seen to make, and
 * with a handful of verified paid touches against over a thousand active bookings there is no honest
 * paid denominator to build it from. Prefer "cannot be constructed" over "constructed with a caveat": a caveat is a string a reader
 * may skip, while a throw is a fact.
 *
 * `causal_estimate` and `associated_noncausal` are exempt BY NAME, because combining planes is what
 * they are for — a causal estimate of paid effect on business outcomes crosses planes by definition.
 * The exemption is the measurement kind declaring itself, not a hole.
 */
export function assertNoCrossPlaneLineage(claims: Readonly<Record<string, MetricClaim>>): void {
  const CROSS_PLANE_KINDS = new Set(['causal_estimate', 'associated_noncausal'])
  for (const claim of Object.values(claims)) {
    if (claim.inputClaimIds.length === 0) continue
    const plane = claim.source.evidencePlane
    // An exempt measurement kind is NOT a free pass. The first version of this guard skipped these
    // two kinds outright, and that was a one-word bypass: relabelling a blended `derived` claim
    // `associated_noncausal` constructed $22.50/booking from paid-only spend over an all-source
    // denominator, kept `attributionScope: 'none'` on the output, and passed. Proven by execution —
    // the HONEST label was blocked and the dishonest one was not, an incentive gradient toward
    // mislabelling.
    //
    // So an exempt kind must also declare the population it produced. A value computed across planes
    // is a modelled estimate about the relationship between two populations, and `causal_estimate` is
    // the scope that says so. Any other scope on a cross-plane claim asserts a population the claim
    // does not have. The rule fires only where a crossing is actually detected, so a same-plane
    // associational claim is untouched.
    if (CROSS_PLANE_KINDS.has(claim.measurementKind)) {
      const crosses = claim.inputClaimIds.some(
        (id) => claims[id] && claims[id].source.evidencePlane !== plane,
      )
      if (crosses && claim.attributionScope !== 'causal_estimate') {
        throw new Error(
          `MetricClaim ${claim.claimId} declares measurementKind '${claim.measurementKind}' to cross `
          + `evidence planes but carries attributionScope '${claim.attributionScope}'. A value computed `
          + "across planes describes a modelled relationship between two populations; declare "
          + "attributionScope 'causal_estimate' or do not cross.",
        )
      }
      continue
    }
    for (const inputId of claim.inputClaimIds) {
      const input = claims[inputId]
      // A lineage id that resolves to nothing is its own defect: the claim asserts a derivation that
      // cannot be checked, which is exactly the shape of a forged reference.
      if (!input) {
        throw new Error(
          `MetricClaim ${claim.claimId} lists input ${inputId}, which is not in the claim set.`,
        )
      }
      if (input.source.evidencePlane !== plane) {
        throw new Error(
          `MetricClaim ${claim.claimId} (${plane}) is derived from ${inputId} `
          + `(${input.source.evidencePlane}). A value computed across evidence planes describes no `
          + 'single population — paid-only spend over an all-source denominator is not a paid CPA. '
          + `Declare measurementKind 'causal_estimate' or 'associated_noncausal' if the crossing is `
          + 'deliberate and modelled.',
        )
      }
    }
  }
}

/**
 * Ledger G. Health per EVIDENCE PLANE, not one hard-coded row.
 *
 * `plane` was a `z.literal('meta_delivery')` and the array was `.length(1)`, so Today could only
 * ever say how the Meta ETL was doing. GA4 and the outcome ledger were silent — or, worse, inferred
 * on the page from env config, which is invented availability: "a key is configured" is not "the
 * plane answered".
 *
 * A plane appears here ONLY when a reader supplied real evidence for it. An absent plane is omitted,
 * never emitted as `unavailable`. Omission says "not established"; `unavailable` says "established,
 * and it is down". Collapsing those is the same error as reading an empty result as absence.
 */
const sourceHealthSchema = z.object({
  plane: z.enum(['meta_delivery', 'outcome_business', 'ga4_telemetry']),
  state: z.enum(['available', 'unavailable', 'partial', 'stale']),
  synchronizedAt: isoTimestamp.nullable(),
  blockerCodes,
  /**
   * False = no claim rendered on this page reads this plane. The cell then renders "Not a Today
   * source" in neutral styling instead of an amber/red alarm, because alarming the owner about a
   * plane nothing on the page consumes is a false signal — GA4 outages already page through
   * monitoring. Computed by the builder from the assembled claim set, never asserted by a caller.
   */
  consumedByToday: z.boolean(),
}).strict()

export const PerformanceCockpitDataSchema = z.object({
  contractVersion: z.literal(4),
  account: z.object({
    id: z.string().trim().min(1),
    metaAccountId: z.string().trim().min(1),
    name: z.string().trim().min(1).nullable(),
  }).strict(),
  controls: z.object({ range: ClaimWindowSchema }).strict(),
  clocks: z.object({
    deliveryClosedThrough: dateOnly.nullable(),
    conversionMatureThrough: dateOnly,
    synchronizedAt: isoTimestamp.nullable(),
  }).strict(),
  claims: z.record(z.string(), MetricClaimSchema),
  paidPerformance: z.object({
    spendClaimId: z.string(),
    pacingClaimId: z.string(),
    resultsClaimId: z.string(),
    costPerResultClaimId: z.string(),
    purchaseRoasClaimId: z.string(),
    linkCtrClaimId: z.string(),
    cpmClaimId: z.string(),
    frequencyClaimId: z.string(),
    costPerLeadClaimId: z.string().nullable(),
    // IDS, not a metricKey lookup. These two shipped resolved by
    // `Object.values(claims).find((c) => c.metricKey === key)`, which was safe only while the claim set
    // held one claim per metric. Per-metric trends ended that: `support` carries the SAME metricKey for
    // the prior and settling windows and is spread ahead of the requested claims, so `.find()` returned
    // the prior window — the page printed last period's reach and a learning rate off by 20×.
    reachClaimId: z.string(),
    optimizationRateClaimId: z.string(),
  }).strict(),
  partialToday: z.object({
    date: dateOnly,
    state: z.enum(['available', 'unavailable', 'partial']),
    claimIds: z.array(z.string()),
  }).strict(),
  comparison: z.object({
    state: z.enum(['available', 'unavailable', 'not_requested']),
    window: ClaimWindowSchema.nullable(),
    claimIds: z.array(z.string()),
  }).strict(),
  /**
   * Ledger G: was `.length(1)`. Meta delivery stays MANDATORY — this is a Meta cockpit and a page
   * that cannot say how its own primary plane is doing is not shippable — but the other planes are
   * present only when established. `.min(1)` plus the refinement below encodes exactly that.
   */
  sourceHealth: z.array(sourceHealthSchema).min(1)
    .refine(
      (rows) => rows.some((row) => row.plane === 'meta_delivery'),
      { message: 'sourceHealth must include the meta_delivery plane' },
    )
    .refine(
      (rows) => new Set(rows.map((row) => row.plane)).size === rows.length,
      { message: 'sourceHealth must carry at most one row per evidence plane' },
    ),
  decisionIds: z.array(z.string()),
  primaryDecisionId: z.string().nullable(),
  primaryDecision: z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    bucket: z.enum(['needs_review', 'tracking_repair', 'monitoring', 'awaiting_implementation', 'outcome_review', 'snoozed']),
    lifecycle: z.string(),
    authority: z.enum(['execution_eligible', 'owner_review', 'diagnostic_only']),
    reviewDate: dateOnly.nullable(),
  }).nullable(),
}).strict().superRefine((cockpit, context) => {
  const referenced = [
    ...Object.values(cockpit.paidPerformance),
    ...cockpit.partialToday.claimIds,
    ...cockpit.comparison.claimIds,
  ].filter((claimId): claimId is string => claimId !== null)
  for (const claimId of referenced) {
    if (!cockpit.claims[claimId]) {
      context.addIssue({ code: 'custom', message: `referenced claim is missing: ${claimId}`, path: ['claims'] })
    }
  }
  if (cockpit.primaryDecisionId !== null && !cockpit.decisionIds.includes(cockpit.primaryDecisionId)) {
    context.addIssue({ code: 'custom', message: 'primary decision must be present in decision IDs' })
  }
  if ((cockpit.primaryDecision?.id ?? null) !== cockpit.primaryDecisionId) {
    context.addIssue({ code: 'custom', message: 'primary decision summary must match primary decision ID' })
  }
})

export type PerformanceCockpitData = z.output<typeof PerformanceCockpitDataSchema>

/** Validate and recursively freeze the response before it crosses a server/API boundary. */
export function createPerformanceCockpitData(input: z.input<typeof PerformanceCockpitDataSchema>): PerformanceCockpitData {
  return deepFreeze(PerformanceCockpitDataSchema.parse(input))
}
