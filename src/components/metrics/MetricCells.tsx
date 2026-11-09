'use client'

import { ChevronUp, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatMetric, metricTone, type MetricDef, type MetricTone } from '@/lib/metrics/catalog'
import type { EntityMetrics } from '@/lib/metrics/aggregate'

const TONE_TEXT: Record<MetricTone, string> = {
  good: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
  neutral: 'var(--text-secondary)',
}

// Sortable <th> cells for the visible metric columns. `sortKey` is the metric key currently sorted on.
export function MetricHeaderCells({
  defs,
  sortKey,
  sortDir,
  onSort,
}: {
  defs: MetricDef[]
  sortKey: string | null
  sortDir: 'asc' | 'desc'
  onSort: (key: string) => void
}) {
  return (
    <>
      {defs.map((d) => {
        const active = sortKey === d.key
        return (
          <th
            key={d.key}
            aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            title={d.description ?? d.label}
            className={cn('whitespace-nowrap', d.align === 'right' ? 'text-right' : 'text-left')}
            style={{ color: 'var(--text-tertiary)' }}
          >
            <button
              type="button"
              onClick={() => onSort(d.key)}
              aria-label={`Sort by ${d.label}${active ? `, currently ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ''}`}
              className={cn('flex min-h-11 w-full items-center gap-1 text-inherit transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60', d.align === 'right' && 'justify-end')}
            >
              {d.header}
              {active
                ? (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" style={{ color: 'var(--accent)' }} /> : <ChevronDown className="w-3 h-3" style={{ color: 'var(--accent)' }} />)
                : <ChevronUp className="w-3 h-3" style={{ color: 'var(--text-tertiary)', opacity: 0.4 }} />}
            </button>
          </th>
        )
      })}
    </>
  )
}

// Matching <td> cells for one entity row's metrics.
export function MetricBodyCells({
  defs,
  metrics,
  windowDays,
  showBands = true,
}: {
  defs: MetricDef[]
  metrics: EntityMetrics | null
  windowDays: number
  /** False keeps raw metrics visually neutral on evidence-only surfaces. */
  showBands?: boolean
}) {
  return (
    <>
      {defs.map((d) => {
        const value = metrics ? (metrics[d.key] as number | null) : null
        const tone: MetricTone = metrics && showBands ? metricTone(d, metrics, windowDays) : 'neutral'
        return (
          <td key={d.key} className={cn('tabular-nums text-sm', d.align === 'right' ? 'text-right' : 'text-left')} style={{ color: TONE_TEXT[tone] }}>
            {formatMetric(d, value)}
          </td>
        )
      })}
    </>
  )
}
