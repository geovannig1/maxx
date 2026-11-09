import { describe, expect, it } from 'vitest'
import { buildPaidCohortGeneration, type PaidCohortBuildInput } from '@/lib/attribution/paid-cohort'

const ACTIVATION = '00000000-0000-4000-8000-000000000781'
const GENERATION = '00000000-0000-4000-8000-000000000782'
const RUN = '00000000-0000-4000-8000-000000000783'
const MANIFEST = '00000000-0000-4000-8000-000000000784'

function base(overrides: Partial<PaidCohortBuildInput> = {}): PaidCohortBuildInput {
  return {
    generationId: GENERATION,
    evaluationRunId: RUN,
    cohortKind: 'recent_scale',
    accountMetaId: 'act_1',
    timezone: 'America/New_York',
    window: { start: '2026-07-01', end: '2026-07-02' },
    asOfDate: '2026-07-20',
    sourceNotBefore: '2026-07-03T09:00:00.000Z',
    appointmentSourceComplete: true,
    appointmentSourceHead: '2026-07-03T10:00:00.000Z',
    appointmentSourceWindowBasis: 'booking_date_et',
    appointmentSourceWindowStart: '2026-07-01',
    appointmentSourceWindowEnd: '2026-07-02',
    maturityLagDays: 14,
    tokenlessSourceKinds: [],
    completenessManifest: {
      id: MANIFEST,
      evaluationRunId: RUN,
      cohortKind: 'recent_scale',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      sourceNotBefore: '2026-07-03T09:00:00.000Z',
      captureCompletedAt: '2026-07-03T10:00:00.000Z',
      linkerCompletedAt: '2026-07-03T10:00:00.000Z',
      captureComplete: true,
      linkerComplete: true,
      captureEligibleInputs: 2,
      capturedTouches: 2,
      eligibleAppointments: 1,
      evaluatedAppointments: 1,
      linkedAppointments: 1,
      blockerCodes: [],
    },
    activation: { id: ACTIVATION, activatedAt: '2026-06-30T04:00:00.000Z' },
    insights: [
      { dateStart: '2026-07-01', entityLevel: 'account', spend: 50, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
      { dateStart: '2026-07-02', entityLevel: 'account', spend: 50, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
      { dateStart: '2026-07-01', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 50, landingPageViews: 1, syncedAt: '2026-07-03T10:00:00Z' },
      { dateStart: '2026-07-02', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 50, landingPageViews: 1, syncedAt: '2026-07-03T10:00:00Z' },
    ],
    touches: [
      { id: 't1', observedAt: '2026-07-01T16:00:00Z', identityComplete: true, metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', fbclid: 'fbc-t1' },
      { id: 't2', observedAt: '2026-07-02T16:00:00Z', identityComplete: true, metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', fbclid: 'fbc-t2' },
    ],
    links: [{ appointmentId: 7001, lastTouchId: 't1', lastInteractionAt: '2026-07-01T16:00:00Z', linkedAt: '2026-07-03T10:00:00Z' }],
    appointments: [{ id: 7001, price: 220, amountPaid: 176, canceled: false, syncedAt: '2026-07-03T10:00:00Z' }],
    ...overrides,
  }
}

describe('paid interaction cohort builder: stored money at the account currency scale', () => {
  const spends = (a: number, b: number): Partial<PaidCohortBuildInput> => ({
    insights: base().insights.map((row) => ({ ...row, spend: row.dateStart === '2026-07-01' ? a : b })),
  })
  const withCurrency = <T>(currency: string, run: () => T): T => {
    const saved = process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
    process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = currency
    try { return run() } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
      else process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = saved
    }
  }

  it('KWD keeps fils: 1.111 + 2.222 is stored as 3.333, not 3.33', () => {
    const result = withCurrency('KWD', () => buildPaidCohortGeneration(base(spends(1.111, 2.222))))
    expect(result.account_spend).toBe(3.333)
    expect(result.entity_spend).toBe(3.333)
  })

  it('USD control: whole cents, float drift removed', () => {
    const result = withCurrency('USD', () => buildPaidCohortGeneration(base(spends(0.1, 0.2))))
    expect(result.account_spend).toBe(0.3)
  })
})

describe('paid interaction cohort builder', () => {
  // Release plan 7.5: an enabled outcome source that cannot carry an attribution token has outcomes the
  // linker can never attribute, so the cohort's linkage is incomplete by construction.
  it('marks every cohort and unit incomplete when an enabled source cannot carry a token', () => {
    const control = buildPaidCohortGeneration(base())
    expect(control.complete).toBe(true)
    const result = buildPaidCohortGeneration(base({ tokenlessSourceKinds: ['csv'] }))
    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toEqual(['source_cannot_carry_token'])
    expect(result.units.every((unit) => !unit.complete && unit.blocker_codes.includes('source_cannot_carry_token'))).toBe(true)
  })

  it('builds exact account/campaign/adset/ad metrics from interaction-date spend and linked outcomes', () => {
    const result = buildPaidCohortGeneration(base())
    expect(result).toMatchObject({
      id: GENERATION,
      cohort_kind: 'recent_scale',
      activation_id: ACTIVATION,
      account_spend: 100,
      entity_spend: 100,
      landing_page_views: 2,
      captured_landing_views: 2,
      complete: true,
      blocker_codes: [],
      metrics: {
        bookings: 1,
        booked_value: 220,
        outcome_recorded_revenue: 176,
        revenue_roas: 1.76,
        zero_value_bookings: 0,
      },
    })
    expect(result.units).toHaveLength(4)
    expect(result.units.find((row) => row.entity_level === 'account')).toMatchObject({
      entity_id: 'act_1', spend: 100, captured_touches: 2, bookings: 1,
      booked_value: 220, complete: true, blocker_codes: [],
    })
    expect(result.units.find((row) => row.entity_level === 'ad')).toMatchObject({ entity_id: '301' })
  })

  it.each([
    ['pre_activation_window', (input: PaidCohortBuildInput) => ({ ...input, activation: { id: ACTIVATION, activatedAt: '2026-07-01T12:00:00Z' } })],
    ['missing_account_insight_days', (input: PaidCohortBuildInput) => ({ ...input, insights: input.insights.filter((row) => !(row.entityLevel === 'account' && row.dateStart === '2026-07-02')) })],
    ['spend_reconciliation_failed', (input: PaidCohortBuildInput) => ({ ...input, insights: input.insights.map((row) => row.entityLevel === 'ad' ? { ...row, spend: 5 } : row) })],
    ['capture_coverage_mismatch', (input: PaidCohortBuildInput) => ({
      ...input,
      touches: input.touches.slice(0, 1),
      insights: input.insights.map((row) => (
        row.entityLevel === 'ad' ? { ...row, landingPageViews: 100 } : row
      )),
    })],
    ['appointment_state_missing', (input: PaidCohortBuildInput) => ({ ...input, appointments: [] })],
  ] as const)('persists %s instead of manufacturing a complete zero', (blocker, alter) => {
    const result = buildPaidCohortGeneration(alter(base()))
    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain(blocker)
  })

  it('does not block on over-capture: server capture legitimately exceeds Meta landing views', () => {
    // Meta's pixel-based LPV misses clicks our first-party server capture sees (ITP, blockers,
    // consent) and is restated for days after launch. Only UNDER-capture can manufacture a false
    // zero, so over-capture must pass. Ad 301 has 2 touches in the fixture; report 1 landing view.
    const input = base()
    const result = buildPaidCohortGeneration({
      ...input,
      insights: input.insights.map((row) => (
        row.entityLevel === 'ad' ? { ...row, landingPageViews: 1 } : row
      )),
    })
    expect(result.blocker_codes).not.toContain('capture_coverage_mismatch')
  })

  it('counts distinct clicks and surfaces duplicate observations', () => {
    // coverageMatches is one-sided, so over-capture no longer blocks. These metrics are the
    // replacement signal: two observations sharing an fbclid are ONE click seen twice, and the gap
    // is the duplicate rate. The capture endpoint has no dedup, so this is the only way a silently
    // inflating numerator becomes visible.
    const input = base()
    const dup = { ...input.touches[0], id: 't-dup', fbclid: input.touches[0].fbclid }
    const result = buildPaidCohortGeneration({ ...input, touches: [...input.touches, dup] })

    expect(result.metrics.captured_clicks).toBe(2)
    expect(result.captured_landing_views).toBe(3)
    expect(result.metrics.captured_duplicate_touches).toBe(1)
  })

  it('treats fbclid-less touches as their own click rather than collapsing them', () => {
    const input = base()
    const noFbclid = input.touches.map((t, i) => ({ ...t, id: `nf${i}`, fbclid: null }))
    const result = buildPaidCohortGeneration({ ...input, touches: noFbclid })

    expect(result.metrics.captured_clicks).toBe(noFbclid.length)
    expect(result.metrics.captured_duplicate_touches).toBe(0)
  })

  it('still blocks on material under-capture', () => {
    const input = base()
    const result = buildPaidCohortGeneration({
      ...input,
      touches: input.touches.slice(0, 1),
      insights: input.insights.map((row) => (
        row.entityLevel === 'ad' ? { ...row, landingPageViews: 100 } : row
      )),
    })
    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain('capture_coverage_mismatch')
  })

  it('does not demand a completeness manifest under the policy-v2 freeze', () => {
    // The v3 cutover is reverted (`paid_cohort_policy_cutovers`): capture_eligible_inputs has no honest producer, so
    // requiring the manifest blocked every generation forever. The mismatch checks below still
    // run whenever a manifest IS supplied, so v3 re-arms the moment policyVersion returns to 3.
    const result = buildPaidCohortGeneration(base({ completenessManifest: null }))
    expect(result.blocker_codes).not.toContain('paid_completeness_manifest_unavailable')
  })

  it.each([
    ['paid_completeness_manifest_mismatch', {
      completenessManifest: { ...base().completenessManifest!, evaluationRunId: GENERATION },
    }],
    ['paid_capture_source_incomplete', {
      completenessManifest: {
        ...base().completenessManifest!, captureComplete: false, captureEligibleInputs: 0,
        capturedTouches: 0, blockerCodes: ['capture_not_exhaustive'],
      },
      touches: [],
      insights: base().insights.map((row) => (
        row.entityLevel === 'ad' ? { ...row, landingPageViews: 0 } : row
      )),
    }],
    ['paid_linker_source_incomplete', {
      completenessManifest: {
        ...base().completenessManifest!, linkerComplete: false, evaluatedAppointments: 0,
        linkedAppointments: 0, blockerCodes: ['linker_not_exhaustive'],
      },
      links: [], appointments: [],
    }],
  ] as const)('withholds exact association when current-run proof has %s', (blocker, overrides) => {
    const result = buildPaidCohortGeneration(base(overrides as Partial<PaidCohortBuildInput>))
    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain(blocker)
  })

  it('rejects zero capture as exact even when a low-volume Meta surface also reports zero', () => {
    const result = buildPaidCohortGeneration(base({
      completenessManifest: {
        ...base().completenessManifest!, captureEligibleInputs: 0, capturedTouches: 0,
      },
      touches: [],
      links: [],
      appointments: [],
      insights: base().insights.map((row) => (
        row.entityLevel === 'ad' ? { ...row, landingPageViews: 0 } : row
      )),
    }))

    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain('paid_capture_source_incomplete')
    expect(result.metrics.outcome_recorded_revenue).toBe(0)
  })

  it('matches the exact source boundary by instant rather than timestamp serialization', () => {
    const result = buildPaidCohortGeneration(base({
      completenessManifest: {
        ...base().completenessManifest!,
        sourceNotBefore: '2026-07-03T05:00:00.000-04:00',
      },
    }))

    expect(result.complete).toBe(true)
  })

  it('requires the cut window itself to be matured and never borrows the recent window clock', () => {
    const result = buildPaidCohortGeneration(base({
      cohortKind: 'matured_cut',
      window: { start: '2026-07-01', end: '2026-07-15' },
      asOfDate: '2026-07-20',
      insights: [], touches: [], links: [], appointments: [],
    }))
    expect(result.blocker_codes).toContain('maturity_lag_not_met')
  })

  it.each([
    ['wrong source-window basis', { appointmentSourceWindowBasis: null }],
    ['missing source-window bounds', { appointmentSourceWindowStart: null }],
    ['source window starts too late', { appointmentSourceWindowStart: '2026-07-02' }],
    ['source window ends too early', { appointmentSourceWindowEnd: '2026-07-01' }],
  ])('fails closed when appointment coverage has %s', (_label, override) => {
    const result = buildPaidCohortGeneration(base(override))
    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain('appointment_source_unavailable')
  })

  it('blocks stale insight and appointment state instead of treating old rows as current evidence', () => {
    const staleInsights = buildPaidCohortGeneration(base({
      insights: base().insights.map((row) => ({ ...row, syncedAt: '2026-07-03T08:59:59Z' })),
    }))
    expect(staleInsights.blocker_codes).toContain('stale_insight_source')

    const staleAppointment = buildPaidCohortGeneration(base({
      appointments: [{ id: 7001, price: 220, amountPaid: 176, canceled: false, syncedAt: null }],
    }))
    expect(staleAppointment.blocker_codes).toContain('stale_appointment_state')

    const unavailableLedger = buildPaidCohortGeneration(base({
      appointmentSourceComplete: false,
      appointmentSourceHead: null,
    }))
    expect(unavailableLedger.blocker_codes).toContain('appointment_source_unavailable')
  })

  it('uses Acuity amountPaid after discount as revenue while keeping booked value separate', () => {
    const result = buildPaidCohortGeneration(base({
      appointments: [{
        id: 7001,
        price: 220,
        amountPaid: 154,
        canceled: false,
        syncedAt: '2026-07-03T10:00:00Z',
      }],
    }))

    expect(result.complete).toBe(true)
    expect(result.metrics.booked_value).toBe(220)
    expect(result.metrics.outcome_recorded_revenue).toBe(154)
    expect(result.metrics.revenue_roas).toBe(1.54)
  })

  it('blocks revenue conclusions when a linked value-bearing booking has no Acuity amountPaid', () => {
    const result = buildPaidCohortGeneration(base({
      appointments: [{
        id: 7001,
        price: 220,
        amountPaid: null,
        canceled: false,
        syncedAt: '2026-07-03T10:00:00Z',
      }],
    }))

    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain('invalid_appointment_revenue')
    expect(result.metrics.bookings).toBe(1)
    expect(result.metrics.booked_value).toBe(220)
    expect(result.metrics.outcome_recorded_revenue).toBe(0)
  })

  it('retains amountPaid on a linked zero-price appointment instead of manufacturing $0 revenue', () => {
    const result = buildPaidCohortGeneration(base({
      appointments: [{
        id: 7001,
        price: 0,
        amountPaid: 25,
        canceled: false,
        syncedAt: '2026-07-03T10:00:00Z',
      }],
    }))

    expect(result.complete).toBe(true)
    expect(result.metrics.zero_value_bookings).toBe(1)
    expect(result.metrics.outcome_recorded_revenue).toBe(25)
    expect(result.metrics.revenue_roas).toBe(0.25)
  })

  it('blocks a linked zero-price appointment whose amountPaid is missing', () => {
    const result = buildPaidCohortGeneration(base({
      appointments: [{
        id: 7001,
        price: 0,
        amountPaid: null,
        canceled: false,
        syncedAt: '2026-07-03T10:00:00Z',
      }],
    }))

    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain('invalid_appointment_revenue')
    expect(result.metrics.zero_value_bookings).toBe(1)
  })

  it('keeps a known-good campaign unit complete when a different campaign has a local capture gap', () => {
    const input = base()
    input.insights.push({
      dateStart: '2026-07-01', entityLevel: 'ad', metaCampaignId: '102', metaAdsetId: '202',
      metaAdId: '302', spend: 0, landingPageViews: 100, syncedAt: '2026-07-03T10:00:00Z',
    })
    const result = buildPaidCohortGeneration(input)
    expect(result.complete).toBe(false)
    expect(result.units.find((row) => row.entity_level === 'campaign' && row.entity_id === '101')?.complete).toBe(true)
    expect(result.units.find((row) => row.entity_level === 'campaign' && row.entity_id === '102')).toMatchObject({
      complete: false, blocker_codes: ['capture_coverage_mismatch'],
    })
  })

  it('blocks the account when any in-window touch has incomplete Meta identity', () => {
    const input = base({
      touches: [
        { id: 't1', observedAt: '2026-07-01T16:00:00Z', identityComplete: true, metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', fbclid: 'fbc-t1' },
        { id: 't2', observedAt: '2026-07-02T16:00:00Z', identityComplete: false, metaCampaignId: null, metaAdsetId: null, metaAdId: null, fbclid: 'fbc-t2' },
      ],
      insights: [
        { dateStart: '2026-07-01', entityLevel: 'account', spend: 50, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-02', entityLevel: 'account', spend: 50, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-01', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 50, landingPageViews: 1, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-02', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 50, landingPageViews: 0, syncedAt: '2026-07-03T10:00:00Z' },
      ],
    })
    const result = buildPaidCohortGeneration(input)
    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain('incomplete_touch_identity')
    expect(result.captured_landing_views).toBe(1)
  })

  it('never turns a paid booking on an incomplete-identity touch into a complete zero cohort', () => {
    const result = buildPaidCohortGeneration(base({
      touches: [
        {
          id: 't1', observedAt: '2026-07-01T16:00:00Z', identityComplete: false,
          metaCampaignId: null, metaAdsetId: null, metaAdId: null, fbclid: 'fbc-t1',
        },
      ],
      links: [{
        appointmentId: 7001,
        lastTouchId: 't1',
        lastInteractionAt: '2026-07-01T16:00:00Z',
        linkedAt: '2026-07-03T10:00:00Z',
      }],
      appointments: [{ id: 7001, price: 500, amountPaid: 500, canceled: false, syncedAt: '2026-07-03T10:00:00Z' }],
      insights: [
        { dateStart: '2026-07-01', entityLevel: 'account', spend: 50, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-02', entityLevel: 'account', spend: 50, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-01', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 50, landingPageViews: 0, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-02', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 50, landingPageViews: 0, syncedAt: '2026-07-03T10:00:00Z' },
      ],
    }))

    expect(result.complete).toBe(false)
    expect(result.blocker_codes).toContain('incomplete_touch_identity')
    expect(result.metrics.bookings).toBe(0)
    expect(result.metrics.booked_value).toBe(0)
  })

  it('uses the account timezone at day boundaries rather than slicing UTC timestamps', () => {
    const input = base({
      window: { start: '2026-07-01', end: '2026-07-01' },
      insights: [
        { dateStart: '2026-07-01', entityLevel: 'account', spend: 50, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-01', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 50, landingPageViews: 1, syncedAt: '2026-07-03T10:00:00Z' },
      ],
      touches: [{
        id: 'late-utc', observedAt: '2026-07-02T02:30:00Z', identityComplete: true,
        metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', fbclid: 'fbc-late-utc',
      }],
      links: [], appointments: [],
      completenessManifest: {
        ...base().completenessManifest!,
        windowEnd: '2026-07-01',
        captureEligibleInputs: 1,
        capturedTouches: 1,
        eligibleAppointments: 0,
        evaluatedAppointments: 0,
        linkedAppointments: 0,
      },
    })
    expect(buildPaidCohortGeneration(input).complete).toBe(true)
  })
})

// Money accumulated in floating point is stored as whole cents.
//
// NOT the cause of the cohort-publication outage, contrary to an earlier version of this comment. The drifted
// values parse fine: PostgREST hands these unconstrained `numeric` columns to the reader as JS
// numbers, and that branch of the money validator tolerates 1e-9 while the drift is ~1e-13. Stored
// generations and units that still hold drifted values are rejected by none of the real schemas. The
// outage was `metrics.revenue_roas` — a JSONB ratio that misses the nearest cent by 6e-4.
//
// This is hygiene, not a repair: money is whole cents, and a representation that survives only on a
// 1e-9 tolerance would fail outright under `numeric(14,2)` or if it ever arrived as a string.
// Rounding is exact recovery — every input is already whole cents (verified against production: 0 of
// 526 daily_insights.spend rows differ from their own 2dp rounding).
describe('money precision at the storage boundary', () => {
  const MONEY_CONTRACT = /^\d{1,14}(?:\.\d{1,2})?$/
  const isWholeCents = (n: number) => Number.isInteger(Math.round(n * 100)) && MONEY_CONTRACT.test(String(n))

  it('emits whole-cent money after accumulating values that drift in floating point', () => {
    // 0.1 + 0.2 is the canonical float artifact; ten of these sum to 2.9999999999999996 unrounded.
    const drifting = Array.from({ length: 10 }, (_, i) => ({
      dateStart: i % 2 === 0 ? '2026-07-01' : '2026-07-02',
      entityLevel: 'ad' as const,
      metaCampaignId: '101', metaAdsetId: '201', metaAdId: `30${i}`,
      spend: 0.1 + 0.2,
      landingPageViews: 0,
      syncedAt: '2026-07-03T10:00:00Z',
    }))
    const result = buildPaidCohortGeneration(base({
      insights: [
        { dateStart: '2026-07-01', entityLevel: 'account', spend: 1.5, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-02', entityLevel: 'account', spend: 1.5, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        ...drifting,
      ],
    }))

    expect(result.account_spend).not.toBeNull()
    expect(isWholeCents(result.account_spend as number)).toBe(true)
    expect(result.entity_spend === null || isWholeCents(result.entity_spend)).toBe(true)
    for (const unit of result.units) {
      if (unit.spend !== null) expect(isWholeCents(unit.spend)).toBe(true)
      expect(isWholeCents(unit.booked_value)).toBe(true)
    }
  })

  it('rounds to the true figure rather than approximating it', () => {
    // $10.10 + $20.20 sums to 30.299999999999997 in binary floating point. The true total is $30.30,
    // and that is what must be stored — the point is recovery of the exact figure, not tolerance.
    // (33.33 + 66.66 happens to be exact in float and would assert nothing, so it is not used here.)
    const result = buildPaidCohortGeneration(base({
      insights: [
        { dateStart: '2026-07-01', entityLevel: 'account', spend: 10.10, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-02', entityLevel: 'account', spend: 20.20, landingPageViews: null, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-01', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 10.10, landingPageViews: 1, syncedAt: '2026-07-03T10:00:00Z' },
        { dateStart: '2026-07-02', entityLevel: 'ad', metaCampaignId: '101', metaAdsetId: '201', metaAdId: '301', spend: 20.20, landingPageViews: 1, syncedAt: '2026-07-03T10:00:00Z' },
      ],
    }))
    expect(10.10 + 20.20).not.toBe(30.30)          // the drift this guards is real
    expect(result.account_spend).toBe(30.30)       // and the stored figure is the true one
    expect(result.entity_spend).toBe(30.30)
  })
})
