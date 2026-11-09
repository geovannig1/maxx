import { describe, expect, it } from 'vitest'
import { evaluateAcuityLedgerHealth, reconciliationCoversAcuityWindow as reconciliationCoversWindow } from '@/lib/outcomes/adapters/acuity/ledger-health'

const NOW = Date.parse('2026-08-16T12:00:00.000Z')

const fresh = {
  last_reconciled_at: '2026-08-16T06:00:00.000Z',
  window_basis: 'booking_date_et',
  window_start_date: '2026-05-18',
  window_end_date: '2028-02-17',
  truncated: false,
} as const

describe('Acuity ledger health authority', () => {
  it('requires the same reconciliation to cover a durable report or cohort window', () => {
    expect(reconciliationCoversWindow({
      available: true,
      completedAt: fresh.last_reconciled_at,
      sourceWindowBasis: fresh.window_basis,
      windowStartDate: fresh.window_start_date,
      windowEndDate: fresh.window_end_date,
      truncated: false,
    }, '2026-07-17', '2026-08-15')).toBe(true)
    expect(reconciliationCoversWindow({
      available: true,
      completedAt: fresh.last_reconciled_at,
      sourceWindowBasis: fresh.window_basis,
      windowStartDate: fresh.window_start_date,
      windowEndDate: '2026-08-01',
      truncated: false,
    }, '2026-07-17', '2026-08-15')).toBe(false)
  })

  it('authorizes only a fresh, non-truncated reconciliation covering the requested window', () => {
    expect(evaluateAcuityLedgerHealth(fresh, '2026-07-17', '2026-08-15', NOW)).toEqual({
      available: true,
      reason: null,
      lastReconciledAt: fresh.last_reconciled_at,
      windowBasis: fresh.window_basis,
      windowStartDate: fresh.window_start_date,
      windowEndDate: fresh.window_end_date,
      truncated: false,
    })
  })

  it.each([
    [null, 'outcome_ledger_health_missing'],
    [{ ...fresh, last_reconciled_at: 'not-a-date' }, 'outcome_ledger_health_invalid'],
    [{ ...fresh, last_reconciled_at: '2026-08-14T00:00:00.000Z' }, 'outcome_ledger_health_stale'],
    [{ ...fresh, truncated: true }, 'outcome_ledger_health_truncated'],
    [{ ...fresh, window_basis: 'appointment_date' }, 'outcome_booking_date_coverage_unproven'],
    [{ ...fresh, window_start_date: undefined }, 'outcome_ledger_health_window_unknown'],
    [{ ...fresh, window_end_date: '2026-08-01' }, 'outcome_ledger_window_not_covered'],
  ])('fails closed for %s', (value, reason) => {
    const result = evaluateAcuityLedgerHealth(value, '2026-07-17', '2026-08-15', NOW)
    expect(result.available).toBe(false)
    expect(result.reason).toContain(reason)
  })
})
