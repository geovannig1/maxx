import Link from 'next/link'
import { computeStatusCards, type StatusCardsInput, type StatusCardStatus } from '@/lib/trust/status-cards'
import { SourceBadge } from '@/components/ui/badges'
import type { TrafficSource } from '@/lib/ga4/client'
import { outcomeNoun } from '@/config/outcome-nouns'

// Tier 2 of Today — the "can I trust today's numbers?" strip. Renders the four plain-English status
// cards (Tracking / Attribution / Freshness / ROAS trust) from the SAME computeStatusCards() the
// diagnostics VerdictHeader uses, so the two surfaces can never disagree. Below the cards, a one-line
// source-provenance summary + SourceBadge, with the FULL per-view copy kept verbatim inside a
// "How to read these numbers" expander. Presentational, server-rendered (computeStatusCards is pure).

const STATUS_HEX: Record<StatusCardStatus, string> = {
  good: 'var(--success)', watch: 'var(--warning)', bad: 'var(--danger)', unknown: 'var(--text-tertiary)',
}

// The full per-view provenance copy, kept verbatim (relocated from dashboard/page.tsx). The visible
// one-liner summarises; the full text lives in the expander so nothing is lost.
const PROVENANCE: Record<TrafficSource, { short: string; full: string }> = {
  complete: {
    short: 'The outcome ledger supplies all-source business totals; GA classifies session channels; Meta supplies ad delivery.',
    full: `The outcome ledger supplies active ${outcomeNoun()} and booked value across all sources. GA paid/non-paid tabs show session-channel confirmation telemetry, not paid outcomes or causality. Meta supplies modelled attribution and ad delivery. Use the exact ${outcomeNoun({ plural: false })}-id join for paid CPA or ROAS.`,
  },
  paid: {
    short: 'GA paid-channel sessions and confirmation events plus Meta delivery — useful telemetry, not proof of paid outcomes.',
    full: `GA classifies sessions into paid channels and reports confirmation events without ${outcomeNoun({ plural: false })} identity. That helps diagnose channel tagging, but it cannot prove an ad caused a ${outcomeNoun({ plural: false })} or support paid CPA/ROAS. Paid money requires the complete exact ${outcomeNoun({ plural: false })}-id join and authoritative mapped spend.`,
  },
  organic: {
    short: 'GA non-paid session and confirmation-event telemetry; this is not a ledger revenue subset.',
    full: `GA sessions classified outside paid channels (organic search/social, direct, referral, email) plus their confirmation-event telemetry. These events have no ${outcomeNoun({ plural: false })} identity, so they are not ${outcomeNoun()} or revenue. Paid delivery, spend, and creative metrics are hidden in this view.`,
  },
}

export function TrustStrip({ input, source, sourceLabel }: { input: StatusCardsInput; source: TrafficSource; sourceLabel: string }) {
  const cards = computeStatusCards(input)
  const prov = PROVENANCE[source]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => {
          const hex = STATUS_HEX[c.status]
          return (
            <Link key={c.key} href={c.href} className="card-base block p-3.5 hover:opacity-90 transition-opacity" style={{ textDecoration: 'none' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="rounded-full shrink-0" style={{ width: 8, height: 8, background: hex }} />
                <span className="section-label" style={{ margin: 0 }}>{c.label}</span>
              </div>
              <p className="text-[12px]" style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>{c.headline}</p>
              {c.detail && <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{c.detail}</p>}
            </Link>
          )
        })}
      </div>

      {/* Source provenance — Outcome source is the all-source business ledger; paid/non-paid GA views are
          session-channel telemetry. The badge identifies the plane, never outcome authority. */}
      <div className="flex items-start gap-2.5 rounded-lg px-4 py-2.5" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-focus)' }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <SourceBadge source={source === 'complete' ? 'outcomes' : 'ga4'} />
            <span className="section-label" style={{ margin: 0, color: 'var(--accent)' }}>{sourceLabel}</span>
          </div>
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{prov.short}</p>
          <details className="mt-1.5">
            <summary className="text-[11px] font-semibold cursor-pointer" style={{ color: 'var(--accent)' }}>How to read these numbers</summary>
            <p className="text-[12px] mt-1.5" style={{ color: 'var(--text-secondary)' }}>{prov.full}</p>
          </details>
        </div>
      </div>
    </div>
  )
}
