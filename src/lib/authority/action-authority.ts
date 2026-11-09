import type { AuthorityBasis } from '@/lib/modes/operating-mode'
import { evaluateDirection, type DirectionalEvidence, type DirectionalVerdict, type AuthorityCeiling, type DirectionalEvaluationOptions } from './directional-policy'

/**
 * THE ONE ACTION AUTHORITY LAYER.
 *
 * The central architectural defect was not any single bad rule — it was that
 * Maxx had several independent brains that could each produce money advice, so it could truthfully say
 * "no money action is authorized" in one surface while another said "Pause this" and a third said
 * "scale these". Reproduced across five paths: raw flag rules, the flags MCP tool, learned-pattern
 * classifications, the daily/weekly report prompts, and the persisted recommendation policy.
 *
 * The rule that fixes it: **no upstream component may author imperative action copy.** Producers emit
 * a structured {@link ActionCandidate} describing what they OBSERVED and on which evidence plane. This
 * module is the only place that decides what the observation is allowed to become, and the only place
 * that renders owner-facing action language.
 *
 * ── THE POLICY (chosen explicitly, per the review's option list) ─────────────────────────────────
 *
 * MONEY actions — budget_scale, budget_cut, pause — change spend. Policy v4 requires an exact
 * `causal_contribution` estimate with `decision_grade_causal_estimate` basis. Interaction cohorts,
 * Meta-modelled results and exact paid joins remain inputs or diagnostics; none is itself a causal
 * contribution estimate. Under anything weaker, a money candidate becomes `diagnostic_only` — the
 * observation survives in full, stated as an observation, with no imperative and no authority.
 *
 * NON-MONEY actions — creative_refresh, structural cleanup, observe — do not move spend, so a weaker
 * plane may carry them to `owner_review`, provided the provenance is named in the copy.
 *
 * `execution_eligible` is a necessary condition, never a sufficient one: automatic execution still
 * requires owner approval AND write mode, which live outside this module.
 */

/** Which evidence plane a candidate rests on, strongest first. */
export type EvidencePlane =
  /** Immutable causal incremental-contribution estimate for the exact experiment target. */
  | 'causal_contribution'
  /** Interaction-aligned paid-touch evidence; diagnostic association, never causal authority by itself. */
  | 'interaction_cohort'
  /** Exact appointment-id join. Real, but keyed on CONFIRMATION date — a period ratio, not causal. */
  | 'exact_paid_join'
  /** outcome ledger business facts. Truth about the BUSINESS, silent about which ad caused it. */
  | 'ledger_business'
  /** Meta's modelled conversions. Meta's estimate of its own performance. */
  | 'meta_modelled'
  /** GA confirmation events. Telemetry with no appointment identity. Never a booking or a CPA. */
  | 'ga_telemetry'
  /** Delivery/configuration state — no outcome claim at all. */
  | 'structural'

export type AuthorityTier = 'execution_eligible' | 'owner_review' | 'diagnostic_only'

export type ActionKind =
  | 'budget_scale' | 'budget_cut' | 'pause' | 'activate' // MONEY
  | 'creative_refresh' | 'structural' | 'observe' // NON-MONEY

/** MONEY kinds move spend and carry the strict requirement. */
const MONEY_KINDS = new Set<ActionKind>(['budget_scale', 'budget_cut', 'pause', 'activate'])
export const isMoneyKind = (k: ActionKind) => MONEY_KINDS.has(k)

/**
 * A producer's structured observation. Note what is absent: any imperative sentence. Producers report
 * what they saw; they do not instruct.
 */
export interface ActionCandidate {
  kind: ActionKind
  /** What was observed, phrased as an observation. Never "Pause this" / "Increase budget by 20%". */
  observation: string
  /** The strongest plane the observation actually rests on. */
  plane: EvidencePlane
  /** What the owner should look at next. Diagnostic, never an instruction to spend. */
  investigate?: string
  /** Entity this concerns, for display. */
  subjectRef?: string
}

export interface ActionAuthorityDecision {
  tier: AuthorityTier
  isMoneyAction: boolean
  authorityBasis: AuthorityBasis
  plane: EvidencePlane
  /** Whether the trusted evidence supports the PROPOSED DIRECTION. Distinct from the evidence being
   *  complete: a complete cohort showing a $412 CPA does not support scaling. */
  directionSupported: boolean
  /** The HIGHEST tier the evidence itself justified. `tier` is this, possibly lowered by plane/basis
   *  — never raised above it. */
  directionCeiling: AuthorityCeiling
  /** Why this tier — always stated, so a downgrade is never silent. */
  reason: string
  /** The ONLY owner-facing action text. Imperative only when the tier permits it. */
  copy: string
}

const PLANE_LABEL: Record<EvidencePlane, string> = {
  causal_contribution: 'an immutable causal incremental-contribution estimate for the exact experiment target',
  interaction_cohort: 'interaction-aligned paid-touch evidence (diagnostic association, not causal authority)',
  exact_paid_join: 'an exact appointment-id join (confirmation-date, not interaction-date)',
  ledger_business: 'Outcome ledger business facts (which do not identify the causing ad)',
  meta_modelled: "Meta's own modelled conversions (its estimate of its own performance)",
  ga_telemetry: 'GA confirmation telemetry (no appointment identity — never a booking or a CPA)',
  structural: 'delivery/configuration state only (no outcome evidence)',
}

/**
 * The single decision. `basis` comes from the operating mode, so every surface answers to the same
 * account-level authority question.
 */
export function decideActionAuthority(
  candidate: ActionCandidate,
  basis: AuthorityBasis,
  /**
   * Trusted, server-resolved directional evidence. Without this the layer
   * validated only the evidence LABEL, so a complete interaction cohort made a LOSING unit
   * `execution_eligible` for `budget_scale`, and one losing state authorised scale, cut and pause at
   * once. Completeness is necessary; direction is the sufficiency half.
   *
   * Omitted ⇒ direction is UNPROVEN, which fails closed for every money kind. A caller that cannot
   * supply trusted evidence cannot obtain money authority — that is the point, not a gap.
   */
  evidence?: DirectionalEvidence,
  /** Pragmatic media-buyer mode: attributed-only association evidence may reach owner_review. */
  opts: DirectionalEvaluationOptions = {},
): ActionAuthorityDecision {
  // Boundary validation: upstream prose is untrusted even when its structured fields are valid. A
  // producer cannot smuggle a second action brain through `observation` or `investigate`; instruction-
  // shaped text is withheld and retained only in the source artifact's audit record.
  const observation = assertsMoneyAuthority(candidate.observation)
    ? `A ${candidate.kind.replaceAll('_', ' ')} candidate was submitted, but its observation text was withheld because it contained action-language rather than a factual observation.`
    : candidate.observation
  const investigate = candidate.investigate && assertsMoneyAuthority(candidate.investigate)
    ? 'The proposed follow-up text was withheld because it contained action-language; inspect the underlying evidence instead.'
    : candidate.investigate
  const money = isMoneyKind(candidate.kind)
  const causal = basis === 'decision_grade_causal_estimate'
    && candidate.plane === 'causal_contribution'
  const direction: DirectionalVerdict = evidence
    ? evaluateDirection(candidate.kind, evidence, opts)
    : { ceiling: money ? 'unsupported' : 'execution', reason: money
        ? 'No trusted directional evidence was supplied, so the direction is UNPROVEN. Money authority fails closed.'
        : 'Non-money action: no directional economics required.' }
  const subject = candidate.subjectRef ? `${candidate.subjectRef}: ` : ''
  const next = investigate ? ` Investigate: ${investigate}` : ''

  // DIRECTION FIRST for money kinds: an action the evidence contradicts must never be presented as a
  // positive recommendation, at ANY tier — not execution_eligible and not owner_review.
  if (money && direction.ceiling === 'unsupported') {
    return {
      tier: 'diagnostic_only',
      isMoneyAction: true,
      authorityBasis: basis,
      plane: candidate.plane,
      directionSupported: false,
      directionCeiling: 'unsupported',
      reason: `The evidence does not support a ${candidate.kind.replaceAll('_', ' ')}: ${direction.reason}`,
      copy: `${subject}NOT SUPPORTED BY THE EVIDENCE — no ${candidate.kind.replaceAll('_', ' ')} is recommended. ${observation} Why the direction fails: ${direction.reason}${next}`,
    }
  }

  // RESTORED — this block was shipped by an earlier change and silently REVERTED by
  // a later commit three days afterwards. That commit removed the branch
  // AND rewrote its test from `it('grants owner_review but never execution_eligible')` asserting
  // `owner_review` to one asserting `diagnostic_only`, relabelling this the "legacy toggle" — so the
  // revert left a green suite and was invisible. The owner-facing setting
  // (`app_settings.media_buyer_recommendations_enabled`) has been TRUE in production since
  // 2026-08-14 and had no effect from 08-21 onward.
  //
  // The justification recorded when the money-quarantine CHECK was widened: the earlier escape hatch was bound to
  // `interaction_cohort_complete`, "no cohort has ever been complete on any policy version", so
  // "every money recommendation drained to diagnostic_only by construction, and three months of work
  // produced zero money recommendations."
  //
  // Verbatim restoration. EXECUTION ELIGIBILITY IS UNCHANGED — causal remains the only route to
  // execution_eligible, and `direction.ceiling` can only ever be owner_review on these paths.
  // The two (plane, basis) pairs match the `action_decisions_v4_money_quarantine` CHECK in
  // the baseline schema; a pair here the database rejects produces a decision that cannot be persisted.
  const pragmaticAllowed = opts.pragmaticMediaBuyerEnabled
    && basis === 'interaction_cohort_complete'
    && candidate.plane === 'interaction_cohort'
    && direction.ceiling === 'owner_review'
  const modelledAllowed = opts.pragmaticMediaBuyerEnabled
    && basis === 'meta_modelled_association'
    && candidate.plane === 'meta_modelled'
    && direction.ceiling === 'owner_review'
  if (pragmaticAllowed || modelledAllowed) {
    return {
      tier: 'owner_review',
      isMoneyAction: true,
      authorityBasis: basis,
      plane: candidate.plane,
      directionSupported: true,
      directionCeiling: 'owner_review',
      reason: modelledAllowed
        ? `Meta-modelled association supports a ${candidate.kind.replaceAll('_', ' ')} at OWNER REVIEW only: ${direction.reason}`
        : `Pragmatic media-buyer mode: attributed paid-cohort association supports a ${candidate.kind.replaceAll('_', ' ')} at OWNER REVIEW only: ${direction.reason}`,
      copy: modelledAllowed
        ? `${subject}FOR OWNER REVIEW — not execution-eligible. ${observation} ${direction.reason} Owner approval required; this rests on Meta's MODELLED estimate, not measured settled revenue.${next}`
        : `${subject}FOR OWNER REVIEW — not execution-eligible. ${observation} ${direction.reason} Owner approval required; this is association evidence, not causal incrementality.${next}`,
    }
  }

  if (money && !causal) {
    // Modelled or associated performance may guide an investigation or a budget-neutral test
    // hypothesis, never a net increase, cut, pause, or activation. Owner review cannot repair a
    // non-causal money claim; keeping this boundary here prevents dormant toggles from re-opening it.
    return {
      tier: 'diagnostic_only',
      isMoneyAction: true,
      authorityBasis: basis,
      plane: candidate.plane,
      directionSupported: false,
      directionCeiling: 'unsupported',
      reason: `Policy-v4 money actions require an exact decision-grade causal-contribution estimate. This rests on ${PLANE_LABEL[candidate.plane]}, which cannot itself authorize the causal contribution direction. Upstream directional diagnostic: ${direction.reason}`,
      copy: `${subject}OBSERVATION (no budget action authorised): ${observation} Basis: ${PLANE_LABEL[candidate.plane]}. This is NOT a causal incremental-contribution result, so no pause, cut or increase is recommended on it.${next}`,
    }
  }

  if (money && causal) {
    // THE CEILING IS A CEILING. Complete evidence plus a supported direction still cannot exceed what
    // the evidence itself justifies: a 2x zero-outcome window tops out at owner_review even here.
    // Previously the boolean made every supported direction execution_eligible, which erased the
    // 2x/3x distinction entirely.
    if (direction.ceiling === 'owner_review') {
      return {
        tier: 'owner_review',
        isMoneyAction: true,
        authorityBasis: basis,
        plane: candidate.plane,
        directionSupported: true,
        directionCeiling: 'owner_review',
        reason: `The causal-contribution estimate is decision-grade, but its direction tops out at OWNER REVIEW: ${direction.reason}`,
        copy: `${subject}FOR OWNER REVIEW — not execution-eligible. ${observation} ${direction.reason}${next}`,
      }
    }
    return {
      tier: 'execution_eligible',
      isMoneyAction: true,
      authorityBasis: basis,
      plane: candidate.plane,
      directionSupported: true,
      directionCeiling: 'execution',
      reason: `The causal-contribution estimate is decision-grade AND supports this direction at execution strength: ${direction.reason}`,
      copy: `${subject}${observation} ${direction.reason} Execution still requires owner approval and write mode.${next}`,
    }
  }

  // NON-MONEY. A weaker plane is admissible, but the provenance is named so nobody reads a modelled
  // figure as a measured one.
  if (candidate.kind === 'observe' || candidate.plane === 'ga_telemetry') {
    return {
      tier: 'diagnostic_only',
      isMoneyAction: false,
      authorityBasis: basis,
      plane: candidate.plane,
      directionSupported: direction.ceiling !== 'unsupported',
      directionCeiling: direction.ceiling,
      reason: candidate.kind === 'observe'
        ? 'Observation only — no action was proposed.'
        : `GA telemetry cannot support an action recommendation.`,
      copy: `${subject}${observation} Basis: ${PLANE_LABEL[candidate.plane]}.${next}`,
    }
  }

  return {
    tier: 'owner_review',
    isMoneyAction: false,
    authorityBasis: basis,
    plane: candidate.plane,
    directionSupported: direction.ceiling !== 'unsupported',
    directionCeiling: direction.ceiling,
    reason: `Non-money action; ${PLANE_LABEL[candidate.plane]} is sufficient for an owner-reviewed recommendation.`,
    copy: `${subject}FOR OWNER REVIEW: ${observation} Basis: ${PLANE_LABEL[candidate.plane]}. No spend change is implied.${next}`,
  }
}

/**
 * Does this text INSTRUCT a money move?
 *
 * Detecting the vocabulary is not enough and is actively wrong: the authority layer's own downgrade
 * copy contains "no pause, cut or increase is recommended on it", and the brief says "NOT a cut
 * instruction". A word-level matcher flags those, which would make the guard useless — it would fire
 * on the very sentences that withhold authority.
 *
 * So this matches the IMPERATIVE MOOD: a directive verb opening a sentence or clause, or an explicit
 * "<verb> budget" construction — and then clears the match if it sits under a negation.
 */
const DIRECTIVE_VERB = 'pause|increase|reduce|scale|cut|raise|lower|kill|stop|boost|reallocate|allocate|shift|put'
const ALLOCATION_VERB = 'reallocate|allocate|shift|put'

/** Clause-initial directive: start of string, or after . ! ? ; : — or a bullet or parenthesis. */
// The verb is CAPTURED so the negation lookback can be anchored on the verb's own offset. Anchoring
// on the match start instead put ". Pause" one clause too early, letting the previous clause's "not"
// excuse it ("This is not ready. Pause this ad immediately.").
const IMPERATIVE_AT_CLAUSE_START = new RegExp(
  `(?:^|[.!?;:]\\s+|—\\s*|\\n\\s*[-*]\\s*|\\()(${DIRECTIVE_VERB})\\b`, 'i')

/**
 * Explicit money-object constructions, wherever they appear. Covers both orders — "increase budget"
 * and the noun form "a 20% budget increase".
 */
const MONEY_OBJECT = new RegExp(
  `\\b(${DIRECTIVE_VERB})\\s+(?:the\\s+)?(?:budget|spend|losses)\\b`
  + `|\\b(${ALLOCATION_VERB})\\b[^.!?;:\\n]{0,80}(?:\\$\\d|\\d+\\s*(?:%|percent)|\\b(?:budget|spend|money|dollars?)\\b)`
  + `|\\b(budget)\\s+by\\s+\\d+`
  + `|\\bbudget\\s+(increase|decrease|reduction|cut|boost)\\b`
  + `|\\b(scale)\\s+(?:these|this|here|it|up)\\b`, 'i')

/**
 * Negation that makes a directive a STATEMENT rather than an instruction — but scoped to the SAME
 * clause only.
 *
 * A review broke the previous version, which looked back a fixed 60 characters and
 * so let an EARLIER clause's negation suppress a LATER directive:
 *   "Do not pause; increase budget immediately."          -> "increase budget" excused by "not"
 *   "This is not ready. Pause this ad immediately."        -> "Pause" excused by "not"
 *   "No change yet. Reduce budget by 30 percent tomorrow." -> "Reduce budget" excused by "No"
 * All three are unambiguous instructions. The lookback is now bounded by the nearest clause boundary
 * before the match, so a negation only excuses a directive inside its own clause.
 *
 * This detector is DEFENCE IN DEPTH ONLY. It never grants authority and never decides that a stored
 * row is safe — that is the structural policy-generation cutover's job (see `isLegacyPolicyRow`).
 */
const NEGATED = /\b(?:no|not|never|neither|without|cannot|can't|withheld|blocked)\b/i
const CLAUSE_BOUNDARY = /[.!?;:\n]|—/g

/** Start index of the clause containing `at`. */
function clauseStart(text: string, at: number): number {
  let start = 0
  CLAUSE_BOUNDARY.lastIndex = 0
  for (let m = CLAUSE_BOUNDARY.exec(text); m && m.index < at; m = CLAUSE_BOUNDARY.exec(text)) {
    start = m.index + m[0].length
  }
  return start
}

/** True when the clause containing `verbAt` carries a negation before the verb. Shared by the
 *  money-imperative and structural-directive filters. */
export function clauseNegatesDirective(text: string, verbAt: number): boolean {
  const from = clauseStart(text, verbAt)
  // Only a negation inside the verb's OWN clause can turn the directive into a description.
  return NEGATED.test(text.slice(from, verbAt))
}

/** True when `text` reads as an instruction to move money. */
export function assertsMoneyAuthority(text: string): boolean {
  for (const re of [IMPERATIVE_AT_CLAUSE_START, MONEY_OBJECT]) {
    const rx = new RegExp(re.source, 'gdi')     // 'd' => match indices, so the VERB offset is known
    for (let m = rx.exec(text); m; m = rx.exec(text)) {
      // Anchor on the captured verb, not the whole match: the match may begin with the clause
      // boundary itself, which would place the lookback in the PRECEDING clause.
      const idx = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices
      const verbAt = idx?.slice(1).find(Boolean)?.[0] ?? m.index
      if (clauseNegatesDirective(text, verbAt)) continue
      return true
    }
  }
  return false
}

/** Exposed for tests that need to see what the matcher keys on. */
export const MONEY_IMPERATIVE_PATTERNS = [IMPERATIVE_AT_CLAUSE_START, MONEY_OBJECT] as const

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// FINAL ARBITRATION — one money disposition per target and window.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Several producers can propose money actions for the SAME target over the same window (a flag, a
 * recommendation, an alert). Evidence makes scale and cut mutually exclusive, but it does NOT make
 * `budget_cut` and `pause` exclusive: at the 3x zero-outcome stop tier both are legitimately
 * execution-eligible. Two simultaneous executable money instructions for one unit is precisely the
 * contradiction this whole pass exists to remove, so exactly one survives.
 *
 * Ranking: ceiling first (execution > owner_review > diagnostic), then severity. At the stop tier the
 * severe action IS the point — "high urgency stop" means stop — so `pause` outranks `budget_cut`
 * there. Below it, the least drastic sufficient action wins.
 *
 * Losers are RETAINED with the reason they were suppressed; nothing is silently dropped.
 */
/**
 * The unit a money disposition is scoped to. Two candidates only compete when EVERY field matches —
 * previously `arbitrateMoneyDisposition` took a flat list and returned one global winner, so a
 * decision about ad set A could suppress an unrelated decision about campaign B, or a July decision
 * could suppress an August one.
 */
export interface DecisionUnit {
  adAccountId: string
  targetLevel: 'account' | 'campaign' | 'adset' | 'ad'
  targetId: string | null
  windowStart: string | null
  windowEnd: string | null
  policyVersion: number
}

export const decisionUnitKey = (u: DecisionUnit) =>
  [u.adAccountId, u.targetLevel, u.targetId ?? '-', u.windowStart ?? '-', u.windowEnd ?? '-', u.policyVersion].join('|')

export interface ArbitratedUnit<T> {
  unit: DecisionUnit
  /** The single ACTIONABLE disposition for this unit, or null when every candidate is diagnostic. */
  winner: T | null
  /** Everything not chosen, with why. Nothing is silently dropped. */
  suppressed: Array<{ candidate: T; reason: string }>
}

const TIER_RANK: Record<AuthorityTier, number> = {
  execution_eligible: 2, owner_review: 1, diagnostic_only: 0,
}
/** Severity within a tier. Higher = more drastic. */
const KIND_SEVERITY: Record<string, number> = { pause: 4, budget_cut: 3, activate: 2, budget_scale: 1 }

/**
 * Arbitrate money dispositions INDEPENDENTLY PER UNIT.
 *
 * Ranking within a unit: tier first, then severity. At the EXECUTION tier the severe action wins —
 * a 3x high-urgency stop should stop, not merely shrink — and below it the least drastic sufficient
 * action wins. When every candidate for a unit is diagnostic there is no actionable winner, and
 * saying so is the honest answer rather than promoting the "best" diagnostic.
 */
export function arbitrateMoneyDispositions<
  T extends { decision: ActionAuthorityDecision; kind: ActionKind; unit: DecisionUnit },
>(candidates: T[]): ArbitratedUnit<T>[] {
  const groups = new Map<string, T[]>()
  for (const c of candidates) {
    if (!isMoneyKind(c.kind)) continue
    const k = decisionUnitKey(c.unit)
    const g = groups.get(k)
    if (g) g.push(c); else groups.set(k, [c])
  }

  return [...groups.values()].map((group) => {
    const ranked = [...group].sort((a, b) => {
      const t = TIER_RANK[b.decision.tier] - TIER_RANK[a.decision.tier]
      if (t !== 0) return t
      const sev = (KIND_SEVERITY[b.kind] ?? 0) - (KIND_SEVERITY[a.kind] ?? 0)
      return a.decision.tier === 'execution_eligible' ? sev : -sev
    })
    const top = ranked[0]!
    const actionable = top.decision.tier !== 'diagnostic_only'
    return {
      unit: top.unit,
      winner: actionable ? top : null,
      suppressed: (actionable ? ranked.slice(1) : ranked).map((c) => ({
        candidate: c,
        reason: actionable
          ? `Suppressed by arbitration for this unit: ${top.kind} at ${top.decision.tier} is the single money disposition for ${top.unit.targetLevel} ${top.unit.targetId ?? 'account'} over ${top.unit.windowStart ?? 'n/a'}..${top.unit.windowEnd ?? 'n/a'}. Retained for audit.`
          : 'No actionable disposition for this unit — every candidate resolved diagnostic_only. Retained as diagnosis.',
      })),
    }
  })
}
