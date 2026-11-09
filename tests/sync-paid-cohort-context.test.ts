import { describe, expect, it } from 'vitest'
import type { SourceReconcileResult } from '@/lib/outcomes/reconciliation'
import { paidCohortPublicationContext } from '@/lib/sync/paid-cohort-stage'
import {
  INSIGHT_RESTATEMENT_LOOKBACK_DAYS,
  canPublishDecisionEvidence,
  canRunLiveDecisionPipeline,
} from '@/lib/sync/orchestrator'

const RUN = '00000000-0000-4000-8000-000000000901'
const START = '2026-07-30T10:00:00.000Z'
const COMPLETE = '2026-07-30T10:01:00.000Z'

describe('daily-sync paid cohort publication context', () => {
  it('refreshes the entire paid-cohort evidence horizon instead of only the attribution window', () => {
    expect(INSIGHT_RESTATEMENT_LOOKBACK_DAYS).toBe(30)
  })

  it('fails the live decision pipeline closed when any required insight level failed', () => {
    expect(canPublishDecisionEvidence(true, false)).toBe(false)
    expect(canRunLiveDecisionPipeline(true, false, true, true)).toBe(false)
    expect(canRunLiveDecisionPipeline(true, true, false, true)).toBe(false)
    expect(canRunLiveDecisionPipeline(true, true, true, false)).toBe(false)
    expect(canRunLiveDecisionPipeline(true, true, true, true)).toBe(true)
  })

  it('marks the appointment source complete only after a non-truncated reconciliation', () => {
    expect(paidCohortPublicationContext({
      evaluationRunId: RUN,
      asOfDate: '2026-07-30',
      sourceNotBefore: START,
      reconcile: {
        available: true, fetched: 10, upserted: 10, truncated: false, completedAt: COMPLETE,
        sourceWindowBasis: 'booking_date_et',
        windowStartDate: '2026-04-01', windowEndDate: '2027-12-31',
      },
    })).toEqual({
      evaluationRunId: RUN,
      asOfDate: '2026-07-30',
      sourceNotBefore: START,
      appointmentSourceComplete: true,
      appointmentSourceHead: COMPLETE,
      appointmentSourceWindowBasis: 'booking_date_et',
      appointmentSourceWindowStart: '2026-04-01',
      appointmentSourceWindowEnd: '2027-12-31',
    })
  })

  it.each<SourceReconcileResult>([
    { available: true, truncated: true, completedAt: COMPLETE },
    { available: true, truncated: false, completedAt: COMPLETE, sourceWindowBasis: 'appointment_date', windowStartDate: '2026-04-01', windowEndDate: '2027-12-31' },
    { available: true, truncated: false },
    { available: false, reason: 'not configured' },
  ])('fails source completeness closed for %j', (reconcile) => {
    const result = paidCohortPublicationContext({
      evaluationRunId: RUN,
      asOfDate: '2026-07-30',
      sourceNotBefore: START,
      reconcile,
    })
    expect(result.appointmentSourceComplete).toBe(false)
    expect(result.appointmentSourceHead).toBeNull()
    expect(result.appointmentSourceWindowBasis).toBeNull()
    expect(result.appointmentSourceWindowStart).toBeNull()
    expect(result.appointmentSourceWindowEnd).toBeNull()
  })
})
