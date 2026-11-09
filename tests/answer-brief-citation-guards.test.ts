import { describe, expect, it } from 'vitest'
import { parseAnswerBriefValue, renderAnswerBrief, type AnswerBriefClaim } from '@/lib/maxx/answer-brief'
import { createMetricClaim } from '@/lib/cockpit/contracts'

/**
 * Two guarantees this file's own docstring already asserted in prose, with nothing behind either.
 *
 * `resolveClaim` says: "a brief cannot file an available claim under 'Unavailable' or vice versa —
 * that guarantee is unchanged and no longer depends on a transcription being faithful." Searching the
 * repo for the error it throws returned exactly one hit: the `throw` itself. No test anywhere filed a
 * claim under the wrong heading, so both directions of the guard could have been deleted with the
 * whole suite green — the same shape as every other defect this round found, restated as a comment.
 *
 * Kept as a THROW rather than softened into server-side re-filing. The server does hold the truth and
 * could route each cited id to the correct section, which would turn a whole-answer loss into a
 * correct render. That is a real product tradeoff and it is the owner's call, not a cleanup: the
 * throw is currently the only thing that makes a model ignoring `availability` visible at all, and
 * `scoreBrief` grades the brief, not the render. Binding the behaviour that ships is the fix here;
 * changing it is a separate decision.
 */

function claim(overrides: {
  claimId: string
  available: boolean
  value?: number
  unit?: 'count' | 'percent'
  label?: string
  comparison?: { method: 'prior_equal_period'; window: { start: string; end: string; basis: 'closed_account_days'; timezone: 'America/New_York' } }
}): AnswerBriefClaim {
  return createMetricClaim({
    claimId: overrides.claimId,
    metricKey: 'meta_results',
    label: overrides.label ?? 'Meta Results',
    value: overrides.available ? overrides.value ?? 18 : null,
    unit: overrides.unit ?? 'count', formula: null, definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'meta-head', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'active' },
    attributionScope: 'meta_platform_modelled',
    window: { start: '2026-04-04', end: '2026-04-23', basis: 'closed_account_days', timezone: 'America/New_York' },
    comparison: overrides.comparison ?? { method: 'none', window: null },
    asOf: '2026-04-24T12:00:00.000Z',
    availability: overrides.available
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: ['no_claim_supply'] },
    coverage: { state: 'complete', numerator: 20, denominator: 20 },
    maturity: { state: 'settled', matureThrough: '2026-04-23' },
    freshness: { state: 'fresh', observedAt: '2026-04-24T12:00:00.000Z', maxAgeHours: 24 },
    setupFingerprint: 'setup-v1',
    authority: { state: 'context', policyVersion: 'meta-results-v1' },
    measurementKind: 'modelled',
    inputClaimIds: [],
  })
}

const AVAILABLE = claim({ claimId: 'claim-available', available: true })
const UNAVAILABLE = claim({ claimId: 'claim-unavailable', available: false })

const brief = (parts: {
  observations?: string[][]
  unavailable?: string[]
  decisions?: string[]
}) => parseAnswerBriefValue({
  summary: 'governed_claims',
  observations: (parts.observations ?? []).map((claim_ids) => ({ claim_ids })),
  unavailable_claim_ids: parts.unavailable ?? [],
  action_decision_ids: parts.decisions ?? [],
  next_check: null,
})

describe('a claim is rendered under the heading its OWN availability says, or not at all', () => {
  it('renders the correct filing (so the rejections below are not vacuous)', () => {
    const out = renderAnswerBrief(
      brief({ observations: [['claim-available']], unavailable: ['claim-unavailable'] }),
      [AVAILABLE, UNAVAILABLE],
    )
    expect(out).toContain('**Governed observations**')
    expect(out).toContain('**Unavailable**')
    expect(out).toContain('**Meta Results — 18**')
    expect(out).toContain('blocked by: no_claim_supply')
  })

  it('REFUSES an unavailable claim filed as an observation', () => {
    expect(() => renderAnswerBrief(
      brief({ observations: [['claim-unavailable']] }),
      [AVAILABLE, UNAVAILABLE],
    )).toThrow(/availability contradicted available/)
  })

  it('REFUSES an available claim filed as unavailable — the direction nothing tested', () => {
    // The `requiredAvailability` parameter takes two values and only one of them had a call site
    // anyone had ever exercised. A guard proven in one direction is a guard proven in one direction.
    expect(() => renderAnswerBrief(
      brief({ unavailable: ['claim-available'] }),
      [AVAILABLE, UNAVAILABLE],
    )).toThrow(/availability contradicted unavailable/)
  })

  it('REFUSES an id the governed set does not contain, in EITHER list', () => {
    expect(() => renderAnswerBrief(brief({ observations: [['ghost']] }), [AVAILABLE]))
      .toThrow(/referenced unknown claim ghost/)
    expect(() => renderAnswerBrief(brief({ unavailable: ['ghost'] }), [AVAILABLE]))
      .toThrow(/referenced unknown claim ghost/)
  })

  it('names the offending id, so the log says which citation failed', () => {
    expect(() => renderAnswerBrief(brief({ observations: [['ghost-42']] }), [AVAILABLE]))
      .toThrow(/ghost-42/)
  })
})

describe('the empty brief renders to its own heading and nothing else', () => {
  /**
   * The measurement behind the guard in `finishWithBrief`. This is what a brief citing nothing
   * actually produces — not an error, not a refusal: one sentence promising evidence that is not
   * there. `runMaxxChat` used to return it with `availability: 'available'`.
   *
   * Left as-is in the renderer deliberately. The renderer's job is to render; the decision that an
   * uncited brief is not an answer belongs where the reader-facing cause is known, which is
   * `withheldBecause` — it can say WHICH plane had no claim supply, and this function cannot.
   */
  it('is a heading over an empty page — which is why the chat must refuse it', () => {
    // The summary-first layout still renders nothing but a statement that there is no evidence.
    expect(renderAnswerBrief(brief({}), [AVAILABLE]))
      .toBe('This answer cites no governed evidence.\n\n**Evidence**')
  })

  it('a brief citing only UNAVAILABLE claims is a real answer and still renders', () => {
    // "I could not measure this, and here is what blocked it" is an answer the contract explicitly
    // asks for. The emptiness guard must not swallow it.
    const out = renderAnswerBrief(brief({ unavailable: ['claim-unavailable'] }), [UNAVAILABLE])
    expect(out).toContain('**Unavailable**')
    expect(out).toContain('blocked by: no_claim_supply')
  })
})

/**
 * The governed-decisions section, which nothing rendered.
 *
 * Mutation testing found it whole: `lines.push('', '**Governed decisions**')` could be DELETED and
 * 3958 tests stayed green, and blanking `'execution_eligible'` or `'not_requested'` out of the
 * persisted-decision enums survived too. `git grep "Governed decisions" -- tests` returned nothing.
 * No test anywhere renders a brief that cites an action decision, so the block that prints authority
 * tier and approval state in front of the owner — the highest-consequence line this renderer emits,
 * the one that says whether a change is approved — was shipped unexercised.
 *
 * Its guard is also invisible to the harness: `if (!parsed.success || parsed.data.id !== id) throw`
 * is a single line with no trailing brace, so neither `if-false` nor `delete-call` can reach it. It
 * appears in the sweep's UNMEASURED list, not among the caught. That is exactly the case where a
 * hand-written test is the only instrument available, so both of its clauses are fired below.
 */
const DECISION = {
  id: 'decision-1',
  persisted: true as const,
  final: true as const,
  record_type: 'action_decisions' as const,
  // At the floor, not above it: `policy_version` is `.min(ACTION_DECISION_POLICY_FLOOR)`, and a
  // fixture sitting comfortably above a boundary never tests the boundary.
  policy_version: 5,
  // The two enum members mutation proved unexercised.
  authority_tier: 'execution_eligible' as const,
  approval_state: 'not_requested' as const,
  action_kind: 'observe' as const,
  owner_copy: 'Observe only; no live change is authorized.',
  lineage: { source_kind: 'recommendation' as const, source_id: 'rec-9' },
}

const decisions = (records: Array<typeof DECISION>) =>
  new Map(records.map((record) => [record.id, record]))

describe('the governed-decisions section', () => {
  it('renders the heading and the decision, with tier and approval state named', () => {
    const out = renderAnswerBrief(
      brief({ observations: [['claim-available']], decisions: ['decision-1'] }),
      [AVAILABLE],
      decisions([DECISION]),
    )
    expect(out).toContain('**Governed decisions**')
    expect(out).toContain('Persisted final ActionDecision: decision-1')
    expect(out).toContain('authority: execution_eligible')
    expect(out).toContain('approval: not_requested')
    expect(out).toContain('Observe only; no live change is authorized.')
  })

  it('omits the heading entirely when no decision is cited', () => {
    const out = renderAnswerBrief(brief({ observations: [['claim-available']] }), [AVAILABLE])
    expect(out).not.toContain('**Governed decisions**')
  })

  it('REFUSES a decision id the governed feed never returned', () => {
    // The `!parsed.success` clause. `validActionDecisions.get` returns undefined, which safeParse
    // rejects — this is the fabricated-id defence, and it had no test.
    expect(() => renderAnswerBrief(
      brief({ decisions: ['fabricated'] }), [AVAILABLE], decisions([DECISION]),
    )).toThrow(/referenced unknown action decision fabricated/)
  })

  it('REFUSES a record filed under a key that is not its own id', () => {
    // The `parsed.data.id !== id` clause, which the first clause cannot reach: the map hands back a
    // VALID record, so safeParse succeeds and only the identity check stands between a reader and a
    // decision line labelled with the wrong id.
    expect(() => renderAnswerBrief(
      brief({ decisions: ['decision-2'] }),
      [AVAILABLE],
      new Map([['decision-2', DECISION]]),
    )).toThrow(/referenced unknown action decision decision-2/)
  })

  it('REFUSES a record below the policy floor, rather than rendering a legacy decision', () => {
    expect(() => renderAnswerBrief(
      brief({ decisions: ['decision-1'] }),
      [AVAILABLE],
      decisions([{ ...DECISION, policy_version: 4 }]),
    )).toThrow(/referenced unknown action decision decision-1/)
  })

  it('REFUSES a record that is not final, or not persisted', () => {
    for (const broken of [{ ...DECISION, final: false }, { ...DECISION, persisted: false }]) {
      expect(() => renderAnswerBrief(
        brief({ decisions: ['decision-1'] }),
        [AVAILABLE],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new Map([['decision-1', broken as any]]),
      )).toThrow(/referenced unknown action decision decision-1/)
    }
  })
})

describe('the no-direction notice states WHY, not just that', () => {
  it('carries the reason clause, which mutation found unasserted', () => {
    // Blanking the second half of this sentence survived the whole suite. The half that survived is
    // the half that explains the system: without it the line asserts a limitation and gives no cause,
    // which is the shape of copy this renderer exists to refuse.
    const out = renderAnswerBrief(brief({ observations: [['claim-available']] }), [AVAILABLE])
    expect(out).toContain(
      'No line states a direction. These are point values with no prior-period comparison behind '
      + 'them, so nothing here says a number rose or fell.',
    )
  })
})

describe('the schema carries no prose-bearing field, including no direction', () => {
  it('REJECTS a brief that carries a direction, so the comments claiming its absence are checkable', () => {
    // Three comments across `brief-rubric.ts`, `chat.ts` and this module described `direction` as
    // `z.literal('not_stated')` for a full round AFTER the id-only rewrite deleted the field. Nothing
    // could contradict them, because nothing asserted the schema's shape from the outside. `.strict()`
    // is what actually enforces it; this is what makes the enforcement visible.
    expect(() => parseAnswerBriefValue({
      summary: 'governed_claims',
      observations: [], action_decision_ids: [], unavailable_claim_ids: [],
      next_check: null,
      direction: 'not_stated',
    })).toThrow()
  })

  it('REJECTS any other unrecognised key, so this is a property of the schema and not one blocklist', () => {
    expect(() => parseAnswerBriefValue({
      summary: 'governed_claims',
      observations: [], action_decision_ids: [], unavailable_claim_ids: [],
      next_check: null,
      recommendation: 'Scale the winning ad set to $200/day.',
    })).toThrow()
  })
})

const PRIOR_WINDOW = {
  start: '2026-03-15', end: '2026-04-03',
  basis: 'closed_account_days' as const, timezone: 'America/New_York' as const,
}
const TREND_UP = claim({
  claimId: 'claim-trend-up', available: true, value: 41.83, unit: 'percent',
  label: 'Meta spend vs prior period',
  comparison: { method: 'prior_equal_period', window: PRIOR_WINDOW },
})
const TREND_DOWN = claim({
  claimId: 'claim-trend-down', available: true, value: -12.4, unit: 'percent',
  label: 'Meta Results vs prior period',
  comparison: { method: 'prior_equal_period', window: PRIOR_WINDOW },
})
const TREND_FLAT = claim({
  claimId: 'claim-trend-flat', available: true, value: 0, unit: 'percent',
  label: 'Meta CPM vs prior period',
  comparison: { method: 'prior_equal_period', window: PRIOR_WINDOW },
})

describe('a trend renders as a direction, not as a bare percentage', () => {
  it('a RISE carries a leading +', () => {
    // `41.83%` and `+41.83%` are the same number, but only one of them says "up" without the reader
    // having to work it out.
    expect(renderAnswerBrief(brief({ observations: [['claim-trend-up']] }), [TREND_UP]))
      .toContain('+41.83%')
  })

  it('a FALL keeps its minus', () => {
    expect(renderAnswerBrief(brief({ observations: [['claim-trend-down']] }), [TREND_DOWN]))
      .toContain('-12.4%')
  })

  it('NO change gets no sign — flat is not a rise', () => {
    const out = renderAnswerBrief(brief({ observations: [['claim-trend-flat']] }), [TREND_FLAT])
    expect(out).toContain('0%')
    expect(out).not.toContain('+0%')
  })

  it('a plain percentage that is NOT a comparison is left alone', () => {
    // CTR is a level, not a direction. A leading `+` on it would assert a movement that no claim made.
    const rate = claim({ claimId: 'claim-ctr', available: true, value: 3.2, unit: 'percent', label: 'Meta link CTR' })
    const out = renderAnswerBrief(brief({ observations: [['claim-ctr']] }), [rate])
    expect(out).toContain('3.2%')
    expect(out).not.toContain('+3.2%')
  })

  it('states WHAT it was compared against, on the line itself', () => {
    // Under per-metric comparable windows two trends on one screen genuinely cover different periods,
    // so the reader cannot infer this from the row above.
    expect(renderAnswerBrief(brief({ observations: [['claim-trend-up']] }), [TREND_UP]))
      .toContain('compared against: 2026-03-15 to 2026-04-03')
  })

  it('a point value says nothing about a comparison window', () => {
    expect(renderAnswerBrief(brief({ observations: [['claim-available']] }), [AVAILABLE]))
      .not.toContain('compared against')
  })
})

describe('the no-direction notice is only said when it is true', () => {
  it('is ABSENT once a trend is cited', () => {
    // The notice was unconditional, and its docstring justified that with "builder.ts stamps
    // comparison: none on every claim". The cockpit now emits prior-period comparisons, so the
    // sentence contradicts the rows above it — which is worse than saying nothing, because it teaches
    // the reader that the prose here is boilerplate.
    expect(renderAnswerBrief(brief({ observations: [['claim-trend-up']] }), [TREND_UP]))
      .not.toContain('No line states a direction')
  })

  it('is still PRESENT for a brief of point values only', () => {
    // Which remains the common case: a trend is refused whenever either window is incomplete,
    // unsettled, unread, or has a zero prior period.
    expect(renderAnswerBrief(brief({ observations: [['claim-available']] }), [AVAILABLE]))
      .toContain('No line states a direction')
  })

  it('one trend among several point values is enough to suppress it', () => {
    const out = renderAnswerBrief(
      brief({ observations: [['claim-available', 'claim-trend-up']] }),
      [AVAILABLE, TREND_UP],
    )
    expect(out).not.toContain('No line states a direction')
    expect(out).toContain('+41.83%')
  })

  it('an UNAVAILABLE trend does not count as stating a direction', () => {
    // A refused trend is exactly the case the notice is for, and it is the common one.
    const refused = claim({ claimId: 'claim-trend-refused', available: false, unit: 'percent',
      label: 'Meta spend pacing vs prior period' })
    const out = renderAnswerBrief(
      brief({ observations: [['claim-available']], unavailable: ['claim-trend-refused'] }),
      [AVAILABLE, refused],
    )
    expect(out).toContain('No line states a direction')
  })
})

describe('a change never disagrees with itself', () => {
  /**
   * The sign was read off the raw value while the magnitude was rounded, so a change of 0.004
   * rendered as `+0%` — "up" and "nothing moved" on the same line. Whatever is shown and whatever is
   * said must be the same figure.
   */
  const tiny = (value: number) => claim({
    claimId: 'claim-tiny', available: true, value, unit: 'percent',
    label: 'Meta spend vs prior period',
    comparison: { method: 'prior_equal_period', window: PRIOR_WINDOW },
  })
  const render = (value: number) =>
    renderAnswerBrief(brief({ observations: [['claim-tiny']] }), [tiny(value)])

  it('a change too small to show does not claim a direction', () => {
    expect(render(0.004)).toContain('0%')
    expect(render(0.004)).not.toContain('+0%')
    expect(render(-0.004)).not.toContain('-0%')
  })

  it('a change that DOES survive rounding keeps its sign', () => {
    // Guards the case above against passing because signs were dropped entirely.
    expect(render(0.04)).toContain('+0.04%')
    expect(render(-0.04)).toContain('-0.04%')
  })

  it('rounds the magnitude and the sign from the SAME number', () => {
    // 0.996 rounds to 1 at two decimals; the sign must come from that, not from a third value.
    expect(render(0.996)).toContain('+1%')
  })
})
