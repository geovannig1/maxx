'use client'

import { useState } from 'react'
import { outcomeLearningLabel, type LearningTone } from '@/lib/recommendations/learning-status'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

// Outcome REVIEW workflow. Shows each scored recommendation outcome with its classification +
// why, and lets the owner APPROVE / REJECT it as a trusted learning. Only approved, decisive,
// non-estimate outcomes feed win-rates + the track record — so Maxx never silently learns. Read-only to
// live campaigns; write mode stays OFF. This only governs what Maxx may learn from.

export interface OutcomeReviewItem {
  id: string
  flag_type: string | null
  audience_type: string | null
  meta_entity_id: string | null
  recommendation: string | null
  outcome: string | null
  outcome_note: string | null
  review_status: string | null
  estimate_only: boolean | null
  metric_name: string | null
  category: string | null
  confidence: string | null
  active_days: number | null
  baseline_value: number | null
  observed_value: number | null
  recommended_on: string | null
}

const TONE_COLOR: Record<LearningTone, string> = {
  good: 'var(--success)', warn: 'var(--warning)', info: 'var(--accent)', neutral: 'var(--text-tertiary)',
}

function Chip({ text, color, title }: { text: string; color: string; title?: string }) {
  return (
    <span title={title} style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', padding: '2px 8px', borderRadius: '6px', color, background: `${color}1f`, border: `1px solid ${color}55` }}>
      {text}
    </span>
  )
}

export function OutcomeReviewList({ outcomes }: { outcomes: OutcomeReviewItem[] }) {
  const [items, setItems] = useState(outcomes)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  async function review(id: string, review_status: 'approved' | 'rejected' | 'inconclusive' | 'pending') {
    setBusyId(id)
    try {
      const res = await fetch(`/api/outcomes/${id}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_status, reviewed_note: notes[id] || undefined }),
      })
      if (res.ok) {
        setItems((prev) => prev.map((o) => (o.id === id ? { ...o, review_status } : o)))
      }
    } finally {
      setBusyId(null)
    }
  }

  if (items.length === 0) return null

  return (
    <div className="space-y-2">
      {items.map((o) => {
        const status = outcomeLearningLabel(o)
        const decisive = o.outcome === 'worked' || o.outcome === 'failed'
        // Only decisive, non-estimate outcomes can become a trusted learning.
        const learnable = decisive && !o.estimate_only && isCausalContributionMetric(o.metric_name)
        const approved = o.review_status === 'approved'
        const rejected = o.review_status === 'rejected'
        const inconclusiveReview = o.review_status === 'inconclusive'
        return (
          <div key={o.id} className="card-base p-4">
            <div className="flex items-start justify-between gap-3">
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {o.flag_type ?? 'recommendation'}{o.audience_type ? ` · ${o.audience_type}` : ''}{o.meta_entity_id ? ` · …${o.meta_entity_id.slice(-4)}` : ''}
                </p>
                {o.recommendation && <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>{o.recommendation}</p>}
                {o.outcome_note && <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '3px' }}>Why: {o.outcome_note}</p>}
              </div>
              <Chip text={status.label} color={TONE_COLOR[status.tone]} title={status.tooltip} />
            </div>

            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '8px', fontSize: '11.5px', color: 'var(--text-tertiary)' }}>
              {o.baseline_value != null && o.observed_value != null && <span>CPA {Number(o.baseline_value).toFixed(0)} → {Number(o.observed_value).toFixed(0)}</span>}
              {o.category && <span>{o.category}</span>}
              {o.confidence && <span>confidence: {o.confidence}</span>}
              {o.active_days != null && <span>{o.active_days} active day{o.active_days === 1 ? '' : 's'}</span>}
              {o.estimate_only && <span style={{ color: 'var(--warning)' }}>estimate-only</span>}
              {o.recommended_on && <span>recommended {o.recommended_on}</span>}
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' }}>
              {!learnable ? (
                <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>
                  Not a trusted-learning candidate — {!isCausalContributionMetric(o.metric_name) ? 'not measured as causal incremental contribution' : o.estimate_only ? 'attribution too low (estimate-only)' : 'inconclusive'}.
                </span>
              ) : approved ? (
                <>
                  <span style={{ fontSize: '11.5px', color: 'var(--success)', fontWeight: 600 }}>✓ Approved as a learning</span>
                  <button onClick={() => review(o.id, 'pending')} disabled={busyId === o.id} style={btn('var(--text-tertiary)')}>Undo</button>
                </>
              ) : rejected ? (
                <>
                  <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', fontWeight: 600 }}>Rejected — not learned</span>
                  <button onClick={() => review(o.id, 'pending')} disabled={busyId === o.id} style={btn('var(--text-tertiary)')}>Undo</button>
                </>
              ) : inconclusiveReview ? (
                <>
                  <span style={{ fontSize: '11.5px', color: 'var(--warning)', fontWeight: 600 }}>Marked inconclusive — not learned</span>
                  <button onClick={() => review(o.id, 'pending')} disabled={busyId === o.id} style={btn('var(--text-tertiary)')}>Undo</button>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
                  <input
                    value={notes[o.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [o.id]: e.target.value }))}
                    placeholder="Optional reviewer note (recommended when rejecting)"
                    style={{ fontSize: '11.5px', padding: '5px 8px', borderRadius: '6px', background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)', maxWidth: '440px' }}
                  />
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button onClick={() => review(o.id, 'approved')} disabled={busyId === o.id} style={btn('var(--success)')}>Approve as learning</button>
                    <button onClick={() => review(o.id, 'inconclusive')} disabled={busyId === o.id} style={btn('var(--warning)')}>Mark inconclusive</button>
                    <button onClick={() => review(o.id, 'rejected')} disabled={busyId === o.id} style={btn('var(--danger)')}>Reject</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function btn(color: string): React.CSSProperties {
  return {
    fontSize: '11.5px', fontWeight: 600, padding: '4px 10px', borderRadius: '6px',
    color, background: `${color}1a`, border: `1px solid ${color}55`, cursor: 'pointer',
  }
}
