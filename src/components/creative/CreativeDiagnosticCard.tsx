'use client'

import Link from 'next/link'
import type { CreativeDiagnostic, CreativeSignalState } from '@/lib/creative/verdict'

const SIGNAL_COLOR: Record<CreativeSignalState, string> = {
  observed: 'var(--accent)',
  partial: 'var(--warning)',
  unavailable: 'var(--text-tertiary)',
}

export function CreativeDiagnosticCard({ diagnostic }: { diagnostic: CreativeDiagnostic }) {
  const evidenceAvailable = diagnostic.state === 'evidence_available'
  const color = evidenceAvailable ? 'var(--accent)' : 'var(--text-tertiary)'
  const background = evidenceAvailable ? 'var(--accent-dim)' : 'var(--border)'

  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background, border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p style={{ color, fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>{diagnostic.label}</p>
          <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Diagnostic only
          </p>
        </div>
        <span className="text-[10px] rounded-full px-2 py-1" style={{ color, border: '1px solid var(--border)' }}>
          No prescriptions
        </span>
      </div>

      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{diagnostic.reason}</p>

      <div className="flex flex-wrap gap-1.5">
        {diagnostic.signals.map((signal) => (
          <span
            key={signal.label}
            title={signal.detail}
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
            style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}
          >
            <span className="rounded-full" style={{ width: 6, height: 6, background: SIGNAL_COLOR[signal.state] }} />
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>{signal.label}</span>
          </span>
        ))}
      </div>

      <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        Governed decisions appear in{' '}
        <Link href="/recommendations" className="underline hover:opacity-80">Current Recommendations</Link>.
      </p>
    </div>
  )
}
