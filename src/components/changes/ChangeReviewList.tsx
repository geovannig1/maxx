'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ChangeApprovalCard, type CardControl, type ChangeCard, type WriteModeState } from './ChangeApprovalCard'

export type ChangeRequest = ChangeCard

// Map the server's returned status to a plain-English result the operator can trust. Two safety
// properties: a recorded-but-not-executed approval must NEVER read the same as a live execution, and an
// execution FAILURE must never fall through to a success message — every status is handled, and the
// unknown default is treated as a failure. Exported for tests.
export function resultMessage(action: 'approve' | 'reject', status: string | undefined): { text: string; ok: boolean } {
  if (action === 'reject') return { text: 'Change rejected.', ok: true }
  switch (status) {
    case 'approved':
      return { text: 'Approved — writes are off; turn on WRITE_MODE_ENABLED to apply. Not executed: it stays listed so you can apply it later.', ok: true }
    case 'WRITE_MODE_DISABLED':
      return { text: 'Approved & recorded — NOT executed live (write mode is OFF on the server).', ok: true }
    case 'DEMO_SIMULATED':
      return { text: 'Demo: simulated — approved and applied to the sample data; nothing was sent to Meta.', ok: true }
    case 'EXECUTED_VERIFIED':
      return { text: 'Approved & executed live — verified.', ok: true }
    case 'EXECUTED_UNVERIFIED':
      return { text: 'Executed live — but the result could not be verified. Check the action log.', ok: false }
    case 'ALREADY_EXECUTED':
      return { text: 'Already executed previously — no second change was made.', ok: true }
    case 'IN_PROGRESS':
      return { text: 'Another execution already claimed this change — check the action log before retrying.', ok: false }
    case 'PREVIOUSLY_FAILED':
      return { text: 'A prior execution of this change failed — not retried automatically. Check the action log.', ok: false }
    case 'NOT_APPROVED':
      return { text: 'Not executed — the change is not in the approved state. Refresh and retry.', ok: false }
    case 'AUTHORITY_REQUIRED':
      return { text: 'Blocked — this request has no valid current execution-eligible ActionDecision lineage.', ok: false }
    case 'EXPIRED':
      return { text: 'Not executed — this approval expired. Create and approve a fresh request.', ok: false }
    case 'OWNERSHIP_UNVERIFIED':
    case 'OWNERSHIP_MISMATCH':
      return { text: 'Not executed — target ownership could not be proven for this account. Create a fresh request after resolving ownership.', ok: false }
    case 'PRECONDITION_UNAVAILABLE':
      return { text: 'Not executed — Meta state could not be re-read safely. Create and approve a fresh request after reads recover.', ok: false }
    case 'STALE_APPROVAL':
      return { text: 'Not executed — Meta changed after approval. Review the current state and approve a fresh request.', ok: false }
    case 'CURRENCY_MISMATCH':
      return { text: 'Not executed — the ad account currency does not match the configured currency.', ok: false }
    case 'AUDIT_INCOMPLETE':
      return { text: 'Live call finished but the audit records could NOT be finalized — do NOT retry; repair the action log first.', ok: false }
    case 'FAILED':
      return { text: 'Live execution FAILED. Check the action log.', ok: false }
    case 'CREATED_PAUSED':
      return { text: 'Created in Meta and verified: every object is PAUSED. Turn it on in Ads Manager when ready.', ok: true }
    case 'CREATED_UNVERIFIED':
      return { text: 'Created PAUSED, but some objects did not read back as planned. Check them in Ads Manager.', ok: false }
    case 'PARTIAL_FAILURE':
      return { text: 'Creation stopped part-way: what exists is PAUSED. Resume to create the rest, or roll back.', ok: false }
    case 'ARCHIVED':
      return { text: 'Rolled back: the created objects were archived.', ok: true }
    case 'REVALIDATION_FAILED':
      return { text: 'Not created: the plan no longer validates against the account. Fix it and submit a new version.', ok: false }
    case 'INTEGRITY_MISMATCH':
      return { text: 'Not created: the plan does not match what was approved.', ok: false }
    case 'ACCOUNT_WRITE_IN_PROGRESS':
      return { text: 'Another change on this ad account is running. Try again when it finishes.', ok: false }
    case 'RECOVERED':
      return { text: 'Recovered: the stuck run is recorded as outcome unknown, with what Meta shows now. The account is free for other changes.', ok: true }
    case 'NOT_STALE':
      return { text: 'Not recovered: the run started recently and may still be working. Wait, then reload.', ok: false }
    case 'NOT_STUCK':
      return { text: 'Nothing to recover: no run of this change is in progress.', ok: false }
    default:
      return { text: `Unexpected result (${status ?? 'no status'}) — check the action log before retrying.`, ok: false }
  }
}

/** Statuses after which the change request is terminally executed server-side. */
const TERMINAL_EXECUTED = new Set(['EXECUTED_VERIFIED', 'EXECUTED_UNVERIFIED', 'ALREADY_EXECUTED', 'DEMO_SIMULATED', 'CREATED_PAUSED', 'CREATED_UNVERIFIED', 'ARCHIVED'])

function messageFor(control: CardControl, response: { ok: boolean; body: Record<string, unknown> }): { text: string; ok: boolean } {
  const status = typeof response.body.status === 'string' ? response.body.status : undefined
  if (control === 'rollback') {
    return response.ok
      ? { text: 'Rollback proposed. It is listed above for your approval.', ok: true }
      : { text: typeof response.body.message === 'string' ? response.body.message : 'The rollback could not be proposed.', ok: false }
  }
  if (control === 'reject') return response.ok ? resultMessage('reject', status) : { text: 'The rejection could not be recorded.', ok: false }
  if (status === 'EXPIRED' && typeof response.body.error === 'string') return { text: response.body.error, ok: false }
  return resultMessage('approve', status)
}

export function ChangeReviewList({
  initial,
  applied = [],
  writeMode,
}: {
  initial: ChangeCard[]
  applied?: ChangeCard[]
  writeMode: WriteModeState
}) {
  const router = useRouter()
  const [items, setItems] = useState(initial)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  function onResult(change: ChangeCard, control: CardControl, response: { ok: boolean; body: Record<string, unknown> }) {
    const status = typeof response.body.status === 'string' ? response.body.status : undefined
    setNotice(messageFor(control, response))
    if (control === 'reject' && response.ok) setItems((prev) => prev.filter((item) => item.id !== change.id))
    else if (status && TERMINAL_EXECUTED.has(status)) setItems((prev) => prev.filter((item) => item.id !== change.id))
    else if (status === 'approved') setItems((prev) => prev.map((item) => (item.id === change.id ? { ...item, status: 'approved' } : item)))
    router.refresh()
  }

  return (
    <div className="space-y-3">
      {notice && <Notice {...notice} />}
      {items.length === 0
        ? <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', padding: '12px 0' }}>No changes waiting for review.</p>
        : items.map((change) => <ChangeApprovalCard key={change.id} change={change} writeMode={writeMode} onResult={onResult} />)}
      {applied.length > 0 && (
        <section className="space-y-3 pt-4" aria-label="Recently applied changes">
          <h2 className="section-label">Recently applied</h2>
          {applied.map((change) => <ChangeApprovalCard key={change.id} change={change} writeMode={writeMode} onResult={onResult} />)}
        </section>
      )}
    </div>
  )
}

function Notice({ text, ok }: { text: string; ok: boolean }) {
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
        background: ok ? 'var(--success-bg)' : 'var(--danger-bg)',
        border: `1px solid ${ok ? 'var(--success-border)' : 'var(--danger-border)'}`,
        color: ok ? 'var(--success)' : 'var(--danger)',
      }}
    >
      {ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {text}
    </div>
  )
}
