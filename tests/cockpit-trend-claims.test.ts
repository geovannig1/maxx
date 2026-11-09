import { describe, expect, it } from 'vitest'
import {
  assemblePerformanceCockpitData, EVENT_BACKED_METRICS, FLOOR_EXEMPT_METRICS,
  type CockpitEvidence, type MetaDeliveryEvidence,
} from '@/lib/cockpit/builder'
import { comparisonWindowKey, type CockpitRange } from '@/lib/cockpit/evidence'
import { comparableWindows } from '@/lib/cockpit/comparison-window'
import { PerformanceCockpitDataSchema } from '@/lib/cockpit/contracts'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { blockerLabel } from '@/lib/diagnostics/blocker-labels'

/**
 * Per-metric trends, one metric at a time.
 *
 * The whole point of the per-claim comparable window is that the twelve metrics do NOT share one, so
 * a single blanket assertion over "the trends" would pass while individual metrics were wrong. Each
 * metric therefore gets its own case, and the two that must refuse a number outright get theirs
 * first, because they are the ones a generic percent-change formula would happily fabricate.
 */

const TZ = 'America/New_York' as const
const range = (start: string, end: string): CockpitRange =>
  ({ start, end, basis: 'closed_account_days', timezone: TZ })

/** Delivery evidence with every source available, scaled by `factor`. */
function delivery(factor: number, days: number, overrides: Partial<MetaDeliveryEvidence> = {}): MetaDeliveryEvidence {
  return {
    available: true, spendAvailable: true, resultsAvailable: true, purchaseAvailable: true,
    leadAvailable: true, linkCtrAvailable: true, cpmAvailable: true, frequencyAvailable: true,
    spend: 1000 * factor, results: 20 * factor, purchaseValue: 3000 * factor, purchaseCount: 10 * factor,
    leads: 8 * factor, linkClicks: 100 * factor, impressions: 10_000 * factor,
    nativeFrequency: 1.5 * factor, dailyBudget: 70, spendCoveredDays: days, coveredDays: days, expectedDays: days,
    synchronizedAt: '2026-08-21T11:55:00.000Z', blockerCodes: [], ...overrides,
  }
}

const REQUESTED = range('2026-08-01', '2026-08-20')
const ASOF = '2026-09-05T12:00:00.000Z'   // far past the settle boundary: the whole request is settled

/**
 * Build the cockpit with comparison evidence for exactly the windows the claims will ask for,
 * derived the same way the loader derives them.
 */
function cockpit(options: {
  asOf?: string
  requested?: CockpitRange
  current?: MetaDeliveryEvidence
  prior?: (window: CockpitRange) => MetaDeliveryEvidence
  omitComparison?: boolean
  omitWindows?: string[]
  comparisonBlockers?: string[]
  partialToday?: CockpitEvidence['partialToday']
} = {}) {
  const requested = options.requested ?? REQUESTED
  const asOf = options.asOf ?? ASOF
  const days = (w: CockpitRange) =>
    Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1

  const deliveryByWindow: Record<string, MetaDeliveryEvidence> = {}
  for (const maturity of [
    { state: 'settled' as const, matureThrough: requested.end },
    { state: 'settling' as const, matureThrough: '2026-08-13' },
  ]) {
    const pair = comparableWindows(requested, maturity)
    if (!pair) continue
    for (const [window, factor] of [[pair.current, 2], [pair.prior, 1]] as const) {
      const key = comparisonWindowKey(window)
      if (key === comparisonWindowKey(requested)) continue
      if (options.omitWindows?.includes(key)) continue
      deliveryByWindow[key] = factor === 1 && options.prior
        ? options.prior(window)
        : delivery(factor, days(window))
    }
  }

  const evidence: CockpitEvidence = {
    account: { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'ES' },
    range: requested,
    asOf,
    delivery: options.current ?? delivery(2, days(requested)),
    ...(options.omitComparison ? {} : {
      comparison: { deliveryByWindow, blockerCodes: options.comparisonBlockers ?? [] },
    }),
    partialToday: options.partialToday ?? { available: false, date: '2026-09-05', spend: null, dailyBudget: null, synchronizedAt: null, blockerCodes: ['x'] },
    synchronizedAt: '2026-08-21T11:55:00.000Z', decisionIds: [], primaryDecisionId: null, primaryDecision: null,
  }
  return assemblePerformanceCockpitData(evidence)
}

const trendFor = (data: ReturnType<typeof cockpit>, metricKey: string) =>
  Object.values(data.claims).find((claim) => claim.metricKey === `${metricKey}_change`)!

describe('the two metrics that must refuse a number, whatever the arithmetic allows', () => {
  it('meta.spend_pacing carries its OWN blocker, not a generic one', () => {
    // Its value is hardcoded null with `historical_budget_continuity_unproven`, so any percent change
    // computed for it would be invented from nothing. The reason must survive into the trend, or the
    // reader learns only that it is missing.
    const trend = trendFor(cockpit(), 'meta.spend_pacing')
    expect(trend.value).toBeNull()
    expect(trend.availability.state).toBe('unavailable')
    expect(trend.availability.blockerCodes).toContain('historical_budget_continuity_unproven')
    expect(trend.availability.blockerCodes).toContain('trend_side_unavailable')
  })

  it('meta.native_frequency refuses when the native rollup is absent', () => {
    // The measurement contract permits a multi-day frequency only from a native all-days rollup.
    const data = cockpit({ current: delivery(2, 20, { frequencyAvailable: false, nativeFrequency: null }) })
    const trend = trendFor(data, 'meta.native_frequency')
    expect(trend.value).toBeNull()
    expect(trend.availability.state).toBe('unavailable')
  })

  it('meta.native_frequency DOES compare two native rollups of equal length', () => {
    // Equal-length windows by construction, both natively computed by Meta, so this is a comparison
    // of two native values rather than a recomputed one. Guards the test above against passing for
    // the wrong reason — a blanket refusal would satisfy it too.
    const trend = trendFor(cockpit(), 'meta.native_frequency')
    expect(trend.availability.state).toBe('available')
    expect(trend.value).toBeCloseTo(100, 6)
  })
})

describe('each remaining metric, one at a time', () => {
  // Prior factor 1, current factor 2 → every raw count and money figure doubles (+100%). Ratios of
  // two doubled figures are unchanged (0%). Asserting the SHAPE per metric, not one blanket number.
  const doubles = ['meta.spend', 'meta.appointment_confirmed_results', 'meta.purchase_value',
    'meta.link_clicks', 'meta.impressions']
  const unchanged = ['meta.cost_per_result', 'meta.purchase_roas', 'meta.link_ctr', 'meta.cpm']

  it.each(doubles)('%s doubles → +100%%', (metricKey) => {
    const trend = trendFor(cockpit(), metricKey)
    expect(trend.availability.state).toBe('available')
    expect(trend.value).toBeCloseTo(100, 6)
  })

  it.each(unchanged)('%s is a ratio of two doubled inputs → 0%%', (metricKey) => {
    const trend = trendFor(cockpit(), metricKey)
    expect(trend.availability.state).toBe('available')
    expect(trend.value).toBeCloseTo(0, 6)
  })

  it('a FALL is reported as a negative percent, not an absolute movement', () => {
    const data = cockpit({ current: delivery(0.5, 20) })
    expect(trendFor(data, 'meta.spend').value).toBeCloseTo(-50, 6)
  })
})

describe('every trend states, in a field, what it was compared against', () => {
  it('carries prior_equal_period and the prior window — not just prose in source.head', () => {
    // The first version stated the prior window ONLY in `source.head`. A statement that lives in
    // prose is a statement no consumer can check, and `comparison.window` stayed null on the one
    // claim in the system that IS a comparison.
    const trend = trendFor(cockpit(), 'meta.spend')
    expect(trend.comparison.method).toBe('prior_equal_period')
    expect(trend.comparison.window).not.toBeNull()
    expect(trend.comparison.window!.start).toBe('2026-07-12')
    expect(trend.comparison.window!.end).toBe('2026-07-31')
  })

  it('the prior window is the same length as the window compared, and does not overlap it', () => {
    const trend = trendFor(cockpit(), 'meta.spend')
    const len = (w: { start: string, end: string }) =>
      Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1
    expect(len(trend.comparison.window!)).toBe(len(trend.window))
    expect(trend.comparison.window!.end < trend.window.start).toBe(true)
  })

  it('cites both sides, and every cited id resolves in the claim set', () => {
    const data = cockpit()
    const trend = trendFor(data, 'meta.spend')
    expect(trend.inputClaimIds).toHaveLength(2)
    for (const id of trend.inputClaimIds) expect(data.claims[id]).toBeDefined()
  })

  it('EVERY claim in the set has resolvable lineage, transitively', () => {
    // The support set must be transitively closed: a derived claim cites its own inputs in its own
    // window, so keeping only the ids a trend names drops those and the lineage guard throws. Found
    // by execution, and only in the settling case.
    const data = cockpit({ asOf: '2026-08-21T12:00:00.000Z' })
    for (const claim of Object.values(data.claims)) {
      for (const id of claim.inputClaimIds) {
        expect(data.claims[id], `${claim.claimId} cites ${id}`).toBeDefined()
      }
    }
  })
})

describe('the windows diverge per metric when the request is partly settling', () => {
  // 2026-08-21 clock: the settle boundary is 2026-08-13, so spend compares the whole request while
  // classifier-governed claims stop there. This is the case the whole design exists for.
  const data = cockpit({ asOf: '2026-08-21T12:00:00.000Z' })

  it('spend compares the FULL request, because money does not re-attribute', () => {
    const trend = trendFor(data, 'meta.spend')
    expect(trend.window.end).toBe('2026-08-20')
  })

  it('conversions stop at the settle boundary', () => {
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.window.end).toBe('2026-08-13')
    expect(trend.window.end).not.toBe(trend.window.start)
  })

  it('the two therefore compare DIFFERENT prior windows', () => {
    expect(trendFor(data, 'meta.spend').comparison.window!.start)
      .not.toBe(trendFor(data, 'meta.appointment_confirmed_results').comparison.window!.start)
  })

  it('the cockpit states NO shared window, rather than picking one that contradicts the rows', () => {
    expect(data.comparison.window).toBeNull()
    expect(data.comparison.state).toBe('available')
  })

  it('a fully settled request DOES share one window', () => {
    const settled = cockpit()
    expect(settled.comparison.window).not.toBeNull()
    expect(settled.comparison.window!.start).toBe('2026-07-12')
  })
})

describe('a trend is refused rather than guessed', () => {
  it('when the prior period is ZERO — that is not a 100% rise', () => {
    const data = cockpit({ prior: () => delivery(0, 20, { spend: 0 }) })
    const trend = trendFor(data, 'meta.spend')
    expect(trend.value).toBeNull()
    expect(trend.availability.blockerCodes).toContain('trend_prior_period_zero')
  })

  it('when a window has INCOMPLETE day coverage, even though the claim itself is available', () => {
    // The guard that maturity cannot provide. `settle-window.ts` records that today's row is usually
    // ABSENT rather than zero, which reads as a real fall in volume rather than a missing day.
    //
    // Aimed at `meta.appointment_confirmed_results` deliberately: it takes `deliveryCoverage`, which
    // reports `partial` when days are missing, and it is a COUNT, so `MetricClaimSchema` permits it
    // to be available anyway. That combination — available claim, incomplete window — is exactly what
    // this branch exists for. `meta.spend` cannot demonstrate it: `spendCoverage` reports complete
    // whenever spend is available, so a spend-based case would pass for the wrong reason.
    const data = cockpit({ prior: () => delivery(1, 20, { coveredDays: 18, expectedDays: 20 }) })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.value).toBeNull()
    expect(trend.availability.state).toBe('unavailable')
    expect(trend.availability.blockerCodes).toContain('trend_window_coverage_incomplete')
    // NOT the unavailable-side path. Both sides ARE available here — that is the point — so a test
    // asserting only "unavailable" would pass whichever branch fired and prove nothing about coverage.
    expect(trend.availability.blockerCodes).not.toContain('trend_side_unavailable')
  })

  it('KEEPS the supporting prior claim when its trend was refused, so counts can still be shown', () => {
    // Reversed deliberately. The earlier behaviour pruned a refused trend's prior claim as
    // unreferenced noise — but the two numbers behind a refused percentage are exactly what a media
    // buyer reads. "17 vs 13 bookings" carries everything the percentage does without the false
    // precision, and it works where a percentage cannot: 0 to 3 at flat spend is the most
    // decision-relevant thing a small account can produce, and it used to render as an absence.
    const data = cockpit({ prior: () => delivery(1, 20, { results: 2 }) })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.availability.state).toBe('unavailable')
    expect(trend.availability.blockerCodes).toContain('trend_sample_too_small')
    // …and both sides are still resolvable, which is what lets the surface print the counts.
    expect(trend.inputClaimIds).toHaveLength(2)
    for (const id of trend.inputClaimIds) expect(data.claims[id]).toBeDefined()
  })

  it('cites nothing when a window could not be READ — there is no count to show', () => {
    // The distinction that matters: refused-but-measured keeps its numbers; never-measured has none.
    const pair = comparableWindows(REQUESTED, { state: 'settled', matureThrough: REQUESTED.end })!
    const data = cockpit({ omitWindows: [comparisonWindowKey(pair.prior)] })
    expect(trendFor(data, 'meta.spend').inputClaimIds).toEqual([])
  })

  it('when the prior window could not be READ at all', () => {
    const pair = comparableWindows(REQUESTED, { state: 'settled', matureThrough: REQUESTED.end })!
    const data = cockpit({ omitWindows: [comparisonWindowKey(pair.prior)] })
    const trend = trendFor(data, 'meta.spend')
    expect(trend.value).toBeNull()
    expect(trend.availability.blockerCodes).toContain('trend_prior_window_unavailable')
  })

  it('when the caller supplied NO comparison evidence — absence is not "no change"', () => {
    const data = cockpit({ omitComparison: true })
    expect(data.comparison.state).toBe('not_requested')
    for (const id of data.comparison.claimIds) {
      expect(data.claims[id].availability.state).toBe('unavailable')
      expect(data.claims[id].availability.blockerCodes).toContain('trend_comparison_evidence_absent')
    }
  })

  it('an unavailable trend carries NO value, whatever lineage it kept', () => {
    // Lineage is kept where both sides were measured, so the counts can be shown. The VALUE is the
    // thing that must never appear on a refused trend — a percentage the data does not support.
    const data = cockpit({ omitComparison: true })
    for (const id of data.comparison.claimIds) {
      expect(data.claims[id].value).toBeNull()
      expect(data.claims[id].inputClaimIds).toEqual([])   // no comparison evidence at all
    }
    const refused = cockpit({ prior: () => delivery(1, 20, { results: 2 }) })
    const trend = trendFor(refused, 'meta.appointment_confirmed_results')
    expect(trend.value).toBeNull()
    expect(trend.inputClaimIds).toHaveLength(2)
  })
})

describe('the assembled cockpit stays contract-valid with trends in it', () => {
  it('validates, and every referenced trend id exists', () => {
    const data = cockpit()
    expect(() => PerformanceCockpitDataSchema.parse(data)).not.toThrow()
    expect(data.comparison.claimIds.length).toBeGreaterThan(0)
    for (const id of data.comparison.claimIds) expect(data.claims[id]).toBeDefined()
  })

  it('emits one trend per delivery metric, and no duplicate claim ids', () => {
    const data = cockpit()
    const ids = Object.values(data.claims).map((c) => c.claimId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(data.comparison.claimIds).toHaveLength(new Set(data.comparison.claimIds).size)
  })

  it('a trend is CONTEXT authority — the numbers it reads remain the authority', () => {
    expect(trendFor(cockpit(), 'meta.spend').authority.state).toBe('context')
    expect(trendFor(cockpit(), 'meta.spend').measurementKind).toBe('derived')
  })

  it('a trend inherits the attribution scope of the metric it describes', () => {
    // A trend on a modelled metric must not present itself as measured.
    const data = cockpit()
    expect(trendFor(data, 'meta.appointment_confirmed_results').attributionScope)
      .toBe(data.claims[data.paidPerformance.resultsClaimId].attributionScope)
    expect(trendFor(data, 'meta.spend').attributionScope)
      .toBe(data.claims[data.paidPerformance.spendClaimId].attributionScope)
  })
})

describe('gaps the mutation sweep found — each was unverified behaviour', () => {
  /**
   * Every case here corresponds to a mutation that SURVIVED a full sweep: the code could be changed
   * and 4107 tests stayed green. Two of them matter more than the rest.
   *
   * `maturity` is the one I had already reviewed BY HAND, measured as correct, and reported as "no
   * change needed" — while nothing asserted it. A measurement I made once is not a guard; deleting
   * the property outright left the suite green.
   */
  const UNSETTLED = range('2026-08-18', '2026-08-21')   // entirely inside the 7-day settle boundary

  it('a trend inherits the maturity of the window it actually covers', () => {
    // Deleting `maturity: current?.maturity` survived. The trend covers the COMPARABLE window, so its
    // maturity must describe that window and not the requested one — a settling label on a fully
    // settled comparison would tell a reader the number may still restate when it cannot.
    const data = cockpit({ asOf: '2026-08-21T12:00:00.000Z' })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.window.end).toBe('2026-08-13')
    expect(trend.maturity.state).toBe('settled')
    expect(trend.maturity.matureThrough).toBe('2026-08-13')
  })

  it('a trend over the full request carries that window\'s maturity, not the shortened one', () => {
    // Guards the case above against passing because every trend was stamped settled-through-08-13.
    const data = cockpit({ asOf: '2026-08-21T12:00:00.000Z' })
    const spend = trendFor(data, 'meta.spend')
    expect(spend.window.end).toBe('2026-08-20')
    expect(spend.maturity.matureThrough).toBe('2026-08-20')
  })

  it('names trend_window_uncomparable when nothing in the request has settled', () => {
    // Blanking that blocker code survived: no test reached the "no comparable pair" path at all.
    const data = cockpit({ requested: UNSETTLED, asOf: '2026-08-21T12:00:00.000Z' })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.availability.state).toBe('unavailable')
    expect(trend.availability.blockerCodes).toContain('trend_window_uncomparable')
  })

  it('says so in the source head, rather than naming a window it does not have', () => {
    const data = cockpit({ requested: UNSETTLED, asOf: '2026-08-21T12:00:00.000Z' })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.source.head).toBe('no comparable prior window')
    expect(trend.comparison.method).toBe('none')
    expect(trend.comparison.window).toBeNull()
  })

  it('reports comparison.state UNAVAILABLE when every trend was refused', () => {
    // Flipping the `some(available)` test survived: nothing asserted the unavailable branch, so the
    // cockpit could have reported "available" over a grid where no trend resolved.
    const data = cockpit({ omitWindows: [
      comparisonWindowKey(comparableWindows(REQUESTED, { state: 'settled', matureThrough: REQUESTED.end })!.prior),
      comparisonWindowKey(comparableWindows(REQUESTED, { state: 'settling', matureThrough: '2026-08-13' })!.prior),
      comparisonWindowKey(comparableWindows(REQUESTED, { state: 'settling', matureThrough: '2026-08-13' })!.current),
    ] })
    expect(data.comparison.claimIds.length).toBeGreaterThan(0)
    for (const id of data.comparison.claimIds) {
      expect(data.claims[id].availability.state).toBe('unavailable')
    }
    expect(data.comparison.state).toBe('unavailable')
  })

  it('reports AVAILABLE when at least one trend resolved', () => {
    // The other side of the same branch.
    expect(cockpit().comparison.state).toBe('available')
  })
})

describe('a trend needs enough events to mean anything', () => {
  /**
   * The blocker the first version of this feature did not have.
   *
   * Six blockers shipped — unread window, incomplete coverage, unsettled window, zero prior period,
   * non-numeric — and every one is about data plumbing. None asked how many conversions are in the
   * box. For example, weekly Results of 3, 8, 2, 5, 9, 4, 7 with spend flat every week produce
   * week-over-week swings of +167%, −75%, +150% with nothing changed.
   *
   * The floor is the repository's own `MIN_BOOKINGS_PERF_CLAIM` (4, Poisson 50%-RSE), already
   * enforced by `audience-performance.ts` before it will compare two groups. The trend path was the
   * one place not applying a doctrine written for exactly this question.
   */
  // DERIVED, not the literal 4. The docstring above says the floor is the repository's own
  // `MIN_BOOKINGS_PERF_CLAIM` — so read it from there. A hardcoded copy does not "move with it"; it
  // BREAKS when the constant moves, and takes the refusal tests down with it.
  const FLOOR = REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM
  const lowEvents = (results: number) => (window: CockpitRange) => ({
    ...delivery(1, 20),
    results,
    purchaseCount: results,
    leads: results,
    // Money and impressions stay large: this isolates the EVENT count as the cause.
    spend: 1000, impressions: 10_000, linkClicks: 100,
    coveredDays: 20, expectedDays: 20,
    ...(window ? {} : {}),
  })

  it('REFUSES a Results trend when the prior period is below the floor', () => {
    const data = cockpit({ prior: lowEvents(FLOOR - 1) })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.value).toBeNull()
    expect(trend.availability.blockerCodes).toContain('trend_sample_too_small')
  })

  it('REFUSES when the CURRENT period is below the floor, even against a rich prior', () => {
    // A large prior against a tiny current is the same defect mirrored.
    const data = cockpit({ current: { ...delivery(1, 20), results: FLOOR - 1 } })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.availability.blockerCodes).toContain('trend_sample_too_small')
  })

  it('ALLOWS it once both sides clear the floor (so this is not a blanket refusal)', () => {
    const data = cockpit({ prior: () => ({ ...delivery(1, 20), results: FLOOR }) })
    const trend = trendFor(data, 'meta.appointment_confirmed_results')
    expect(trend.availability.state).toBe('available')
  })

  it('applies to DERIVED metrics too — a ratio does not add information to its own n', () => {
    // cost_per_result over 3 bookings is a claim about 3 bookings. Hiding the count behind a division
    // is exactly how a small sample gets laundered into a confident percentage.
    const data = cockpit({ prior: lowEvents(FLOOR - 1) })
    // cost_per_lead included: its map entry could be DELETED with all 4102 tests green, because it
    // appeared in neither the must-refuse list nor the must-not-refuse list.
    for (const metricKey of ['meta.cost_per_result', 'meta.purchase_roas', 'meta.purchase_value', 'meta.cost_per_lead']) {
      expect(trendFor(data, metricKey).availability.blockerCodes, metricKey)
        .toContain('trend_sample_too_small')
    }
  })

  it('does NOT apply to delivery metrics, which have real n even on a small account', () => {
    // Tens of thousands of impressions, hundreds of clicks. Refusing these would be false caution.
    const data = cockpit({ prior: lowEvents(FLOOR - 1) })
    for (const metricKey of ['meta.spend', 'meta.impressions', 'meta.link_clicks', 'meta.link_ctr', 'meta.cpm']) {
      expect(trendFor(data, metricKey).availability.state, metricKey).toBe('available')
    }
  })

  it('uses the repository floor, not a number invented here', () => {
    // If MIN_BOOKINGS_PERF_CLAIM moves, this moves with it rather than silently disagreeing.
    expect(FLOOR).toBe(REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM)
  })
})

describe('a refused trend carries the loader\'s reason, not just a generic one', () => {
  /**
   * `ComparisonEvidence.blockerCodes` was write-only. The loader computes
   * `cockpit_trend_window_read_failed:<window>` — the only artifact naming WHICH window failed — and
   * nothing read it, so the owner and the chat saw only `trend_prior_window_unavailable`. Proven by
   * mutation: returning `blockerCodes: []` from the loader failed only the loader's own tests.
   */
  it('keeps the loader\'s internal codes OUT of what the owner reads', () => {
    // Forwarding them reintroduced the defect the labelling commit had just removed: `sorted()` is
    // alphabetical, `cockpit_…` sorts before `trend_…`, and both renderers show
    // `blockerLabel(blockerCodes[0])` — which has no mapping for them. The cell read
    // "No prior-period comparison · cockpit trend window read failed:2026-07-12:2026-07-31".
    const pair = comparableWindows(REQUESTED, { state: 'settled', matureThrough: REQUESTED.end })!
    const priorKey = comparisonWindowKey(pair.prior)
    const data = cockpit({
      omitWindows: [priorKey],
      comparisonBlockers: [`cockpit_trend_window_read_failed:${priorKey}`],
    })
    const trend = trendFor(data, 'meta.spend')
    expect(trend.availability.state).toBe('unavailable')
    // The owner-facing reason, which IS labelled.
    expect(trend.availability.blockerCodes).toContain('trend_prior_window_unavailable')
    // And nothing internal.
    for (const code of trend.availability.blockerCodes) {
      expect(code, `internal code reached the owner: ${code}`).not.toMatch(/^cockpit_/)
    }
  })

  it('every owner-facing blocker on a trend has a label — checked at the RENDER, not the code', () => {
    // The real property: whatever ends up first after `sorted()` is what the cell prints. Asserting
    // "contains the right code" cannot see an unlabelled code sorting ahead of it.
    const pair = comparableWindows(REQUESTED, { state: 'settled', matureThrough: REQUESTED.end })!
    const data = cockpit({
      omitWindows: [comparisonWindowKey(pair.prior)],
      comparisonBlockers: [`cockpit_trend_window_read_failed:${comparisonWindowKey(pair.prior)}`],
    })
    for (const id of data.comparison.claimIds) {
      const claim = data.claims[id]
      if (claim.availability.state !== 'unavailable') continue
      const shown = blockerLabel(claim.availability.blockerCodes[0] ?? 'source_unavailable')
      expect(shown, `${id} renders a raw code`).not.toMatch(/_/)
    }
  })

  it('does NOT attach loader blockers to a trend that resolved fine', () => {
    // A read failure on one window must not decorate the trends that were unaffected by it.
    const pair = comparableWindows(REQUESTED, { state: 'settling', matureThrough: '2026-08-13' })!
    const data = cockpit({
      asOf: '2026-08-21T12:00:00.000Z',
      omitWindows: [comparisonWindowKey(pair.prior)],
      comparisonBlockers: [`cockpit_trend_window_read_failed:${comparisonWindowKey(pair.prior)}`],
    })
    const spend = trendFor(data, 'meta.spend')
    expect(spend.availability.state).toBe('available')
    expect(spend.availability.blockerCodes).toEqual([])
  })
})

/**
 * TOTALITY, not membership. Every metric that gets a trend must have DECIDED about the event floor.
 *
 * `EVENT_BACKED_METRICS` is opt-IN, so a metric added to `deliveryClaimsByMetric` silently gets a
 * trend with no floor. That is not hypothetical: `meta.optimization_events_per_week` shipped that
 * way, and because its value is `results ÷ days × 7` its percent change is ARITHMETICALLY IDENTICAL
 * to the Results trend — so one cockpit refused 2→40 Results as `trend_sample_too_small` and
 * published the same 2→40 as +1900%, in the same drawer, citable by the governed chat.
 *
 * The two membership tests above could not catch it. They enumerate metrics someone remembered; this
 * asserts the union covers the emitted population, so a metric added later must be classified or the
 * suite fails.
 */
describe('every trended metric is classified against the event floor', () => {
  it('leaves no emitted *_change claim unclassified', () => {
    const data = cockpit()
    const emitted = data.comparison.claimIds
      .map((id) => data.claims[id].metricKey.replace(/_change$/, ''))
    expect(emitted.length).toBeGreaterThan(10)
    const unclassified = emitted.filter(
      (key) => !EVENT_BACKED_METRICS.has(key) && !FLOOR_EXEMPT_METRICS.has(key),
    )
    expect(unclassified).toEqual([])
  })

  it('classifies each metric exactly once — the two lists cannot both claim one', () => {
    const both = [...EVENT_BACKED_METRICS.keys()].filter((key) => FLOOR_EXEMPT_METRICS.has(key))
    expect(both).toEqual([])
  })

  it('refuses the weekly rate on the same counts that refuse Results — they are the same events', () => {
    // The regression this whole block exists for, stated as behaviour rather than as a list.
    // Two bookings against one: below MIN_BOOKINGS_PERF_CLAIM on both sides.
    const data = cockpit({
      current: delivery(2, 20, { results: 2 }),
      prior: () => delivery(1, 20, { results: 1 }),
    })
    const results = trendFor(data, 'meta.appointment_confirmed_results')
    const rate = trendFor(data, 'meta.optimization_events_per_week')
    expect(results.availability.state).toBe('unavailable')
    expect(rate.availability.state).toBe(results.availability.state)
    expect(rate.availability.blockerCodes).toContain('trend_sample_too_small')
  })
})

/**
 * Every headline id resolves to the REQUESTED window.
 *
 * This is the fixture gap that let the wrong-window bug ship. `performance-cockpit-contract.test.ts`
 * builds from `completeEvidence()`, which supplies no `comparison` — so `support` is empty, no metric
 * appears twice, and a lookup that picks the wrong duplicate cannot be observed. Six tests written
 * specifically to prove reach and the learning rate were BUILT rather than injected all ran against
 * the one evidence shape in which the defect is unreachable.
 *
 * The trend feature's whole premise is that the claim set now holds the same metricKey over several
 * windows. Asserting resolution here — where that is true — is the property, not the anecdote.
 */
describe('the cockpit publishes ids that point at the requested window', () => {
  it('resolves every paidPerformance id to a claim covering the request, not a compared window', () => {
    const data = cockpit()
    const ids = Object.entries(data.paidPerformance)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    expect(ids.length).toBeGreaterThanOrEqual(10)
    for (const [field, claimId] of ids) {
      const claim = data.claims[claimId]
      expect(claim, `${field} -> ${claimId} does not resolve`).toBeDefined()
      expect(claim.window.start, field).toBe(REQUESTED.start)
      expect(claim.window.end, field).toBe(REQUESTED.end)
    }
  })

  it('holds the same metric over more than one window — otherwise the test above proves nothing', () => {
    // The guard against this whole block being vacuous. If the fixture ever stops producing
    // duplicates, resolution becomes trivially correct and the assertion above stops testing it.
    const data = cockpit()
    const windowsPerMetric = new Map<string, number>()
    for (const claim of Object.values(data.claims)) {
      windowsPerMetric.set(claim.metricKey, (windowsPerMetric.get(claim.metricKey) ?? 0) + 1)
    }
    const duplicated = [...windowsPerMetric.entries()].filter(([, count]) => count > 1)
    expect(duplicated.map(([key]) => key)).toContain('meta.native_reach')
    expect(duplicated.map(([key]) => key)).toContain('meta.optimization_events_per_week')
  })
})

/**
 * A trend's `inputClaimIds` are ORDERED: current first, prior second.
 *
 * `TodayPerformanceCockpit`'s `trendCounts` destructures them positionally —
 * `const [currentId, priorId] = trend.inputClaimIds` — and nothing asserted the order.
 * `MetricClaimSchema` only checks uniqueness. Any future normalisation (a sort, a Set round-trip)
 * silently renders "11 vs 24" where the truth is "24 vs 11": the counts-first line, which exists
 * precisely because the percentage cannot be trusted here, would then be backwards with no symptom.
 */
describe('trend lineage is ordered, not merely present', () => {
  it('cites the current window first and the prior window second', () => {
    const data = cockpit()
    const trends = data.comparison.claimIds
      .map((id) => data.claims[id])
      .filter((claim) => claim.inputClaimIds.length === 2)
    expect(trends.length).toBeGreaterThan(5)
    for (const trend of trends) {
      const [currentId, priorId] = trend.inputClaimIds
      const current = data.claims[currentId] ?? Object.values(data.claims).find((c) => c.claimId === currentId)
      const prior = data.claims[priorId] ?? Object.values(data.claims).find((c) => c.claimId === priorId)
      expect(current, `${trend.metricKey} current`).toBeDefined()
      expect(prior, `${trend.metricKey} prior`).toBeDefined()
      // The current side is the later window. Compared as dates, not by position in the array.
      expect(current!.window.start >= prior!.window.end, trend.metricKey).toBe(true)
      expect(current!.window.start, trend.metricKey).toBe(trend.window.start)
    }
  })
})

/**
 * "Could not be read" and "has no figure here" are different facts.
 *
 * One code — `trend_prior_window_unavailable`, labelled "the earlier period could not be read" —
 * covered three situations and stated only one of them: a window that genuinely failed to read, a
 * window that read fine but carries no claim for THIS metric (cost-per-Lead in a period with no
 * leads), and the CURRENT side being absent, where "the earlier period" is simply false.
 *
 * Same class of defect as `trend_prior_period_zero` reading as its own opposite: a label that states
 * something other than the fact is worse than a raw code, because it looks like an answer.
 */
describe('a trend says which of the two failures actually happened', () => {
  it('says the window could not be READ when the window is genuinely missing', () => {
    const prior = comparableWindows(REQUESTED, { state: 'settled', matureThrough: REQUESTED.end })!.prior
    const data = cockpit({ omitWindows: [comparisonWindowKey(prior)] })
    const spend = trendFor(data, 'meta.spend')
    expect(spend.availability.blockerCodes).toContain('trend_prior_window_unavailable')
    expect(spend.availability.blockerCodes).not.toContain('trend_metric_absent_in_window')
  })

  it('says the METRIC is absent when the window read fine but has no figure for it', () => {
    // The window is present and every other metric compares. Only leads are missing, which makes
    // `costPerLeadClaim` null in that window — read successfully, no claim.
    const data = cockpit({ prior: () => delivery(1, 20, { leadAvailable: false, leads: null }) })
    const cpl = trendFor(data, 'meta.cost_per_lead')
    expect(cpl.availability.blockerCodes).toContain('trend_metric_absent_in_window')
    expect(cpl.availability.blockerCodes).not.toContain('trend_prior_window_unavailable')
    // The distinction is only worth making if the window really was read — proven by a sibling
    // metric over the SAME window comparing successfully.
    expect(trendFor(data, 'meta.spend').availability.state).toBe('available')
  })

  it('states both new codes in owner English', () => {
    expect(blockerLabel('trend_metric_absent_in_window')).not.toContain('trend')
    expect(blockerLabel('cockpit_trend_read_threw')).not.toContain('cockpit')
  })
})

/**
 * The CURRENT side can be the missing one, and the code must say so.
 *
 * Both `sidesRead` mutations survived the sweep — flipping `currentClaims !== null` and flipping the
 * `current === null && …` conjunct each left the suite green, because every fixture here supplied the
 * current comparable window. Under settling maturity the current side is a SUB-window of the request,
 * not the request itself, so it is genuinely a separate read that can genuinely be absent.
 */
describe('the current comparable window can be the one that is missing', () => {
  const SETTLING_ASOF = '2026-08-21T12:00:00.000Z'   // request not yet settled: current side is a sub-window

  it('reports the window as unread when the CURRENT side could not be read', () => {
    const pair = comparableWindows(REQUESTED, { state: 'settling', matureThrough: '2026-08-13' })!
    expect(comparisonWindowKey(pair.current)).not.toBe(comparisonWindowKey(REQUESTED))
    const data = cockpit({ asOf: SETTLING_ASOF, omitWindows: [comparisonWindowKey(pair.current)] })
    const results = trendFor(data, 'meta.appointment_confirmed_results')
    expect(results.availability.state).toBe('unavailable')
    expect(results.availability.blockerCodes).toContain('trend_prior_window_unavailable')
    expect(results.availability.blockerCodes).not.toContain('trend_metric_absent_in_window')
  })

  it('reports both sides read when both windows are present', () => {
    // The negative half, so the assertion above cannot pass by the code always saying "unread".
    const data = cockpit({ asOf: SETTLING_ASOF })
    const results = trendFor(data, 'meta.appointment_confirmed_results')
    expect(results.availability.blockerCodes).not.toContain('trend_prior_window_unavailable')
  })
})

/**
 * The daily budget is a NUMBER on the page, not just a denominator inside someone else's formula.
 *
 * `readDailyBudget` is CBO/ABO-safe and was already being read — then used only to divide today's
 * spend into "87.0% of current daily budget". The page stated a ratio and never stated what the
 * ratio was of, and "should I scale" is decided against the owner-approved ceiling, not against 87%.
 */
describe('the current daily budget is a governed claim', () => {
  const withBudget = (dailyBudget: number | null) => cockpit({
    partialToday: {
      available: true, date: '2026-09-05', spend: 78.1, dailyBudget,
      synchronizedAt: '2026-09-05T11:00:00.000Z', blockerCodes: [],
    },
  })

  it('publishes the budget as its own claim, in dollars', () => {
    const data = withBudget(90)
    const claim = Object.values(data.claims).find((c) => c.metricKey === 'meta.current_daily_budget')
    expect(claim, 'no daily-budget claim was published').toBeDefined()
    expect(claim!.value).toBe(90)
    expect(claim!.unit).toBe('money')
    // A live setting, not a closed-period measurement.
    expect(claim!.measurementKind).toBe('operational')
    expect(data.partialToday.claimIds).toContain(claim!.claimId)
  })

  it('is CITED by the pace it is the denominator of', () => {
    // The drawer showed where the numerator came from and left the denominator — the number a reader
    // most wants to check — with no row at all.
    const data = withBudget(90)
    const pacing = Object.values(data.claims).find((c) => c.metricKey === 'meta.partial_today_budget_pacing')!
    const budget = Object.values(data.claims).find((c) => c.metricKey === 'meta.current_daily_budget')!
    expect(pacing.inputClaimIds).toContain(budget.claimId)
    expect(pacing.inputClaimIds.length).toBe(2)
  })

  it('refuses with a named reason when no active budget can be read', () => {
    const data = withBudget(null)
    const claim = Object.values(data.claims).find((c) => c.metricKey === 'meta.current_daily_budget')!
    expect(claim.availability.state).toBe('unavailable')
    expect(claim.availability.blockerCodes).toContain('meta_daily_budget_unavailable')
    expect(claim.value).toBeNull()
  })
})
