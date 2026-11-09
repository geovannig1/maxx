import { describe, expect, it } from 'vitest'
import { MAXX_CHAT_MESSAGE_BOUNDS } from '@/app/api/maxx/chat/route'
import { governMaxxAnswer } from '@/lib/maxx/chat'
import { parseAnswerBriefValue, renderAnswerBrief } from '@/lib/maxx/answer-brief'
import { summariseBlockers } from '@/lib/maxx/answer-brief'
import {
  assemblePerformanceCockpitData, type CockpitEvidence, type MetaDeliveryEvidence,
} from '@/lib/cockpit/builder'
import { comparisonWindowKey, type CockpitRange } from '@/lib/cockpit/evidence'
import { comparableWindows } from '@/lib/cockpit/comparison-window'

/**
 * A governed answer must fit in the message bound that answer will be REPLAYED under.
 *
 * `MaxxChat` sends the whole transcript on every turn, so an assistant turn longer than the API's
 * per-message cap makes the NEXT question fail `400 Invalid request`: the good answer renders, and
 * the conversation dies with a generic red banner and no diagnosis.
 *
 * It was structurally unreachable before per-metric trends — 14 claims rendered to ~4,247 chars
 * against a 6,000 cap. Per-metric trends took the cockpit to 49 claims, and the answer contract tells the model
 * to "cite every claim that bears on the question, including the unavailable ones". This is the same
 * defect as the tool-result cap, on the other side of the loop, so it gets the same treatment: bind
 * the bound to what the system can actually produce.
 */

const TZ = 'America/New_York' as const
const RANGE: CockpitRange = { start: '2026-08-01', end: '2026-08-20', basis: 'closed_account_days', timezone: TZ }

function delivery(factor: number, days: number): MetaDeliveryEvidence {
  return {
    available: true, spendAvailable: true, resultsAvailable: true, purchaseAvailable: true,
    leadAvailable: true, linkCtrAvailable: true, cpmAvailable: true, frequencyAvailable: true,
    spend: 1234.56 * factor, results: 40 * factor, purchaseValue: 3000 * factor,
    purchaseCount: 20 * factor, leads: 16 * factor, linkClicks: 100 * factor,
    impressions: 10_000 * factor, nativeFrequency: 1.5 * factor, dailyBudget: 70,
    spendCoveredDays: days, coveredDays: days, expectedDays: days,
    synchronizedAt: '2026-08-21T11:55:00.000Z', blockerCodes: [],
  }
}
const span = (w: CockpitRange) =>
  Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1

/** The largest claim set the contract can produce: a SETTLING request, everything available. */
function worstCaseCockpit() {
  const deliveryByWindow: Record<string, MetaDeliveryEvidence> = {}
  for (const maturity of [
    { state: 'settled' as const, matureThrough: RANGE.end },
    { state: 'settling' as const, matureThrough: '2026-08-13' },
  ]) {
    const pair = comparableWindows(RANGE, maturity)
    if (!pair) continue
    for (const [window, factor] of [[pair.current, 2], [pair.prior, 1]] as const) {
      const key = comparisonWindowKey(window)
      if (key !== comparisonWindowKey(RANGE)) deliveryByWindow[key] = delivery(factor, span(window))
    }
  }
  const evidence: CockpitEvidence = {
    account: { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'Example Studio' },
    range: RANGE, asOf: '2026-08-21T12:00:00.000Z', delivery: delivery(2, 20),
    comparison: { deliveryByWindow, blockerCodes: [] },
    partialToday: { available: true, date: '2026-08-21', spend: 4.57, dailyBudget: 70, synchronizedAt: '2026-08-21T11:57:00.000Z', blockerCodes: [] },
    synchronizedAt: '2026-08-21T11:55:00.000Z', decisionIds: [], primaryDecisionId: null, primaryDecision: null,
  }
  return assemblePerformanceCockpitData(evidence)
}

/** The largest brief the schema permits over that cockpit: 8 observations × 8 ids. */
function fullestAnswer() {
  const cockpit = worstCaseCockpit()
  const claims = Object.values(cockpit.claims)
  const available = claims.filter((c) => c.availability.state === 'available').map((c) => c.claimId)
  const unavailable = claims.filter((c) => c.availability.state === 'unavailable').map((c) => c.claimId)
  const observations: Array<{ claim_ids: string[] }> = []
  for (let i = 0; i < available.length && observations.length < 8; i += 8) {
    observations.push({ claim_ids: available.slice(i, i + 8) })
  }
  const brief = parseAnswerBriefValue({
    summary: 'governed_claims',
    observations,
    action_decision_ids: [],
    unavailable_claim_ids: unavailable.slice(0, 16),
    next_check: null,
  })
  // `governMaxxAnswer` prepends the evidence disclosure and the diagnostic notice, so the text the
  // client stores and replays is larger than the render alone.
  return governMaxxAnswer(renderAnswerBrief(brief, claims), [{
    tool: 'get_performance_cockpit', sources: ['Meta'],
    dateWindow: `requested ${RANGE.start} to ${RANGE.end}; actual coverage must come from tool lineage`,
    scope: 'account act_123', observedAt: '2026-08-21T12:00:00.000Z',
    freshness: 'tool response observed 2026-08-21T12:00:00.000Z', availability: 'returned',
    caveat: 'A returned response does not make every metric complete, current, or decision-grade.',
  }], 'server_composed')
}

describe('the fullest governed answer fits in the assistant message bound', () => {
  it('really is a large claim set — otherwise this measures a small one', () => {
    const all = Object.values(worstCaseCockpit().claims)
    expect(all.length).toBeGreaterThan(40)
  })

  it('cites the schema maximum, so this is the worst case and not a typical one', () => {
    const text = fullestAnswer()
    expect(text.length).toBeGreaterThan(4_247)   // above the pre-Round-2 ceiling
  })

  it('FITS — a longer answer would 400 the next question', () => {
    expect(fullestAnswer().length).toBeLessThan(MAXX_CHAT_MESSAGE_BOUNDS.assistant)
  })

  it('leaves headroom, so the next metric added does not kill the conversation', () => {
    expect(fullestAnswer().length).toBeLessThan(MAXX_CHAT_MESSAGE_BOUNDS.assistant * 0.8)
  })

  it('would NOT have fit the old shared 6,000 cap — the regression this pins', () => {
    // The bound was 6,000 for both roles. Proof the change was necessary rather than precautionary.
    expect(fullestAnswer().length).toBeGreaterThan(6_000)
  })

  it('keeps the USER bound tight — a typed question is not a rendered answer', () => {
    // NOT `toBe(6_000)`. A literal equal to the constant is a tripwire, not an assertion: it fires
    // when the cap is legitimately tuned and says nothing about behaviour. The property is that a
    // typed question stays far tighter than a rendered answer.
    expect(MAXX_CHAT_MESSAGE_BOUNDS.assistant).toBeGreaterThan(MAXX_CHAT_MESSAGE_BOUNDS.user * 2)
    expect(MAXX_CHAT_MESSAGE_BOUNDS.user).toBeLessThan(fullestAnswer().length)
  })
})

describe('a conversation survives several governed answers', () => {
  /**
   * Raising the per-message bound fixed nothing on its own. `MaxxChat` replays every turn, so the cap
   * that actually gates the request is the HISTORY cap — and it was left at 30,000 while a single
   * governed answer measures ~14,500. The third request came within ~800 chars of it and the fourth
   * failed 413, producing the same generic red banner two turns later than before.
   */
  const answer = fullestAnswer()
  const question = 'How did spend and bookings move versus the prior period?'

  it('a full governed answer is as large as claimed', () => {
    expect(answer.length).toBeGreaterThan(10_000)
    expect(answer.length).toBeLessThan(MAXX_CHAT_MESSAGE_BOUNDS.assistant)
  })

  it('would have died within a few turns under the old 30,000 history cap', () => {
    // Stated as a property rather than a turn number. My first version said the fourth turn, the
    // second said the third — and the answer grows whenever a claim is added, so any fixed turn is a
    // number that expires. What matters is that a short conversation breached the old cap and does
    // not breach the new one.
    const turn = (n: number) => (answer.length + question.length) * n
    const firstBreach = [1, 2, 3, 4, 5].find((n) => turn(n) > 30_000)
    expect(firstBreach, 'a governed conversation no longer breaches the OLD cap at all').toBeDefined()
    // The docstring above says a fixed turn number expires — and then one was pinned anyway. The
    // property is "within a few turns", which is what `[1..5].find` already establishes.
    expect(firstBreach!).toBeLessThan(5)
    expect(turn(firstBreach!)).toBeLessThanOrEqual(MAXX_CHAT_MESSAGE_BOUNDS.history)
  })

  it('now carries five full answers and five questions', () => {
    const fiveTurns = (answer.length + question.length) * 5
    expect(fiveTurns).toBeLessThanOrEqual(MAXX_CHAT_MESSAGE_BOUNDS.history)
  })

  it('is DERIVED from the message bounds, so the two cannot drift apart again', () => {
    // The original defect was one constant being raised while the other was forgotten.
    expect(MAXX_CHAT_MESSAGE_BOUNDS.history)
      .toBe((MAXX_CHAT_MESSAGE_BOUNDS.assistant + MAXX_CHAT_MESSAGE_BOUNDS.user) * 5)
  })
})

/**
 * An unavailable claim's blocker list is BOUNDED.
 *
 * The message-bound work above measured a claim-SUPPLY ceiling: every fixture sets
 * `blockerCodes: []`, so what it proved was "how many claims can be cited", not "how long can the
 * text get". Those are different questions, and the second one had no answer.
 *
 * `source-readers.ts` emits one DATE-STAMPED code per missing day and a trend claim merges both
 * sides', so a 90-day window — which `closed-date-range` permits — put ~180 codes on ONE line. That
 * is the same 400/413 red banner the bounds were raised to remove, arriving through the text instead
 * of through the claim count.
 */
describe('a blocked claim cannot grow without limit', () => {
  const days = (n: number, prefix: string) => Array.from(
    { length: n }, (_, i) => `${prefix}:2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
  )

  it('collapses date-stamped repeats to a family and a count', () => {
    const out = summariseBlockers(days(27, 'meta_account_spend_day_missing'))
    expect(out).toContain('meta_account_spend_day_missing')
    expect(out).toMatch(/\(\d+ days\)/)
    expect(out).not.toContain('2026-08-04')
  })

  it('stays short even at the largest window the date range permits', () => {
    // 90 days x both sides of a trend, the worst case the readers can actually produce.
    const worst = [...days(90, 'meta_account_spend_day_missing'), ...days(90, 'meta_results_day_missing')]
    const rendered = summariseBlockers(worst)
    expect(worst.join(', ').length).toBeGreaterThan(5_000)   // the unbounded version, for contrast
    expect(rendered.length).toBeLessThan(200)
  })

  it('says how many families it left out rather than silently truncating', () => {
    const many = ['a_code', 'b_code', 'c_code', 'd_code', 'e_code', 'f_code']
    expect(summariseBlockers(many)).toMatch(/and 2 more/)
  })

  it('still states something when a claim is blocked for no recorded reason', () => {
    expect(summariseBlockers([])).toBe('unstated')
  })
})
