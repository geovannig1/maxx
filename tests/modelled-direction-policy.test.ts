import { describe, expect, it } from 'vitest'
import {
  evaluateModelledDirection,
  MIN_LINKAGE_COVERAGE_FOR_CUT,
  type ModelledDirectionalEvidence,
  type ModelledPerformanceWindow,
} from '@/lib/authority/directional-policy'
import { MAXX_OWNER_PROFIT_POLICY, ownerProfitPolicyEvidence } from '@/lib/economics/profit-policy'

const win = (o: Partial<ModelledPerformanceWindow> = {}): ModelledPerformanceWindow => ({
  windowStart: '2026-08-04', windowEnd: '2026-08-17',
  spend: 400, modelledBookings: 10, modelledCpa: 40,
  peakDailyFrequency: 1.8, windowFrequency: 2.2,
  source: 'daily_insights',
  observedDays: 14,
  expectedDays: 14,
  earliestSyncedAt: '2026-08-18T10:30:00.000Z',
  latestSyncedAt: '2026-08-18T10:30:00.000Z',
  ...o,
})
const priorWin = (o: Partial<ModelledPerformanceWindow> = {}): ModelledPerformanceWindow => win({
  windowStart: '2026-07-21', windowEnd: '2026-08-03', ...o,
})

const ev = (o: Partial<ModelledDirectionalEvidence> = {}): ModelledDirectionalEvidence => ({
  recent: win(), prior: priorWin(),
  sourceGeneration: {
    id: 'sync-generation-1',
    status: 'success',
    dateRangeStart: '2026-07-21',
    dateRangeEnd: '2026-08-17',
    startedAt: '2026-08-18T10:00:00.000Z',
    completedAt: '2026-08-18T10:30:00.000Z',
  },
  targetCpa: 60, watchCpa: 100, linkageCoverage: 0.31, blendedRoas: null, ...o,
})

const policy = (current: number | null = 50, proposed: number | null = 60) =>
  ownerProfitPolicyEvidence({
    currentAccountDailyBudget: current,
    proposedAccountDailyBudget: proposed,
  }, MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling)

describe('meta-modelled money direction', () => {
  it('never exceeds owner_review, even on excellent modelled performance', () => {
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ modelledCpa: 12, modelledBookings: 40 }),
      prior: priorWin({ modelledCpa: 11, modelledBookings: 40 }),
    }))
    expect(v.ceiling).toBe('owner_review')
  })

  it('requires BOTH windows; a single good window proves nothing', () => {
    expect(evaluateModelledDirection('budget_scale', ev({ prior: null })).ceiling).toBe('unsupported')
  })

  it('requires a real non-overlapping adjacent 14-day comparison', () => {
    const verdict = evaluateModelledDirection('budget_scale', ev({
      prior: win({ modelledCpa: 10, modelledBookings: 40 }),
    }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/non-overlapping 14-day/i)
  })

  it('refuses sparse modelled windows even when the observed days look excellent', () => {
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ observedDays: 3, modelledCpa: 10, modelledBookings: 40 }),
      prior: priorWin({ modelledCpa: 10, modelledBookings: 40 }),
    }))
    expect(v.ceiling).toBe('unsupported')
    expect(v.reason).toMatch(/complete 14-day/i)
  })

  it('refuses stale modelled windows whose source was not synced through the window end', () => {
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ latestSyncedAt: '2026-08-16T10:30:00.000Z', modelledCpa: 10, modelledBookings: 40 }),
      prior: priorWin({ modelledCpa: 10, modelledBookings: 40 }),
    }))
    expect(v.ceiling).toBe('unsupported')
    expect(v.reason).toMatch(/fresh/i)
  })

  it.each([
    ['missing', null],
    ['partial', { ...ev().sourceGeneration!, status: 'partial' }],
    ['stale', { ...ev().sourceGeneration!, completedAt: '2026-08-16T10:30:00.000Z' }],
    ['not covering every required day', { ...ev().sourceGeneration!, dateRangeStart: '2026-07-22' }],
  ])('refuses a %s source generation', (_label, sourceGeneration) => {
    const verdict = evaluateModelledDirection('budget_scale', ev({
      sourceGeneration,
      recent: win({ modelledCpa: 10, modelledBookings: 40 }),
      prior: priorWin({ modelledCpa: 10, modelledBookings: 40 }),
    }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/generation/i)
  })

  it('refuses rows that cannot be linked to the declared source generation', () => {
    const verdict = evaluateModelledDirection('budget_scale', ev({
      recent: win({ earliestSyncedAt: '2026-08-17T23:00:00.000Z', modelledCpa: 10 }),
      prior: priorWin({ modelledCpa: 10 }),
    }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/generation/i)
  })

  it('refuses a scale when either window misses the owner CPA target', () => {
    const v = evaluateModelledDirection('budget_scale', ev({ prior: priorWin({ modelledCpa: 95 }) }))
    expect(v.ceiling).toBe('unsupported')
    expect(v.reason).toContain('BOTH windows')
  })

  it('refuses a scale into the creative-fatigue band', () => {
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ peakDailyFrequency: 1.2, windowFrequency: 4.3 }),
    }))
    expect(v.ceiling).toBe('unsupported')
    expect(v.reason).toContain('fatigue')
  })

  it('does not treat peak daily frequency as a lower bound on window frequency', () => {
    // Two disjoint daily audiences can produce a 3.0 peak day while the whole window is near 1.0:
    // day A = 3 impressions / 1 reached; day B = 100 / 100; window = 103 / 101.
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ peakDailyFrequency: 3, windowFrequency: 103 / 101 }),
    }))
    expect(v.ceiling).toBe('owner_review')
    expect(v.reason).not.toMatch(/single day.*window is at least/i)
  })

  it('every modelled money direction discloses that the CPA is GROSS of cancellations', () => {
    // Meta is never told a booking cancelled -- the Acuity webhook gates CAPI on
    // `isInitialScheduled && !canceled`, because Meta cannot retract a conversion. So the count this
    // CPA divides by includes every cancellation. For example, netting a $40 modelled CPA at plausible
    // cancellation rates can give $50-$80 -- across a $45 target and, at the top, across a $70 watch
    // line. Both directions must say so, or the owner reads an optimistic number as a settled one.
    const scale = evaluateModelledDirection('budget_scale', ev({
      recent: win({ peakDailyFrequency: 1.8, windowFrequency: 2.2 }),
    }))
    expect(scale.ceiling).toBe('owner_review')
    expect(scale.reason).toMatch(/GROSS of cancellations/)

    const cut = evaluateModelledDirection('budget_cut', ev({
      recent: win({ modelledCpa: 400, modelledBookings: 1 }),
      prior: priorWin({ modelledCpa: 380, modelledBookings: 1 }),
    }))
    expect(cut.ceiling).toBe('owner_review')
    expect(cut.reason).toMatch(/GROSS of cancellations/)
  })

  it('refuses a scale when only a PEAK DAILY frequency is available, not the window reading', () => {
    // The defect this pins: the 3.0 constant is a WINDOW band, and it was being compared against a
    // peak DAILY number that does not bound the whole-window value. For example, a retargeting ad set
    // at 2.1 peak daily would clear a budget increase while Meta's window frequency for the same
    // 14 days is 4.3 -- already above the band. Peak daily below the band proves nothing about the
    // window, so it can no longer clear a scale.
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ peakDailyFrequency: 2.1, windowFrequency: null }),
    }))
    expect(v.ceiling).toBe('unsupported')
    expect(v.reason).toMatch(/WINDOW's frequency/)
    expect(v.reason).toMatch(/peak DAILY/)
  })

  it('refuses a scale when the WINDOW frequency is in the fatigue band', () => {
    // 2.1 peak daily / 4.3 window: a pair where the old guard passed and the new one refuses.
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ peakDailyFrequency: 2.1, windowFrequency: 4.3 }),
    }))
    expect(v.ceiling).toBe('unsupported')
    // Asserting the string the owner reads.
    expect(v.reason).toContain('Window frequency is 4.3')
    expect(v.reason).toContain('fatigue')
  })

  it('ANTI-VACUITY: an unsaturated window frequency still clears the scale', () => {
    // Without this, the two cases above would pass against a rule that refuses everything.
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ peakDailyFrequency: 1.8, windowFrequency: 2.2 }),
    }))
    expect(v.ceiling).toBe('owner_review')
  })

  it('refuses a scale on thin spend even at a great CPA', () => {
    const v = evaluateModelledDirection('budget_scale', ev({
      recent: win({ spend: 50, modelledCpa: 10 }), prior: priorWin({ spend: 50, modelledCpa: 10 }),
    }))
    expect(v.ceiling).toBe('unsupported')
    expect(v.reason).toContain('3x')
  })

  it('supports a cut when both windows breach the watch CPA', () => {
    const v = evaluateModelledDirection('budget_cut', ev({
      recent: win({ modelledCpa: 140, modelledBookings: 3 }),
      prior: priorWin({ modelledCpa: 155, modelledBookings: 2 }),
    }))
    expect(v.ceiling).toBe('owner_review')
    expect(v.reason).toContain('at or above the $100.00 watch threshold')
    expect(v.reason).not.toContain('under the $100.00 watch threshold')
  })

  it('refuses a cut when the windows disagree', () => {
    const v = evaluateModelledDirection('pause', ev({
      recent: win({ modelledCpa: 140, modelledBookings: 3 }),
      prior: priorWin({ modelledCpa: 30, modelledBookings: 12 }),
    }))
    expect(v.ceiling).toBe('unsupported')
    expect(v.reason).toContain('disagree')
  })

  it('labels a cut as resting on modelled data when deterministic linkage is under-measured', () => {
    // THE FALSE-ZERO GUARD. With linkage this low the exact-join cohort reports ~0 bookings; that
    // is our tracking failing, not the ads. The copy must say so rather than imply a measured loss.
    const v = evaluateModelledDirection('budget_cut', ev({
      recent: win({ modelledCpa: 140, modelledBookings: 3 }),
      prior: priorWin({ modelledCpa: 150, modelledBookings: 3 }),
      linkageCoverage: 0.31,
    }))
    expect(v.ceiling).toBe('owner_review')
    expect(v.reason).toContain('UNDER-MEASUREMENT')
  })

  it('drops the under-measurement caveat once linkage clears the bar', () => {
    const v = evaluateModelledDirection('budget_cut', ev({
      recent: win({ modelledCpa: 140, modelledBookings: 3 }),
      prior: priorWin({ modelledCpa: 150, modelledBookings: 3 }),
      linkageCoverage: MIN_LINKAGE_COVERAGE_FOR_CUT + 0.05,
    }))
    expect(v.reason).not.toContain('UNDER-MEASUREMENT')
  })

  it('always discloses that the numbers are Meta-modelled estimates', () => {
    for (const kind of ['budget_scale', 'budget_cut'] as const) {
      const v = evaluateModelledDirection(kind, ev({
        recent: win({ modelledCpa: kind === 'budget_scale' ? 40 : 140 }),
        prior: priorWin({ modelledCpa: kind === 'budget_scale' ? 40 : 150 }),
      }))
      if (v.ceiling !== 'unsupported') expect(v.reason).toContain('Meta-modelled')
    }
  })
})

describe('modelled evidence never displaces stronger evidence', () => {
  it('is ignored by evaluateDirection whenever contribution evidence exists', async () => {
    const { evaluateDirection } = await import('@/lib/authority/directional-policy')
    // A modelled window that would otherwise authorise a scale, alongside a contribution window.
    // The contribution path must run: its own validation fails closed here, proving the modelled
    // shortcut did NOT take over.
    const verdict = evaluateDirection('budget_scale', {
      objective: 'bookings', exactCpa: null, provenOutcomes: null, lagged: null,
      postPeriodCorroboratesLoss: false, structuralContinuity: true, windowsConflict: false,
      targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
      profitPolicy: null,
      recentContribution: { status: 'incomplete' } as never,
      modelled: ev({ recent: win({ modelledCpa: 10 }), prior: priorWin({ modelledCpa: 10 }) }),
    }, { pragmaticMediaBuyerEnabled: true })
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).not.toContain('Meta-modelled')
  })
})

describe('modelled performance reader completeness metadata', () => {
  const dayRange = (start: string, days: number) => Array.from({ length: days }, (_, i) => {
    const d = new Date(`${start}T00:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  })

  function dbReturning(
    rows: Array<Record<string, unknown>>,
    generation: Record<string, unknown> | null = {
      id: 'sync-generation-1', status: 'success', date_range_start: '2026-07-22',
      date_range_end: '2026-08-18', started_at: '2026-08-05T10:00:00.000Z',
      completed_at: '2026-08-19T10:30:00.000Z',
    },
  ) {
    const daily = {
      select: () => daily, eq: () => daily, gte: () => daily,
      lte: () => Promise.resolve({ data: rows, error: null }),
    }
    const logs = {
      select: () => logs, eq: () => logs, lte: () => logs, gte: () => logs,
      order: () => logs, limit: () => logs,
      maybeSingle: () => Promise.resolve({ data: generation, error: null }),
    }
    return { from: (table: string) => table === 'api_sync_logs' ? logs : daily } as never
  }

  it('threads daily_insights coverage and freshness into both modelled windows', async () => {
    const { readModelledPerformance } = await import('@/lib/economics/modelled-performance')
    const rows = [
      ...dayRange('2026-07-22', 14),
      ...dayRange('2026-08-05', 3),
    ].map((date_start) => ({
      date_start,
      spend: 10,
      bookings: 1,
      // A `daily_insights` ROW, not a ModelledPerformanceWindow. The production column is
      // `frequency` — I applied 7f1d544's rename to the wrong type here, so these rows carried
      // neither key the reader reads and `foldWindow` silently produced a null peak. The test kept
      // passing because it never asserted frequency, which left the derivation uncovered entirely.
      frequency: 1.2,
      synced_at: date_start >= '2026-08-05' ? '2026-08-07T10:30:00.000Z' : '2026-08-05T10:30:00.000Z',
    }))

    const windows = await readModelledPerformance(dbReturning(rows), 'acct', 'adset', 'as-1', '2026-08-19')

    expect(windows.recent).toMatchObject({
      source: 'daily_insights',
      observedDays: 3,
      expectedDays: 14,
      latestSyncedAt: '2026-08-07T10:30:00.000Z',
      // The derivation itself, which nothing asserted before: the PEAK comes from the rows'
      // `frequency` column, and `windowFrequency` is null because daily reach cannot bound it.
      peakDailyFrequency: 1.2,
      windowFrequency: null,
    })
    expect(windows.prior).toMatchObject({
      source: 'daily_insights',
      observedDays: 14,
      expectedDays: 14,
      earliestSyncedAt: '2026-08-05T10:30:00.000Z',
      latestSyncedAt: '2026-08-05T10:30:00.000Z',
    })
    expect(windows.sourceGeneration).toEqual({
      id: 'sync-generation-1', status: 'success', dateRangeStart: '2026-07-22',
      dateRangeEnd: '2026-08-18', startedAt: '2026-08-05T10:00:00.000Z',
      completedAt: '2026-08-19T10:30:00.000Z',
    })
  })
})

describe('authority gate treatment of the modelled basis', () => {
  // RESTORED to the original assertion. A later cockpit change reverted the
  // authority branch this pins and rewrote this test to assert the reverted behaviour, calling the
  // owner's live setting a "legacy toggle" — which is why the revert left a green suite.
  it('grants owner_review but never execution_eligible', async () => {
    const { decideActionAuthority } = await import('@/lib/authority/action-authority')
    const decision = decideActionAuthority(
      { kind: 'budget_scale', plane: 'meta_modelled', observation: 'Modelled CPA is under target.' },
      'meta_modelled_association',
      {
        objective: 'bookings', exactCpa: null, provenOutcomes: null, lagged: null,
        postPeriodCorroboratesLoss: false, structuralContinuity: true, windowsConflict: false,
        targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
        profitPolicy: policy(50, 60),
        modelled: ev({ recent: win({ modelledCpa: 30 }), prior: priorWin({ modelledCpa: 32 }) }),
      },
      { pragmaticMediaBuyerEnabled: true },
    )
    expect(decision.tier).toBe('owner_review')
    expect(decision.isMoneyAction).toBe(true)
    expect(decision.copy).toContain('MODELLED')
  })

  it('keeps Meta-modelled money diagnostic when setup continuity is not explicitly proven', async () => {
    const { decideActionAuthority } = await import('@/lib/authority/action-authority')
    const decision = decideActionAuthority(
      { kind: 'budget_scale', plane: 'meta_modelled', observation: 'Modelled CPA is under target.' },
      'meta_modelled_association',
      {
        objective: 'bookings', exactCpa: null, provenOutcomes: null, lagged: null,
        postPeriodCorroboratesLoss: false, structuralContinuity: null, windowsConflict: false,
        targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
        profitPolicy: policy(50, 60),
        modelled: ev({ recent: win({ modelledCpa: 30 }), prior: priorWin({ modelledCpa: 32 }) }),
      },
      { pragmaticMediaBuyerEnabled: true },
    )
    expect(decision.tier).toBe('diagnostic_only')
    expect(decision.reason).toMatch(/continuity/i)
  })

  it('keeps Meta-modelled scale diagnostic without a known current budget and sized proposal', async () => {
    const { decideActionAuthority } = await import('@/lib/authority/action-authority')
    const decision = decideActionAuthority(
      { kind: 'budget_scale', plane: 'meta_modelled', observation: 'Modelled CPA is under target.' },
      'meta_modelled_association',
      {
        objective: 'bookings', exactCpa: null, provenOutcomes: null, lagged: null,
        postPeriodCorroboratesLoss: false, structuralContinuity: true, windowsConflict: false,
        targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
        profitPolicy: policy(null, null),
        modelled: ev({ recent: win({ modelledCpa: 30 }), prior: priorWin({ modelledCpa: 32 }) }),
      },
      { pragmaticMediaBuyerEnabled: true },
    )
    expect(decision.tier).toBe('diagnostic_only')
    expect(decision.reason).toMatch(/current and proposed/i)
  })

  it('keeps Meta-modelled cut diagnostic without a concrete lower budget proposal', async () => {
    const { decideActionAuthority } = await import('@/lib/authority/action-authority')
    const decision = decideActionAuthority(
      { kind: 'budget_cut', plane: 'meta_modelled', observation: 'Modelled CPA is over watch.' },
      'meta_modelled_association',
      {
        objective: 'bookings', exactCpa: null, provenOutcomes: null, lagged: null,
        postPeriodCorroboratesLoss: false, structuralContinuity: true, windowsConflict: false,
        targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
        profitPolicy: policy(50, null),
        modelled: ev({
          recent: win({ modelledCpa: 140, modelledBookings: 3 }),
          prior: priorWin({ modelledCpa: 150, modelledBookings: 3 }),
        }),
      },
      { pragmaticMediaBuyerEnabled: true },
    )
    expect(decision.tier).toBe('diagnostic_only')
    expect(decision.reason).toMatch(/current and proposed/i)
  })

  it('keeps Meta-modelled scale diagnostic when the proposed account budget exceeds the owner ceiling', async () => {
    const { decideActionAuthority } = await import('@/lib/authority/action-authority')
    const decision = decideActionAuthority(
      { kind: 'budget_scale', plane: 'meta_modelled', observation: 'Modelled CPA is under target.' },
      'meta_modelled_association',
      {
        objective: 'bookings', exactCpa: null, provenOutcomes: null, lagged: null,
        postPeriodCorroboratesLoss: false, structuralContinuity: true, windowsConflict: false,
        targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
        profitPolicy: policy(60, MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling + 10),
        modelled: ev({ recent: win({ modelledCpa: 30 }), prior: priorWin({ modelledCpa: 32 }) }),
      },
      { pragmaticMediaBuyerEnabled: true },
    )
    expect(decision.tier).toBe('diagnostic_only')
    expect(decision.reason).toMatch(/ceiling/i)
  })

  it('stays diagnostic_only when pragmatic mode is off', async () => {
    const { decideActionAuthority } = await import('@/lib/authority/action-authority')
    const decision = decideActionAuthority(
      { kind: 'budget_scale', plane: 'meta_modelled', observation: 'Modelled CPA is under target.' },
      'meta_modelled_association',
      {
        objective: 'bookings', exactCpa: null, provenOutcomes: null, lagged: null,
        postPeriodCorroboratesLoss: false, structuralContinuity: true, windowsConflict: false,
        targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
        modelled: ev({ recent: win({ modelledCpa: 30 }), prior: priorWin({ modelledCpa: 32 }) }),
      },
      {},
    )
    expect(decision.tier).toBe('diagnostic_only')
  })
})
