import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaidCohortPairEvidence } from '@/lib/attribution/paid-cohort-reader'
import {
  mapExecutiveOutcomeWindowFactsV1,
  mapExecutivePaidCohortEvidenceV1,
} from '@/lib/report/executive-evidence-business-readers'
import { validateExecutivePlacementSourceHeadV1 } from '@/lib/report/executive-evidence-meta-reader'
import {
  assertExecutiveReportCoreSourcesV1,
  createExecutiveEvidenceProductionReadersV1,
} from '@/lib/report/executive-evidence-production'
import type { ExecutiveMetaOutcomePlaneV1 } from '@/lib/report/executive-evidence'
import {
  aggregateExecutiveMetaRowsV1,
  projectExecutivePlacementRowsV1,
  reconcileExecutivePlacementOutcomesV1,
  reconcileExecutivePlacementSpendV1,
} from '@/lib/report/executive-evidence-meta-reader'
import { weeklyExecutiveEvidenceFixture } from './fixtures/weekly-executive'

describe('executive evidence production reader mappings', () => {
  it('blocks report publication when a current core read failed or last-day delivery is absent', () => {
    expect(() => assertExecutiveReportCoreSourcesV1(weeklyExecutiveEvidenceFixture, {
      meta: new Error('injected Meta read failure'),
    })).toThrow(/Meta delivery evidence unavailable: injected Meta read failure/)

    const missing = structuredClone(weeklyExecutiveEvidenceFixture)
    missing.meta!.byWindow.lastDay = null
    expect(() => assertExecutiveReportCoreSourcesV1(missing))
      .toThrow(/no authoritative account-level row was returned/i)

    const stale = structuredClone(weeklyExecutiveEvidenceFixture)
    stale.meta!.byWindow.lastDay = stale.meta!.byWindow.trailing7
    stale.outcomes!.byWindow.lastDay = stale.outcomes!.byWindow.trailing7
    expect(() => assertExecutiveReportCoreSourcesV1(
      stale,
      {},
      '2026-08-10T10:04:00.000Z',
    )).toThrow(/current sync/i)
  })
  it('wires every required production evidence plane', () => {
    const readers = createExecutiveEvidenceProductionReadersV1({} as SupabaseClient)
    expect(Object.keys(readers).sort()).toEqual(
      [
        'projectSetupChanges',
        'readOutcome',
        'readCapi',
        'readGaIdentity',
        'readMeta',
        'readMetaColdWarm',
        'readMetaPlacements',
        'readPaidCohort',
        'readTracking',
      ].sort(),
    )
  })

  it('keeps active paid revenue unavailable when any active amount_paid is missing', () => {
    const mapped = mapExecutiveOutcomeWindowFactsV1([
      {
        id: 1,
        price: 300,
        amount_paid: 250,
        canceled: false,
        business_state: 'active_value_bearing',
      },
      {
        id: 2,
        price: 0,
        amount_paid: null,
        canceled: false,
        business_state: 'active_zero_value',
      },
      {
        id: 3,
        price: 400,
        amount_paid: 400,
        canceled: true,
        business_state: 'canceled',
      },
    ])

    expect(mapped).toMatchObject({
      activeAppointments: 2,
      valueBearingBookings: 1,
      zeroValueAppointments: 1,
      activeAmountPaidObserved: 250,
      activeAmountPaidRevenue: null,
      amountPaidCoverage: { withRecordedAmount: 1, total: 2 },
      canceledAppointments: 1,
      canceledAmountPaidObserved: 400,
    })
  })

  it('preserves a positive payment on a zero-price active appointment', () => {
    expect(
      mapExecutiveOutcomeWindowFactsV1([
        {
          id: 4,
          price: 0,
          amount_paid: 175,
          canceled: false,
          business_state: 'active_zero_value',
        },
      ]),
    ).toMatchObject({
      bookedValue: 0,
      zeroValueAppointments: 1,
      activeAmountPaidRevenue: 175,
    })
  })

  it('maps only validated, complete paid-cohort facts to candidate exact metrics', () => {
    const pair: PaidCohortPairEvidence = {
      evaluationRunId: '10000000-0000-4000-8000-000000000001',
      recentScale: {
        generationId: '10000000-0000-4000-8000-000000000002',
        cohortKind: 'recent_scale',
        windowStart: '2026-08-01',
        windowEnd: '2026-08-14',
        asOfDate: '2026-08-15',
        complete: true,
        blockerCodes: [],
        generationComplete: true,
        generationBlockerCodes: [],
        spend: 200,
        bookings: 2,
        bookedValue: 650,
        metrics: { outcome_recorded_revenue: 610 },
      },
      maturedCut: {
        generationId: '10000000-0000-4000-8000-000000000003',
        cohortKind: 'matured_cut',
        windowStart: '2026-07-18',
        windowEnd: '2026-07-31',
        asOfDate: '2026-08-15',
        complete: true,
        blockerCodes: [],
        generationComplete: true,
        generationBlockerCodes: [],
        spend: 180,
        bookings: 1,
        bookedValue: 300,
        metrics: { outcome_recorded_revenue: 300 },
      },
    }

    expect(mapExecutivePaidCohortEvidenceV1(pair)).toMatchObject({
      complete: true,
      associatedSpend: 200,
      associatedValueBearingBookings: 2,
      associatedAmountPaidRevenue: 610,
    })

    const incomplete = structuredClone(pair)
    incomplete.recentScale.metrics = {}
    expect(mapExecutivePaidCohortEvidenceV1(incomplete)).toMatchObject({
      complete: false,
      associatedAmountPaidRevenue: null,
      blockerCodes: ['paid_cohort_revenue_unavailable'],
    })
  })

  it('keeps unavailable Meta fields null rather than manufacturing telemetry zeros', () => {
    expect(
      aggregateExecutiveMetaRowsV1([
        {
          spend: 25,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          leads: 2,
          bookings: 1,
          link_clicks: null,
          landing_page_views: null,
          appointment_value: null,
          bookings_view_through: null,
        },
      ]),
    ).toMatchObject({
      spendAmount: 25,
      linkClicks: null,
      landingPageViews: null,
      modeledBookingValue: null,
      modeledClickBookings: null,
      modeledViewBookings: null,
      modeledUnknownBookings: 1,
    })
  })

  it('does not sum daily reach into a selected-period audience claim', () => {
    const fact = aggregateExecutiveMetaRowsV1([
      { spend: 10, impressions: 100, reach: 80, clicks: 5, leads: 0, bookings: 0 },
      { spend: 10, impressions: 100, reach: 90, clicks: 5, leads: 0, bookings: 0 },
    ])

    expect(fact.reach).toBe(90)
    expect(fact.reachAggregation).toBe('peak_daily')
  })

  it('retains Meta delivery but withholds outcome facts when the current-run outcome plane is incomplete', () => {
    const incompletePlane: ExecutiveMetaOutcomePlaneV1 = {
      status: 'incomplete',
      blockerCodes: ['campaign_adset_outcome_reconciliation_failed'],
      sourceNotBefore: '2026-08-16T14:30:00.000Z',
      checkedLevels: ['campaign', 'adset', 'ad'],
    }

    expect(
      aggregateExecutiveMetaRowsV1([
        {
          spend: 25,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          leads: 2,
          bookings: 1,
          link_clicks: 18,
          landing_page_views: 15,
          appointment_value: 300,
          bookings_view_through: 0,
        },
      ], undefined, incompletePlane),
    ).toMatchObject({
      spendAmount: 25,
      impressions: 1_000,
      reach: 800,
      linkClicks: 18,
      landingPageViews: 15,
      leads: null,
      modeledBookings: null,
      modeledBookingValue: null,
      modeledClickBookings: null,
      modeledViewBookings: null,
      modeledUnknownBookings: null,
      outcomePlane: incompletePlane,
    })
  })

  it('proves placement completeness by spend reconciliation, not a row on every zero-delivery day', () => {
    const sparseRows = [
      { breakdown_type: 'publisher_platform', spend: 40 },
      { breakdown_type: 'publisher_platform', spend: 60 },
      { breakdown_type: 'platform_position', spend: 100 },
    ]
    expect(reconcileExecutivePlacementSpendV1(sparseRows, 100)).toEqual([])
    expect(reconcileExecutivePlacementSpendV1(sparseRows, 110)).toEqual([
      'meta_placement_spend_reconciliation_failed:publisher_platform',
      'meta_placement_spend_reconciliation_failed:platform_position',
    ])
  })

  it('withholds placement outcomes unless both dimensions reconcile to campaign authority', () => {
    const rows = [
      { breakdown_type: 'publisher_platform', leads: 3, bookings: 1 },
      { breakdown_type: 'platform_position', leads: 0, bookings: 0 },
    ]
    expect(reconcileExecutivePlacementOutcomesV1(rows, { leads: 3, modeledBookings: 1 }))
      .toEqual([
        'meta_placement_bookings_reconciliation_failed:platform_position',
        'meta_placement_leads_reconciliation_failed:platform_position',
      ])

    expect(reconcileExecutivePlacementOutcomesV1([
      { breakdown_type: 'publisher_platform', leads: null, bookings: null },
      { breakdown_type: 'platform_position', leads: null, bookings: null },
    ], { leads: 3, modeledBookings: 1 })).toEqual(['meta_placement_outcomes_unavailable'])

    const projected = projectExecutivePlacementRowsV1([
      {
        breakdown_type: 'publisher_platform', breakdown_value: 'instagram', spend: 40,
        impressions: 1_000, clicks: 25, leads: 3, bookings: 1,
      },
      {
        breakdown_type: 'platform_position', breakdown_value: 'reels', spend: 40,
        impressions: 1_000, clicks: 25, leads: 0, bookings: 0,
      },
    ], {
      status: 'complete', blockerCodes: [], sourceNotBefore: null,
      checkedLevels: ['campaign', 'adset', 'ad'],
    }, { leads: 3, modeledBookings: 1 })
    expect(projected.blockerCodes).toEqual(expect.arrayContaining([
      'meta_placement_leads_reconciliation_failed:platform_position',
      'meta_placement_bookings_reconciliation_failed:platform_position',
    ]))
    expect(projected.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ spendAmount: 40, impressions: 1_000, clicks: 25, leads: null, modeledBookings: null }),
    ]))
  })

  it('accepts placement rows only from the exact complete committed source window', () => {
    expect(validateExecutivePlacementSourceHeadV1(JSON.stringify({
      complete: true,
      completed_at: '2026-08-16T14:00:00.000Z',
      window_start: '2026-08-09',
      window_end: '2026-08-15',
      dimensions: ['publisher_platform', 'platform_position'],
      row_count: 12,
    }), {
      windowStart: '2026-08-09', windowEnd: '2026-08-15',
      asOf: '2026-08-16T15:00:00.000Z', rowCount: 12,
    })).toEqual({ valid: true, head: '2026-08-16T14:00:00.000Z', blockerCodes: [] })

    expect(validateExecutivePlacementSourceHeadV1(JSON.stringify({
      complete: true,
      completed_at: '2026-08-16T14:00:00.000Z',
      window_start: '2026-08-08',
      window_end: '2026-08-14',
      dimensions: ['publisher_platform', 'platform_position'],
      row_count: 12,
    }), {
      windowStart: '2026-08-09', windowEnd: '2026-08-15',
      asOf: '2026-08-16T15:00:00.000Z', rowCount: 12,
    })).toMatchObject({ valid: false, blockerCodes: ['meta_placement_source_window_mismatch'] })
  })

  it('rejects a same-window placement head that predates the current lifecycle run', () => {
    const validateWithBoundary = validateExecutivePlacementSourceHeadV1 as unknown as (
      raw: unknown,
      expected: {
        windowStart: string
        windowEnd: string
        asOf: string
        rowCount: number
        sourceNotBefore: string
      },
    ) => ReturnType<typeof validateExecutivePlacementSourceHeadV1>

    expect(validateWithBoundary(JSON.stringify({
      complete: true,
      completed_at: '2026-08-16T14:00:00.000Z',
      window_start: '2026-08-09',
      window_end: '2026-08-15',
      dimensions: ['publisher_platform', 'platform_position'],
      row_count: 12,
    }), {
      windowStart: '2026-08-09',
      windowEnd: '2026-08-15',
      asOf: '2026-08-16T15:00:00.000Z',
      rowCount: 12,
      sourceNotBefore: '2026-08-16T14:30:00.000Z',
    })).toMatchObject({
      valid: false,
      blockerCodes: ['meta_placement_source_head_before_current_run'],
    })

    expect(validateWithBoundary(JSON.stringify({
      complete: true,
      completed_at: '2026-08-16T14:30:00.000Z',
      window_start: '2026-08-09',
      window_end: '2026-08-15',
      dimensions: ['publisher_platform', 'platform_position'],
      row_count: 12,
    }), {
      windowStart: '2026-08-09',
      windowEnd: '2026-08-15',
      asOf: '2026-08-16T15:00:00.000Z',
      rowCount: 12,
      sourceNotBefore: '2026-08-16T14:30:00.000Z',
    })).toEqual({
      valid: true,
      head: '2026-08-16T14:30:00.000Z',
      blockerCodes: [],
    })
  })
})
