'use client'

import { useState } from 'react'
import type { RecommendationDecision as Decision, UserDecision } from '@/lib/recommendations/decisions'

// Explicit decision control on a recommendation card (closed-loop). Records the human's INTENT —
// accepted / rejected / acted-on / snoozed / needs-more-data. It executes NOTHING: "Accept" ≠ execute,
// and the API returns action_allowed_now:false / write_mode:off. "Acted on" means the human acted
// outside Maxx (or via an approved workflow), which is what makes the later outcome review-eligible.

const OPTIONS: { key: UserDecision; label: string; color: string }[] = [
  { key: 'accepted', label: 'Accept', color: 'var(--success)' },
  { key: 'acted_on', label: 'Mark acted on', color: 'var(--accent)' },
  { key: 'snoozed', label: 'Snooze', color: 'var(--warning)' },
  { key: 'needs_more_data', label: 'Needs more data', color: 'var(--text-secondary)' },
  { key: 'rejected', label: 'Reject', color: 'var(--danger)' },
]
const LABEL: Record<UserDecision, string> = {
  accepted: 'Accepted', rejected: 'Rejected', acted_on: 'Acted on', ignored: 'Ignored', snoozed: 'Snoozed', needs_more_data: 'Needs more data',
}

export function RecommendationDecision({ recId, current, authorityTier }: {
  recId: string
  current: Decision | null
  authorityTier: 'execution_eligible' | 'owner_review' | 'diagnostic_only'
}) {
  const [decision, setDecision] = useState<Decision | null>(current)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<UserDecision | null>(null)

  async function decide(user_decision: UserDecision) {
    setBusy(user_decision)
    try {
      const res = await fetch(`/api/recommendations/${recId}/decision`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_decision, decision_note: note || undefined }),
      })
      if (res.ok) {
        const j = await res.json()
        setDecision({
          user_decision,
          decision_note: note || null,
          decided_by: null,
          decision_date: j?.data?.decision_date ?? new Date().toISOString(),
          action_taken: !!j?.data?.action_taken,
          action_taken_date: null,
          follow_up_date: null,
          expected_outcome_window: null,
          learning_eligibility: null,
        })
        setNote('')
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ marginTop: '10px', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-tertiary)' }}>Your decision:</span>
        {OPTIONS.map((d) => (
          <button
            key={d.key}
            onClick={() => decide(d.key)}
            disabled={busy !== null || (d.key === 'acted_on' && authorityTier === 'diagnostic_only')}
            title={d.key === 'acted_on' && authorityTier === 'diagnostic_only'
              ? 'A diagnostic observation cannot be confirmed as an action.'
              : undefined}
            style={{
              fontSize: '11px', fontWeight: 600, padding: '3px 9px', borderRadius: '6px', cursor: 'pointer',
              color: d.color,
              background: decision?.user_decision === d.key ? `${d.color}33` : `${d.color}12`,
              border: `1px solid ${d.color}${decision?.user_decision === d.key ? 'aa' : '44'}`,
            }}
          >
            {d.label}
          </button>
        ))}
      </div>
      {authorityTier === 'diagnostic_only' && (
        <p style={{ fontSize: '10.5px', color: 'var(--text-tertiary)', marginTop: '5px' }}>
          Diagnostic only: you can accept/reject the observation, but cannot mark it acted on.
        </p>
      )}
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note (recommended when rejecting)"
        style={{
          marginTop: '6px', width: '100%', fontSize: '11.5px', padding: '5px 8px', borderRadius: '6px',
          background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)',
        }}
      />
      {decision && (
        <p style={{ fontSize: '10.5px', color: 'var(--text-tertiary)', marginTop: '5px' }}>
          Recorded: <b>{LABEL[decision.user_decision]}</b>{decision.action_taken ? ' · action taken' : ''}{decision.decision_note ? ` · “${decision.decision_note}”` : ''}. This records intent only; recording a decision changes nothing in Meta.
        </p>
      )}
    </div>
  )
}
