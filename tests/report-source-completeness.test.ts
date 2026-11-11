import { describe, expect, it } from 'vitest'
import type { OutcomeSourceRef } from '@/lib/outcomes/source-health'
import {
  collectedValueNote, outcomeArrivalLine, pushOnlyOutcomeArrival, reportMoneyCompleteness, reportOutcomeArrival, reportOutcomesReady,
  reportSourceCompleteness,
} from '@/lib/outcomes/report-gate'

// money_basis.revenue_complete measures collected-value coverage (every active outcome in the window
// has a recorded collected value), not whether the sources are complete. A push-only report can read it
// true, so reports now state source completeness explicitly (reconciled, as received/imported, or mixed)
// and never present push-only outcomes as complete. A mixed install (reconciled + push-only) records the
// arrival label for its push-only part, and still waits for its reconciliation.

const WEBHOOK: OutcomeSourceRef = { sourceId: 'src-webhook', kind: 'webhook' }
const CSV: OutcomeSourceRef = { sourceId: 'src-csv', kind: 'csv' }
const RECONCILED: OutcomeSourceRef = { sourceId: 'src-reconciled', kind: 'acuity' }
const WINDOW = { startDate: '2026-10-08', endDate: '2026-11-06' }
const W = { many: 'bookings' }

describe('source completeness on reports', () => {
  it('labels the push-only part of a mixed install and marks it mixed', () => {
    expect(reportOutcomeArrival([RECONCILED, WEBHOOK])).toEqual({
      sources: [{ source_id: 'src-webhook', kind: 'webhook', label: 'As received' }], mixed: true,
    })
    // The gate's push-only arrival stays null for a mixed install (control).
    expect(pushOnlyOutcomeArrival([RECONCILED, WEBHOOK])).toBeNull()
  })

  it('records a push-only install as before and a reconciled-only install as nothing (controls)', () => {
    expect(reportOutcomeArrival([CSV])).toEqual(pushOnlyOutcomeArrival([CSV]))
    expect(reportOutcomeArrival([RECONCILED])).toBeNull()
    expect(reportOutcomeArrival([])).toBeNull()
  })

  it('keeps the reconciliation gate for a mixed install', () => {
    const arrival = reportOutcomeArrival([RECONCILED, WEBHOOK])
    expect(reportOutcomesReady({ lifecycleRun: true, arrival, reconcile: { available: false, reason: 'x' }, ...WINDOW })).toBe(false)
    expect(reportOutcomesReady({ lifecycleRun: true, arrival: reportOutcomeArrival([WEBHOOK]), reconcile: null, ...WINDOW })).toBe(true)
  })

  it('names source completeness explicitly', () => {
    expect(reportSourceCompleteness(null)).toBe('reconciled')
    expect(reportSourceCompleteness(reportOutcomeArrival([WEBHOOK]))).toBe('as_received')
    expect(reportSourceCompleteness(reportOutcomeArrival([RECONCILED, CSV]))).toBe('mixed')
  })

  it('writes a mixed arrival line naming both parts', () => {
    const line = outcomeArrivalLine(reportOutcomeArrival([RECONCILED, CSV]))
    expect(line).toContain('Reconciled · As imported')
    expect(line).toMatch(/As imported part is counted as it arrived/)
  })

  it('never presents push-only collected value as complete, and keeps the reconciled note (control)', () => {
    const asReceived = collectedValueNote(W, 'as_received', reportOutcomeArrival([WEBHOOK]))
    expect(asReceived).toContain('As received')
    expect(asReceived).toMatch(/collected value recorded for every outcome counted/)
    expect(asReceived).not.toMatch(/\bcomplete\b/i)
    expect(collectedValueNote(W, 'mixed', reportOutcomeArrival([RECONCILED, WEBHOOK]))).toContain('Reconciled + As received')
    expect(collectedValueNote(W, 'reconciled', null)).toBe('active bookings only')
    expect(collectedValueNote(W, undefined, null)).toBe('active bookings only')
  })
})

describe('revenue_complete claims only what the sources can prove', () => {
  it('is false on an as-received or mixed report even with every collected value recorded', () => {
    for (const completeness of ['as_received', 'mixed'] as const) {
      expect(reportMoneyCompleteness({ sourceAvailable: true, collectedValueCovered: true, completeness }), completeness)
        .toEqual({ revenue_complete: false, collected_value_coverage_complete: true })
    }
  })

  it('is true only for reconciled sources with full coverage (controls)', () => {
    expect(reportMoneyCompleteness({ sourceAvailable: true, collectedValueCovered: true, completeness: 'reconciled' }))
      .toEqual({ revenue_complete: true, collected_value_coverage_complete: true })
    expect(reportMoneyCompleteness({ sourceAvailable: true, collectedValueCovered: false, completeness: 'reconciled' }))
      .toEqual({ revenue_complete: false, collected_value_coverage_complete: false })
    expect(reportMoneyCompleteness({ sourceAvailable: false, collectedValueCovered: true, completeness: 'reconciled' }))
      .toEqual({ revenue_complete: false, collected_value_coverage_complete: false })
  })
})

describe('reading a stored report', () => {
  it('reads the stated completeness and arrival, and treats older or malformed reports as unstated', async () => {
    const { readReportSourceCompleteness } = await import('@/lib/outcomes/report-gate')
    const arrival = reportOutcomeArrival([RECONCILED, WEBHOOK])
    expect(readReportSourceCompleteness({ money_basis: { source_completeness: 'mixed' }, outcome_arrival: arrival }))
      .toEqual({ completeness: 'mixed', arrival })
    expect(readReportSourceCompleteness({ money_basis: { revenue_complete: true } })).toEqual({ completeness: undefined, arrival: null })
    expect(readReportSourceCompleteness({ money_basis: { source_completeness: 'complete' }, outcome_arrival: { sources: [{ label: 1 }] } }))
      .toEqual({ completeness: undefined, arrival: null })
    expect(readReportSourceCompleteness(null)).toEqual({ completeness: undefined, arrival: null })
  })
})
