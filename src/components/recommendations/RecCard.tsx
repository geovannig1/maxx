import { StatusChip } from '@/components/ui/range-badge'
import { TrustBadge } from '@/components/trust/TrustBadge'
import { trustLevelFor } from '@/lib/trust/trust'
import { learningStatus, type LearningTone } from '@/lib/recommendations/learning-status'
import { RecommendationDecision } from '@/components/recommendations/RecommendationDecision'
import type { StoredRecommendation } from '@/lib/recommendations/store'
import type { RecommendationDecision as Decision } from '@/lib/recommendations/decisions'
import type { LedgerRow } from '@/lib/recommendations/setup-ledger'
import { outcomeNoun } from '@/config/outcome-nouns'

// Decision-first recommendation card (UI-revamp v2, Wave 3). Re-layers every field the old flat card
// rendered into seven zones so the DECISION leads and the honesty is one expander away — but the four
// warning types + "what could make this wrong" stay VISIBLE without any interaction (non-negotiable
// safety invariant). No data, thresholds, or safety labels change here; this is layout only. The card is
// a server component — expanders are native <details>, so it needs no client JS of its own.

const RISK_COLOR: Record<string, string> = {
  low: 'var(--success)', medium: 'var(--warning)', high: 'var(--danger)',
}
const TONE_COLOR: Record<LearningTone, string> = {
  good: 'var(--success)', warn: 'var(--warning)', info: 'var(--accent)', neutral: 'var(--text-tertiary)',
}
const AUTHORITY_COLOR = {
  execution_eligible: 'var(--success)',
  owner_review: 'var(--warning)',
  diagnostic_only: 'var(--text-tertiary)',
} as const

function chip(text: string, color: string, title?: string) {
  return (
    <span title={title} style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '100px', color, background: 'var(--bg-subtle)', border: `1px solid ${color}55` }}>
      {text}
    </span>
  )
}

function metaRow(label: string, value: string) {
  return (
    <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
      <span style={{ fontWeight: 600 }}>{label}:</span> {value}
    </p>
  )
}

function impactLine(label: string, value: string, color: string) {
  return (
    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px' }}>
      <span style={{ fontWeight: 600, color }}>{label}:</span> {value}
    </p>
  )
}

// Stored evidence strings can carry raw float dumps (0.6706624999999999); round long decimals for
// display only — values are unchanged at the source, this is typography not truth-editing.
function fmtEvidence(s: string): string {
  return s.replace(/(\d+\.\d{3,})/g, (m) => (+parseFloat(m).toFixed(2)).toString())
}

export function RecCard({ rec: r, decision, history }: {
  rec: StoredRecommendation
  decision: Decision | null
  history: LedgerRow[]
}) {
  const ls = learningStatus(r)
  const hasWarnings = !!(
    r.low_data_warning || r.estimate_warning || r.attribution_warning ||
    (r.what_could_make_this_wrong && r.what_could_make_this_wrong.length > 0)
  )
  const hasImpact = !!(r.expected_upside || r.possible_downside)

  return (
    <div className="card-base p-4">
      <div
        className="mb-3 rounded-lg px-3 py-2"
        style={{
          background: decision ? 'var(--bg-subtle)' : 'var(--accent-dim)',
          border: `1px solid ${decision ? 'var(--border)' : 'var(--border-focus)'}`,
        }}
      >
        <p className="text-[12.5px] font-semibold" style={{ color: decision ? 'var(--text-secondary)' : 'var(--accent)' }}>
          {decision ? 'Decision recorded' : 'Decision needed'}
        </p>
        <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          Source: {r.data_sources?.length ? r.data_sources.join(', ') : 'recommendation generation'} · Date: {r.date_range_start || r.date_range_end ? `${r.date_range_start ?? '—'} → ${r.date_range_end ?? '—'}` : r.generated_at} · Scope: {r.target_entity_type} · Availability: {r.action_authority_tier === 'diagnostic_only' ? 'Diagnostic only' : r.action_authority_tier.replaceAll('_', ' ')}
        </p>
      </div>

      {/* Z1 — header: entity headline + chips in DESIGN order (max 4): type · status · trust · risk. */}
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        {chip(r.recommendation_type.replace(/_/g, ' '), 'var(--accent-hover)')}
        {r.target_status && <StatusChip status={r.target_status} title={r.target_language ?? undefined} />}
        <TrustBadge score={Math.round(r.confidence_score * 100)} level={trustLevelFor(Math.round(r.confidence_score * 100))} />
        {chip(`risk ${r.risk_level}`, RISK_COLOR[r.risk_level] ?? 'var(--warning)')}
        {chip(r.action_authority_tier.replace(/_/g, ' '), AUTHORITY_COLOR[r.action_authority_tier])}
      </div>
      <p style={{ fontSize: '14px', color: 'var(--text-primary)', marginTop: '8px', fontWeight: 600 }}>
        {r.target_entity_name ?? r.target_entity_type}
      </p>

      {/* Z2 — claim (visible): observed fact leads, reason supports. */}
      <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '6px' }}>{r.observed_fact}</p>
      <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>{r.reason_for_action}</p>

      {/* Z3 — impact (visible): expected upside / possible downside as two short labeled lines. */}
      {hasImpact && (
        <div style={{ marginTop: '6px' }}>
          {r.expected_upside && impactLine('Expected upside', r.expected_upside, 'var(--success)')}
          {r.possible_downside && impactLine('Possible downside', r.possible_downside, 'var(--warning)')}
        </div>
      )}

      <div
        className="grid gap-2 sm:grid-cols-2"
        style={{ marginTop: '8px' }}
      >
        <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Exact paid CPA</p>
          <p className="text-[14px] font-semibold mt-1" style={{ color: 'var(--text-secondary)' }}>Unavailable</p>
        </div>
        <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Exact paid ROAS</p>
          <p className="text-[14px] font-semibold mt-1" style={{ color: 'var(--text-secondary)' }}>Unavailable</p>
        </div>
      </div>
      <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--text-tertiary)' }}>
        Unavailable until the exact paid {outcomeNoun({ plural: false })} join is complete. Meta-modelled outcomes are diagnostic context only.
      </p>

      {/* Z4 — warnings (visible, one well): the four warning types stay un-hidden, never behind a click. */}
      {hasWarnings && (
        <div style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '8px', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          {r.low_data_warning && <p style={{ fontSize: '11.5px', color: 'var(--warning)' }}>⚠ {r.low_data_warning}</p>}
          {r.estimate_warning && <p style={{ fontSize: '11.5px', color: 'var(--warning)', marginTop: r.low_data_warning ? '4px' : 0 }}>⚠ {r.estimate_warning}</p>}
          {r.attribution_warning && <p style={{ fontSize: '11.5px', color: 'var(--warning)', marginTop: (r.low_data_warning || r.estimate_warning) ? '4px' : 0 }}>⚠ {r.attribution_warning}</p>}
          {r.what_could_make_this_wrong && r.what_could_make_this_wrong.length > 0 && (
            <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: (r.low_data_warning || r.estimate_warning || r.attribution_warning) ? '6px' : 0 }}>
              <span style={{ fontWeight: 600 }}>What could make this wrong:</span> {r.what_could_make_this_wrong.join(' ')}
            </p>
          )}
        </div>
      )}

      {/* Z5 — "Evidence & why": all provenance/honesty detail, one expander away. */}
      <details style={{ marginTop: '8px' }}>
        <summary style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-tertiary)', cursor: 'pointer' }}>
          Evidence &amp; why
        </summary>
        <div style={{ marginTop: '6px' }}>
          {r.evidence_summary && metaRow('Evidence', fmtEvidence(r.evidence_summary))}
          {r.data_sources && r.data_sources.length > 0 && metaRow('Data source', r.data_sources.join(', '))}
          {(r.date_range_start || r.date_range_end) && metaRow('Date range', `${r.date_range_start ?? '—'} → ${r.date_range_end ?? '—'}`)}
          {r.attribution_confidence != null && metaRow('Attribution confidence', `${Math.round(r.attribution_confidence * 100)}%`)}
          {r.prior_learning_used && metaRow('Prior learning used', r.prior_learning_used)}
          {r.external_knowledge_used && r.external_knowledge_used.length > 0 && metaRow('External knowledge used', r.external_knowledge_used.join(' · '))}
          {r.minimum_data_needed && metaRow('Minimum data needed', r.minimum_data_needed)}
          {metaRow('Learning eligibility', r.learning_eligibility ? 'yes' : 'no')}
          <div style={{ marginTop: '6px' }}>{chip(ls.label, TONE_COLOR[ls.tone], ls.tooltip)}</div>
        </div>
      </details>

      {/* Z6 — setting history from the Ad Decision Ledger: what was previously decided for this entity,
          why, and what actually launched — the "why did we choose this?" memory. Read-only. */}
      {history.length > 0 && (
        <details style={{ marginTop: '8px' }}>
          <summary style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-tertiary)', cursor: 'pointer' }}>
            Setting history ({history.length})
          </summary>
          <div style={{ marginTop: '6px' }}>
            {history.map((h) => (
              <p key={h.id} style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                <span style={{ fontWeight: 600 }}>{h.setting_name}:</span>{' '}
                {h.previous_value ? `${h.previous_value} → ` : ''}{h.final_value ?? h.proposed_value ?? '—'}
                {h.actual_launched_value ? ` (launched: ${h.actual_launched_value})` : ''}
                {h.user_decision ? ` · ${h.user_decision.replace(/_/g, ' ')}` : ''}
                {h.conflicts_with_prior && !h.prior_deprecated ? ' · ⚠ conflict pending' : ''}
                {h.reason ? <span style={{ color: 'var(--text-tertiary)' }}> — {h.reason}</span> : null}
              </p>
            ))}
          </div>
        </details>
      )}

      {/* Z7 — decision: one compact status sentence (write-mode safety label KEPT, compacted from the old
          5-fragment footer) framing the explicit decision control. */}
      <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '10px' }}>
        Your decision is recorded here; a change runs only after you approve it on the Changes page, with write mode on.
        {r.approval_required ? ' Needs your approval.' : ''}
        {r.recommended_next_check_date ? ` Re-check ${r.recommended_next_check_date}.` : ''}
      </p>
      <RecommendationDecision recId={r.id} current={decision} authorityTier={r.action_authority_tier} />
    </div>
  )
}
