'use client'

import { CheckCircle2, AlertCircle } from 'lucide-react'
import type { TrustScore, TrustLevel } from '@/lib/trust/trust'

// The one trust visual reused everywhere — a recommendation, a metric, a reconciliation, an anomaly.
// Color + the 95% "verified" check are consistent so users learn one signal across the whole app.

export const TRUST_COLOR: Record<TrustLevel, string> = {
  verified: 'var(--success)',
  high: 'var(--accent)',
  moderate: 'var(--warning)',
  low: 'var(--trust-low)',
  insufficient: 'var(--text-tertiary)',
}

export function trustBadgeStyle(level: TrustLevel): React.CSSProperties {
  const color = TRUST_COLOR[level]
  return {
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    border: `1px solid ${color}`,
    color,
  }
}

export function TrustBadge({ score, level, size = 'sm' }: { score: number; level: TrustLevel; size?: 'sm' | 'md' }) {
  const h = size === 'md' ? 26 : 22
  const fs = size === 'md' ? 12 : 11
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap"
      style={{ height: h, padding: `0 ${size === 'md' ? 10 : 8}px`, fontSize: fs, ...trustBadgeStyle(level) }}
      title={`Trust ${score}% — ${level}${level === 'verified' ? ' (≥95% bar)' : ''}`}
    >
      {level === 'verified' ? <CheckCircle2 style={{ width: fs, height: fs }} /> : <AlertCircle style={{ width: fs, height: fs }} />}
      {score}% · {level}
    </span>
  )
}

/** The full trust explanation — factor bars, integrity ceilings, and concrete gaps. */
export function TrustBreakdown({ trust }: { trust: TrustScore }) {
  const applicable = trust.factors.filter((f) => f.weight > 0)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <TrustBadge score={trust.score} level={trust.level} size="md" />
        <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{trust.headline}</span>
      </div>

      <div className="space-y-1.5">
        {applicable.map((f) => (
          <div key={f.key} className="flex items-center gap-2">
            <span className="text-[11px] w-28 shrink-0" style={{ color: 'var(--text-tertiary)' }}>{f.label}</span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-subtle)' }}>
              <div className="h-full rounded-full" style={{ width: `${Math.round(f.score * 100)}%`, background: f.score >= 0.85 ? 'var(--success)' : f.score >= 0.5 ? 'var(--warning)' : 'var(--trust-low)' }} />
            </div>
            <span className="text-[10.5px] w-32 shrink-0 truncate" style={{ color: 'var(--text-tertiary)' }} title={f.detail}>{f.detail}</span>
          </div>
        ))}
      </div>

      {trust.ceilings.length > 0 && (
        <div className="space-y-1">
          {trust.ceilings.map((c, i) => (
            <p key={i} className="text-[11px] flex items-start gap-1.5" style={{ color: 'var(--trust-low)' }}>
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>Capped at {Math.round(c.cap * 100)}%: {c.reason}</span>
            </p>
          ))}
        </div>
      )}

      {trust.gaps.length > 0 && (
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-tertiary)' }}>To reach 95%</p>
          <ul className="space-y-0.5">
            {trust.gaps.map((g, i) => (
              <li key={i} className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>• {g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
