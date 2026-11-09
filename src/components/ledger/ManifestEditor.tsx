'use client'

import { useState } from 'react'
import type { ManifestRow } from '@/lib/recommendations/manifest'
import { assessManifestAcceptance, entityKeyForSetup } from '@/lib/recommendations/manifest'
import { blockerLabels } from '@/lib/diagnostics/blocker-labels'
import type { LedgerRow } from '@/lib/recommendations/setup-ledger'

// Pre-launch setup manifest editor (Ad Decision Ledger). The eventual flow is a server-verified
// CampaignPlan proposal → exact-revision owner acceptance → ledger record. That repository does not exist
// yet, so every proposal and legacy launch row is read-only. Nothing here launches anything; write mode
// stays OFF and every recorded row carries action_allowed_now:false.

const inputStyle: React.CSSProperties = {
  width: '100%', fontSize: '12px', padding: '6px 9px', borderRadius: '6px',
  background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)',
}

interface RecordedState {
  id: string
  final_value: string | null
  actual_launched_value: string | null
  user_decision: string | null
  conflicts_with_prior: boolean
  change_summary: string | null
  /** false = what Meta shows differs from the recorded plan (drift). null = not comparable yet. */
  launched_matches_plan?: boolean | null
}

function chip(text: string, color: string) {
  return (
    <span style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '100px', color, background: 'var(--bg-subtle)', border: `1px solid ${color}55` }}>
      {text}
    </span>
  )
}

function SettingRow({ def, recorded, onRecord, busy }: {
  def: ManifestRow
  recorded: RecordedState | null
  onRecord: (def: ManifestRow, finalValue: string) => Promise<void>
  busy: boolean
}) {
  const value = def.proposed_value
  const acceptance = assessManifestAcceptance(def, value)

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '10px' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <p style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{def.setting_name}</p>
        {recorded
          ? recorded.conflicts_with_prior
            ? chip('conflict — needs approval', 'var(--warning)')
            : chip(recorded.user_decision ?? 'recorded', 'var(--success)')
          : chip('not recorded', 'var(--text-tertiary)')}
        {recorded?.actual_launched_value && chip(`launched: ${recorded.actual_launched_value.slice(0, 40)}`, 'var(--accent)')}
        {recorded?.launched_matches_plan === false && chip('⚠ launched differs from plan', 'var(--warning)')}
      </div>
      <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{def.reason}</p>
      {def.switch_risk && (
        <p style={{ fontSize: '11px', color: 'var(--warning)', marginTop: '2px' }}>Do not change too soon: {def.switch_risk}</p>
      )}

      {recorded ? (
        <div style={{ marginTop: '6px' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
            <span style={{ fontWeight: 600 }}>Chosen:</span> {recorded.final_value ?? '—'}
          </p>
          {recorded.conflicts_with_prior && recorded.change_summary && (
            <p style={{ fontSize: '11px', color: 'var(--warning)', marginTop: '2px' }}>Switch pending approval: {recorded.change_summary}</p>
          )}
          <p style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '4px' }}>
            Legacy launch row is read-only until an immutable CampaignPlan repository can bind and verify a revision.
          </p>
        </div>
      ) : (
        <div style={{ marginTop: '6px' }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
            <textarea
              value={value}
              readOnly
              rows={2}
              style={{ ...inputStyle, flex: 1, resize: 'vertical' }}
            />
            <button
              onClick={() => acceptance.allowed && onRecord(def, value)}
              disabled={busy || !acceptance.allowed}
              /* The machine codes stay in the DOM as data so tests can assert the exact reason,
                 while the operator reads prose. Same split as ActiveAccountUnavailableNotice. */
              data-blocked-by={acceptance.allowed ? undefined : acceptance.reason_codes.join(' ')}
              title={acceptance.allowed ? undefined : `Blocked: ${blockerLabels(acceptance.reason_codes) ?? 'reason unavailable'}`}
              style={{ fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: '6px', cursor: acceptance.allowed ? 'pointer' : 'not-allowed', color: acceptance.allowed ? 'var(--success)' : 'var(--text-tertiary)', background: 'var(--success-bg)', border: '1px solid rgba(52,211,153,0.35)', whiteSpace: 'nowrap' }}
            >
              {acceptance.allowed ? 'Approve & record' : 'Awaiting plan'}
            </button>
          </div>
          {!acceptance.allowed && (
            <p style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '4px' }}>
              {/* Was `reason_codes.join(', ')` — raw enum tokens shown to the operator. */}
              Cannot approve: {blockerLabels(acceptance.reason_codes) ?? 'reason unavailable'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function ManifestEditor({ defaults, existing }: { defaults: ManifestRow[]; existing: LedgerRow[] }) {
  const [campaignName, setCampaignName] = useState('Example Studio — Launch')
  const [busy, setBusy] = useState(false)
  // Rows recorded during this session layer over the server-fetched ones. Keyed by
  // `${entityKey}:${category}` so renaming the campaign mid-session doesn't carry the previous
  // manifest's recorded state onto the new one.
  const [recordedNow, setRecordedNow] = useState<Record<string, RecordedState>>({})

  const entityKey = entityKeyForSetup(null, campaignName)

  function recordedFor(category: string): RecordedState | null {
    const now = recordedNow[`${entityKey}:${category}`]
    if (now) return now
    const match = existing.find(
      (r) => r.setting_category === category && (r.entity_key === entityKey || r.entity_name === campaignName)
    )
    if (!match) return null
    return {
      id: match.id,
      final_value: match.final_value,
      actual_launched_value: match.actual_launched_value,
      user_decision: match.user_decision,
      conflicts_with_prior: match.conflicts_with_prior && !match.prior_deprecated,
      change_summary: match.change_summary,
    }
  }

  async function record(def: ManifestRow, finalValue: string) {
    const acceptance = assessManifestAcceptance(def, finalValue)
    if (!acceptance.allowed || !def.plan_source) return

    setBusy(true)
    try {
      const res = await fetch('/api/setup-decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'campaign',
          planned_name: campaignName,
          entity_name: campaignName,
          setting_category: def.setting_category,
          setting_name: def.setting_name,
          proposed_value: def.proposed_value,
          final_value: finalValue,
          origin: 'launch_setup',
          reason: def.reason,
          switch_risk: def.switch_risk,
          user_decision: 'accepted',
          proposal_status: def.proposal_status,
          blocker_codes: def.blocker_codes,
          campaign_plan_id: def.plan_source.plan_id,
          campaign_plan_revision: def.plan_source.revision,
          campaign_plan_hash: def.plan_source.content_hash,
        }),
      })
      const j = (await res.json()) as { id?: string; conflict?: { change_summary?: string | null } | null }
      if (res.ok && j.id) {
        setRecordedNow((prev) => ({
          ...prev,
          [`${entityKey}:${def.setting_category}`]: {
            id: j.id!,
            final_value: finalValue,
            actual_launched_value: null,
            user_decision: 'accepted',
            conflicts_with_prior: !!j.conflict,
            change_summary: j.conflict?.change_summary ?? null,
          },
        }))
      }
    } finally {
      setBusy(false)
    }
  }

  const recordedCount = defaults.filter((d) => recordedFor(d.setting_category)).length

  return (
    <div className="card-base p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Pre-launch checklist</p>
        <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>{recordedCount}/{defaults.length} settings recorded</span>
      </div>
      <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '3px' }}>
        Context-free guidance is view-only. Approval becomes available only after the server can verify an approved
        CampaignPlan proposal, rationale, revision, and content hash. Recording never changes anything in Meta.
      </p>
      <div style={{ marginTop: '12px' }}>
        <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-tertiary)', display: 'block', marginBottom: '4px' }}>
          Planned campaign name (ties every setting to one checklist)
        </label>
        <input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} style={inputStyle} />
      </div>

      {defaults.map((def) => (
        <SettingRow
          key={def.setting_category}
          def={def}
          recorded={recordedFor(def.setting_category)}
          onRecord={record}
          busy={busy}
        />
      ))}
    </div>
  )
}
