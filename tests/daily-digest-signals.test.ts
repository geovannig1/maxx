import { describe, expect, it } from 'vitest'
import {
  deriveDigestDescriptiveStates,
  gateCountDelta,
  gateRateDelta,
  pacingBand,
  sumDailyBudgetTarget,
} from '@/lib/report/daily-digest-signals'

function evidence(overrides: Record<string, unknown> = {}) {
  const available = { availability: 'available', head: '2026-08-15T10:00:00Z', blockerCodes: [] }
  const window = (startDate: string, endDate: string) => ({
    startDate,
    endDate,
    availability: 'available',
    blockerCodes: [],
  })
  const snapshot = {
    contract: 'executive_evidence_snapshot',
    version: 1,
    generatedAt: '2026-08-16T10:00:00Z',
    account: { id: 'acct', name: 'Example Studio', timezone: 'America/New_York' },
    asOf: '2026-08-15',
    lastCompleteDate: '2026-08-15',
    windows: {
      lastDay: window('2026-08-15', '2026-08-15'),
      trailing7: window('2026-08-09', '2026-08-15'),
      prior7: window('2026-08-02', '2026-08-08'),
      monthToDate: window('2026-08-01', '2026-08-15'),
      postChange: { ...window('2026-08-09', '2026-08-15'), changeId: '00000000-0000-4000-8000-000000000001' },
    },
    sources: {
      setupChanges: available,
      outcomes: available,
      meta: available,
      metaColdWarm: available,
      metaPlacements: available,
      tracking: available,
      capi: available,
      gaIdentity: available,
      paidCohort: available,
    },
    outcomes: {
      byWindow: {
        lastDay: null,
        trailing7: {
          activeAppointments: 30,
          valueBearingBookings: 30,
          zeroValueAppointments: 0,
          bookedValue: 12_000,
          activeAmountPaidObserved: 12_000,
          activeAmountPaidRevenue: 12_000,
          amountPaidCoverage: { withRecordedAmount: 30, total: 30 },
          canceledAppointments: 2,
          canceledAmountPaidObserved: 800,
        },
        prior7: {
          activeAppointments: 5,
          valueBearingBookings: 5,
          zeroValueAppointments: 0,
          bookedValue: 2_000,
          activeAmountPaidObserved: 2_000,
          activeAmountPaidRevenue: 2_000,
          amountPaidCoverage: { withRecordedAmount: 5, total: 5 },
          canceledAppointments: 1,
          canceledAmountPaidObserved: 400,
        },
        monthToDate: null,
        postChange: null,
      },
      weeklyTrend8: [],
    },
    meta: {
      byWindow: {
        lastDay: null,
        trailing7: {
          spendAmount: 700,
          impressions: 10_000,
          reach: 8_000,
          linkClicks: 300,
          landingPageViews: 250,
          leads: 20,
          modeledBookings: 5,
          modeledBookingValue: 2_000,
          modeledClickBookings: 3,
          modeledViewBookings: 2,
          modeledUnknownBookings: 0,
        },
        prior7: {
          spendAmount: 700,
          impressions: 10_000,
          reach: 8_000,
          linkClicks: 200,
          landingPageViews: 125,
          leads: 10,
          modeledBookings: 50,
          modeledBookingValue: 20_000,
          modeledClickBookings: 30,
          modeledViewBookings: 20,
          modeledUnknownBookings: 0,
        },
        monthToDate: null,
        postChange: null,
      },
      weeklyTrend8: [],
    },
    tracking: {},
    capi: {},
    gaIdentity: {},
    metaColdWarm: {},
    metaPlacements: {},
    paidCohort: {
      complete: true,
      blockerCodes: [],
      recentScale: { complete: true, blockerCodes: [] },
      maturedCut: { complete: true, blockerCodes: [] },
      exactPaidAssociation: {},
    },
    setupChanges: {
      contract_version: 1,
      as_of: '2026-08-15',
      ad_account_db_id: 'acct',
      meta_account_id: 'act_123',
      status: 'available',
      complete: true,
      blocker_codes: [],
      campaigns: [],
      adsets: [],
      active_ad_wrappers: [],
      creative_reuse: {},
      cold_warm_comparison: { status: 'clean', blocker_codes: [] },
      latest_material_change: {
        status: 'known',
        governanceBasis: 'confirmed_executed_decision',
        materialChangeId: '00000000-0000-4000-8000-000000000001',
        materialChangeIds: ['00000000-0000-4000-8000-000000000001'],
        occurredAt: '2026-08-09T12:00:00Z',
        reason: 'Budget updated after owner approval.',
        source: 'ad_setup_decisions',
        settingCategories: ['budget'],
        affectedMetaIds: ['campaign-1'],
      },
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
    },
    authority: { tier: 'diagnostic_only', moneyActionsAuthorized: false, reason: 'Evidence is descriptive.' },
    governedActions: { availability: 'unavailable', items: null, blockerCodes: ['governed_actions_not_connected'] },
    blockerCodes: [],
  }
  return { ...snapshot, ...overrides } as never
}

type MutableEvidence = {
  windows: Record<string, Record<string, unknown>>
  sources: Record<string, Record<string, unknown>>
  outcomes: { byWindow: Record<string, Record<string, unknown>> }
  meta: { byWindow: Record<string, Record<string, unknown>> }
  setupChanges: Record<string, unknown>
}

describe('pacingBand', () => {
  // Industry variance bands: 0-4 green, 4-10 yellow, 10-15 orange, >15 red (abs % off target)
  it.each([
    [100, 100, 'green'],    // 0% off
    [103.9, 100, 'green'],  // 3.9% over
    [96.1, 100, 'green'],   // 3.9% under
    [104, 100, 'green'],    // exactly 4% over -> still green (<=4)
    [96, 100, 'green'],     // exactly 4% under -> still green (<=4)
    [104.1, 100, 'yellow'],
    [90.1, 100, 'yellow'],  // 9.9% under
    [110, 100, 'yellow'],   // exactly 10% over -> still yellow (<=10)
    [90, 100, 'yellow'],    // exactly 10% under -> still yellow (<=10)
    [110.1, 100, 'orange'],
    [85.1, 100, 'orange'],  // 14.9% under
    [115, 100, 'orange'],   // exactly 15% over -> still orange (<=15)
    [85, 100, 'orange'],    // exactly 15% under -> still orange (<=15)
    [115.1, 100, 'red'],
    [80, 100, 'red'],
  ])('spend %s vs target %s -> %s', (spend, target, band) => {
    expect(pacingBand(spend, target)).toBe(band)
  })
  it('is unavailable with no target', () => {
    expect(pacingBand(50, null)).toBe('unavailable')
    expect(pacingBand(50, 0)).toBe('unavailable')
  })
  it('is unavailable for a non-finite target (NaN, undefined, Infinity)', () => {
    expect(pacingBand(50, NaN)).toBe('unavailable')
    expect(pacingBand(50, undefined as unknown as number)).toBe('unavailable')
    expect(pacingBand(50, Infinity)).toBe('unavailable')
  })
})

describe('sumDailyBudgetTarget', () => {
  it('sums ACTIVE campaign daily budgets (CBO) that have at least one ACTIVE ad set', () => {
    expect(sumDailyBudgetTarget(
      [{ id: 'c1', status: 'ACTIVE', daily_budget: 60 }, { id: 'c2', status: 'PAUSED', daily_budget: 40 }],
      [
        { campaign_id: 'c1', status: 'ACTIVE', daily_budget: null },
        { campaign_id: 'c2', status: 'ACTIVE', daily_budget: null },
      ],
    )).toBe(60)
  })
  it('drops a CBO budget when every ad set under the ACTIVE campaign is PAUSED (it can spend nothing)', () => {
    expect(sumDailyBudgetTarget(
      [{ id: 'c1', status: 'ACTIVE', daily_budget: 60 }],
      [
        { campaign_id: 'c1', status: 'PAUSED', daily_budget: 25 },
        { campaign_id: 'c1', status: 'PAUSED', daily_budget: 41 },
      ],
    )).toBeNull()
  })
  it('leaves the rest of the account intact when an all-paused CBO campaign contributes nothing', () => {
    expect(sumDailyBudgetTarget(
      [
        { id: 'c1', status: 'ACTIVE', daily_budget: 60 },
        { id: 'c2', status: 'ACTIVE', daily_budget: 40 },
      ],
      [
        { campaign_id: 'c1', status: 'PAUSED', daily_budget: null },
        { campaign_id: 'c2', status: 'ACTIVE', daily_budget: null },
      ],
    )).toBe(40)
  })
  it('drops a CBO budget when the ACTIVE campaign has no ad sets at all', () => {
    expect(sumDailyBudgetTarget([{ id: 'c1', status: 'ACTIVE', daily_budget: 60 }], [])).toBeNull()
  })
  it('returns null when a CBO campaign has no ACTIVE ad set and one status is unreadable', () => {
    expect(sumDailyBudgetTarget(
      [{ id: 'c1', status: 'ACTIVE', daily_budget: 60 }],
      [
        { campaign_id: 'c1', status: 'PAUSED', daily_budget: null },
        { campaign_id: 'c1', status: null, daily_budget: null },
      ],
    )).toBeNull()
  })
  it('still counts a CBO budget when an ACTIVE ad set is found beside an unreadable one', () => {
    expect(sumDailyBudgetTarget(
      [{ id: 'c1', status: 'ACTIVE', daily_budget: 60 }],
      [
        { campaign_id: 'c1', status: 'ACTIVE', daily_budget: null },
        { campaign_id: 'c1', status: null, daily_budget: null },
      ],
    )).toBe(60)
  })

  describe('effective_status wins over status (it is what predicts spend)', () => {
    it('drops a campaign whose status is ACTIVE but whose effective_status is PAUSED', () => {
      expect(sumDailyBudgetTarget(
        [{ id: 'c1', status: 'ACTIVE', effective_status: 'PAUSED', daily_budget: 60 }],
        [{ campaign_id: 'c1', status: 'ACTIVE', daily_budget: null }],
      )).toBeNull()
    })
    it('drops an ad set whose status is ACTIVE but whose effective_status is CAMPAIGN_PAUSED (CBO)', () => {
      expect(sumDailyBudgetTarget(
        [{ id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: 60 }],
        [{ campaign_id: 'c1', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', daily_budget: null }],
      )).toBeNull()
    })
    it('drops an ad-set budget whose status is ACTIVE but whose effective_status is CAMPAIGN_PAUSED (ABO)', () => {
      expect(sumDailyBudgetTarget(
        [{ id: 'c1', status: 'ACTIVE', daily_budget: null }],
        [
          { campaign_id: 'c1', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', daily_budget: 25 },
          { campaign_id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: 27 },
        ],
      )).toBe(27)
    })
    it('falls back to status when effective_status is null or absent', () => {
      expect(sumDailyBudgetTarget(
        [{ id: 'c1', status: 'ACTIVE', effective_status: null, daily_budget: null }],
        [{ campaign_id: 'c1', status: 'ACTIVE', effective_status: null, daily_budget: 25 }],
      )).toBe(25)
    })
    it('treats an ACTIVE effective_status on a PAUSED status row as spendable', () => {
      expect(sumDailyBudgetTarget(
        [{ id: 'c1', status: 'PAUSED', effective_status: 'ACTIVE', daily_budget: null }],
        [{ campaign_id: 'c1', status: 'PAUSED', effective_status: 'ACTIVE', daily_budget: 25 }],
      )).toBe(25)
    })
  })
  it('falls through to ACTIVE ad set budgets when the campaign budget is null (ABO)', () => {
    expect(sumDailyBudgetTarget(
      [{ id: 'c1', status: 'ACTIVE', daily_budget: null }],
      [
        { campaign_id: 'c1', status: 'ACTIVE', daily_budget: 25 },
        { campaign_id: 'c1', status: 'PAUSED', daily_budget: 99 },
        { campaign_id: 'other', status: 'ACTIVE', daily_budget: 99 },
      ],
    )).toBe(25)
  })
  it('returns null when no active budget exists anywhere', () => {
    expect(sumDailyBudgetTarget([{ id: 'c1', status: 'ACTIVE', daily_budget: null }], [])).toBeNull()
  })
  it('ignores ad sets under a campaign that already has its own CBO budget', () => {
    expect(sumDailyBudgetTarget(
      [{ id: 'c1', status: 'ACTIVE', daily_budget: 60 }],
      [{ campaign_id: 'c1', status: 'ACTIVE', daily_budget: 25 }],
    )).toBe(60)
  })
  it('does not double-count a duplicate campaign row (ABO fallback)', () => {
    expect(sumDailyBudgetTarget(
      [
        { id: 'c1', status: 'ACTIVE', daily_budget: null },
        { id: 'c1', status: 'ACTIVE', daily_budget: null },
      ],
      [{ campaign_id: 'c1', status: 'ACTIVE', daily_budget: 25 }],
    )).toBe(25)
  })
  it('returns null for the whole account when an ABO ad set has a null status (unverifiable, not confidently wrong)', () => {
    expect(sumDailyBudgetTarget(
      [
        { id: 'c1', status: 'ACTIVE', daily_budget: null },
        { id: 'c2', status: 'ACTIVE', daily_budget: 50 },
      ],
      [{ campaign_id: 'c1', status: null, daily_budget: 25 }],
    )).toBeNull()
  })
})

describe('gateRateDelta', () => {
  it('gates deltas under the 20% reporting threshold', () => {
    expect(gateRateDelta(110, 100)).toEqual({ delta_pct: 10, noise_gated: true, state: 'within_noise' })
  })
  it('passes deltas at/above threshold', () => {
    const g = gateRateDelta(130, 100)
    expect(g.noise_gated).toBe(false)
    expect(g.state).toBe('significant')
    expect(g.delta_pct).toBeCloseTo(30)
  })
  it('is null-delta when baseline missing or zero', () => {
    expect(gateRateDelta(5, null)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
    expect(gateRateDelta(5, 0)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
  })
  it('treats non-finite current or baseline as no baseline (not a NaN/Infinity delta)', () => {
    expect(gateRateDelta(NaN, 100)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
    expect(gateRateDelta(undefined as unknown as number, 100)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
    expect(gateRateDelta(Infinity, 100)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
    expect(gateRateDelta(110, NaN)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
  })
})

describe('gateCountDelta', () => {
  it('gates when Poisson CIs overlap (small counts are noise)', () => {
    // 3 vs 5: CI(3)=[0.15,5.85], CI(5)=[1.32,8.68] overlap -> gated
    expect(gateCountDelta(3, 5).noise_gated).toBe(true)
  })
  it('passes when CIs are disjoint', () => {
    // 30 vs 5: CI(30)=[20.99,39.01], CI(5)=[1.32,8.68] disjoint -> not gated
    const g = gateCountDelta(30, 5)
    expect(g.noise_gated).toBe(false)
    expect(g.state).toBe('significant')
    expect(g.delta_pct).toBeCloseTo(500)
  })
  it('treats non-finite current or baseline as no baseline', () => {
    expect(gateCountDelta(NaN, 5)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
    expect(gateCountDelta(3, Infinity)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
  })
  it('handles a zero baseline as no_baseline even when current is 1 (sd floors at count=1, no NaN)', () => {
    expect(gateCountDelta(1, 0)).toEqual({ delta_pct: null, noise_gated: true, state: 'no_baseline' })
  })
  it('handles a zero current count without producing NaN', () => {
    // CI(0)=[0,1.645], CI(5)=[1.32,8.68] overlap -> within_noise, delta_pct exact -100%
    const g = gateCountDelta(0, 5)
    expect(g.state).toBe('within_noise')
    expect(g.delta_pct).toBe(-100)
  })
})

describe('GatedDelta invariant', () => {
  it('noise_gated always equals state !== "significant" across all three states', () => {
    const cases = [
      gateRateDelta(5, null),   // no_baseline
      gateRateDelta(110, 100),  // within_noise
      gateRateDelta(130, 100),  // significant
      gateCountDelta(1, 0),     // no_baseline
      gateCountDelta(3, 5),     // within_noise
      gateCountDelta(30, 5),    // significant
    ]
    for (const g of cases) {
      expect(g.noise_gated).toBe(g.state !== 'significant')
    }
  })
})

describe('Daily Digest V3 descriptive states', () => {
  it('derives three independent canonical states from the executive evidence snapshot', () => {
    const states = deriveDigestDescriptiveStates(evidence())

    expect(states.business.state).toBe('higher')
    expect(states.paid_delivery.state).toBe('improving')
    expect(states.data_confidence.state).toBe('complete')
    expect(Object.keys(states)).toEqual(['business', 'paid_delivery', 'data_confidence'])
  })

  it('does not use modelled bookings or modelled value to classify paid delivery', () => {
    const base = evidence() as unknown as MutableEvidence
    const changed = evidence({
      meta: {
        ...base.meta,
        byWindow: {
          ...base.meta.byWindow,
          trailing7: {
            ...base.meta.byWindow.trailing7,
            modeledBookings: 0,
            modeledBookingValue: 0,
          },
          prior7: {
            ...base.meta.byWindow.prior7,
            modeledBookings: 10_000,
            modeledBookingValue: 10_000_000,
          },
        },
      },
    })

    expect(deriveDigestDescriptiveStates(changed).paid_delivery.state).toBe('improving')
  })

  it('classifies business from all active appointments rather than only value-bearing appointments', () => {
    const base = evidence() as unknown as MutableEvidence
    const divergentZeroValueMix = evidence({
      outcomes: {
        ...base.outcomes,
        byWindow: {
          ...base.outcomes.byWindow,
          prior7: {
            ...base.outcomes.byWindow.prior7,
            activeAppointments: 30,
            valueBearingBookings: 10,
            zeroValueAppointments: 20,
            amountPaidCoverage: { withRecordedAmount: 30, total: 30 },
          },
        },
      },
    })

    expect(deriveDigestDescriptiveStates(divergentZeroValueMix).business.state).toBe('mixed')
  })

  it('keeps business and paid-delivery states independent from unrelated source blockers', () => {
    const base = evidence() as unknown as MutableEvidence
    const unrelatedBlockers = evidence({
      sources: {
        ...base.sources,
        outcomes: {
          availability: 'partial',
          head: '2026-08-15T10:00:00Z',
          blockerCodes: ['outcome_amount_paid_coverage_incomplete:weeklyTrend8:0'],
        },
        meta: {
          availability: 'partial',
          head: '2026-08-15T10:00:00Z',
          blockerCodes: [
            'meta_window_incomplete:monthToDate',
            'meta_metric_unavailable:weeklyTrend8:0:modeled_booking_value',
          ],
        },
      },
      blockerCodes: [
        'acuity:outcome_amount_paid_coverage_incomplete:weeklyTrend8:0',
        'meta:meta_window_incomplete:monthToDate',
      ],
    })

    const states = deriveDigestDescriptiveStates(unrelatedBlockers)
    expect(states.business.state).toBe('higher')
    expect(states.paid_delivery.state).toBe('improving')
    expect(states.data_confidence.state).toBe('degraded')
  })

  it('fails business closed when amount_paid coverage is incomplete', () => {
    const base = evidence() as unknown as MutableEvidence
    const incomplete = evidence({
      outcomes: {
        ...base.outcomes,
        byWindow: {
          ...base.outcomes.byWindow,
          trailing7: {
            ...base.outcomes.byWindow.trailing7,
            activeAmountPaidRevenue: null,
            amountPaidCoverage: { withRecordedAmount: 29, total: 30 },
          },
        },
      },
    })

    expect(deriveDigestDescriptiveStates(incomplete).business.state).toBe('unavailable')
  })

  it('requires two complete seven-day windows and a non-zero prior business baseline', () => {
    const base = evidence() as unknown as MutableEvidence
    const shortWindow = evidence({
      windows: {
        ...base.windows,
        trailing7: { ...base.windows.trailing7, startDate: '2026-08-10' },
      },
    })
    const zeroPrior = evidence({
      outcomes: {
        ...base.outcomes,
        byWindow: {
          ...base.outcomes.byWindow,
          prior7: {
            ...base.outcomes.byWindow.prior7,
            activeAppointments: 0,
            valueBearingBookings: 0,
            activeAmountPaidObserved: 0,
            activeAmountPaidRevenue: 0,
            amountPaidCoverage: { withRecordedAmount: 0, total: 0 },
          },
        },
      },
    })

    expect(deriveDigestDescriptiveStates(shortWindow).business.state).toBe('insufficient_evidence')
    expect(deriveDigestDescriptiveStates(zeroPrior).business.state).toBe('insufficient_evidence')
  })

  it('calls business stable only when both governed comparisons are within noise, otherwise mixed', () => {
    const base = evidence() as unknown as MutableEvidence
    const stable = evidence({
      outcomes: {
        ...base.outcomes,
        byWindow: {
          ...base.outcomes.byWindow,
          trailing7: {
            ...base.outcomes.byWindow.trailing7,
            valueBearingBookings: 5,
            activeAppointments: 5,
            bookedValue: 2_100,
            activeAmountPaidObserved: 2_100,
            activeAmountPaidRevenue: 2_100,
            amountPaidCoverage: { withRecordedAmount: 5, total: 5 },
          },
        },
      },
    })
    const mixed = evidence({
      outcomes: {
        ...base.outcomes,
        byWindow: {
          ...base.outcomes.byWindow,
          trailing7: {
            ...base.outcomes.byWindow.trailing7,
            activeAmountPaidObserved: 1_000,
            activeAmountPaidRevenue: 1_000,
          },
        },
      },
    })

    expect(deriveDigestDescriptiveStates(stable).business.state).toBe('stable')
    expect(deriveDigestDescriptiveStates(mixed).business.state).toBe('mixed')
  })

  it('requires minimum paid-delivery evidence before comparing cost per LPV and link CTR', () => {
    const base = evidence() as unknown as MutableEvidence
    const thin = evidence({
      meta: {
        ...base.meta,
        byWindow: {
          ...base.meta.byWindow,
          trailing7: { ...base.meta.byWindow.trailing7, landingPageViews: 19 },
        },
      },
    })

    expect(deriveDigestDescriptiveStates(thin).paid_delivery.state).toBe('insufficient_evidence')
  })

  it('classifies conflicting paid-delivery signals as mixed', () => {
    const base = evidence() as unknown as MutableEvidence
    const conflict = evidence({
      meta: {
        ...base.meta,
        byWindow: {
          ...base.meta.byWindow,
          trailing7: {
            ...base.meta.byWindow.trailing7,
            landingPageViews: 250,
            linkClicks: 100,
          },
        },
      },
    })

    expect(deriveDigestDescriptiveStates(conflict).paid_delivery.state).toBe('mixed')
  })

  it('keeps confidence degraded unless every required source, cohort, blocker, and change reason is complete', () => {
    const base = evidence() as unknown as MutableEvidence
    const partialTracking = evidence({
      sources: { ...base.sources, tracking: { availability: 'partial', head: null, blockerCodes: ['tracking_partial'] } },
    })
    const noChangeReason = evidence({
      setupChanges: { ...base.setupChanges, latest_material_change: { status: 'unknown', occurredAt: null, reasonCode: 'reason_unknown' } },
    })
    const missingColdWarm = evidence({
      sources: { ...base.sources, metaColdWarm: { availability: 'unavailable', head: null, blockerCodes: ['cold_warm_unavailable'] } },
      metaColdWarm: null,
    })

    expect(deriveDigestDescriptiveStates(partialTracking).data_confidence.state).toBe('degraded')
    expect(deriveDigestDescriptiveStates(noChangeReason).data_confidence.state).toBe('degraded')
    expect(deriveDigestDescriptiveStates(missingColdWarm).data_confidence.state).toBe('degraded')
  })

  it('marks confidence unavailable when either Acuity or Meta core evidence is absent', () => {
    expect(deriveDigestDescriptiveStates(evidence({ outcomes: null })).data_confidence.state).toBe('unavailable')
    expect(deriveDigestDescriptiveStates(evidence({ meta: null })).data_confidence.state).toBe('unavailable')
  })

  it('marks confidence unavailable when required Acuity or Meta window facts are malformed', () => {
    const base = evidence() as unknown as MutableEvidence
    const badOutcome = evidence({
      outcomes: { ...base.outcomes, byWindow: { ...base.outcomes.byWindow, trailing7: {
        ...base.outcomes.byWindow.trailing7, activeAmountPaidRevenue: null,
      } } },
    })
    const badMeta = evidence({
      meta: { ...base.meta, byWindow: { ...base.meta.byWindow, prior7: {
        ...base.meta.byWindow.prior7, impressions: -1,
      } } },
    })

    expect(deriveDigestDescriptiveStates(badOutcome).data_confidence.state).toBe('unavailable')
    expect(deriveDigestDescriptiveStates(badMeta).data_confidence.state).toBe('unavailable')
  })

  it('labels every threshold as diagnostic and never as an owner target or action authority', () => {
    const copy = Object.values(deriveDigestDescriptiveStates(evidence()))
      .map((state) => state.line)
      .join(' ')

    expect(copy).toContain('diagnostic reporting')
    expect(copy).not.toMatch(/owner target|recommended target|should|scale|pause|increase budget/i)
  })
})
