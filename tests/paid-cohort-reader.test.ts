import { describe, expect, it } from 'vitest'
import { readLatestPaidCohortArtifact } from '@/lib/attribution/paid-cohort-store'
import { PAID_COHORT_DIAGNOSTIC_SCHEMAS } from '@/lib/attribution/paid-cohort-reader'
import { PAID_COHORT_POLICY } from '@/lib/attribution/paid-cohort-policy'
import {
  ACCOUNT,
  ACTIVATION,
  COHORT_RUN,
  MATURED_GENERATION,
  RECENT_GENERATION,
  artifactTablesWith,
  cohortGeneration,
  cohortUnit,
  fakeDb,
  healthyTables,
  invalidArtifactTables,
  publishedCohortTables,
  storedMetrics,
  uuid,
} from './helpers/paid-cohort-store-fixture'

describe('strict paid cohort reader', () => {
  it('reads one strict latest artifact, pages every query, and returns only locally intact ad units', async () => {
    const { db, queries } = fakeDb(publishedCohortTables())

    const artifact = await readLatestPaidCohortArtifact(db, ACCOUNT)

    expect(artifact).toEqual({
      evaluationRunId: COHORT_RUN,
      recentScale: {
        generation: {
          generationId: RECENT_GENERATION,
          cohortKind: 'recent_scale',
          windowStart: '2026-07-16',
          windowEnd: '2026-07-29',
          asOfDate: '2026-07-30',
          activationId: ACTIVATION,
          contractVersion: 1,
          policyVersion: 2,
          complete: true,
          blockerCodes: [],
        },
        adUnits: [{
          id: uuid(910),
          generationId: RECENT_GENERATION,
          metaAdId: '301',
          spend: 70.25,
          landingPageViews: 10,
          capturedTouches: 9,
          bookings: 2,
          bookedValue: 440.5,
          complete: false,
          blockerCodes: ['capture_coverage_mismatch'],
          zeroValueBookings: 1,
          canceledLinks: 0,
        }],
      },
      maturedCut: {
        generation: {
          generationId: MATURED_GENERATION,
          cohortKind: 'matured_cut',
          windowStart: '2026-07-02',
          windowEnd: '2026-07-15',
          asOfDate: '2026-07-30',
          activationId: ACTIVATION,
          contractVersion: 1,
          policyVersion: 2,
          complete: true,
          blockerCodes: [],
        },
        adUnits: [{
          id: uuid(911),
          generationId: MATURED_GENERATION,
          metaAdId: '301',
          spend: 120,
          landingPageViews: null,
          capturedTouches: 4,
          bookings: 0,
          bookedValue: 0,
          complete: true,
          blockerCodes: [],
          zeroValueBookings: 0,
          canceledLinks: 2,
        }],
      },
    })
    expect(queries.filter((query) => query.table === 'paid_cohort_units').map((query) => query.range))
      .toEqual([[0, 999], [1000, 1999]])
    for (const query of queries) {
      const scoped = query.table === 'ad_accounts'
        ? query.filters.id === ACCOUNT
        : query.filters.ad_account_id === ACCOUNT
      expect(scoped, `${query.table} was not account scoped`).toBe(true)
      if (query.table !== 'ad_accounts' && query.table !== 'paid_measurement_activations') {
        expect(query.range, `${query.table} was not paged`).toBeDefined()
      }
    }
  })

  it('rejects duplicate generations and duplicate units instead of projecting torn data', async () => {
    const generationBase = publishedCohortTables()
    const duplicateGenerationTables = {
      ...generationBase,
      paid_cohort_generations: [
        ...generationBase.paid_cohort_generations,
        cohortGeneration({ id: uuid(913), cohort_kind: 'matured_cut' }),
      ],
    }
    await expect(readLatestPaidCohortArtifact(
      fakeDb(duplicateGenerationTables).db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_DATA_INVALID' })

    const unitBase = publishedCohortTables()
    const duplicateUnitTables = {
      ...unitBase,
      paid_cohort_units: [
        ...unitBase.paid_cohort_units,
        cohortUnit({ id: uuid(914) }),
      ],
    }
    await expect(readLatestPaidCohortArtifact(
      fakeDb(duplicateUnitTables).db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_DATA_INVALID' })
  })

  it.each([
    ['activation', { generation: { activation_id: 'not-a-uuid' } }],
    ['generation money', { generation: { account_spend: 'not-money' } }],
    ['generation sub-cent number', { generation: { account_spend: 637.141 } }],
    ['generation sub-cent string', { generation: { account_spend: '637.1399999999999' } }],
    ['generation landing-page views', { generation: { landing_page_views: '1.5' } }],
    ['generation captured views', { generation: { captured_landing_views: '-1' } }],
    ['unit money', { unit: { spend: 'not-money' } }],
    ['unit sub-cent number', { unit: { spend: 70.254 } }],
    ['unit sub-cent string', { unit: { spend: '70.2500000000001' } }],
    ['unit landing-page views', { unit: { landing_page_views: '1.5' } }],
    ['captured touches', { unit: { captured_touches: '-1' } }],
    ['bookings', { unit: { bookings: '1.5' } }],
    ['booked value', { unit: { booked_value: 'not-money' } }],
    ['booked value sub-cent number', { unit: { booked_value: 318.505 } }],
    ['rounded spend precision', { unit: { spend: '9007199254740990.99' } }],
    ['rounded booked-value precision', { unit: { booked_value: '9007199254740990.99' } }],
    ['zero-value bookings', { unit: { metrics: storedMetrics(-1, 0) } }],
    ['canceled links', { unit: { metrics: { zero_value_bookings: 0 } } }],
    ['checkout revenue', { unit: { metrics: { ...storedMetrics(), outcome_recorded_revenue: 'not-money' } } }],
  ])('rejects malformed artifact %s', async (_label, overrides) => {
    await expect(readLatestPaidCohortArtifact(
      fakeDb(invalidArtifactTables(overrides)).db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_DATA_INVALID' })
  })

  it('normalizes insignificant JSON floating-point noise in stored money fields', async () => {
    const artifact = await readLatestPaidCohortArtifact(
      fakeDb(artifactTablesWith({
        generations: {
          0: { account_spend: 637.1399999999999 },
          1: { account_spend: 300.00000000000006 },
        },
        units: {
          0: { spend: 637.1399999999999, booked_value: 318.50000000000006 },
          1: { spend: 119.99999999999999, booked_value: 0.00000000000000001 },
        },
      })).db,
      ACCOUNT,
    )

    expect(artifact?.recentScale.adUnits[0]).toMatchObject({ spend: 637.14, bookedValue: 318.5 })
    expect(artifact?.maturedCut.adUnits[0]).toMatchObject({ spend: 120, bookedValue: 0 })
  })

  it.each([
    ['impossible calendar date', { generations: {
      0: { as_of_date: '2026-02-30' }, 1: { as_of_date: '2026-02-30' },
    } }],
    ['reversed recent window', { generations: {
      0: { window_start: '2026-07-20', window_end: '2026-07-19' },
    } }],
    ['overlapping windows', { generations: {
      1: { window_end: '2026-07-20' },
    } }],
    ['recent window including as-of', { generations: {
      0: { window_end: '2026-07-30' },
    } }],
    ['insufficient matured lag', { generations: {
      0: { window_start: '2026-07-20' },
      1: { window_start: '2026-07-04', window_end: '2026-07-17' },
    } }],
  ])('rejects artifact %s', async (_label, overrides) => {
    await expect(readLatestPaidCohortArtifact(
      fakeDb(artifactTablesWith(overrides)).db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_DATA_INVALID' })
  })

  it.each([
    ['null activation without activation_missing', { generations: {
      0: { activation_id: null }, 1: { activation_id: null },
    } }],
    ['real activation carrying activation_missing', { generations: {
      0: { complete: false, blocker_codes: ['activation_missing'] },
      1: { complete: false, blocker_codes: ['activation_missing'] },
    } }],
    ['unknown blocker', { generations: {
      0: { complete: false, blocker_codes: ['unknown_blocker'] },
    } }],
    ['duplicate blocker', { generations: {
      0: { activation_id: null, complete: false, blocker_codes: ['activation_missing', 'activation_missing'] },
      1: { activation_id: null, complete: false, blocker_codes: ['activation_missing'] },
    } }],
    ['empty blocker', { generations: {
      0: { complete: false, blocker_codes: [''] },
    } }],
  ])('rejects artifact with %s', async (_label, overrides) => {
    await expect(readLatestPaidCohortArtifact(
      fakeDb(artifactTablesWith(overrides)).db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_DATA_INVALID' })
  })

  it.each([
    ['activation_missing', {
      generations: {
        0: { activation_id: null, complete: false, blocker_codes: ['activation_missing'] },
        1: { activation_id: null, complete: false, blocker_codes: ['activation_missing'] },
      },
      units: {
        0: { complete: true, blocker_codes: [] },
        1: { complete: false, blocker_codes: ['activation_missing'] },
        2: { complete: false, blocker_codes: ['activation_missing'] },
      },
    }],
    ['pre_activation_window', {
      generations: { 0: { complete: false, blocker_codes: ['pre_activation_window'] } },
      units: {
        0: { complete: true, blocker_codes: [] },
        2: { complete: false, blocker_codes: ['pre_activation_window'] },
      },
    }],
  ])('rejects an ad unit that omits generation-wide %s', async (_label, overrides) => {
    await expect(readLatestPaidCohortArtifact(
      fakeDb(artifactTablesWith(overrides)).db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_DATA_INVALID' })
  })

  it('rejects invalid artifact account scope before querying', async () => {
    const { db, queries } = fakeDb(publishedCohortTables())
    await expect(readLatestPaidCohortArtifact(db, 'not-an-account-id')).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    })
    expect(queries).toHaveLength(0)
  })

  it('returns null before the first publication', async () => {
    const empty = fakeDb({ ...healthyTables(), paid_cohort_generations: [], paid_cohort_units: [] })
    await expect(readLatestPaidCohortArtifact(empty.db, ACCOUNT)).resolves.toBeNull()
  })

  it.each([1, 3])('treats non-current v%s generations as unavailable instead of action-authoritative evidence', async (version) => {
    const tables = publishedCohortTables()
    tables.paid_cohort_generations = tables.paid_cohort_generations.map((row) => ({
      ...row,
      policy_version: version,
    }))
    const legacyOnly = fakeDb(tables)

    await expect(readLatestPaidCohortArtifact(legacyOnly.db, ACCOUNT)).resolves.toBeNull()
    const latestQuery = legacyOnly.queries.find((query) => query.table === 'paid_cohort_generations')
    expect(latestQuery?.filters).toMatchObject({ contract_version: 1, policy_version: 2 })
  })
})

// THE RECOMMENDATION OUTAGE, at the schema.
//
// After the decision gate opened, every recommendation generation died with "The latest paid cohort
// generation is malformed." The cause was a category error: `revenue_roas` is a QUOTIENT
// (acuity revenue ÷ spend = 150 / 512.40 = 0.2927400468384075) and was being validated by the MONEY
// validator, which enforces at most two decimal places. Every honest ROAS value was rejected.
//
// It stayed hidden because the quotient was 0 or null until Acuity revenue began flowing, and because
// the error carried no field name — it said only "is malformed", which cost two wrong diagnoses.
describe('paid cohort schemas: ratios are not money', () => {
  const { generation, unit } = PAID_COHORT_DIAGNOSTIC_SCHEMAS

  const metrics = (over: Record<string, unknown> = {}) => ({
    zero_value_bookings: 0, canceled_links: 0,
    outcome_recorded_revenue: 150, revenue_roas: 150 / 512.4, ...over,
  })

  it('accepts a full-precision ROAS quotient', () => {
    const parsed = generation.safeParse({
      id: '00000000-0000-4000-8000-0000000009a1',
      evaluation_run_id: '00000000-0000-4000-8000-0000000009a2',
      cohort_kind: 'recent_scale',
      window_start: '2026-03-02', window_end: '2026-03-15', as_of_date: '2026-03-16',
      activation_id: '00000000-0000-4000-8000-0000000009a3',
      contract_version: PAID_COHORT_POLICY.contractVersion,
      policy_version: PAID_COHORT_POLICY.policyVersion,
      account_spend: 512.4, landing_page_views: 280, captured_landing_views: 455,
      complete: false, blocker_codes: ['incomplete_touch_identity'],
      metrics: metrics(),
      created_at: '2026-03-16T22:00:00.000Z',
    })
    // 0.2927400468384075 has 16 decimal places and is a perfectly valid ratio.
    expect(parsed.success).toBe(true)
  })

  const unitRow = (spend: unknown) => ({
    id: '00000000-0000-4000-8000-0000000009b1',
    generation_id: '00000000-0000-4000-8000-0000000009b2',
    entity_level: 'ad', entity_id: '301',
    spend,
    landing_page_views: 1, captured_touches: 1, bookings: 1, booked_value: 150,
    complete: true, blocker_codes: [],
    metrics: metrics(),
  })

  // The money contract is deliberately strict on the string branch, which is how stored money arrives
  // (PostgREST serialises `numeric` as a string). A stored figure that is not whole cents means the
  // WRITER is broken — and that is precisely how the outage was found. Relaxing it to
  // normalise epsilon drift was tried and reverted: it would have hidden the writer bug for good.
  it('rejects stored money that is not whole cents, so a writer bug cannot hide', () => {
    expect(unit.safeParse(unitRow('512.4000000000001')).success).toBe(false)
    expect(unit.safeParse(unitRow('512.499')).success).toBe(false)
  })
})
