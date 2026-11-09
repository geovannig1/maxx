import { z } from 'zod'
import {
  ATTRIBUTION_SCOPE_DESCRIPTIONS, MetricClaimSchema, PAID_DELIVERY_PLANES, type MetricClaim,
} from '@/lib/cockpit/contracts'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { displayValue } from './answer-values'
import { composeAnswerSummary } from './answer-summary'
import { evidenceHeading } from './answer-sections'

const claimId = z.string().trim().min(1).max(240)

const SOURCE_TIMESTAMP_METRICS = new Set([
  'meta.ad.delivery_sub_status',
  'meta.adset.delivery_sub_status',
  'meta.adset.audience_readiness',
  'capi.dataset_quality',
])

const persistedFinalActionDecisionSchema = z.object({
  id: claimId,
  persisted: z.literal(true),
  final: z.literal(true),
  record_type: z.literal('action_decisions'),
  policy_version: z.number().int().min(ACTION_DECISION_POLICY_FLOOR),
  action_kind: z.enum([
    'budget_scale', 'budget_cut', 'pause', 'activate',
    'creative_refresh', 'structural', 'observe',
  ]).optional(),
  authority_tier: z.enum(['execution_eligible', 'owner_review', 'diagnostic_only']),
  approval_state: z.enum(['not_requested', 'pending', 'approved', 'rejected']),
  owner_copy: z.string().trim().min(1).max(1_200)
    .refine((value) => !/[\r\n]/.test(value)).optional(),
  lineage: z.object({
    source_kind: z.enum(['flag', 'recommendation', 'alert', 'diagnostic', 'evaluator', 'report', 'creative_fatigue', 'legacy']),
    source_id: z.string().trim().min(1).max(240).nullable(),
  }).strict(),
}).strict()

export type PersistedFinalActionDecisionEvidence = z.infer<typeof persistedFinalActionDecisionSchema>

export function parsePersistedFinalActionDecisionEvidence(value: unknown): PersistedFinalActionDecisionEvidence[] {
  return z.array(persistedFinalActionDecisionSchema).max(100).parse(value)
}

/**
 * The model SELECTS governed claims by id. It does not transcribe them.
 *
 * This used to require a full `AnswerBriefClaimPredicate` per citation — ten nested fields copied
 * byte-exactly from the claim — which `matchingPredicateError` then compared against
 * `createAnswerBriefClaimPredicate(claim)`, re-derived from the very claim the id had just selected.
 * A server-vs-server comparison. The claim was already fetched BY `claim_id`, and an id absent from
 * the governed set is rejected by that lookup, so the nine other fields decided nothing: they could
 * only match (no-op) or mismatch (throw). Zero bits of selection power, and `claimLine` renders from
 * the claim, never from the predicate, so a transcription could not reach the output either.
 *
 * They were not merely inert, they were harmful, in two measured ways:
 *
 *   COST — one predicate serialises to ~723-983 bytes, roughly 200-330 output tokens. `max_tokens`
 *   is 2048, so ~8 citations exhausted the entire budget, while this schema permitted 8 observations
 *   x 8 predicates plus 8 unavailable = 72. The cockpit alone publishes 13 claims; citing all of them
 *   cost over the whole budget. A complete brief could not be emitted.
 *
 *   CORRECTNESS — `claimId` is `metricKey:start:end` but `asOf` is stamped per load
 *   (`loader.ts:30`), so two cockpit calls in one turn produce the same id with a different
 *   `lineage.as_of`. The second overwrote the first in `claimsById`; the model had transcribed the
 *   first; `matchingPredicateError` returned 'lineage'; the answer was withheld with the same opaque
 *   message a genuine schema failure produces. One drifted character anywhere in 723 bytes — in the
 *   24-char timestamp, in `head`, or in the ORDER of `input_claim_ids` — did the same.
 *
 * `action_decision_ids` was already id-only in this same schema, validated server-side. Claims now
 * match it.
 */
const answerBriefSchema = z.object({
  /** Literal mode: model-authored summaries are not accepted. */
  summary: z.literal('governed_claims'),
  observations: z.array(z.object({
    claim_ids: z.array(claimId).min(1).max(8),
  }).strict()).max(8),
  action_decision_ids: z.array(claimId).max(3),
  unavailable_claim_ids: z.array(claimId).max(16),
  /**
   * Follow-up prose could make an unsupported factual or action claim, so the only legal value is
   * null — and `.default(null)` means an ABSENT key is also legal, because to a JSON author omitting
   * a key and writing null are the same statement.
   *
   * `z.null()` alone rejected `undefined`, and that is not hypothetical: measured against production
   * immediately after this schema change, the model returned an otherwise perfect brief with
   * `next_check` simply left out, and the whole answer was withheld with "did not come back in the
   * governed format". A contract that fails on a distinction its author cannot perceive is a contract
   * defect, not a violation.
   *
   * The guarantee is unchanged: any non-null value is still rejected, which the `semantic-action-claim`
   * governance preflight proves by submitting "Pause the campaign now."
   */
  next_check: z.null().default(null),
}).strict()

export type AnswerBrief = z.infer<typeof answerBriefSchema>
export type AnswerBriefClaim = MetricClaim

/**
 * Parse an already-decoded brief.
 *
 * The model no longer writes the brief as JSON text in an assistant turn; it submits it as the input
 * of a forced tool call, which arrives pre-decoded and pre-validated against the tool's schema.
 */
export function parseAnswerBriefValue(value: unknown): AnswerBrief {
  return answerBriefSchema.parse(value)
}

/**
 * Canonicalize a strict, id-only submission against the governed claims from this turn.
 *
 * Anthropic strict mode does not support `maxItems`, so it can accept a structurally valid tool call
 * whose arrays exceed the zod bounds. Rejecting that whole turn made a presentation limit look like
 * a governance failure. The server owns both facts the model cannot safely assert: which selected ids
 * exist, and whether each is available. It therefore deduplicates exact ids, assigns them from the
 * governed claim state, and chunks available claims into the existing eight-by-eight render bound.
 * Unknown ids and every prose/extra-field shape still fail closed.
 */
const submittedAnswerBriefSchema = z.object({
  summary: z.literal('governed_claims'),
  observations: z.array(z.object({
    claim_ids: z.array(claimId).min(1).max(128),
  }).strict()).max(128),
  action_decision_ids: z.array(claimId).max(3),
  unavailable_claim_ids: z.array(claimId).max(128),
  next_check: z.null().default(null),
}).strict()

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/** The owner surface the brief renders onto. The producer of `required_claim_ids` must fit inside it. */
export const MAX_AVAILABLE_BRIEF_CLAIMS = 64
export const MAX_UNAVAILABLE_BRIEF_CLAIMS = 16

export function normalizeAnswerBriefValue(
  value: unknown,
  claimsById: ReadonlyMap<string, AnswerBriefClaim>,
  requiredClaimIds: readonly string[] = [],
  requiredActionDecisionIds: readonly string[] = [],
): AnswerBrief {
  const submitted = submittedAnswerBriefSchema.parse(value)
  const selected = uniqueIds([
    ...requiredClaimIds,
    ...submitted.observations.flatMap((observation) => observation.claim_ids),
    ...submitted.unavailable_claim_ids,
  ])
  const available: string[] = []
  const unavailable: string[] = []
  for (const id of selected) {
    const claim = claimsById.get(id)
    if (!claim) throw new Error(`AnswerBrief referenced unknown claim ${id}.`)
    if (claim.availability.state === 'available') available.push(id)
    else unavailable.push(id)
  }
  // Keep the total owner surface bounded: at most 64 available claims and sixteen unavailable
  // claims. The latter covers a two-ad-set audit when both setup fields and all account evidence
  // planes are unavailable. A larger required packet is a server defect, never something to
  // truncate silently after declaring it required.
  //
  // Exported because the PRODUCER has to respect the same number. It did not: the governed audit
  // marked three claims required per unsynced ad set with no bound, so a six-ad-set account
  // over-declared and every governed answer was withheld here as `brief: null`. One constant, read
  // by both sides, is what stops the producer and the renderer disagreeing about the budget again.
  if (available.length > MAX_AVAILABLE_BRIEF_CLAIMS || unavailable.length > MAX_UNAVAILABLE_BRIEF_CLAIMS) {
    throw new Error('AnswerBrief selected more governed claims than the owner surface can render.')
  }
  const observations: AnswerBrief['observations'] = []
  for (let index = 0; index < available.length; index += 8) {
    observations.push({ claim_ids: available.slice(index, index + 8) })
  }
  const actionDecisionIds = uniqueIds([
    ...requiredActionDecisionIds,
    ...submitted.action_decision_ids,
  ])
  if (actionDecisionIds.length > 3) {
    throw new Error('AnswerBrief selected more persisted decisions than the owner surface can render.')
  }
  return answerBriefSchema.parse({
    summary: submitted.summary,
    observations,
    action_decision_ids: actionDecisionIds,
    unavailable_claim_ids: unavailable,
    next_check: null,
  })
}

export function parseAnswerBrief(raw: string): AnswerBrief {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Maxx did not return a valid structured AnswerBrief.')
  }
  return answerBriefSchema.parse(parsed)
}

/** Accept only claim objects deliberately emitted by a governed tool/cockpit adapter. */
export function parseAnswerBriefClaims(value: unknown): AnswerBriefClaim[] {
  const candidates = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? Object.values(value as Record<string, unknown>)
      : []
  return z.array(MetricClaimSchema).max(500).parse(candidates)
}


/**
 * One rendered evidence line.
 *
 * The trailing field used to be `caveat:`, packing three unrelated facts under a word meaning
 * "warning": the attribution scope, the maturity state, and the freshness state. Two problems, both
 * measured rather than argued. First, `meta.spend` carries `attributionScope: 'none'`, so the line
 * read `caveat: none` — "no caveats" — on the metric a reader is most likely to divide by something.
 * Second, maturity was ALREADY rendered earlier in the same line, so the composite was one novel
 * value, one duplicate, and one novel value. Freshness, meanwhile, appeared nowhere else and was
 * buried under a label that did not name it.
 *
 * Split into fields that say what they hold. Unavailable claims get `blocked by:`, because "caveat"
 * understates a hard unavailability that `availability: unavailable` has already announced.
 */
/**
 * Blocker codes for one claim, BOUNDED.
 *
 * `blockerCodes.join(', ')` was unbounded, and the codes are not a fixed vocabulary: `source-readers`
 * emits one DATE-STAMPED code per missing day (`meta_account_spend_day_missing:2026-08-04`, ~41
 * chars), and a trend claim merges both sides' codes. A 90-day window — which `closed-date-range`
 * permits — puts ~180 codes, roughly 7,400 characters, on ONE line; eight such observations exceed
 * the 24,000-char assistant bound and then the history bound, producing the same generic red banner
 * the message-bound work set out to remove, one layer down.
 *
 * Counting the repeats instead of listing them also reads better: "27 days of Meta spend missing" is
 * the fact, and 27 dates is the same fact rendered as noise.
 */
const MAX_LISTED_BLOCKERS = 4

export function summariseBlockers(codes: readonly string[]): string {
  if (codes.length === 0) return 'unstated'
  // Date-stamped codes collapse to their family with a count; the date is in the window already.
  const families = new Map<string, number>()
  for (const code of codes) {
    const family = code.includes(':') ? code.slice(0, code.indexOf(':')) : code
    families.set(family, (families.get(family) ?? 0) + 1)
  }
  const listed = [...families.entries()]
    .slice(0, MAX_LISTED_BLOCKERS)
    .map(([family, count]) => (count > 1 ? `${family} (${count} days)` : family))
  const omitted = families.size - listed.length
  return omitted > 0 ? `${listed.join(', ')}, and ${omitted} more` : listed.join(', ')
}

function claimLine(claim: AnswerBriefClaim): string {
  const window = `${claim.window.start} to ${claim.window.end} ${claim.window.timezone}`
  const scope = `${claim.entity.level} ${claim.entity.id}`
  const observedAt = claim.freshness.observedAt && SOURCE_TIMESTAMP_METRICS.has(claim.metricKey)
    ? `; observed at: ${claim.freshness.observedAt}`
    : ''
  const tail = claim.availability.state === 'unavailable'
    ? `blocked by: ${summariseBlockers(claim.availability.blockerCodes)}`
    : `attribution: ${ATTRIBUTION_SCOPE_DESCRIPTIONS[claim.attributionScope]}; freshness: ${claim.freshness.state}`
  // A comparison that does not say what it was taken against is a number with half its meaning
  // missing — and under per-metric comparable windows two trends on the same screen genuinely cover
  // different periods, so the reader cannot infer it from the one above.
  const comparedWith = claim.comparison.method === 'prior_equal_period' && claim.comparison.window
    ? `; compared against: ${claim.comparison.window.start} to ${claim.comparison.window.end}`
    : ''
  // Value first, provenance last. The previous single line set nine metadata fields at the same
  // typographic weight as the number, with the number buried mid-sentence between `source:` and
  // `scope:`, so a reader scanning four claims read thirty-six fields to find four figures.
  // `direction: not stated` was the worst of them: repeated on every line, identical every time, and
  // saying only that the system is not asserting a trend. It is stated once per answer now, by
  // `noDirectionNotice`, where it is a fact about the answer rather than noise on each row.
  //
  // TRAILING BACKSLASH, not a bare newline. This is rendered by `react-markdown`, which is mounted
  // with no `remarkPlugins` — no `remark-breaks` — so a soft line break inside a list item is lazy
  // continuation and CommonMark collapses all three lines into one wrapped paragraph. Verified
  // against the real renderer: soft breaks emit no `<br/>` at all, a backslash emits one. The first
  // version of this function was checked by asserting on `renderAnswerBrief`'s raw string, which is
  // the artifact, not the surface — the three-line shape it claimed never reached a browser.
  //
  // EVERY FIELD KEEPS ITS LABEL. The first version collapsed three of them into
  // `Provenance: meta, measured, authoritative` — positional tokens with no names. In a system whose
  // whole doctrine is that a measurement lane must be STATED, a bare `measured` sitting between a
  // source and an authority is not a statement of it.
  return `- **${claim.label} — ${displayValue(claim)}**\\\n`
    + `  ${window}${comparedWith}; scope: ${scope}\\\n`
    + `  source: ${claim.source.system}; measurement lane: ${claim.measurementKind}; `
    + `authority: ${claim.authority.state}; availability: ${claim.availability.state}; `
    + `maturity: ${claim.maturity.state}; ${tail}${observedAt}`
}

/**
 * Said only when it is TRUE — which is no longer always.
 *
 * This line used to be unconditional, and its own docstring explained why: `builder.ts` stamped
 * `comparison: { method: 'none', window: null }` on every claim, so there was no delta anywhere for
 * any layer to call up or down. The cockpit now emits `*_change` claims carrying
 * `method: 'prior_equal_period'`, so the sentence is false whenever one of them is cited — and a
 * standing disclaimer that contradicts the rows above it is worse than no disclaimer, because it
 * teaches the reader that the prose here is boilerplate.
 *
 * It still fires for a brief citing only point values, which remains the common case: a trend is
 * refused whenever either window is incomplete, unsettled, unread, or has a zero prior period.
 */
function noDirectionNotice(): string {
  return 'No line states a direction. These are point values with no prior-period comparison behind '
    + 'them, so nothing here says a number rose or fell.'
}

/** True when at least one rendered claim IS a prior-period comparison. */
function statesADirection(claims: AnswerBriefClaim[]): boolean {
  return claims.some((claim) => claim.comparison.method === 'prior_equal_period')
}

/**
 * The line a reader needs when an all-source count is rendered beside a paid-only figure.
 *
 * This is the failure no lineage guard can catch, because NO ARITHMETIC OCCURS: $585 of Meta spend on
 * one line and 26 all-source bookings on the next, and the reader divides them into a $22.50 "paid
 * CPA" that describes nothing. `assertNoCrossPlaneLineage` stops the system computing it; only prose
 * can pre-empt a person computing it.
 *
 * Deliberately NOT a rule against mixing scopes. That was the first design and it was wrong twice
 * over: q1 asks Maxx to reconcile Meta with the outcome source, so forbidding the adjacency forbids the answer;
 * and the builder already mixes scopes inside its own blessed lineage — `meta.cost_per_result` divides
 * `none` spend by `meta_platform_modelled` results — so the rule would have failed a governed metric
 * standalone. Make it legible, not illegal.
 */
function nonComparabilityNotice(claims: AnswerBriefClaim[]): string | null {
  // Keyed on the EVIDENCE PLANE, not on attributionScope. Scope names a measurement method; the plane
  // names the population. `'none'` in particular means "this metric has no attribution dimension at
  // all" — true of Meta spend and equally true of an unattributed business total — so classifying it
  // as paid-only was right by accident, resting on the unstated fact that every `'none'` claim in src
  // happens to be meta_delivery. The outcome-source adapter is what breaks that accident.
  //
  // `ga4_session_classified` showed the same hole from the other side: excluded from the paid-only
  // set because GA4 classification CAN be organic, so an all-source count beside paid-social sessions
  // rendered with no notice. The plane answers what the scope cannot.
  const business = claims.filter((claim) => claim.source.evidencePlane === 'outcome_business')
  const paid = claims.filter((claim) => PAID_DELIVERY_PLANES.has(claim.source.evidencePlane))
  if (business.length === 0 || paid.length === 0) return null
  // Names BOTH misreadings, because restricting this to a currency numerator was wrong. The share
  // reading needs no money at all: "Meta reports 17 results, the business booked 68" invites "25% of
  // bookings came from ads", which is the error attribution-ladder.ts was written to prevent — e.g.
  // Meta claims 31 lifetime while first-party proves 4 against 170 value-bearing.
  //
  // This fires on every reconciliation answer, and that is correct rather than noise: reconciliation
  // is exactly the question where the two populations sit side by side.
  return 'These lines count different populations. The paid figures cover Meta-attributed activity '
    + 'only; the business figures include organic. One is neither a share nor a cost per unit of the '
    + 'other.'
}

/**
 * The whole of the model's selection power: an id, checked against the governed set.
 *
 * An id the tools did not publish is rejected here, which is the only check the deleted predicate
 * comparison ever actually performed. Availability is asserted against the CLAIM rather than against
 * anything the model said, so a brief cannot file an available claim under "Unavailable" or vice
 * versa — that guarantee is unchanged and no longer depends on a transcription being faithful.
 */
function resolveClaim(
  citedId: string,
  claimsById: ReadonlyMap<string, AnswerBriefClaim>,
  requiredAvailability: 'available' | 'unavailable' | null,
): AnswerBriefClaim {
  const claim = claimsById.get(citedId)
  if (!claim) throw new Error(`AnswerBrief referenced unknown claim ${citedId}.`)
  if (requiredAvailability && claim.availability.state !== requiredAvailability) {
    throw new Error(`AnswerBrief claim availability contradicted ${requiredAvailability}.`)
  }
  return claim
}

/**
 * Render only deterministic text from fully-matched governed claims and final persisted decisions.
 *
 * Summary first: a plain-English lead composed by template from the SAME claims and decisions (see
 * `answer-summary.ts`), then the recommended next step when a persisted decision was selected, then
 * the evidence under a heading the chat bubble collapses. Every claim and decision is resolved and
 * validated before anything is composed, so an unknown id still fails the whole answer.
 */
export function renderAnswerBrief(
  brief: AnswerBrief,
  claims: AnswerBriefClaim[],
  validActionDecisions: ReadonlyMap<string, PersistedFinalActionDecisionEvidence> = new Map(),
): string {
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]))
  const observed = brief.observations.flatMap((observation) =>
    observation.claim_ids.map((citedId) => resolveClaim(citedId, claimsById, 'available')))
  const unavailable = brief.unavailable_claim_ids.map((citedId) => resolveClaim(citedId, claimsById, 'unavailable'))
  const decisions = brief.action_decision_ids.map((id) => {
    const parsed = persistedFinalActionDecisionSchema.safeParse(validActionDecisions.get(id))
    if (!parsed.success || parsed.data.id !== id) throw new Error(`AnswerBrief referenced unknown action decision ${id}.`)
    return parsed.data
  })

  const { summary, nextStep } = composeAnswerSummary({ observed, unavailable, decisions })
  const lines: string[] = [summary]
  if (nextStep) lines.push('', `**Recommended next step:** ${nextStep}`)
  lines.push('', evidenceHeading(observed.length + unavailable.length))
  if (observed.length > 0) {
    lines.push('', '**Governed observations**', ...observed.map(claimLine))
    // Server-authored, and only when the dangerous pair is actually on screen. The model cannot write
    // this and cannot suppress it: `answer-brief` permits 8 predicates in one observation with no
    // divider, so it chooses what sits next to what.
    const notice = nonComparabilityNotice(observed)
    if (notice) lines.push('', notice)
    if (!statesADirection(observed)) lines.push('', noDirectionNotice())
  }
  if (unavailable.length > 0) {
    lines.push('', '**Unavailable**', ...unavailable.map(claimLine))
  }
  if (decisions.length > 0) {
    lines.push('', '**Governed decisions**')
    for (const decision of decisions) {
      const ownerCopy = decision.owner_copy ? `${decision.owner_copy} ` : ''
      lines.push(`- ${ownerCopy}Persisted final ActionDecision: ${decision.id}; authority: ${decision.authority_tier}; approval: ${decision.approval_state}.`)
    }
  }
  return lines.join('\n')
}
