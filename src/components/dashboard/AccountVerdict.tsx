import Link from 'next/link'
import { SourceBadge } from '@/components/ui/badges'
import { verdictTone, type AccountVerdict as Verdict } from '@/lib/dashboard/verdict'
import { outcomeNoun } from '@/config/outcome-nouns'

// The Tier-1 HERO of the redesigned Today page (design-system §3.1). Answers "what should I care about
// today?" before any chart: a trust-toned account verdict + the outcome-source active-appointment amount + the
// ranked "needs you" links. Quiet for good news, loud for bad (verdictTone). Server-rendered.

const TONE_HEX: Record<'success' | 'warning' | 'danger' | 'neutral', string> = {
  success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)', neutral: 'var(--text-tertiary)',
}

export function AccountVerdict({
  verdict,
  revenue,
  needs,
}: {
  verdict: Verdict
  revenue: { value: number; bookings: number } | null // amount_paid over active appointments
  needs: { label: string; href: string }[]
}) {
  const hex = TONE_HEX[verdictTone(verdict.level)]
  return (
    <div className="card-base" style={{ padding: 'var(--card-pad-hero, 24px)' }}>
      <div className="flex items-start justify-between gap-6 flex-wrap">
        {/* Verdict */}
        <div className="min-w-0">
          <p className="section-label" style={{ marginBottom: 6 }}>Account verdict</p>
          <div className="flex items-center gap-2.5">
            <span className="rounded-full shrink-0" style={{ width: 10, height: 10, background: hex }} />
            <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em', color: hex, lineHeight: 1 }}>{verdict.headline}</h2>
          </div>
          <p className="text-[13px] mt-2 max-w-xl" style={{ color: 'var(--text-secondary)' }}>{verdict.detail}</p>
          {verdict.factors.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {verdict.factors.map((f, i) => (
                <li key={i} className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>• {f}</li>
              ))}
            </ul>
          )}
        </div>

        {/* recorded collected value over active appointments, all sources. */}
        {revenue && (
          <div className="text-right shrink-0">
            <div className="flex items-center gap-1.5 justify-end mb-1">
              <SourceBadge source="outcomes" />
              <span className="section-label">Amount paid · active {outcomeNoun()}</span>
            </div>
            <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
              ${Math.round(revenue.value).toLocaleString()}
            </div>
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{revenue.bookings} value-bearing {outcomeNoun({ count: revenue.bookings })} · active {outcomeNoun()} only</div>
          </div>
        )}
      </div>

      {/* What needs you today */}
      {needs.length > 0 && (
        <div className="mt-4 pt-3 flex flex-wrap items-center gap-2" style={{ borderTop: '1px solid var(--border)' }}>
          <span className="section-label">Needs you</span>
          {needs.map((n) => (
            <Link
              key={n.href + n.label}
              href={n.href}
              className="text-[12px] font-semibold rounded-lg px-2.5 py-1"
              style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-focus)', color: 'var(--accent)', textDecoration: 'none' }}
            >
              {n.label} →
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
