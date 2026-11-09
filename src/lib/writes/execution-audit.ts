import 'server-only'
import * as Sentry from '@sentry/nextjs'
import type { getAdminClient } from '@/lib/supabase/admin'
import { emitAlert } from '@/lib/monitoring/alerts'

// The ADR-059 executor's audit outcomes that never reached Meta, or whose records could not be
// reconciled: AUDIT_INCOMPLETE and a precondition refusal after the claim. Split out of executor.ts with
// no behavior change.

/** Emit the standard AUDIT_INCOMPLETE alert + Sentry and return the typed result. Shared by the
 *  ALREADY_EXECUTED repair path so a recovery that cannot confirm the change-request repair
 *  surfaces loudly instead of reading as clean success. */
export function auditIncomplete(changeRequestId: string, detail: string): object {
  emitAlert({
    area: 'write_attempt',
    severity: 'critical',
    message: `WRITE AUDIT INCOMPLETE — change_request ${changeRequestId} repair could not be confirmed (${detail}). Fix the rows manually before retrying.`,
    dedupeKey: `audit-incomplete:${changeRequestId}`,
  })
  Sentry.captureMessage(`[WRITE] AUDIT INCOMPLETE (recovery) ${changeRequestId}: ${detail}`, 'error')
  return {
    status: 'AUDIT_INCOMPLETE',
    change_request_id: changeRequestId,
    // The database detail goes to the alert and Sentry above, never into the response body.
    finalize_error: 'AUDIT_FINALIZE_FAILED',
    message: 'The prior execution could not be reconciled — do NOT retry until the rows are repaired.',
  }
}

type LivePreconditionFailure = 'PRECONDITION_UNAVAILABLE' | 'OWNERSHIP_MISMATCH' | 'STALE_APPROVAL'

/**
 * Finalize an owned claim when the last-moment read proves the approved mutation is no longer safe.
 * No Meta mutation has happened. Both records become non-executable so a new snapshot, decision and
 * owner approval are required; a failure to record that fact is itself an audit emergency.
 */
export async function finalizePreconditionFailure(
  db: ReturnType<typeof getAdminClient>,
  input: {
    status: LivePreconditionFailure
    reason: string
    claimId: string
    changeRequestId: string
    adAccountId: string
    currentState: Record<string, unknown> | null
  },
): Promise<object> {
  const result = {
    mutation_applied: false,
    precondition_status: input.status,
    reason: input.reason,
  }
  const { data: logRows, error: logError } = await db
    .from('action_log')
    .update({
      result,
      after_state: input.currentState,
      status: 'failed',
      error: input.reason,
      verified: false,
    })
    .eq('id', input.claimId)
    .eq('ad_account_id', input.adAccountId)
    .select('id')
  const { data: requestRows, error: requestError } = await db
    .from('change_requests')
    .update({ status: 'failed', result, after_state: input.currentState })
    .eq('id', input.changeRequestId)
    .eq('ad_account_id', input.adAccountId)
    .eq('status', 'approved')
    .select('id')

  const logMissing = !Array.isArray(logRows) || logRows.length !== 1
  const requestMissing = !Array.isArray(requestRows) || requestRows.length !== 1
  if (logError || requestError || logMissing || requestMissing) {
    const detail = [
      logError && `action_log ${input.claimId}: ${logError.message}`,
      requestError && `change_request ${input.changeRequestId}: ${requestError.message}`,
      !logError && logMissing && `action_log ${input.claimId}: expected one finalized row`,
      !requestError && requestMissing && `change_request ${input.changeRequestId}: expected one finalized row`,
    ].filter(Boolean).join('; ')
    emitAlert({
      area: 'write_attempt',
      severity: 'critical',
      message: `WRITE PRECONDITION AUDIT INCOMPLETE — no Meta mutation was attempted for change_request ${input.changeRequestId}, but its blocked claim could not be finalized (${detail}). Repair the audit rows before any retry.`,
      dedupeKey: `precondition-audit-incomplete:${input.changeRequestId}`,
    })
    Sentry.captureMessage(`[WRITE] PRECONDITION AUDIT INCOMPLETE ${input.changeRequestId}: ${detail}`, 'error')
    return {
      status: 'AUDIT_INCOMPLETE',
      change_request_id: input.changeRequestId,
      applied: false,
      finalize_error: 'AUDIT_FINALIZE_FAILED',
      message: 'No Meta mutation was attempted, but the blocked execution could not be finalized. Repair the audit rows before retrying.',
    }
  }

  return {
    status: input.status,
    change_request_id: input.changeRequestId,
    applied: false,
    message: `${input.reason} No Meta mutation was attempted. Create a fresh decision and obtain a new owner approval.`,
  }
}
