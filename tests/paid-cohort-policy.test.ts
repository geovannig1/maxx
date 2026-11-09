import { describe, expect, it } from 'vitest'
import {
  PAID_COHORT_POLICY,
  PAID_MEASUREMENT_ACTIVATION_POLICY,
  resolvePaidCohortWindows,
  resolvePaidCohortWindowsFromActivation,
} from '@/lib/attribution/paid-cohort-policy'

describe('paid cohort policy v2 (v3 frozen — paid_cohort_policy_cutovers)', () => {
  it('uses adjacent, non-overlapping 14-day windows and a 14-day provisional cut lag', () => {
    expect(resolvePaidCohortWindows('2026-07-30')).toEqual({
      recentScale: { start: '2026-07-16', end: '2026-07-29' },
      maturedCut: { start: '2026-07-02', end: '2026-07-15' },
    })
    expect(PAID_COHORT_POLICY).toMatchObject({
      contractVersion: 1,
      policyVersion: 2,
      recentScaleDays: 14,
      maturedCutDays: 14,
      maturityLagDays: 14,
      maturityBasis: 'provisional_owner_approved_assumption',
    })
    expect(PAID_MEASUREMENT_ACTIVATION_POLICY).toEqual({
      contractVersion: 1,
      policyVersion: 1,
    })
  })

  it('keeps inclusive day counts correct across month and leap-day boundaries', () => {
    expect(resolvePaidCohortWindows('2024-03-10')).toEqual({
      recentScale: { start: '2024-02-25', end: '2024-03-09' },
      maturedCut: { start: '2024-02-11', end: '2024-02-24' },
    })
  })

  it.each(['', '2026-7-30', '2026-02-30', 'tomorrow'])(
    'rejects an invalid as-of date: %s',
    (value) => expect(() => resolvePaidCohortWindows(value)).toThrow(/as-of date/i),
  )

  it('trims the recent scale window to the first full day after activation when activation is inside the window', () => {
    const asOf = '2026-08-15'
    const base = resolvePaidCohortWindows(asOf)
    expect(base.recentScale).toEqual({ start: '2026-08-01', end: '2026-08-14' })

    const trimmed = resolvePaidCohortWindowsFromActivation(asOf, '2026-08-03')
    expect(trimmed.recentScale).toEqual({ start: '2026-08-04', end: '2026-08-14' })
    expect(trimmed.maturedCut).toEqual(base.maturedCut)
  })

  it('leaves windows unchanged when activation is before the computed recent window', () => {
    const asOf = '2026-08-15'
    const base = resolvePaidCohortWindows(asOf)
    expect(resolvePaidCohortWindowsFromActivation(asOf, '2026-07-20')).toEqual(base)
  })

  it('leaves windows unchanged when no activation is supplied', () => {
    const asOf = '2026-08-15'
    const base = resolvePaidCohortWindows(asOf)
    expect(resolvePaidCohortWindowsFromActivation(asOf, null)).toEqual(base)
    expect(resolvePaidCohortWindowsFromActivation(asOf, undefined)).toEqual(base)
  })
})
