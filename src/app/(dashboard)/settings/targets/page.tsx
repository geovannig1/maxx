'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, RotateCcw, Save } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { applyTargetOverrides } from '@/lib/targets/target-ranges'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

interface MetricRange {
  metric: string
  label: string
  unit: string
  direction: 'lower_is_better' | 'higher_is_better'
  /** null for a cost metric (CPA, CPL, CPC, CPM): no default target until the owner sets one. */
  excellent: number | null
  healthy: number | null
  watch: number | null
  minSpend: number
  minClicks: number
  minBookings: number
  minDays: number
  provisional: boolean
}

const BAND_FIELDS = [['excellent', 'Excellent'], ['healthy', 'Healthy'], ['watch', 'Watch']] as const
const GATE_FIELDS = [['minSpend', 'Min spend'], ['minClicks', 'Min clicks'], ['minBookings', `Min ${OW.many}`], ['minDays', 'Min days']] as const

export default function TargetsEditorPage() {
  const [defaults, setDefaults] = useState<Record<string, MetricRange>>({})
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // Block a save whose band edges are inverted (a bad value would read as good).
  const [orderError, setOrderError] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/targets', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { setDefaults(d.defaults ?? {}); setEdits(d.overrides ?? {}) })
      .catch(() => toast.error('Failed to load targets'))
      .finally(() => setLoading(false))
  }, [])

  function setField(metric: string, field: string, raw: string) {
    setEdits((prev) => {
      const next = { ...prev, [metric]: { ...(prev[metric] ?? {}) } }
      if (raw.trim() === '') {
        delete next[metric][field]
      } else {
        const n = parseFloat(raw)
        if (Number.isFinite(n) && n >= 0) next[metric][field] = n
      }
      if (Object.keys(next[metric]).length === 0) delete next[metric]
      return next
    })
  }

  function resetMetric(metric: string) {
    setEdits((prev) => { const n = { ...prev }; delete n[metric]; return n })
  }

  // Mirror the server's validateRangeOrdering on the EFFECTIVE bands (defaults + edits): lower_is_better
  // needs excellent ≤ healthy ≤ watch; higher_is_better the reverse. Reject before the API round-trip.
  function orderingErrors(payload: Record<string, Record<string, number>>): string[] {
    const errs: string[] = []
    for (const m of Object.values(defaults)) {
      const o = payload[m.metric] ?? {}
      const excellent = o.excellent ?? m.excellent
      const healthy = o.healthy ?? m.healthy
      const watch = o.watch ?? m.watch
      if (excellent === null && healthy === null && watch === null) continue // no target for this cost metric
      if (healthy === null || watch === null) {
        errs.push(`${m.label}: set both the healthy (target) and watch (maximum) edges, or none.`)
        continue
      }
      const top = excellent ?? healthy // excellent is optional on a cost target
      const ordered = m.direction === 'lower_is_better'
        ? top <= healthy && healthy <= watch
        : top >= healthy && healthy >= watch
      if (!ordered) {
        const rule = m.direction === 'lower_is_better' ? 'excellent ≤ healthy ≤ watch' : 'excellent ≥ healthy ≥ watch'
        errs.push(`${m.label}: bands must satisfy ${rule} (got excellent ${excellent}, healthy ${healthy}, watch ${watch}).`)
      }
    }
    return errs
  }

  async function save(payload: Record<string, Record<string, number>>) {
    const bandErrors = orderingErrors(payload)
    if (bandErrors.length > 0) {
      setOrderError(bandErrors)
      toast.error('Band edges are out of order — fix them before saving.')
      return
    }
    setOrderError([])
    setSaving(true)
    try {
      const res = await fetch('/api/targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (res.ok) {
        const d = await res.json()
        applyTargetOverrides(d.overrides ?? {}) // take effect in this browser session immediately
        toast.success('Targets saved — bands update across the app on next view.')
      } else {
        const b = await res.json().catch(() => ({}))
        toast.error(b.error ?? 'Save failed')
      }
    } catch { toast.error('Network error') }
    finally { setSaving(false) }
  }

  const metrics = Object.values(defaults)
  const overriddenCount = Object.keys(edits).length

  function fieldValue(metric: string, field: string): string {
    const v = edits[metric]?.[field]
    return v === undefined ? '' : String(v)
  }

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/settings" className="flex items-center gap-1 text-xs mb-2 hover:opacity-80 transition-opacity" style={{ color: 'var(--text-tertiary)' }}>
            <ArrowLeft className="w-3 h-3" /> Settings
          </Link>
          <h1 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.025em' }}>Performance Targets</h1>
          <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
            The band thresholds and minimum-data gates that drive every Healthy / Watch / Critical colour across the app. Leave a field blank to use the default. Cost metrics have no default: set a target to have them judged.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { setEdits({}); save({}) }}
            disabled={saving || overriddenCount === 0}
            className="flex items-center gap-1.5 rounded-lg text-xs transition-colors disabled:opacity-40"
            style={{ height: 32, padding: '0 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset all
          </button>
          <button
            onClick={() => save(edits)}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            style={{ height: 32, padding: '0 14px', background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff' }}
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : `Save${overriddenCount ? ` (${overriddenCount})` : ''}`}
          </button>
        </div>
      </div>

      {orderError.length > 0 && (
        <div className="rounded-lg p-3 space-y-1" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>Band edges are out of order — nothing was saved:</p>
          {orderError.map((e, i) => (
            <p key={i} className="text-xs" style={{ color: 'var(--danger)' }}>· {e}</p>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
      ) : (
        <div className="space-y-3">
          {metrics.map((m) => {
            const isOverridden = !!edits[m.metric]
            return (
              <div key={m.metric} className="card-base p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{m.label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', color: 'var(--text-tertiary)' }}>
                      {m.unit === '$' ? '$' : m.unit === '%' ? '%' : m.unit === 'x' ? '×' : '#'} · {m.direction === 'lower_is_better' ? 'lower is better' : 'higher is better'}
                    </span>
                    {m.provisional && <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>provisional</span>}
                  </div>
                  {isOverridden && (
                    <button onClick={() => resetMetric(m.metric)} className="flex items-center gap-1 text-[10px] hover:opacity-80" style={{ color: 'var(--accent)' }}>
                      <RotateCcw className="w-3 h-3" /> Reset
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {BAND_FIELDS.map(([field, label]) => (
                    <label key={field} className="block">
                      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
                      <input
                        type="number" min="0" step="any"
                        value={fieldValue(m.metric, field)}
                        placeholder={m[field] === null ? 'Set a target' : String(m[field])}
                        onChange={(e) => setField(m.metric, field, e.target.value)}
                        className="w-full h-8 px-2 mt-0.5 rounded-md text-sm tabular-nums focus:outline-none"
                        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                    </label>
                  ))}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {GATE_FIELDS.map(([field, label]) => (
                    <label key={field} className="block">
                      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
                      <input
                        type="number" min="0" step="any"
                        value={fieldValue(m.metric, field)}
                        placeholder={String(m[field as keyof MetricRange])}
                        onChange={(e) => setField(m.metric, field, e.target.value)}
                        className="w-full h-8 px-2 mt-0.5 rounded-md text-sm tabular-nums focus:outline-none"
                        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        Bands are ordered by the metric direction (e.g. for CPL: excellent ≤ healthy ≤ watch, anything above = critical).
        Min-data gates suppress a verdict until there&apos;s enough spend / clicks / {OW.many} / days. Changes apply to the
        on-screen colours and the verdict engine; saved per ad account.
      </p>
    </div>
  )
}
