'use client'

import { useState } from 'react'
import { SETTING_LABELS } from '@/lib/recommendations/manifest'
import { READ_ONLY_APPLY_NOTE } from '@/lib/ui/proposal'

// Manual action capture (Ad Decision Ledger). Write mode is OFF, so real changes happen
// manually in Meta Ads Manager — this form RECORDS what the human did ("I launched this", "I changed the
// budget", "I changed the attribution window") so the ledger stays the source of truth. It logs intent
// + fact only; no Meta call is ever made. If the logged value contradicts a prior recorded decision, the
// API returns a conflict flag and it surfaces on the conflict banner for explicit resolution.

const ENTITY_TYPES = ['campaign', 'adset', 'ad', 'account'] as const

const inputStyle: React.CSSProperties = {
  width: '100%', fontSize: '12px', padding: '6px 9px', borderRadius: '6px',
  background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)',
}
const labelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: 'var(--text-tertiary)', display: 'block', marginBottom: '4px',
}

export function ManualActionForm() {
  const [entityType, setEntityType] = useState<string>('campaign')
  const [entityName, setEntityName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [category, setCategory] = useState<string>('budget')
  const [previousValue, setPreviousValue] = useState('')
  const [newValue, setNewValue] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit() {
    if (!newValue.trim()) {
      setResult({ ok: false, text: 'Enter the value you changed it to (or launched with).' })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/setup-decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId.trim() || undefined,
          planned_name: entityName.trim() || undefined,
          entity_name: entityName.trim() || undefined,
          setting_category: category,
          setting_name: SETTING_LABELS[category] ?? category,
          previous_value: previousValue.trim() || undefined,
          actual_launched_value: newValue.trim(),
          origin: 'manual_action',
          user_decision: 'acted_on',
          action_taken: true,
          decision_note: note.trim() || undefined,
        }),
      })
      const j = (await res.json()) as { conflict?: { change_summary?: string | null } | null; error?: string }
      if (!res.ok) {
        setResult({ ok: false, text: j.error ?? 'Failed to record' })
      } else if (j.conflict) {
        setResult({
          ok: true,
          text: `Recorded — but this CONTRADICTS a prior decision (${j.conflict.change_summary ?? 'see conflict banner'}). The prior stays active until you approve the switch on the Recommendations page.`,
        })
      } else {
        setResult({ ok: true, text: 'Recorded in the ledger. Nothing was executed — this logs what you did manually.' })
      }
      if (res.ok) {
        setPreviousValue('')
        setNewValue('')
        setNote('')
      }
    } catch {
      setResult({ ok: false, text: 'Failed to record' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card-base p-4">
      <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Log a manual action</p>
      <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '3px' }}>
        Record what you did in Meta Ads Manager (launched a campaign, changed a budget/event/audience, paused an
        ad) so Maxx remembers it and can watch the outcome. {READ_ONLY_APPLY_NOTE}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '12px' }}>
        <div>
          <label style={labelStyle}>Setting changed</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {Object.entries(SETTING_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Entity type</label>
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Entity name (campaign/ad set/ad)</label>
          <input value={entityName} onChange={(e) => setEntityName(e.target.value)} placeholder="e.g. Example Studio — Launch" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Meta ID (optional)</label>
          <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="e.g. 1200987…" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Previous value (optional)</label>
          <input value={previousValue} onChange={(e) => setPreviousValue(e.target.value)} placeholder="e.g. $30/day" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>New value (what you set/launched)</label>
          <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="e.g. $45/day" style={inputStyle} />
        </div>
      </div>
      <div style={{ marginTop: '10px' }}>
        <label style={labelStyle}>Why / note (optional)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you made this change" style={inputStyle} />
      </div>

      <button
        onClick={submit}
        disabled={busy}
        style={{
          marginTop: '12px', fontSize: '12px', fontWeight: 600, padding: '7px 14px', borderRadius: '6px',
          cursor: busy ? 'not-allowed' : 'pointer', color: 'var(--on-accent)', background: 'var(--accent)', border: 'none', opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? 'Recording…' : 'Record manual action'}
      </button>

      {result && (
        <p style={{ fontSize: '11.5px', color: result.ok ? 'var(--success)' : 'var(--danger)', marginTop: '8px' }}>
          {result.text}
        </p>
      )}
    </div>
  )
}
