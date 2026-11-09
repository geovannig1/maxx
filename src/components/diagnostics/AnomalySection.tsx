'use client'

import { TrendingUp, CheckCircle2 } from 'lucide-react'
import { TrustBadge } from '@/components/trust/TrustBadge'
import type { AnomalyExplanation } from '@/lib/diagnostics/anomaly'

const SEV_COLOR: Record<string, string> = { high: 'var(--trust-low)', medium: 'var(--warning)', low: 'var(--accent)', none: 'var(--text-tertiary)' }

export function AnomalySection({ anomalies, movements, priorLabel }: {
  anomalies: AnomalyExplanation[]
  movements: AnomalyExplanation[]
  priorLabel: string
}) {
  return (
    <div className="space-y-3">
      {anomalies.length === 0 ? (
        <div className="card-base p-4 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--success)' }} />
          <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            No anomalies — every efficiency metric held or improved {priorLabel}.
          </p>
        </div>
      ) : (
        anomalies.map((a) => (
          <div key={a.key} className="card-base p-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <TrendingUp className="w-4 h-4 mt-0.5 shrink-0" style={{ color: SEV_COLOR[a.severity] }} />
                <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{a.headline}</p>
              </div>
              {a.trust && <TrustBadge score={a.trust.score} level={a.trust.level} />}
            </div>
            {a.topMovers.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-6">
                {a.topMovers.map((m) => (
                  <span key={m.id} className="text-[11px] rounded-md px-2 py-0.5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                    {m.name}: {m.deltaPct != null ? `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct.toFixed(0)}%` : '—'} · {(m.spendShare * 100).toFixed(0)}% spend
                  </span>
                ))}
              </div>
            )}
          </div>
        ))
      )}

      {/* All movements at a glance */}
      <div className="flex flex-wrap gap-1.5">
        {movements.map((m) => {
          const c = m.direction === 'worsened' ? 'var(--trust-low)' : m.direction === 'improved' ? 'var(--success)' : 'var(--text-tertiary)'
          return (
            <span key={m.key} className="text-[11px] rounded-md px-2 py-1 tabular-nums" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              {m.label} <span style={{ color: c }}>{m.changePct != null ? `${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(0)}%` : '—'}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
