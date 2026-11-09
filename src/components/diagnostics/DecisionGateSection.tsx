'use client'

import { useEffect, useState } from 'react'
import { blockerLabel } from '@/lib/diagnostics/blocker-labels'

/** Owner-facing name for each gate. The internal names are camelCase function parameters. */
const GATE_LABELS: Record<string, string> = {
  lifecycleRun: 'This run covers the current day',
  insightLevelsComplete: 'Meta returned every reporting level',
  metaOutcomeMetricsComplete: 'Conversion figures are complete',
  paidCohortPublished: 'Paid-results evidence was published',
}

interface GateRecord {
  verdict: 'live' | 'frozen'
  gates: Record<string, boolean>
  closedBy: string[]
  metaOutcomeBlockerCodes: string[]
  evaluatedAt: string
}

interface Resp {
  status: 'recorded' | 'not_recorded'
  syncStatus?: string
  recordedAt?: string
  gateNames: string[]
  gate?: GateRecord
}

export function DecisionGateSection() {
  const [data, setData] = useState<Resp | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/diagnostics/decision-gate')
      .then(async (r) => {
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) setError(body?.error ?? 'Could not read the decision gate')
        else setData(body as Resp)
      })
      .catch(() => { if (!cancelled) setError('Could not read the decision gate') })
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
        {error} — so whether new advice can be generated is unknown, not confirmed.
      </p>
    )
  }
  if (!data) {
    return <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Checking…</p>
  }

  // A run that ended before the gate was evaluated. Never reported as a passing gate.
  if (data.status === 'not_recorded' || !data.gate) {
    return (
      <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
        No sync has recorded a decision-gate verdict yet. This is unknown, not open.
      </p>
    )
  }

  const { gate } = data
  const live = gate.verdict === 'live'

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span
          className="text-[12px] font-bold uppercase tracking-wide"
          style={{ color: live ? 'var(--success)' : 'var(--warning)' }}
        >
          {live ? 'Generating advice' : 'Advice frozen'}
        </span>
        {data.recordedAt && (
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            as of {new Date(data.recordedAt).toLocaleString()}
          </span>
        )}
      </div>

      <ul className="space-y-1">
        {data.gateNames.map((name) => {
          const open = gate.gates[name] === true
          return (
            <li key={name} className="flex items-start gap-2 text-[12px]">
              <span
                aria-hidden
                style={{ color: open ? 'var(--success)' : 'var(--warning)' }}
              >
                {open ? '✓' : '✗'}
              </span>
              <span style={{ color: open ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                {GATE_LABELS[name] ?? name}
              </span>
            </li>
          )
        })}
      </ul>

      {!live && (
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {gate.closedBy.length === 1
            ? 'One check is holding advice back. Clearing it releases the rest.'
            : `${gate.closedBy.length} checks are holding advice back — all of them must clear.`}
        </p>
      )}

      {gate.metaOutcomeBlockerCodes.length > 0 && (
        <details className="text-[12px]">
          <summary style={{ color: 'var(--text-tertiary)', cursor: 'pointer' }}>
            {gate.metaOutcomeBlockerCodes.length} conversion-data gap
            {gate.metaOutcomeBlockerCodes.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {gate.metaOutcomeBlockerCodes.map((code) => (
              <li key={code} style={{ color: 'var(--text-secondary)' }} data-blocker-code={code}>
                {blockerLabel(code)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
