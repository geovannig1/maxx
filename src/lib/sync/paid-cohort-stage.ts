import type { SourceReconcileResult } from '@/lib/outcomes/reconciliation'
import type { PaidCohortPublicationContext } from '@/lib/attribution/paid-cohort-store'

/** PURE: translate reconciliation liveness into the immutable cohort publication boundary. */
export function paidCohortPublicationContext(input: {
  evaluationRunId: string
  asOfDate: string
  sourceNotBefore: string
  reconcile: SourceReconcileResult
}): PaidCohortPublicationContext {
  const complete = input.reconcile.available === true
    && input.reconcile.truncated === false
    && typeof input.reconcile.completedAt === 'string'
    && input.reconcile.sourceWindowBasis === 'booking_date_et'
    && typeof input.reconcile.windowStartDate === 'string'
    && typeof input.reconcile.windowEndDate === 'string'
  return {
    evaluationRunId: input.evaluationRunId,
    asOfDate: input.asOfDate,
    sourceNotBefore: input.sourceNotBefore,
    appointmentSourceComplete: complete,
    appointmentSourceHead: complete ? input.reconcile.completedAt! : null,
    appointmentSourceWindowBasis: complete ? 'booking_date_et' : null,
    appointmentSourceWindowStart: complete ? input.reconcile.windowStartDate ?? null : null,
    appointmentSourceWindowEnd: complete ? input.reconcile.windowEndDate ?? null : null,
  }
}
