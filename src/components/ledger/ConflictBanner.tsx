'use client'

import { useState } from 'react'
import type { LedgerRow } from '@/lib/recommendations/setup-ledger'

// Conflict & revision banner (Ad Decision Ledger surfacing). Shows every UNRESOLVED setting
// switch: what was previously decided, what the new decision says, why it changed, and the risk of
// switching. The human resolves it explicitly — "Approve switch" retires the prior decision, "Keep prior"
// rejects the new one. NOTHING here executes a change: both buttons only update the ledger (write mode
// stays OFF); any real change is applied manually in Meta Ads Manager.

export function ConflictBanner({ conflicts }: { conflicts: LedgerRow[] }) {
  const [rows, setRows] = useState<LedgerRow[]>(conflicts)
  const [busy, setBusy] = useState<string | null>(null)

  async function resolve(row: LedgerRow, approve: boolean) {
    setBusy(row.id)
    try {
      const res = await fetch(`/api/setup-decisions/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(approve ? { approve_switch: true, user_decision: 'accepted' } : { user_decision: 'rejected' }),
      })
      if (res.ok) setRows((prev) => prev.filter((r) => r.id !== row.id))
    } finally {
      setBusy(null)
    }
  }

  if (rows.length === 0) return null

  return (
    <div
      className="p-4"
      style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid var(--warning-border)', borderRadius: '10px' }}
    >
      <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--warning)', margin: 0 }}>
        ⚠ Setting switch{rows.length > 1 ? 'es' : ''} awaiting your approval ({rows.length})
      </p>
      <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '3px' }}>
        A new decision contradicts an earlier recorded decision for the same setting. The prior decision stays
        active until you approve the switch. Resolving this updates the ledger only; nothing changes in Meta.
      </p>
      <div className="space-y-2" style={{ marginTop: '10px' }}>
        {rows.map((r) => (
          <div key={r.id} style={{ borderTop: '1px solid var(--warning-bg)', paddingTop: '8px' }}>
            <p style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              {r.setting_name}
              {r.entity_name ? <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> · {r.entity_name}</span> : null}
            </p>
            {r.change_summary && (
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                <span style={{ fontWeight: 600 }}>Change:</span> {r.change_summary}
              </p>
            )}
            {r.why_changed && (
              <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                <span style={{ fontWeight: 600 }}>Why the new one is better:</span> {r.why_changed}
              </p>
            )}
            {r.switch_risk && (
              <p style={{ fontSize: '11.5px', color: 'var(--warning)', marginTop: '2px' }}>
                <span style={{ fontWeight: 600 }}>Risk of switching:</span> {r.switch_risk}
              </p>
            )}
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button
                onClick={() => resolve(r, true)}
                disabled={busy !== null}
                style={{
                  fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                  color: 'var(--success)', background: 'var(--success-bg)', border: '1px solid rgba(52,211,153,0.35)',
                }}
              >
                {busy === r.id ? 'Saving…' : 'Approve switch (retire prior)'}
              </button>
              <button
                onClick={() => resolve(r, false)}
                disabled={busy !== null}
                style={{
                  fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                  color: 'var(--danger)', background: 'rgba(248,113,113,0.08)', border: '1px solid var(--danger-border)',
                }}
              >
                Keep prior (reject new)
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
