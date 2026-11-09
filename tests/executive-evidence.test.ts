import { describe, expect, it, vi } from 'vitest'
import { buildExecutiveEvidenceSnapshotV1, type ExecutiveEvidenceReadersV1, type ExecutiveEvidenceSourceReadV1, type ExecutiveSetupChangeProjectionV1 } from '@/lib/report/executive-evidence'

const input = {
  accountId: '00000000-0000-4000-8000-000000000901',
  accountName: 'Example Studio',
  timezone: 'America/New_York',
  asOf: '2026-08-16T12:00:00.000Z',
  lastCompleteDate: '2026-08-15',
} as const

const available = <T>(data: T, head = '2026-08-16T10:00:00.000Z'): ExecutiveEvidenceSourceReadV1<T> => ({
  availability: 'available',
  head,
  blockerCodes: [],
  data,
})

const setupProjection: ExecutiveSetupChangeProjectionV1 = {
  contract_version: 1,
  as_of: input.asOf,
  ad_account_db_id: input.accountId,
  meta_account_id: '100000000000777',
  status: 'available',
  complete: true,
  blocker_codes: [],
  campaigns: [],
  adsets: [],
  active_ad_wrappers: [],
  creative_reuse: {
    distinct_active_ad_wrappers: 0,
    distinct_active_meta_creative_ids: 0,
    distinct_active_media: 0,
    concept_coverage_complete: true,
    distinct_known_concepts: null,
    reused_meta_creative_id_groups: [],
    reused_media_groups: [],
    reused_concept_groups: [],
  },
  cold_warm_comparison: {
    status: 'clean',
    cold_meta_adset_id: 'cold-1',
    warm_meta_adset_id: 'warm-1',
    role_basis: 'governed',
    blocker_codes: [],
  },
  latest_material_change: {
    status: 'known',
    governanceBasis: 'confirmed_executed_decision',
    materialChangeId: '10000000-0000-4000-8000-000000000010',
    materialChangeIds: ['10000000-0000-4000-8000-000000000010'],
    occurredAt: '2026-08-10T14:00:00.000Z',
    reason: 'Owner-approved budget change',
    source: 'ad_setup_decisions',
    settingCategories: ['budget'],
    affectedMetaIds: ['adset-1'],
  },
  action_authority_tier: 'diagnostic_only',
  prescriptions: [],
}

function completeReaders(): ExecutiveEvidenceReadersV1 {
  const outcomeFacts = {
    activeAppointments: 4,
    valueBearingBookings: 3,
    zeroValueAppointments: 1,
    bookedValue: 900,
    activeAmountPaidObserved: 780,
    activeAmountPaidRevenue: 780,
    amountPaidCoverage: { withRecordedAmount: 4, total: 4 },
    canceledAppointments: 1,
    canceledAmountPaidObserved: 200,
  }
  const metaFacts = {
    spendAmount: 65,
    impressions: 10000,
    reach: 8000,
    linkClicks: 100,
    landingPageViews: 80,
    leads: 12,
    modeledBookings: 3,
    modeledBookingValue: 600,
    modeledClickBookings: 1,
    modeledViewBookings: 2,
    modeledUnknownBookings: 0,
  }
  return {
    projectSetupChanges: vi.fn(async () => available(setupProjection, '2026-08-16T09:00:00.000Z')),
    readOutcome: vi.fn(async () =>
      available({
        byWindow: {
          lastDay: outcomeFacts,
          trailing7: outcomeFacts,
          prior7: outcomeFacts,
          monthToDate: outcomeFacts,
          postChange: outcomeFacts,
        },
        weeklyTrend8: [
          {
            windowStart: '2026-08-09',
            windowEnd: '2026-08-15',
            activeAppointments: 12,
            valueBearingBookings: 10,
            zeroValueAppointments: 2,
            bookedValue: 3000,
            activeAmountPaidObserved: 2700,
            activeAmountPaidRevenue: 2700,
            amountPaidCoverage: { withRecordedAmount: 12, total: 12 },
            canceledAppointments: 2,
            canceledAmountPaidObserved: 400,
          },
        ],
      }),
    ),
    readMeta: vi.fn(async () =>
      available({
        byWindow: {
          lastDay: metaFacts,
          trailing7: metaFacts,
          prior7: metaFacts,
          monthToDate: metaFacts,
          postChange: metaFacts,
        },
        weeklyTrend8: [],
      }),
    ),
    readMetaColdWarm: vi.fn(async () =>
      available({
        windowStart: '2026-08-09',
        windowEnd: '2026-08-15',
        comparisonStatus: 'clean' as const,
        blockerCodes: [],
        units: [
          {
            entityLevel: 'adset' as const,
            entityId: 'cold-1',
            parentCampaignId: 'campaign-1',
            name: 'Cold',
            comparisonRole: 'cold' as const,
            ...metaFacts,
          },
          {
            entityLevel: 'adset' as const,
            entityId: 'warm-1',
            parentCampaignId: 'campaign-1',
            name: 'Warm',
            comparisonRole: 'warm' as const,
            ...metaFacts,
          },
        ],
      }),
    ),
    readMetaPlacements: vi.fn(async () =>
      available({
        windowStart: '2026-08-09',
        windowEnd: '2026-08-15',
        blockerCodes: [],
        rows: [
          {
            dimension: 'publisher_platform' as const,
            value: 'instagram',
            spendAmount: 65,
            impressions: 10000,
            clicks: 100,
            leads: 12,
            modeledBookings: 3,
          },
        ],
      }),
    ),
    readTracking: vi.fn(async () =>
      available({
        landingPageViews: 80,
        paidTouchObservations: 70,
        identityCompleteTouches: 65,
        identityIncompleteTouches: 5,
        linkedAppointments: 3,
      }),
    ),
    readCapi: vi.fn(async () =>
      available({
        mode: 'live' as const,
        eligibleAppointments: 4,
        sentAppointments: 4,
        acceptedAppointments: 3,
        failedAppointments: 1,
        expiredAppointments: 0,
      }),
    ),
    readGaIdentity: vi.fn(async () =>
      available({
        confirmationEvents: 4,
        identifiedEvents: 3,
        legacyUnlinkedEvents: 1,
        duplicateAppointments: 0,
        unmatchedAppointmentIds: 0,
        websiteBookingsMissingGa: 1,
        unknownOriginAppointments: 0,
        scope: 'mixed_partial_coverage' as const,
      }),
    ),
    readPaidCohort: vi.fn(async () =>
      available({
        policyVersion: 2,
        complete: true,
        blockerCodes: [],
        recentScale: {
          windowStart: '2026-08-02',
          windowEnd: '2026-08-15',
          complete: true,
          blockerCodes: [],
        },
        maturedCut: {
          windowStart: '2026-07-19',
          windowEnd: '2026-08-01',
          complete: true,
          blockerCodes: [],
        },
        associatedSpend: 200,
        associatedValueBearingBookings: 2,
        associatedAmountPaidRevenue: 610,
      }),
    ),
  }
}

// A structurally clean split is not the same as a comparable one. The Cold/Warm rollup covers a date
// window, so it is only comparable when that window holds one delivery regime: no material change
// inside it, no significant edit that reset a compared cell, and both cells out of learning.
const comparedAdset = (
  meta_adset_id: string,
  learning_stage: string | null,
  latest_significant_edit_at: string | null,
) => ({
  meta_adset_id,
  learning_stage,
  latest_significant_edit_at,
} as unknown as ExecutiveSetupChangeProjectionV1['adsets'][number])

/** Cold/Warm window is 2026-08-09..2026-08-15; this change predates it, so it never confounds. */
const settledChange = {
  ...setupProjection.latest_material_change,
  occurredAt: '2026-08-05T14:00:00.000Z',
} as ExecutiveSetupChangeProjectionV1['latest_material_change']

/** Both compared cells settled: change predates the window and each cell has exited learning. */
const settledComparison = {
  latest_material_change: settledChange,
  adsets: [comparedAdset('cold-1', 'SUCCESS', null), comparedAdset('warm-1', 'SUCCESS', null)],
} satisfies Partial<ExecutiveSetupChangeProjectionV1>

function readersWithSetup(overrides: Partial<ExecutiveSetupChangeProjectionV1>): ExecutiveEvidenceReadersV1 {
  const readers = completeReaders()
  readers.projectSetupChanges = vi.fn(async () => available({ ...setupProjection, ...overrides }))
  return readers
}

describe('ExecutiveEvidenceSnapshotV1', () => {
  it('builds explicit completed-day windows and a governed post-change window', async () => {
    const readers = completeReaders()
    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot).toMatchObject({
      contract: 'executive_evidence_snapshot',
      version: 1,
      account: {
        id: input.accountId,
        name: input.accountName,
        timezone: input.timezone,
      },
      windows: {
        lastDay: {
          startDate: '2026-08-15',
          endDate: '2026-08-15',
          availability: 'available',
        },
        trailing7: {
          startDate: '2026-08-09',
          endDate: '2026-08-15',
          availability: 'available',
        },
        prior7: {
          startDate: '2026-08-02',
          endDate: '2026-08-08',
          availability: 'available',
        },
        monthToDate: {
          startDate: '2026-08-01',
          endDate: '2026-08-15',
          availability: 'available',
        },
        postChange: {
          startDate: '2026-08-10',
          endDate: '2026-08-15',
          availability: 'available',
          changeId: '10000000-0000-4000-8000-000000000010',
        },
      },
      authority: { tier: 'diagnostic_only', moneyActionsAuthorized: false },
      governedActions: {
        availability: 'unavailable',
        items: null,
        blockerCodes: ['governed_actions_not_connected'],
      },
    })
    expect(snapshot.sources.outcomes).toEqual({
      availability: 'available',
      head: '2026-08-16T10:00:00.000Z',
      blockerCodes: [],
    })
    expect(snapshot.outcomes?.byWindow.lastDay?.activeAmountPaidRevenue).toBe(780)
    expect(snapshot.meta?.byWindow.lastDay?.modeledViewBookings).toBe(2)
    // Complete evidence is not a comparable window: the fixture's governed change landed 2026-08-10,
    // inside the 08-09..08-15 rollup, so the split is blocked and postChange is the proven substrate.
    expect(snapshot.metaColdWarm).toMatchObject({
      comparisonStatus: 'blocked',
      units: [{ comparisonRole: 'cold' }, { comparisonRole: 'warm' }],
    })
    expect(snapshot.metaColdWarm?.blockerCodes).toContain('comparison_window_spans_material_change')
    expect(snapshot.metaPlacements?.rows[0]).toMatchObject({
      dimension: 'publisher_platform',
      value: 'instagram',
      spendAmount: 65,
    })
    expect(snapshot.setupChanges?.cold_warm_comparison).toEqual(setupProjection.cold_warm_comparison)
    expect(snapshot.paidCohort?.exactPaidAssociation).toEqual({
      attributionBasis: 'immutable_paid_touch_association',
      spendAmount: 200,
      valueBearingBookings: 2,
      amountPaidRevenue: 610,
      revenueRoas: 3.05,
    })
  })

  it('normalizes missing, throwing, and malformed reads to unavailable rather than zero', async () => {
    const readers: ExecutiveEvidenceReadersV1 = {
      projectSetupChanges: vi.fn(
        async () =>
          ({
            availability: 'available',
            head: null,
            blockerCodes: [],
            data: null,
          }) as ExecutiveEvidenceSourceReadV1<ExecutiveSetupChangeProjectionV1>,
      ),
      readMeta: vi.fn(async () => {
        throw new Error('warehouse timeout')
      }),
    }

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.setupChanges).toBeNull()
    expect(snapshot.meta).toBeNull()
    expect(snapshot.outcomes).toBeNull()
    expect(snapshot.sources.setupChanges).toMatchObject({
      availability: 'unavailable',
      blockerCodes: ['setup_changes_source_data_missing'],
    })
    expect(snapshot.sources.meta).toMatchObject({
      availability: 'unavailable',
      blockerCodes: ['meta_source_read_failed'],
    })
    expect(snapshot.sources.outcomes).toMatchObject({
      availability: 'unavailable',
      blockerCodes: ['outcome_reader_missing'],
    })
    expect(snapshot.windows.postChange).toMatchObject({
      availability: 'unavailable',
      startDate: null,
      endDate: '2026-08-15',
      blockerCodes: ['material_change_not_available'],
    })
    expect(snapshot.blockerCodes).toEqual(expect.arrayContaining(['setup_changes:setup_changes_source_data_missing', 'meta:meta_source_read_failed', 'outcomes:outcome_reader_missing']))
  })

  it('withholds paid revenue and ROAS whenever cohort evidence is incomplete', async () => {
    const readers = completeReaders()
    readers.readPaidCohort = vi.fn(async () =>
      available({
        policyVersion: 2,
        complete: false,
        blockerCodes: ['incomplete_touch_identity'],
        recentScale: {
          windowStart: '2026-08-02',
          windowEnd: '2026-08-15',
          complete: false,
          blockerCodes: ['incomplete_touch_identity'],
        },
        maturedCut: {
          windowStart: '2026-07-19',
          windowEnd: '2026-08-01',
          complete: true,
          blockerCodes: [],
        },
        associatedSpend: 200,
        associatedValueBearingBookings: 0,
        associatedAmountPaidRevenue: 0,
      }),
    )

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.paidCohort?.complete).toBe(false)
    expect(snapshot.paidCohort?.exactPaidAssociation).toBeNull()
    expect(snapshot.sources.paidCohort).toMatchObject({
      availability: 'partial',
      blockerCodes: ['incomplete_touch_identity'],
    })
    expect(snapshot.blockerCodes).toContain('paid_cohort:incomplete_touch_identity')
  })

  it('preserves partial diagnostic facts but never upgrades their source availability', async () => {
    const readers = completeReaders()
    readers.readGaIdentity = vi.fn(async () => ({
      availability: 'partial' as const,
      head: '2026-08-16T08:00:00.000Z',
      blockerCodes: ['ga_identity_coverage_incomplete'],
      data: {
        confirmationEvents: 10,
        identifiedEvents: 4,
        legacyUnlinkedEvents: 6,
        duplicateAppointments: 1,
        unmatchedAppointmentIds: 1,
        websiteBookingsMissingGa: 2,
        unknownOriginAppointments: 1,
        scope: 'mixed_partial_coverage' as const,
      },
    }))

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.gaIdentity?.confirmationEvents).toBe(10)
    expect(snapshot.sources.gaIdentity).toEqual({
      availability: 'partial',
      head: '2026-08-16T08:00:00.000Z',
      blockerCodes: ['ga_identity_coverage_incomplete'],
    })
    expect(snapshot.blockerCodes).toContain('ga_identity:ga_identity_coverage_incomplete')
  })

  it('withholds exact Acuity revenue when amount_paid coverage is incomplete', async () => {
    const readers = completeReaders()
    const incomplete = {
      activeAppointments: 4,
      valueBearingBookings: 3,
      zeroValueAppointments: 1,
      bookedValue: 900,
      activeAmountPaidObserved: 580,
      activeAmountPaidRevenue: 780,
      amountPaidCoverage: { withRecordedAmount: 3, total: 4 },
      canceledAppointments: 1,
      canceledAmountPaidObserved: 200,
    }
    readers.readOutcome = vi.fn(async () =>
      available({
        byWindow: {
          lastDay: incomplete,
          trailing7: incomplete,
          prior7: incomplete,
          monthToDate: incomplete,
          postChange: incomplete,
        },
        weeklyTrend8: [],
      }),
    )

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.outcomes?.byWindow.lastDay).toMatchObject({
      activeAmountPaidObserved: 580,
      activeAmountPaidRevenue: null,
      amountPaidCoverage: { withRecordedAmount: 3, total: 4 },
    })
    expect(snapshot.sources.outcomes.availability).toBe('partial')
    expect(snapshot.sources.outcomes.blockerCodes).toContain('outcome_amount_paid_coverage_incomplete:lastDay')
  })

  it('does not replace fully observed paid revenue with booked value', async () => {
    const readers = completeReaders()
    const paidOnZeroPrice = {
      activeAppointments: 1,
      valueBearingBookings: 0,
      zeroValueAppointments: 1,
      bookedValue: 0,
      activeAmountPaidObserved: 500,
      activeAmountPaidRevenue: 500,
      amountPaidCoverage: { withRecordedAmount: 1, total: 1 },
      canceledAppointments: 0,
      canceledAmountPaidObserved: 0,
    }
    readers.readOutcome = vi.fn(async () =>
      available({
        byWindow: {
          lastDay: paidOnZeroPrice,
          trailing7: paidOnZeroPrice,
          prior7: paidOnZeroPrice,
          monthToDate: paidOnZeroPrice,
          postChange: paidOnZeroPrice,
        },
        weeklyTrend8: [],
      }),
    )

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.outcomes?.byWindow.lastDay).toMatchObject({
      bookedValue: 0,
      activeAmountPaidRevenue: 500,
    })
    expect(snapshot.sources.outcomes.availability).toBe('available')
  })

  it('withholds exact paid ROAS when the cohort source itself is partial', async () => {
    const readers = completeReaders()
    readers.readPaidCohort = vi.fn(async () => ({
      availability: 'partial' as const,
      head: '2026-08-16T10:00:00.000Z',
      blockerCodes: ['paid_cohort_head_stale'],
      data: {
        policyVersion: 2,
        complete: true,
        blockerCodes: [],
        recentScale: {
          windowStart: '2026-08-02',
          windowEnd: '2026-08-15',
          complete: true,
          blockerCodes: [],
        },
        maturedCut: {
          windowStart: '2026-07-19',
          windowEnd: '2026-08-01',
          complete: true,
          blockerCodes: [],
        },
        associatedSpend: 200,
        associatedValueBearingBookings: 2,
        associatedAmountPaidRevenue: 610,
      },
    }))

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.paidCohort?.exactPaidAssociation).toBeNull()
    expect(snapshot.sources.paidCohort).toMatchObject({
      availability: 'partial',
      blockerCodes: ['paid_cohort_head_stale'],
    })
  })

  it('blocks a nominal Cold/Warm comparison when setup evidence says the split is not clean', async () => {
    // Settled window so this isolates one variable: the structural blocker alone must propagate.
    const readers = readersWithSetup({
      ...settledComparison,
      status: 'blocked' as const,
      complete: false,
      blocker_codes: ['cold_warm_overlap_not_excluded'] as ExecutiveSetupChangeProjectionV1['blocker_codes'],
      cold_warm_comparison: {
        ...setupProjection.cold_warm_comparison,
        status: 'blocked' as const,
        blocker_codes: ['cold_warm_overlap_not_excluded'] as ExecutiveSetupChangeProjectionV1['cold_warm_comparison']['blocker_codes'],
      },
    })

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.metaColdWarm).toMatchObject({
      comparisonStatus: 'blocked',
      blockerCodes: ['setup:cold_warm_overlap_not_excluded'],
    })
    expect(snapshot.sources.metaColdWarm).toMatchObject({
      availability: 'partial',
      blockerCodes: ['setup:cold_warm_overlap_not_excluded'],
    })
  })

  it('blocks the Cold/Warm comparison when a material change lands inside the comparison window', async () => {
    // setupProjection's change is 2026-08-10, inside the 2026-08-09..2026-08-15 comparison window.
    const readers = readersWithSetup({
      adsets: [comparedAdset('cold-1', 'SUCCESS', null), comparedAdset('warm-1', 'SUCCESS', null)],
    })

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.metaColdWarm?.comparisonStatus).toBe('blocked')
    expect(snapshot.metaColdWarm?.blockerCodes).toContain('comparison_window_spans_material_change')
  })

  it('blocks the Cold/Warm comparison when a compared cell is still in the learning phase', async () => {
    const readers = readersWithSetup({
      latest_material_change: settledChange,
      adsets: [comparedAdset('cold-1', 'LEARNING', null), comparedAdset('warm-1', 'SUCCESS', null)],
    })

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.metaColdWarm?.comparisonStatus).toBe('blocked')
    expect(snapshot.metaColdWarm?.blockerCodes).toContain('comparison_cell_learning')
  })

  it('blocks the Cold/Warm comparison when a compared cell was significantly edited inside the window', async () => {
    const readers = readersWithSetup({
      latest_material_change: settledChange,
      adsets: [
        comparedAdset('cold-1', 'SUCCESS', '2026-08-12T18:00:00.000Z'),
        comparedAdset('warm-1', 'SUCCESS', null),
      ],
    })

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.metaColdWarm?.comparisonStatus).toBe('blocked')
    expect(snapshot.metaColdWarm?.blockerCodes).toContain('comparison_cell_edited_in_window')
  })

  it('blocks the Cold/Warm comparison when a compared cell learning state cannot be verified', async () => {
    // No ad-set evidence for the named cells: unverifiable is not clean.
    const readers = readersWithSetup({ latest_material_change: settledChange, adsets: [] })

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.metaColdWarm?.comparisonStatus).toBe('blocked')
    expect(snapshot.metaColdWarm?.blockerCodes).toContain('comparison_cell_learning_unknown')
  })

  it('keeps the Cold/Warm comparison clean when the change predates the window and both cells exited learning', async () => {
    const readers = readersWithSetup({
      latest_material_change: settledChange,
      adsets: [
        comparedAdset('cold-1', 'SUCCESS', '2026-08-05T14:00:00.000Z'),
        comparedAdset('warm-1', 'SUCCESS', null),
      ],
    })

    const snapshot = await buildExecutiveEvidenceSnapshotV1(input, readers)

    expect(snapshot.metaColdWarm?.comparisonStatus).toBe('clean')
    expect(snapshot.metaColdWarm?.blockerCodes).toEqual([])
  })
})
