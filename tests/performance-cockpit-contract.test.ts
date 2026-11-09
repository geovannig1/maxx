import { describe, expect, it } from 'vitest'
import { MetricClaimSchema, PerformanceCockpitDataSchema, createMetricClaim, type MetricClaimInput } from '@/lib/cockpit/contracts'
import { assemblePerformanceCockpitData, type CockpitEvidence } from '@/lib/cockpit/builder'

const WINDOW = { start: '2026-04-06', end: '2026-04-24', basis: 'closed_account_days' as const, timezone: 'America/New_York' as const }

function baseClaim(overrides: Partial<MetricClaimInput> = {}): MetricClaimInput {
  return {
    claimId: 'meta.spend:2026-04-06:2026-04-24', metricKey: 'meta.spend', label: 'Meta spend', value: 963.4,
    unit: 'money', formula: 'sum(account daily spend)', definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'act_123' }, attributionScope: 'none', window: WINDOW,
    comparison: { method: 'none', window: null }, asOf: '2026-04-25T12:00:00.000Z', availability: { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 19, denominator: 19 }, maturity: { state: 'settling', matureThrough: '2026-04-17' },
    freshness: { state: 'fresh', observedAt: '2026-04-25T11:55:00.000Z', maxAgeHours: 26 }, setupFingerprint: null,
    authority: { state: 'authoritative', policyVersion: 'cockpit-v3' }, measurementKind: 'measured', inputClaimIds: [], ...overrides,
  }
}

function completeEvidence(): CockpitEvidence {
  return {
    account: { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'Example Studio' }, range: WINDOW,
    asOf: '2026-04-25T12:00:00.000Z',
    delivery: {
      available: true, spendAvailable: true, resultsAvailable: true, purchaseAvailable: true, leadAvailable: true,
      linkCtrAvailable: true, cpmAvailable: true, frequencyAvailable: false,
      spend: 963.4, results: 17, purchaseValue: 2410, purchaseCount: 11, leads: 26, linkClicks: 47,
      impressions: 15_000, nativeFrequency: null, dailyBudget: 55, spendCoveredDays: 19, coveredDays: 19, expectedDays: 19,
      synchronizedAt: '2026-04-25T11:55:00.000Z', blockerCodes: ['meta_native_period_frequency_missing'],
    },
    partialToday: { available: true, date: '2026-04-25', spend: 5.31, dailyBudget: 55, synchronizedAt: '2026-04-25T11:57:00.000Z', blockerCodes: [] },
    synchronizedAt: '2026-04-25T11:55:00.000Z', decisionIds: ['decision-1'], primaryDecisionId: 'decision-1',
    primaryDecision: { id: 'decision-1', title: 'Review source health', summary: 'Review governed evidence.', bucket: 'needs_review', lifecycle: 'ready', authority: 'owner_review', reviewDate: null },
  }
}

describe('Meta-only performance cockpit metric contract', () => {
  it('keeps claim truth axes independent and deeply immutable', () => {
    const claim = createMetricClaim(baseClaim({ measurementKind: 'modelled' }))
    expect(Object.isFrozen(claim)).toBe(true)
    expect(Object.isFrozen(claim.window)).toBe(true)
    expect(() => MetricClaimSchema.parse(baseClaim({ value: 1.5, unit: 'ratio', coverage: { state: 'partial', numerator: 9, denominator: 10 } }))).toThrow(/available ratios require complete coverage/)
  })

  it('emits only Meta owner metrics, with canonical purchase ROAS and optional lead cost', () => {
    const cockpit = assemblePerformanceCockpitData(completeEvidence())
    const purchaseRoas = cockpit.claims[cockpit.paidPerformance.purchaseRoasClaimId]
    const costPerLead = cockpit.paidPerformance.costPerLeadClaimId ? cockpit.claims[cockpit.paidPerformance.costPerLeadClaimId] : null
    expect(cockpit.contractVersion).toBe(4)
    expect(cockpit.sourceHealth.map((source) => source.plane)).toEqual(['meta_delivery'])
    expect(Object.values(cockpit.claims).some((claim) => claim.source.system === 'outcomes')).toBe(false)
    expect(Object.values(cockpit.claims).some((claim) => claim.metricKey.startsWith('paid.'))).toBe(false)
    expect(purchaseRoas).toMatchObject({ metricKey: 'meta.purchase_roas', label: 'Meta Purchase ROAS', value: 2410 / 963.4, attributionScope: 'meta_platform_modelled', measurementKind: 'derived' })
    expect(purchaseRoas.inputClaimIds).toHaveLength(2)
    expect(costPerLead).toMatchObject({ metricKey: 'meta.cost_per_lead', value: 963.4 / 26 })
    expect(cockpit.claims[cockpit.paidPerformance.linkCtrClaimId].value).toBeCloseTo(0.3133)
    expect(cockpit.claims[cockpit.paidPerformance.cpmClaimId].value).toBeCloseTo(64.2267)
    expect(cockpit.claims[cockpit.paidPerformance.frequencyClaimId].availability.state).toBe('unavailable')
    expect(() => PerformanceCockpitDataSchema.parse(cockpit)).not.toThrow()
  })

  it('withholds purchase ROAS rather than mixing source families or inventing zero', () => {
    const evidence = completeEvidence()
    const cockpit = assemblePerformanceCockpitData({ ...evidence, delivery: { ...evidence.delivery, purchaseAvailable: false, purchaseValue: null, purchaseCount: null, blockerCodes: ['meta_purchase_canonical_pair_invalid:2026-04-09'] } })
    const claim = cockpit.claims[cockpit.paidPerformance.purchaseRoasClaimId]
    expect(claim.value).toBeNull()
    expect(claim.availability.blockerCodes).toContain('meta_purchase_canonical_pair_invalid:2026-04-09')
  })

  it('omits lead cost when Meta has no separate canonical lead action', () => {
    const evidence = completeEvidence()
    expect(assemblePerformanceCockpitData({ ...evidence, delivery: { ...evidence.delivery, leadAvailable: false, leads: null } }).paidPerformance.costPerLeadClaimId).toBeNull()
  })
})

/**
 * A claim id must name the window that claim covers.
 *
 * `claimId()` derived from `input.range` while `commonClaim` accepted a `window` override. Nothing
 * passes an override today, so the two always agreed and the divergence was unobservable — and it
 * becomes an id COLLISION the moment a prior-period claim exists: same metric key, different window,
 * one id. `Object.fromEntries` keeps the last silently, so a claim disappears before
 * `assertNoCrossPlaneLineage` sees it and a brief citing the dropped id fails to resolve for a reason
 * no reader can diagnose. `assertUniqueClaimIds` would fire on the cockpit's own output.
 *
 * Asserted on the ASSEMBLED cockpit, not by calling `claimId` directly: what matters is which window
 * the shipped ids name.
 */
describe('a claim id names the window that claim covers', () => {
  it('every requested-window claim id ends in the requested window', () => {
    const cockpit = assemblePerformanceCockpitData(completeEvidence())
    const windowed = Object.values(cockpit.claims).filter((c) => c.window.basis === 'closed_account_days')
    expect(windowed.length).toBeGreaterThan(0)
    for (const claim of windowed) {
      expect(claim.claimId).toBe(`${claim.metricKey}:${claim.window.start}:${claim.window.end}`)
    }
  })

  it('the partial-today claims name THEIR single day, not the requested range', () => {
    // These build their ids by hand. If the rule above were implemented by stamping the requested
    // range onto every id, these would silently become wrong — so the rule is asserted as
    // "id matches its own window", never as "id matches the range".
    const cockpit = assemblePerformanceCockpitData(completeEvidence())
    const partial = Object.values(cockpit.claims).filter((c) => c.window.basis === 'partial_today')
    expect(partial.length).toBeGreaterThan(0)
    for (const claim of partial) {
      expect(claim.window.start).toBe(claim.window.end)
      expect(claim.claimId).toBe(`${claim.metricKey}:${claim.window.start}`)
      expect(claim.claimId).not.toContain(WINDOW.start)
    }
  })

  it('a shorter requested range moves the ids with it', () => {
    // Proves the id tracks the window rather than a constant. Without this, an implementation that
    // hard-coded the fixture's dates would pass both tests above.
    const short = { ...WINDOW, start: '2026-04-10', end: '2026-04-14' }
    const cockpit = assemblePerformanceCockpitData({ ...completeEvidence(), range: short })
    const spend = Object.values(cockpit.claims).find((c) => c.metricKey === 'meta.spend')
    expect(spend?.claimId).toBe('meta.spend:2026-04-10:2026-04-14')
  })

  it('the assembled cockpit contains no duplicate claim id', () => {
    const ids = Object.values(assemblePerformanceCockpitData(completeEvidence()).claims).map((c) => c.claimId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('spend coverage counts days, rather than restating an availability flag', () => {
  /**
   * These pass a `spendCoveredDays` the READER CANNOT PRODUCE, and that is stated rather than hidden.
   *
   * `spendAvailable` is false if any expected date is missing a row, so `spendAvailable === true`
   * implies `spendCoveredDays === expectedDays`. The 18-of-19 case below is therefore unreachable
   * from `readMetaDelivery` today. It is asserted anyway because the builder must not INVENT a
   * numerator — a future reader that reports a genuine per-day count must flow through unchanged —
   * but nobody should read these as proof of a live defect fixed.
   *
   * The commit that introduced the change claimed the old form rendered `19/19 · complete` at 18 of
   * 19 days. It did not: at 18 of 19 the old form took its `deliveryCoverage` branch and rendered
   * `partial`. That claim came from a review fixture built the same way this one is, and was repeated
   * without checking reachability.
   */
  it('reports the real numerator when a day is missing', () => {
    const evidence = completeEvidence()
    const cockpit = assemblePerformanceCockpitData({
      ...evidence,
      delivery: { ...evidence.delivery, spendCoveredDays: 18, expectedDays: 19 },
    })
    const spend = cockpit.claims[cockpit.paidPerformance.spendClaimId]
    expect(spend.coverage.numerator).toBe(18)
    expect(spend.coverage.denominator).toBe(19)
    expect(spend.coverage.state).toBe('partial')
  })

  it('still reports complete when every day is present', () => {
    const spend = assemblePerformanceCockpitData(completeEvidence())
      .claims[assemblePerformanceCockpitData(completeEvidence()).paidPerformance.spendClaimId]
    expect(spend.coverage).toMatchObject({ state: 'complete', numerator: 19, denominator: 19 })
  })

  it('does not inherit the RESULTS day count, which is a joint flag rather than a day count', () => {
    // `coveredDays` is `spendAvailable && resultsAvailable ? expectedDays : 0`. When campaign
    // reconciliation fails it is 0 while every spend row is present — so spend must not read it, or
    // it reports 0/19 for a window whose spend is complete.
    const evidence = completeEvidence()
    const cockpit = assemblePerformanceCockpitData({
      ...evidence,
      delivery: { ...evidence.delivery, coveredDays: 0, spendCoveredDays: 19, expectedDays: 19 },
    })
    const spend = cockpit.claims[cockpit.paidPerformance.spendClaimId]
    expect(spend.coverage.numerator).toBe(19)
    expect(spend.coverage.state).toBe('complete')
  })
})

describe('reach and the learning-phase rate are BUILT, not just rendered', () => {
  /**
   * Both survived their first mutation: the UI tests inject these claims as fixtures, so the builder
   * that produces them was never exercised. Making the reach claim permanently unavailable, and
   * dropping the ×7 that turns Results into a weekly rate, each left the whole suite green. That is
   * this author's signature failure — assertion and fixture agreeing by construction — and it is why
   * these cases drive `assemblePerformanceCockpitData` instead.
   */
  const claimFor = (data: ReturnType<typeof assemblePerformanceCockpitData>, metricKey: string) =>
    Object.values(data.claims).find((c) => c.metricKey === metricKey)!

  it('publishes reach from the native rollup the reader already fetched', () => {
    const evidence = completeEvidence()
    const data = assemblePerformanceCockpitData({
      ...evidence,
      delivery: { ...evidence.delivery, frequencyAvailable: true, nativeFrequency: 1.6, nativeReach: 10_240 },
    })
    const reach = claimFor(data, 'meta.native_reach')
    expect(reach.availability.state).toBe('available')
    expect(reach.value).toBe(10_240)
  })

  it('refuses reach when the native rollup failed, EVEN IF a reach number is present', () => {
    // The two conditions are varied INDEPENDENTLY. My first version set `frequencyAvailable: false`
    // and `nativeReach: null` together, so removing the frequency gate changed nothing and the
    // mutation survived — fixture and assertion co-varying, the same failure this file keeps finding.
    //
    // Reach and frequency come from ONE native period read. A reach value surviving a failed read is
    // stale, and publishing it beside an unavailable frequency would present it as current.
    const evidence = completeEvidence()
    const data = assemblePerformanceCockpitData({
      ...evidence,
      delivery: { ...evidence.delivery, frequencyAvailable: false, nativeFrequency: null, nativeReach: 10_240 },
    })
    const reach = claimFor(data, 'meta.native_reach')
    expect(reach.availability.state).toBe('unavailable')
    expect(reach.value).toBeNull()
    expect(reach.availability.blockerCodes).toContain('meta_native_reach_unavailable')
  })

  it('refuses reach when the rollup succeeded but carries no reach figure', () => {
    // The other half, so neither condition alone can satisfy both cases.
    const evidence = completeEvidence()
    const data = assemblePerformanceCockpitData({
      ...evidence,
      delivery: { ...evidence.delivery, frequencyAvailable: true, nativeFrequency: 1.6, nativeReach: null },
    })
    expect(claimFor(data, 'meta.native_reach').availability.state).toBe('unavailable')
  })

  it('scales Results to a WEEKLY rate, so it is comparable to Meta\'s 50', () => {
    // The fixture window is 2026-04-06..2026-04-24 — nineteen days — with 17 Results.
    // 17 / 19 * 7 ≈ 6.26. Dropping the ×7 would report 17, which is not a weekly rate.
    const rate = claimFor(assemblePerformanceCockpitData(completeEvidence()), 'meta.optimization_events_per_week')
    expect(rate.availability.state).toBe('available')
    expect(rate.value).toBeCloseTo((17 / 19) * 7, 6)
  })

  it('moves with the selected window rather than assuming a week', () => {
    // A ten-day window, same Results ⇒ a higher weekly rate. Guards the case above against passing
    // on a hardcoded divisor.
    const evidence = completeEvidence()
    const data = assemblePerformanceCockpitData({
      ...evidence,
      range: { ...evidence.range, start: '2026-04-06', end: '2026-04-15' },
    })
    expect(claimFor(data, 'meta.optimization_events_per_week').value).toBeCloseTo(11.9, 6)
  })

  it('refuses the rate when Results are unavailable, rather than reporting zero per week', () => {
    const evidence = completeEvidence()
    const data = assemblePerformanceCockpitData({
      ...evidence,
      delivery: { ...evidence.delivery, resultsAvailable: false, results: null },
    })
    const rate = claimFor(data, 'meta.optimization_events_per_week')
    expect(rate.availability.state).toBe('unavailable')
    expect(rate.value).toBeNull()
  })

  it('cites the Results claim it was derived from', () => {
    const data = assemblePerformanceCockpitData(completeEvidence())
    const rate = claimFor(data, 'meta.optimization_events_per_week')
    expect(rate.inputClaimIds).toEqual([data.paidPerformance.resultsClaimId])
    for (const id of rate.inputClaimIds) expect(data.claims[id]).toBeDefined()
  })
})
