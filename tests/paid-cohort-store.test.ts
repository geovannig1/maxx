import { describe, expect, it } from 'vitest'
import {
  PaidCohortStoreError,
  publishPaidCohortPair,
  readLatestPaidCohortPair,
  readLatestPaidCohortPairs,
} from '@/lib/attribution/paid-cohort-store'
import {
  ACCOUNT,
  ACTIVATION,
  RUN,
  cohortGeneration,
  context,
  fakeDb,
  healthyTables,
  storedMetrics,
  uuid,
} from './helpers/paid-cohort-store-fixture'

describe('paid cohort store', () => {
  const source = (kind: string, enabled = true, n = 1) => ({ id: uuid(70_000 + n), ad_account_id: ACCOUNT, kind, enabled })

  it('publishes a CSV-only cohort as incomplete with source_cannot_carry_token', async () => {
    const tables = { ...healthyTables(), outcome_sources: [source('csv')] }
    const { db } = fakeDb(tables)
    const result = await publishPaidCohortPair(db, ACCOUNT, context)
    for (const cohort of [result.recent, result.matured]) {
      expect(cohort.complete).toBe(false)
      expect(cohort.blocker_codes).toContain('source_cannot_carry_token')
    }
  })

  it('also blocks when a CSV source is enabled beside a token-carrying source', async () => {
    const { db } = fakeDb({ ...healthyTables(), outcome_sources: [source('webhook', true, 1), source('csv', true, 2)] })
    const result = await publishPaidCohortPair(db, ACCOUNT, context)
    expect(result.recent.blocker_codes).toContain('source_cannot_carry_token')
  })

  // The webhook payload has no paid-touch token field and nothing links webhook outcomes to paid
  // touches, so a webhook source cannot carry a token: its outcomes would be unlinkable while the
  // cohort reported complete.
  // a webhook delivery can carry a signed paid-touch token and is linked like an Acuity booking,
  // so an enabled webhook source no longer blocks by itself. A webhook outcome without a token is simply
  // not linked (tests/db/outcome-webhook-paid-touch-db.test.ts proves the coverage on the real schema).
  it('does not block on an enabled webhook source by itself, because webhook outcomes can be linked', async () => {
    const { db } = fakeDb({ ...healthyTables(), outcome_sources: [source('webhook')] })
    const result = await publishPaidCohortPair(db, ACCOUNT, context)
    expect(result.recent.complete).toBe(true)
    expect(result.recent.blocker_codes).not.toContain('source_cannot_carry_token')
  })

  it('control: an enabled CSV source beside a webhook source still blocks', async () => {
    const { db } = fakeDb({ ...healthyTables(), outcome_sources: [source('webhook'), source('csv', true, 2)] })
    const result = await publishPaidCohortPair(db, ACCOUNT, context)
    expect(result.recent.complete).toBe(false)
    expect(result.recent.blocker_codes).toContain('source_cannot_carry_token')
  })

  it('controls: a token-carrying source, or a disabled CSV or webhook source, leaves the cohort complete', async () => {
    for (const sources of [[source('acuity')], [source('csv', false)], [source('webhook', false)]]) {
      const { db } = fakeDb({ ...healthyTables(), outcome_sources: sources })
      const result = await publishPaidCohortPair(db, ACCOUNT, context)
      expect(result.recent.complete, JSON.stringify(sources)).toBe(true)
      expect(result.recent.blocker_codes).not.toContain('source_cannot_carry_token')
    }
  })

  it('fails the publication when the outcome sources cannot be read', async () => {
    const { db } = fakeDb({ ...healthyTables(), outcome_sources: [source('csv')] }, 'outcome_sources')
    await expect(publishPaidCohortPair(db, ACCOUNT, context)).rejects.toThrow()
  })

  it('reads every source account-scoped, pages past 1000, and publishes one exact pair', async () => {
    const { db, queries, rpc } = fakeDb(healthyTables(1001))
    const result = await publishPaidCohortPair(db, ACCOUNT, context)

    expect(result.recent.complete).toBe(true)
    expect(result.matured.complete).toBe(true)
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0][0]).toBe('commit_paid_cohort_pair')
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_ad_account_id: ACCOUNT,
      p_evaluation_run_id: RUN,
      p_as_of_date: '2026-07-30',
      p_contract_version: 1,
      p_policy_version: 2,
      p_maturity_lag_days: 14,
    })
    const touchRanges = queries
      .filter((query) => query.table === 'paid_touch_observations')
      .map((query) => query.range)
    expect(touchRanges).toEqual([[0, 999], [1000, 1999]])

    for (const query of queries.filter((row) => row.table !== 'ad_accounts')) {
      expect(query.filters.ad_account_id, `${query.table} was not account scoped`).toBe(ACCOUNT)
    }
  })

  it('joins links to outcomes by uuid and keeps a link without a readable outcome visible as missing', async () => {
    const tables = healthyTables()
    const touch = tables.paid_touch_observations.find((row) => String(row.observed_at).startsWith('2026-07-20'))!
    const link = (id: number, outcomeId: string) => ({
      id: uuid(70_000 + id), ad_account_id: ACCOUNT, outcome_id: outcomeId, last_touch_id: touch.id,
      last_interaction_at: touch.observed_at, linked_at: '2026-07-21T12:00:00.000Z',
    })
    tables.outcome_touch_links = [link(1, uuid(80_001)), link(2, uuid(80_002))]
    tables.outcomes = [{
      id: uuid(80_001), ad_account_id: ACCOUNT, external_id: '501', gross_value: 125, collected_value: 125,
      status: 'confirmed', synced_at: '2026-07-30T11:00:00.000Z',
    }]
    tables.paid_cohort_completeness_manifests = []
    const { db } = fakeDb(tables)

    const result = await publishPaidCohortPair(db, ACCOUNT, context)
    const unit = result.recent.units.find((row) => row.entity_level === 'ad')!
    expect(unit.bookings).toBe(1)
    expect(unit.booked_value).toBe(125)
    expect(unit.blocker_codes).toContain('appointment_state_missing')
  })

  it('counts a linked outcome whose external id is not a number (a webhook order id)', async () => {
    const tables = healthyTables()
    const touch = tables.paid_touch_observations.find((row) => String(row.observed_at).startsWith('2026-07-20'))!
    const link = (id: number, outcomeId: string) => ({
      id: uuid(70_000 + id), ad_account_id: ACCOUNT, outcome_id: outcomeId, last_touch_id: touch.id,
      last_interaction_at: touch.observed_at, linked_at: '2026-07-21T12:00:00.000Z',
    })
    tables.outcome_touch_links = [link(1, uuid(80_001)), link(2, uuid(80_002))]
    // Two sources may share an external id: they are still two outcomes.
    tables.outcomes = [
      { id: uuid(80_001), ad_account_id: ACCOUNT, external_id: 'ORDER-1001', gross_value: 125, collected_value: 125,
        status: 'confirmed', synced_at: '2026-07-30T11:00:00.000Z' },
      { id: uuid(80_002), ad_account_id: ACCOUNT, external_id: 'ORDER-1001', gross_value: 40, collected_value: 40,
        status: 'confirmed', synced_at: '2026-07-30T11:00:00.000Z' },
    ]
    tables.paid_cohort_completeness_manifests = []
    const { db } = fakeDb(tables)

    const result = await publishPaidCohortPair(db, ACCOUNT, context)
    const unit = result.recent.units.find((row) => row.entity_level === 'ad')!
    expect(unit.bookings).toBe(2)
    expect(unit.booked_value).toBe(165)
    expect(unit.blocker_codes).not.toContain('link_touch_mismatch')
    expect(unit.blocker_codes).not.toContain('appointment_state_missing')
  })

  it('publishes without demanding a completeness manifest under the policy-v2 freeze', async () => {
    // The v3 cutover is reverted (`paid_cohort_policy_cutovers`): capture_eligible_inputs has no honest producer, so a
    // missing manifest must not block. The malformed-manifest test below still fail-stops, so a
    // manifest that IS supplied is validated exactly as before and v3 re-arms on policyVersion 3.
    const tables = healthyTables()
    tables.paid_cohort_completeness_manifests = []
    const { db, rpc } = fakeDb(tables)

    const result = await publishPaidCohortPair(db, ACCOUNT, context)

    expect(result.recent.blocker_codes).not.toContain('paid_completeness_manifest_unavailable')
    expect(result.matured.blocker_codes).not.toContain('paid_completeness_manifest_unavailable')
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('fails without publishing when a completeness manifest row is malformed', async () => {
    const tables = healthyTables()
    tables.paid_cohort_completeness_manifests[0].captured_touches = -1
    const { db, rpc } = fakeDb(tables)

    await expect(publishPaidCohortPair(db, ACCOUNT, context)).rejects.toMatchObject({
      code: 'SOURCE_DATA_INVALID',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('persists activation_missing as a blocked pair instead of fabricating pre-activation history', async () => {
    const tables = healthyTables()
    tables.paid_measurement_activations = []
    const { db, rpc } = fakeDb(tables)
    const result = await publishPaidCohortPair(db, ACCOUNT, context)
    expect(result.recent).toMatchObject({ complete: false, activation_id: null })
    expect(result.recent.blocker_codes).toContain('activation_missing')
    expect(result.matured.blocker_codes).toContain('activation_missing')
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('fails closed on malformed or unavailable source rows and never publishes them', async () => {
    const malformed = healthyTables()
    malformed.daily_insights[0].spend = 'garbage'
    const invalidDb = fakeDb(malformed)
    await expect(publishPaidCohortPair(invalidDb.db, ACCOUNT, context)).rejects.toBeInstanceOf(PaidCohortStoreError)
    expect(invalidDb.rpc).not.toHaveBeenCalled()

    const unavailableDb = fakeDb(healthyTables(), 'paid_touch_observations')
    await expect(publishPaidCohortPair(unavailableDb.db, ACCOUNT, context)).rejects.toMatchObject({
      code: 'SOURCE_READ_FAILED',
    })
    expect(unavailableDb.rpc).not.toHaveBeenCalled()
  })

  it('reads both directions from the same latest run and the exact requested unit', async () => {
    const otherRun = '00000000-0000-4000-8000-000000000804'
    const recent = '00000000-0000-4000-8000-000000000805'
    const matured = '00000000-0000-4000-8000-000000000806'
    const olderRun = uuid(9_990)
    const tables = healthyTables()
    tables.paid_cohort_generations = [
      {
        id: recent, ad_account_id: ACCOUNT, evaluation_run_id: otherRun, cohort_kind: 'recent_scale',
        window_start: '2026-07-16', window_end: '2026-07-29', as_of_date: '2026-07-30',
        activation_id: ACTIVATION, contract_version: 1, policy_version: 2,
        landing_page_views: 10, captured_landing_views: 10,
        complete: true, blocker_codes: [], account_spend: 140,
        metrics: { bookings: 2, booked_value: 440, ...storedMetrics() },
        created_at: '2026-07-30T11:00:00.000Z',
      },
      {
        id: matured, ad_account_id: ACCOUNT, evaluation_run_id: otherRun, cohort_kind: 'matured_cut',
        window_start: '2026-07-02', window_end: '2026-07-15', as_of_date: '2026-07-30',
        activation_id: ACTIVATION, contract_version: 1, policy_version: 2,
        landing_page_views: 10, captured_landing_views: 10,
        complete: true, blocker_codes: [], account_spend: 300,
        metrics: { bookings: 0, booked_value: 0, ...storedMetrics() },
        created_at: '2026-07-30T11:00:00.000Z',
      },
      // This complete same-account run has lexically higher IDs and a later created_at, but its
      // as-of date is older. The first PostgREST order key must remain primary.
      cohortGeneration({
        id: uuid(9_999), evaluation_run_id: olderRun,
        window_start: '2026-07-15', window_end: '2026-07-28', as_of_date: '2026-07-29',
        created_at: '2026-07-31T12:00:00.000Z',
      }),
      cohortGeneration({
        id: uuid(9_998), evaluation_run_id: olderRun, cohort_kind: 'matured_cut',
        window_start: '2026-07-01', window_end: '2026-07-14', as_of_date: '2026-07-29',
        created_at: '2026-07-31T12:00:00.000Z',
      }),
      // A newer-looking row from ANOTHER account must never enter the pair.
      {
        id: uuid(900), ad_account_id: uuid(901), evaluation_run_id: uuid(902), cohort_kind: 'recent_scale',
        window_start: '2026-07-16', window_end: '2026-07-29', as_of_date: '2026-07-31',
        activation_id: null, contract_version: 1, policy_version: 2,
        landing_page_views: 1, captured_landing_views: 1,
        complete: true, blocker_codes: [], account_spend: 1, metrics: storedMetrics(),
        created_at: '2026-07-31T11:00:00.000Z',
      },
    ]
    tables.paid_cohort_units = [
      { id: uuid(910), ad_account_id: ACCOUNT, generation_id: recent, entity_level: 'account', entity_id: 'act_1', spend: 140, landing_page_views: 10, captured_touches: 10, bookings: 2, booked_value: 440, complete: true, blocker_codes: [], metrics: { cpa: 70, ...storedMetrics() } },
      { id: uuid(911), ad_account_id: ACCOUNT, generation_id: matured, entity_level: 'account', entity_id: 'act_1', spend: 300, landing_page_views: 10, captured_touches: 10, bookings: 0, booked_value: 0, complete: true, blocker_codes: [], metrics: { cpa: null, ...storedMetrics() } },
    ]

    const { db, queries } = fakeDb(tables)
    const pair = await readLatestPaidCohortPair(db, ACCOUNT, { entityLevel: 'account', entityId: 'act_1' })
    expect(pair).toMatchObject({
      evaluationRunId: otherRun,
      recentScale: { generationId: recent, spend: 140, bookings: 2, complete: true },
      maturedCut: { generationId: matured, spend: 300, bookings: 0, complete: true },
    })
    for (const query of queries) {
      const scoped = query.table === 'ad_accounts'
        ? query.filters.id === ACCOUNT
        : query.filters.ad_account_id === ACCOUNT
      expect(scoped).toBe(true)
    }

    const batched = fakeDb(tables)
    const pairs = await readLatestPaidCohortPairs(batched.db, ACCOUNT, [
      { entityLevel: 'account', entityId: 'act_1' },
      { entityLevel: 'campaign', entityId: 'missing-campaign' },
    ])
    expect(pairs?.get('account:act_1')?.recentScale).toMatchObject({ complete: true, bookings: 2 })
    expect(pairs?.get('campaign:missing-campaign')?.recentScale).toMatchObject({
      complete: false, blockerCodes: ['unit_not_present'],
    })
    expect(batched.queries.filter((query) => query.table === 'paid_cohort_units')).toHaveLength(1)
  })

  it('returns null before the first publication and rejects a torn one-direction run', async () => {
    const empty = fakeDb({ ...healthyTables(), paid_cohort_generations: [], paid_cohort_units: [] })
    await expect(readLatestPaidCohortPair(
      empty.db, ACCOUNT, { entityLevel: 'account', entityId: 'act_1' },
    )).resolves.toBeNull()

    const tornTables = healthyTables()
    tornTables.paid_cohort_generations = [{
      id: uuid(920), ad_account_id: ACCOUNT, evaluation_run_id: uuid(921), cohort_kind: 'recent_scale',
      window_start: '2026-07-16', window_end: '2026-07-29', as_of_date: '2026-07-30',
      activation_id: null, contract_version: 1, policy_version: 2,
      landing_page_views: null, captured_landing_views: 0,
      complete: false, blocker_codes: ['activation_missing'], account_spend: null, metrics: storedMetrics(),
      created_at: '2026-07-30T11:00:00.000Z',
    }]
    tornTables.paid_cohort_units = []
    const torn = fakeDb(tornTables)
    await expect(readLatestPaidCohortPair(
      torn.db, ACCOUNT, { entityLevel: 'account', entityId: 'act_1' },
    )).rejects.toMatchObject({ code: 'SOURCE_DATA_INVALID' })
  })
})
