import { CheckCircle2, AlertTriangle } from 'lucide-react'
import type { StatusCard, StatusCardStatus } from '@/lib/trust/status-cards'
import type { IntegrityStatus } from '@/lib/diagnostics/reconcile'

// The owner-readable verdict at the top of /diagnostics, DERIVED from the same status cards and spend
// reconciliation the page renders below it. It used to be a constant list that read "Blocked" on every
// install whatever the data said; now each row says what this account's evidence says, and the page
// reads "Healthy" only when every measured check passes. Paid ROAS stays unavailable: no check on this
// page supplies the exact outcome-id join it needs, and unavailable is never shown as a pass or zero.

export type VerdictState = 'verified' | 'watch' | 'attention' | 'not_measured' | 'unavailable'

export interface VerdictRow { label: string; state: VerdictState; detail: string }

const STATE_COPY: Record<VerdictState, { label: string; color: string }> = {
  verified: { label: 'Verified', color: 'var(--success)' },
  watch: { label: 'Watch', color: 'var(--warning)' },
  attention: { label: 'Action needed', color: 'var(--danger)' },
  not_measured: { label: 'Not measured', color: 'var(--text-tertiary)' },
  unavailable: { label: 'Unavailable', color: 'var(--text-tertiary)' },
}

const FROM_CARD: Record<StatusCardStatus, VerdictState> = {
  good: 'verified', watch: 'watch', bad: 'attention', unknown: 'not_measured',
}

const INTEGRITY: Record<IntegrityStatus, { state: VerdictState; detail: string }> = {
  aligned: { state: 'verified', detail: 'Every spend source compared for this window agrees.' },
  minor_drift: { state: 'watch', detail: 'A small spend-source drift, usually a partial-day gap. Re-sync to reconcile.' },
  mismatch: { state: 'attention', detail: 'Spend sources disagree for this window. Re-sync before trusting windowed spend.' },
  unknown: { state: 'not_measured', detail: 'There is no second spend source to compare for this window.' },
}

/** PURE. The verdict rows for the diagnostics page, from its computed cards and spend integrity. */
export function plainTrustRows(cards: readonly StatusCard[], integrity: IntegrityStatus): VerdictRow[] {
  const card = (key: StatusCard['key']) => cards.find((c) => c.key === key)
  const fromCard = (key: StatusCard['key'], label: string): VerdictRow => {
    const c = card(key)
    return c ? { label, state: FROM_CARD[c.status], detail: c.headline } : { label, state: 'not_measured', detail: 'Not measured in this view.' }
  }
  return [
    fromCard('tracking', 'Tracking'),
    fromCard('attribution', 'Attribution'),
    fromCard('freshness', 'Freshness'),
    { label: 'Spend reconciliation', ...INTEGRITY[integrity] },
    {
      label: 'Paid ROAS',
      state: 'unavailable',
      detail: 'Unavailable is not a pass and not zero: paid ROAS needs a complete exact outcome-id join and authoritative mapped spend, which this page does not read.',
    },
  ]
}

export type VerdictTone = 'healthy' | 'neutral' | 'attention'

/** Healthy only when every data check was measured and verified. Paid ROAS is structural, not a data check. */
export function overallVerdict(rows: readonly VerdictRow[]): { tone: VerdictTone; text: string } {
  const checks = rows.filter((row) => row.state !== 'unavailable')
  const measured = checks.filter((row) => row.state !== 'not_measured')
  const failing = measured.filter((row) => row.state !== 'verified')
  const unmeasured = checks.length - measured.length
  if (measured.length === 0) return { tone: 'neutral', text: 'No data check could be measured in this view.' }
  if (failing.length > 0) {
    return { tone: 'attention', text: `${failing.length} of ${measured.length} measured ${measured.length === 1 ? 'check needs' : 'checks need'} attention.` }
  }
  if (unmeasured > 0) {
    return { tone: 'neutral', text: `Every measured check passes; ${unmeasured} ${unmeasured === 1 ? 'check is' : 'checks are'} not measured in this view.` }
  }
  return { tone: 'healthy', text: 'Healthy: every data check passes.' }
}

const TONE_COLOR: Record<VerdictTone, string> = {
  healthy: 'var(--success)', neutral: 'var(--text-secondary)', attention: 'var(--warning)',
}

export function PlainTrustVerdict({ cards, integrity }: { cards: readonly StatusCard[]; integrity: IntegrityStatus }) {
  const rows = plainTrustRows(cards, integrity)
  const overall = overallVerdict(rows)
  const Icon = overall.tone === 'attention' ? AlertTriangle : CheckCircle2
  return (
    <section aria-label="Plain trust verdict" data-trust-verdict={overall.tone} className="card-base p-4 space-y-3">
      <div>
        <p className="text-[14px] font-bold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>Plain trust verdict</p>
        <p role="status" className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: TONE_COLOR[overall.tone] }}>
          <Icon className="w-4 h-4 shrink-0" aria-hidden />
          {overall.text}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{row.label}</span>
              <span className="text-[11px] font-semibold" style={{ color: STATE_COPY[row.state].color }}>{STATE_COPY[row.state].label}</span>
            </div>
            <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>{row.detail}</p>
          </div>
        ))}
      </div>
      <details className="text-[12px]">
        <summary style={{ color: 'var(--text-tertiary)', cursor: 'pointer' }}>Technical proof</summary>
        <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>
          Each row is computed from the evidence sections below: tracking and attribution telemetry, data freshness, and the spend reconciliation. A check that could not be measured is shown as not measured, never as a pass.
        </p>
      </details>
    </section>
  )
}
