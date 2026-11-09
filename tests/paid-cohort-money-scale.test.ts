import { afterEach, describe, expect, it } from 'vitest'
import { PAID_COHORT_DIAGNOSTIC_SCHEMAS } from '@/lib/attribution/paid-cohort-reader'
import { projectPaidCreativeOutcomes } from '@/lib/creative/paid-outcomes'
import type { PaidCohortEvaluationArtifact } from '@/lib/attribution/paid-cohort-store'

// Stored paid-cohort money is validated at the account currency's own minor unit: three decimals for
// KWD, two for USD, none for JPY. Anything finer, or anything not a plain decimal, still fails closed.

const CURRENCY_ENV = 'NEXT_PUBLIC_ACCOUNT_CURRENCY'
const saved = process.env[CURRENCY_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[CURRENCY_ENV]
  else process.env[CURRENCY_ENV] = saved
})

const { unit } = PAID_COHORT_DIAGNOSTIC_SCHEMAS
const unitRow = (spend: unknown) => ({
  id: '00000000-0000-4000-8000-0000000009b1',
  generation_id: '00000000-0000-4000-8000-0000000009b2',
  entity_level: 'ad', entity_id: '301',
  spend,
  landing_page_views: 1, captured_touches: 1, bookings: 1, booked_value: 150,
  complete: true, blocker_codes: [],
  metrics: { zero_value_bookings: 0, canceled_links: 0 },
})
const spendOf = (value: unknown) => {
  const parsed = unit.safeParse(unitRow(value))
  return parsed.success ? (parsed.data as { spend: number }).spend : 'rejected'
}

const MALFORMED = ['1e3', '-1', '1.', '.5', '1,5', ' 1.5', 'abc', '', '0x10', '512.4000000000001']

describe('paid cohort money at the account currency scale', () => {
  it('KWD: three-decimal money is accepted, from a stored string and from a number', () => {
    process.env[CURRENCY_ENV] = 'KWD'
    expect(spendOf('512.499')).toBe(512.499)
    expect(spendOf('12.5')).toBe(12.5)
    expect(spendOf(1.235)).toBe(1.235)
  })

  it('KWD: finer than fils, or malformed, is still rejected', () => {
    process.env[CURRENCY_ENV] = 'KWD'
    expect(spendOf('512.4991')).toBe('rejected')
    expect(spendOf(1.2345)).toBe('rejected')
    for (const bad of MALFORMED) expect(spendOf(bad), bad).toBe('rejected')
  })

  it('USD control: the two-decimal contract is unchanged', () => {
    process.env[CURRENCY_ENV] = 'USD'
    expect(spendOf('512.49')).toBe(512.49)
    expect(spendOf('512.499')).toBe('rejected')
    expect(spendOf(1.235)).toBe('rejected')
    for (const bad of MALFORMED) expect(spendOf(bad), bad).toBe('rejected')
  })

  it('JPY: whole yen only', () => {
    process.env[CURRENCY_ENV] = 'JPY'
    expect(spendOf('1234')).toBe(1234)
    expect(spendOf(1234)).toBe(1234)
    expect(spendOf('1234.5')).toBe('rejected')
    expect(spendOf(1234.5)).toBe('rejected')
  })
})

describe('paid creative projection money at the account currency scale', () => {
  const RECENT = '00000000-0000-4000-8000-000000000002'
  const MATURED = '00000000-0000-4000-8000-000000000003'
  const adUnit = (generationId: string, metaAdId: string, spend: number) => ({
    id: `00000000-0000-4000-8000-${metaAdId.padStart(12, '0')}`, generationId, metaAdId,
    spend, landingPageViews: 2, capturedTouches: 1, bookings: 1, bookedValue: 100,
    complete: true, blockerCodes: [], zeroValueBookings: 0, canceledLinks: 0,
  })
  const generation = (generationId: string, cohortKind: string) => ({
    generationId, cohortKind, windowStart: '2026-07-16', windowEnd: '2026-07-29', asOfDate: '2026-07-30',
    activationId: '00000000-0000-4000-8000-000000000004', contractVersion: 1, policyVersion: 1, complete: true, blockerCodes: [],
  })
  const artifact = (spends: number[]) => ({
    evaluationRunId: '00000000-0000-4000-8000-000000000001',
    recentScale: { generation: generation(RECENT, 'recent_scale'), adUnits: spends.map((spend, index) => adUnit(RECENT, String(101 + index), spend)) },
    maturedCut: { generation: generation(MATURED, 'matured_cut'), adUnits: [adUnit(MATURED, '201', 10)] },
  }) as unknown as PaidCohortEvaluationArtifact
  const stable = (metaCreativeId: string, first: string) => ({
    state: 'observed_stable' as const, metaCreativeId, boundaryObservationIds: [first, `${first}-b`] as [string, string],
  })
  const project = (spends: number[]) => projectPaidCreativeOutcomes(
    artifact(spends),
    {
      recent_scale: new Map(spends.map((_, index) => [String(101 + index), stable('501', `r${index}`)])),
      matured_cut: new Map([['201', stable('601', 'm')]]),
    },
    new Map(),
  )

  it('KWD: fils are summed exactly; finer than fils is refused', () => {
    process.env[CURRENCY_ENV] = 'KWD'
    expect(() => project([0.001, 0.002])).not.toThrow()
    expect(() => project([0.0001])).toThrowError(expect.objectContaining({ code: 'MONETARY_SCALE_INVALID' }))
  })

  it('USD control: a third decimal is refused', () => {
    process.env[CURRENCY_ENV] = 'USD'
    expect(() => project([0.001])).toThrowError(expect.objectContaining({ code: 'MONETARY_SCALE_INVALID' }))
  })
})
