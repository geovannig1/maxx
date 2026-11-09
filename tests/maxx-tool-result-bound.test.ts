import { describe, expect, it } from 'vitest'
import { MAX_TOOL_RESULT_CHARS, serializeGovernedToolResultWithMeta } from '@/lib/maxx/chat'
import {
  assemblePerformanceCockpitData, type CockpitEvidence, type MetaDeliveryEvidence,
} from '@/lib/cockpit/builder'
import { comparisonWindowKey, type CockpitRange } from '@/lib/cockpit/evidence'
import { comparableWindows } from '@/lib/cockpit/comparison-window'
import { boundedDayCodes } from '@/lib/cockpit/source-readers'

/**
 * A governed cockpit must fit in one tool result.
 *
 * THE FAILURE THIS PREVENTS. Past `MAX_TOOL_RESULT_CHARS` the payload is replaced by a truncated
 * STRING. `claimsFromToolResult` cannot parse a string, so EVERY claim is dropped and the turn ends
 * in "a governed lookup that does publish citable claims returned none this time". Not a shorter
 * answer — no answer, on the account's own numbers.
 *
 * It nearly shipped. Per-metric trends took a settling cockpit from 14 claims to 49 and its
 * payload to 61,618 chars against a 60,000 bound. Every test passed. The gate passed. Nothing
 * compared the payload to the bound, so the relationship between "how many claims we emit" and
 * "whether the chat works at all" was unobservable.
 *
 * This drives the REAL serializer with a worst-case cockpit, so the next growth in claims is a red
 * test rather than a silent loss of evidence. When it fails: raise the bound deliberately and say
 * what grew — do not widen it to turn the test green.
 */

const TZ = 'America/New_York' as const
const RANGE: CockpitRange = { start: '2026-08-01', end: '2026-08-20', basis: 'closed_account_days', timezone: TZ }

/** Every source available, so no claim is cheap: an unavailable claim carries no value or lineage. */
function delivery(factor: number, days: number): MetaDeliveryEvidence {
  return {
    available: true, spendAvailable: true, resultsAvailable: true, purchaseAvailable: true,
    leadAvailable: true, linkCtrAvailable: true, cpmAvailable: true, frequencyAvailable: true,
    spend: 1234.56 * factor, results: 20 * factor, purchaseValue: 3000 * factor,
    purchaseCount: 10 * factor, leads: 8 * factor, linkClicks: 100 * factor,
    impressions: 10_000 * factor, nativeFrequency: 1.5 * factor, dailyBudget: 70,
    spendCoveredDays: days, coveredDays: days, expectedDays: days,
    synchronizedAt: '2026-08-21T11:55:00.000Z', blockerCodes: [],
  }
}

const spanDays = (w: CockpitRange) =>
  Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1

/**
 * The largest cockpit the current contract can produce: a SETTLING request, so spend and the
 * classifier-governed metrics resolve to different comparable windows and both sets of prior claims
 * are emitted.
 */
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
      if (key !== comparisonWindowKey(RANGE)) deliveryByWindow[key] = delivery(factor, spanDays(window))
    }
  }
  const evidence: CockpitEvidence = {
    account: { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'Example Studio' },
    range: RANGE,
    asOf: '2026-08-21T12:00:00.000Z',   // mid-settle: the divergent case
    delivery: delivery(2, 20),
    comparison: { deliveryByWindow, blockerCodes: [] },
    partialToday: { available: true, date: '2026-08-21', spend: 4.57, dailyBudget: 70, synchronizedAt: '2026-08-21T11:57:00.000Z', blockerCodes: [] },
    synchronizedAt: '2026-08-21T11:55:00.000Z',
    decisionIds: ['decision-1'], primaryDecisionId: 'decision-1',
    primaryDecision: { id: 'decision-1', title: 'Review source health', summary: 'Review governed evidence.', bucket: 'needs_review', lifecycle: 'ready', authority: 'owner_review', reviewDate: null },
  }
  return assemblePerformanceCockpitData(evidence)
}

const serialize = (result: unknown) => serializeGovernedToolResultWithMeta(
  { tool: 'get_performance_cockpit', args: { start_date: RANGE.start, end_date: RANGE.end }, result },
  MAX_TOOL_RESULT_CHARS,
)

describe('a worst-case governed cockpit fits in one tool result', () => {
  it('really is the divergent case — otherwise this measures the small cockpit', () => {
    // Guards the whole file: if the fixture stopped producing two comparable windows it would shrink
    // to the settled shape and pass while the real payload overflowed.
    const cockpit = worstCaseCockpit()
    expect(cockpit.comparison.window).toBeNull()          // no single shared prior window
    expect(Object.keys(cockpit.claims).length).toBeGreaterThan(40)
  })

  it('is NOT truncated', () => {
    const { truncated } = serialize(worstCaseCockpit())
    expect(truncated).toBe(false)
  })

  it('survives as parseable JSON with its claims intact', () => {
    // The real consequence, asserted rather than inferred from the flag: `claimsFromToolResult`
    // parses this text, and a truncated payload becomes a string it cannot read.
    const cockpit = worstCaseCockpit()
    const parsed = JSON.parse(serialize(cockpit).text) as { data: { claims: Record<string, unknown> } }
    expect(Object.keys(parsed.data.claims)).toHaveLength(Object.keys(cockpit.claims).length)
  })

  it('leaves real headroom, so the next metric added does not break the chat', () => {
    const { text } = serialize(worstCaseCockpit())
    expect(text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS * 0.8)
  })

  it('reports the measurement, so a failure says how much too big', () => {
    const { text } = serialize(worstCaseCockpit())
    const cockpit = worstCaseCockpit()
    expect({
      claims: Object.keys(cockpit.claims).length,
      chars: text.length,
      bound: MAX_TOOL_RESULT_CHARS,
    }).toMatchObject({ bound: MAX_TOOL_RESULT_CHARS })
    expect(text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS)
  })
})

describe('the truncation path still works when a payload genuinely is too big', () => {
  it('truncates and flags it, rather than silently passing an oversized payload', () => {
    // The bound must still BIND. A test that only proves the cockpit fits would also pass if
    // truncation had been disabled entirely.
    const huge = { claims: Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`claim-${i}`, { filler: 'x'.repeat(500) }]),
    ) }
    const { truncated, text } = serialize(huge)
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
  })
})

/**
 * THE OTHER growth vector, and the one the fixture above cannot see.
 *
 * The cockpit above pins a 20-day, fully-covered window with `blockerCodes: []`. Payload size is
 * also driven by something that fixture models zero of: `source-readers.ts` emitted ONE blocker code
 * per absent day, and `builder.ts` spreads a source's codes into EVERY unavailable claim it
 * produces (`[...input.delivery.blockerCodes, 'meta_X_unavailable']`, ~10 per window, once per
 * comparison window). A wide window multiplies one code per day by that fan-out.
 *
 * That is not hypothetical. `ytd` is a shipped one-click preset in `DATE_PRESETS`, persisted in the
 * URL, and `get_performance_cockpit` accepts any window the model asks for. If `daily_insights`
 * account rows begin partway through the year, a YTD request can span 236 days of which 158 have no
 * row at all -- and a window with absent days reports
 * `spendAvailable: false`, so every claim is the unavailable kind that carries the full list.
 *
 * Past `MAX_TOOL_RESULT_CHARS` the payload becomes a truncated STRING, and `chat.ts` registers
 * claims only `if (!truncated)` -- so the owner clicks a preset and the chat loses ALL of its
 * evidence, answering "a governed lookup that does publish citable claims returned none this time".
 *
 * The codes are built by the PRODUCTION helper rather than written as literals, so if the cap in
 * `boundedDayCodes` is ever removed this fixture grows one code per day exactly as the readers
 * would, and this file goes red instead of the chat going quiet.
 */
describe('absent-day blocker codes cannot grow the cockpit without bound', () => {
  const WIDE: CockpitRange = { start: '2026-01-01', end: '2026-08-24', basis: 'closed_account_days', timezone: TZ }
  const WIDE_SPAN_DAYS = 236
  const WIDE_ABSENT_DAYS = 158

  const absentDates = (count: number) => Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10))

  /** The real production state for a gappy window: nothing available, every claim carrying the codes. */
  function gappyDelivery(days: number): MetaDeliveryEvidence {
    const absent = Math.max(1, Math.round(days * (WIDE_ABSENT_DAYS / WIDE_SPAN_DAYS)))
    return {
      available: false, spendAvailable: false, resultsAvailable: false, purchaseAvailable: false,
      leadAvailable: false, linkCtrAvailable: false, cpmAvailable: false, frequencyAvailable: false,
      spend: 0, results: 0, purchaseValue: 0, purchaseCount: 0, leads: 0, linkClicks: 0,
      impressions: 0, nativeFrequency: 0, dailyBudget: 70,
      spendCoveredDays: days - absent, coveredDays: days - absent, expectedDays: days,
      synchronizedAt: '2026-08-25T11:55:00.000Z',
      blockerCodes: boundedDayCodes('meta_account_spend_day_missing', absentDates(absent)),
    }
  }

  function gappyCockpit() {
    const deliveryByWindow: Record<string, MetaDeliveryEvidence> = {}
    for (const maturity of [
      { state: 'settled' as const, matureThrough: WIDE.end },
      { state: 'settling' as const, matureThrough: '2026-08-13' },
    ]) {
      const pair = comparableWindows(WIDE, maturity)
      if (!pair) continue
      for (const window of [pair.current, pair.prior]) {
        const key = comparisonWindowKey(window)
        if (key !== comparisonWindowKey(WIDE)) deliveryByWindow[key] = gappyDelivery(spanDays(window))
      }
    }
    const evidence: CockpitEvidence = {
      account: { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'Example Studio' },
      range: WIDE,
      asOf: '2026-08-25T12:00:00.000Z',
      delivery: gappyDelivery(WIDE_SPAN_DAYS),
      comparison: { deliveryByWindow, blockerCodes: [] },
      partialToday: { available: true, date: '2026-08-25', spend: 4.57, dailyBudget: 70, synchronizedAt: '2026-08-25T11:57:00.000Z', blockerCodes: [] },
      synchronizedAt: '2026-08-25T11:55:00.000Z',
      decisionIds: ['decision-1'], primaryDecisionId: 'decision-1',
      primaryDecision: { id: 'decision-1', title: 'Review source health', summary: 'Review governed evidence.', bucket: 'needs_review', lifecycle: 'ready', authority: 'owner_review', reviewDate: null },
    }
    return assemblePerformanceCockpitData(evidence)
  }

  const serializeWide = (result: unknown) => serializeGovernedToolResultWithMeta(
    { tool: 'get_performance_cockpit', args: { start_date: WIDE.start, end_date: WIDE.end }, result },
    MAX_TOOL_RESULT_CHARS,
  )

  it('ANTI-VACUITY: the fixture really carries absent-day codes on real claims', () => {
    // Without this the case could pass by modelling a clean window — which is exactly how the
    // overflow stayed invisible to the fixture above.
    const cockpit = gappyCockpit()
    const codes = Object.values(cockpit.claims)
      .flatMap((claim) => (claim as { availability?: { blockerCodes?: string[] } }).availability?.blockerCodes ?? [])
    expect(codes.some((code) => code.startsWith('meta_account_spend_day_missing'))).toBe(true)
    expect(Object.keys(cockpit.claims).length).toBeGreaterThan(10)
  })

  it('a YTD-width window with 158 absent days is NOT truncated', () => {
    expect(serializeWide(gappyCockpit()).truncated).toBe(false)
  })

  it('keeps its claims parseable, which is the thing that actually breaks', () => {
    const cockpit = gappyCockpit()
    const parsed = JSON.parse(serializeWide(cockpit).text) as { data: { claims: Record<string, unknown> } }
    expect(Object.keys(parsed.data.claims)).toHaveLength(Object.keys(cockpit.claims).length)
  })

  it('reports the measurement, so a failure says how much too big', () => {
    const { text } = serializeWide(gappyCockpit())
    expect({ chars: text.length, bound: MAX_TOOL_RESULT_CHARS })
      .toMatchObject({ bound: MAX_TOOL_RESULT_CHARS })
    expect(text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS)
  })
})
