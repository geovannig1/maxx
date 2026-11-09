import { describe, expect, it } from 'vitest'

import type { PaidCohortEvaluationArtifact } from '@/lib/attribution/paid-cohort-store'
import type { CreativeAssignmentResolution } from '@/lib/creative/assignment-stability'
import {
  PaidCreativeProjectionError,
  projectPaidCreativeOutcomes,
  type PaidCreativeAssignmentsByDirection,
} from '@/lib/creative/paid-outcomes'

const RUN = '00000000-0000-4000-8000-000000000001'
const RECENT = '00000000-0000-4000-8000-000000000002'
const MATURED = '00000000-0000-4000-8000-000000000003'

function unit(
  generationId: string,
  metaAdId: string,
  overrides: Partial<PaidCohortEvaluationArtifact['recentScale']['adUnits'][number]> = {},
) {
  return {
    id: `00000000-0000-4000-8000-${metaAdId.padStart(12, '0')}`,
    generationId,
    metaAdId,
    spend: 10,
    landingPageViews: 2,
    capturedTouches: 1,
    bookings: 1,
    bookedValue: 100,
    complete: true,
    blockerCodes: [],
    zeroValueBookings: 0,
    canceledLinks: 0,
    ...overrides,
  }
}

function artifact(
  recentUnits = [unit(RECENT, '101')],
  maturedUnits = [unit(MATURED, '201')],
): PaidCohortEvaluationArtifact {
  return {
    evaluationRunId: RUN,
    recentScale: {
      generation: {
        generationId: RECENT,
        cohortKind: 'recent_scale',
        windowStart: '2026-07-16',
        windowEnd: '2026-07-29',
        asOfDate: '2026-07-30',
        activationId: '00000000-0000-4000-8000-000000000004',
        contractVersion: 1,
        policyVersion: 1,
        complete: true,
        blockerCodes: [],
      },
      adUnits: recentUnits,
    },
    maturedCut: {
      generation: {
        generationId: MATURED,
        cohortKind: 'matured_cut',
        windowStart: '2026-07-02',
        windowEnd: '2026-07-15',
        asOfDate: '2026-07-30',
        activationId: '00000000-0000-4000-8000-000000000004',
        contractVersion: 1,
        policyVersion: 1,
        complete: true,
        blockerCodes: [],
      },
      adUnits: maturedUnits,
    },
  }
}

function stable(metaCreativeId: string, first: string, second: string) {
  return {
    state: 'observed_stable' as const,
    metaCreativeId,
    boundaryObservationIds: [first, second] as [string, string],
  }
}

function assignments(
  recent: PaidCreativeAssignmentsByDirection['recent_scale'],
  matured: PaidCreativeAssignmentsByDirection['matured_cut'],
): PaidCreativeAssignmentsByDirection {
  return { recent_scale: recent, matured_cut: matured }
}

describe('projectPaidCreativeOutcomes', () => {
  it('returns a distinct not-published result when no governed pair exists', () => {
    expect(projectPaidCreativeOutcomes(null, assignments(new Map(), new Map()), new Map())).toEqual({
      status: 'not_published',
      evaluation_run_id: null,
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      note: expect.stringContaining('associated via governed last-paid-touch'),
      recent_scale: null,
      matured_cut: null,
    })
  })

  it('withholds a whole direction when any assignment is blocked without hiding the other direction', () => {
    const result = projectPaidCreativeOutcomes(
      artifact([unit(RECENT, '101'), unit(RECENT, '102')]),
      assignments(
        new Map<string, CreativeAssignmentResolution>([
          ['101', stable('501', 'obs-r1', 'obs-r2')],
          ['102', { state: 'blocked', blockerCode: 'assignment_history_missing' }],
        ]),
        new Map([['201', stable('601', 'obs-m1', 'obs-m2')]]),
      ),
      new Map(),
    )

    expect(result.status).toBe('available')
    expect(result.recent_scale).toMatchObject({
      status: 'blocked',
      cohort_kind: 'recent_scale',
      blocker_codes: ['assignment_history_missing'],
      creatives: [],
    })
    expect(result.matured_cut).toMatchObject({
      status: 'available',
      cohort_kind: 'matured_cut',
      creatives: [{
        status: 'available',
        meta_creative_id: '601',
        contributing_meta_ad_ids: ['201'],
        outcomes: { spend: 10, booked_value: 100 },
      }],
    })
  })

  it('returns blocked when a governed pair exists but neither direction has a numeric creative', () => {
    const result = projectPaidCreativeOutcomes(
      artifact(),
      assignments(
        new Map([['101', { state: 'blocked', blockerCode: 'assignment_history_missing' }]]),
        new Map([['201', { state: 'blocked', blockerCode: 'assignment_identity_missing' }]]),
      ),
      new Map(),
    )

    expect(result).toMatchObject({
      status: 'blocked',
      evaluation_run_id: RUN,
      recent_scale: {
        status: 'blocked', blocker_codes: ['assignment_history_missing'], creatives: [],
      },
      matured_cut: {
        status: 'blocked', blocker_codes: ['assignment_identity_missing'], creatives: [],
      },
    })
  })

  it('groups deterministically, sums complete ads, and blocks only an incomplete mapped creative', () => {
    const result = projectPaidCreativeOutcomes(
      artifact([
        unit(RECENT, '103', { spend: 5, landingPageViews: 1, bookings: 0, bookedValue: 0 }),
        unit(RECENT, '101', {
          spend: 12.5,
          landingPageViews: 4,
          capturedTouches: 3,
          bookings: 2,
          bookedValue: 250,
          zeroValueBookings: 1,
          canceledLinks: 1,
        }),
        unit(RECENT, '102', {
          complete: false,
          blockerCodes: ['capture_coverage_mismatch', 'stale_insight_source'],
        }),
        unit(RECENT, '104', {
          spend: 7.5,
          landingPageViews: 2,
          capturedTouches: 2,
          bookings: 1,
          bookedValue: 75,
          zeroValueBookings: 2,
        }),
      ]),
      assignments(
        new Map([
          ['104', stable('700', 'obs-4a', 'obs-4b')],
          ['102', stable('800', 'obs-2a', 'obs-2b')],
          ['101', stable('700', 'obs-1a', 'obs-1b')],
          ['103', stable('800', 'obs-3a', 'obs-3b')],
        ]),
        new Map([['201', stable('900', 'obs-9a', 'obs-9b')]]),
      ),
      new Map([
        ['700', { creative_name: 'Complete creative', thumbnail_url: 'https://img/700' }],
        ['800', { creative_name: 'Blocked creative', thumbnail_url: null }],
      ]),
    )

    expect(result.recent_scale).toMatchObject({
      status: 'available',
      generation_id: RECENT,
      window_start: '2026-07-16',
      window_end: '2026-07-29',
      as_of_date: '2026-07-30',
      contract_version: 1,
      policy_version: 1,
      blocker_codes: ['capture_coverage_mismatch', 'stale_insight_source'],
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
    })
    expect(result.recent_scale?.creatives).toEqual([
      {
        status: 'available',
        complete: true,
        evaluation_run_id: RUN,
        generation_id: RECENT,
        meta_creative_id: '700',
        creative_name: 'Complete creative',
        thumbnail_url: 'https://img/700',
        contributing_meta_ad_ids: ['101', '104'],
        assignment_observation_ids: ['obs-1a', 'obs-1b', 'obs-4a', 'obs-4b'],
        blocker_codes: [],
        action_authority_tier: 'diagnostic_only',
        prescriptions: [],
        outcomes: {
          spend: 20,
          landing_page_views: 6,
          captured_touches: 5,
          value_bearing_bookings: 3,
          booked_value: 325,
          zero_value_bookings: 3,
          canceled_links: 1,
        },
      },
      {
        status: 'blocked',
        complete: false,
        evaluation_run_id: RUN,
        generation_id: RECENT,
        meta_creative_id: '800',
        creative_name: 'Blocked creative',
        thumbnail_url: null,
        contributing_meta_ad_ids: ['102', '103'],
        assignment_observation_ids: ['obs-2a', 'obs-2b', 'obs-3a', 'obs-3b'],
        blocker_codes: ['capture_coverage_mismatch', 'stale_insight_source'],
        action_authority_tier: 'diagnostic_only',
        prescriptions: [],
        outcomes: null,
      },
    ])
  })

  it('preserves numeric zero for a complete creative and never mixes cohort directions', () => {
    const zero = unit(RECENT, '101', {
      spend: 0,
      landingPageViews: 0,
      capturedTouches: 0,
      bookings: 0,
      bookedValue: 0,
      zeroValueBookings: 0,
      canceledLinks: 0,
    })
    const result = projectPaidCreativeOutcomes(
      artifact([zero], [unit(MATURED, '101', { spend: 99, bookedValue: 999 })]),
      assignments(
        new Map([['101', stable('501', 'recent-a', 'recent-b')]]),
        new Map([['101', stable('501', 'matured-a', 'matured-b')]]),
      ),
      new Map(),
    )

    expect(result.recent_scale?.creatives[0]).toMatchObject({
      outcomes: {
        spend: 0,
        landing_page_views: 0,
        captured_touches: 0,
        value_bearing_bookings: 0,
        booked_value: 0,
        zero_value_bookings: 0,
        canceled_links: 0,
      },
      assignment_observation_ids: ['recent-a', 'recent-b'],
    })
    expect(result.matured_cut?.creatives[0]).toMatchObject({
      outcomes: { spend: 99, booked_value: 999 },
      assignment_observation_ids: ['matured-a', 'matured-b'],
    })
  })

  it('adds monetary values through exact minor units without decimal drift', () => {
    const result = projectPaidCreativeOutcomes(
      artifact([
        unit(RECENT, '101', { spend: 0.1, bookedValue: 0.1 }),
        unit(RECENT, '102', { spend: 0.2, bookedValue: 0.2 }),
      ]),
      assignments(
        new Map([
          ['101', stable('501', 'one-a', 'one-b')],
          ['102', stable('501', 'two-a', 'two-b')],
        ]),
        new Map([['201', stable('601', 'matured-a', 'matured-b')]]),
      ),
      new Map(),
    )

    expect(result.recent_scale?.creatives[0]).toMatchObject({
      outcomes: { spend: 0.3, booked_value: 0.3 },
    })
  })

  it.each([
    ['spend', { spend: 50_000_000_000_000 }, { spend: 50_000_000_000_000 }],
    ['booked value', { bookedValue: 50_000_000_000_000 }, { bookedValue: 50_000_000_000_000 }],
    ['landing-page views', { landingPageViews: Number.MAX_SAFE_INTEGER }, { landingPageViews: 1 }],
    ['captured touches', { capturedTouches: Number.MAX_SAFE_INTEGER }, { capturedTouches: 1 }],
    ['value-bearing bookings', { bookings: Number.MAX_SAFE_INTEGER }, { bookings: 1 }],
    ['zero-value bookings', { zeroValueBookings: Number.MAX_SAFE_INTEGER }, { zeroValueBookings: 1 }],
    ['canceled links', { canceledLinks: Number.MAX_SAFE_INTEGER }, { canceledLinks: 1 }],
  ])('rejects %s aggregate overflow instead of publishing an inaccurate total', (
    _label,
    first,
    second,
  ) => {
    expect(() => projectPaidCreativeOutcomes(
      artifact([
        unit(RECENT, '101', first),
        unit(RECENT, '102', second),
      ]),
      assignments(
        new Map([
          ['101', stable('501', 'one-a', 'one-b')],
          ['102', stable('501', 'two-a', 'two-b')],
        ]),
        new Map([['201', stable('601', 'matured-a', 'matured-b')]]),
      ),
      new Map(),
    )).toThrowError(PaidCreativeProjectionError)

    try {
      projectPaidCreativeOutcomes(
        artifact([unit(RECENT, '101', first), unit(RECENT, '102', second)]),
        assignments(
          new Map([
            ['101', stable('501', 'one-a', 'one-b')],
            ['102', stable('501', 'two-a', 'two-b')],
          ]),
          new Map([['201', stable('601', 'matured-a', 'matured-b')]]),
        ),
        new Map(),
      )
    } catch (error) {
      expect(error).toMatchObject({ code: 'NUMERIC_AGGREGATE_OVERFLOW' })
    }
  })

  it('rejects monetary precision finer than integer minor units', () => {
    expect(() => projectPaidCreativeOutcomes(
      artifact([unit(RECENT, '101', { spend: 0.001 })]),
      assignments(
        new Map([['101', stable('501', 'recent-a', 'recent-b')]]),
        new Map([['201', stable('601', 'matured-a', 'matured-b')]]),
      ),
      new Map(),
    )).toThrowError(expect.objectContaining({ code: 'MONETARY_SCALE_INVALID' }))
  })

  it.each([
    ['spend', { spend: 4_503_599_627_370_494 / 100 }, { spend: 4_503_599_627_370_496 / 100 }],
    [
      'booked value',
      { bookedValue: 4_503_599_627_370_494 / 100 },
      { bookedValue: 4_503_599_627_370_496 / 100 },
    ],
  ])('rejects a safe %s minor-unit sum that cannot round-trip through the public number', (
    _label,
    first,
    second,
  ) => {
    expect(() => projectPaidCreativeOutcomes(
      artifact([
        unit(RECENT, '101', first),
        unit(RECENT, '102', second),
      ]),
      assignments(
        new Map([
          ['101', stable('501', 'one-a', 'one-b')],
          ['102', stable('501', 'two-a', 'two-b')],
        ]),
        new Map([['201', stable('601', 'matured-a', 'matured-b')]]),
      ),
      new Map(),
    )).toThrowError(expect.objectContaining({ code: 'NUMERIC_AGGREGATE_OVERFLOW' }))
  })

  it('keeps authority diagnostic-only and uses the governed non-causal claim vocabulary', () => {
    const result = projectPaidCreativeOutcomes(
      artifact(),
      assignments(
        new Map([['101', stable('501', 'recent-a', 'recent-b')]]),
        new Map([['201', stable('601', 'matured-a', 'matured-b')]]),
      ),
      new Map(),
    )
    expect(result.note).toContain('associated via governed last-paid-touch')
    expect(result.note).toContain('booked value')
    expect(result.note).not.toMatch(/caus|generated|revenue|winner|loser|rank|recommend|should/i)
    expect(result.prescriptions).toEqual([])
    expect(result.recent_scale?.prescriptions).toEqual([])
    expect(result.recent_scale?.creatives.every((creative) =>
      creative.action_authority_tier === 'diagnostic_only' && creative.prescriptions.length === 0
    )).toBe(true)
  })
})
