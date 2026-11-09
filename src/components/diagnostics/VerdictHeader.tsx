'use client'

import { computeStatusCards, type StatusCard, type StatusCardStatus } from '@/lib/trust/status-cards'
import type { AttributionUtm } from './AttributionSection'
import type { TrustScore } from '@/lib/trust/trust'
import type { SpendIntegrityResult, PlaneConflictResult } from '@/lib/diagnostics/reconcile'

// Plain-English verdict layer atop /diagnostics — renders the SAME computeStatusCards() the dashboard
// TrustStrip uses, so the two surfaces can never tell different stories. Pure lib, nothing fetched here;
// every input is mapped from the already-fetched ReconResp. latestSyncFailed isn't in ReconResp, so it's
// left undefined — the lib answers on data age alone (and marks anything it can't measure as unknown,
// never a fabricated verdict).

const STATUS: Record<StatusCardStatus, { label: string; text: string; bg: string; border: string }> = {
  good: { label: 'Good', text: 'var(--success)', bg: 'var(--success-bg)', border: 'var(--success-border)' },
  watch: { label: 'Watch', text: 'var(--warning)', bg: 'var(--warning-bg)', border: 'var(--warning-border)' },
  bad: { label: 'Action needed', text: 'var(--danger)', bg: 'var(--danger-bg)', border: 'var(--danger-border)' },
  unknown: { label: 'Not measured', text: 'var(--text-tertiary)', bg: 'var(--bg-subtle)', border: 'var(--border)' },
}

function StatusPill({ status }: { status: StatusCardStatus }) {
  const s = STATUS[status]
  return (
    <span className="inline-flex items-center rounded-full text-[11px] font-semibold shrink-0" style={{ height: 20, padding: '0 8px', background: s.bg, border: `1px solid ${s.border}`, color: s.text }}>
      {s.label}
    </span>
  )
}

function VerdictCard({ card }: { card: StatusCard }) {
  // card.href is `/diagnostics#<anchor>` (or `/diagnostics` for the page-top trust evidence). Link with
  // the bare hash so the deep-link scrolls in place without dropping the ?from&to range query.
  const hashIdx = card.href.indexOf('#')
  const hash = hashIdx >= 0 ? card.href.slice(hashIdx) : null
  return (
    <div className="card-base p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{card.label}</span>
        <StatusPill status={card.status} />
      </div>
      <p className="text-[13px] font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>{card.headline}</p>
      {card.detail && <p className="text-[11.5px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>{card.detail}</p>}
      {hash && (
        <a href={hash} className="text-[11.5px] font-semibold mt-auto pt-1" style={{ color: 'var(--accent)' }}>
          See the evidence ↓
        </a>
      )}
    </div>
  )
}

export interface DiagnosticsVerdictInput {
  ga4Available: boolean
  utm: AttributionUtm | null
  attributedShare: number | null
  dataAgeHours: number | null
  integrityStatus: SpendIntegrityResult['status']
  trust: TrustScore
  moneyDirection: PlaneConflictResult['direction']
}

/** The page's four cards, computed once so the plain verdict above them reads the same evidence. */
export function diagnosticsStatusCards({ ga4Available, utm, attributedShare, dataAgeHours, integrityStatus, trust, moneyDirection }: DiagnosticsVerdictInput): StatusCard[] {
  return computeStatusCards({
    ga4Available,
    // ReconResp's utm is snake_case AttributionUtm; the lib consumes camelCase UtmCoverageStats.
    utm: utm ? { adsTotal: utm.ads_total, adsCorrect: utm.ads_correct, adsMissing: utm.ads_missing, adsMisconfigured: utm.ads_misconfigured, adsUnverified: 0, coverage: utm.coverage } : null,
    attributedShare,
    dataAgeHours,
    integrityStatus,
    trust,
    moneyDirection,
    outcomeBasis: 'telemetry_only',
  })
}

export function VerdictHeader({ cards }: { cards: readonly StatusCard[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => <VerdictCard key={card.key} card={card} />)}
    </div>
  )
}
