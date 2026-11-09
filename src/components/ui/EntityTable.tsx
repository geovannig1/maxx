'use client'

import type { ComponentType, ReactNode } from 'react'
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { MetricHeaderCells, MetricBodyCells } from '@/components/metrics/MetricCells'
import type { MetricDef } from '@/lib/metrics/catalog'
import type { EntityMetrics } from '@/lib/metrics/aggregate'

/**
 * Foundation primitive: one table, per acceptance bar 6.
 *
 * WHAT WAS ACTUALLY DUPLICATED. The metric COLUMNS were already shared (`metricsForLevel` plus
 * MetricHeaderCells/MetricBodyCells). What was triplicated across performance/campaigns, /adsets
 * and /ads is the SHELL around them — the card wrapper, the sortable leading headers, the
 * four-state body (loading skeleton / error / empty / rows), the colSpan arithmetic, and the
 * trailing open-details chevron. `SortIcon` was pasted four times: those three pages plus
 * /performance/segments.
 *
 * So this owns the shell and delegates metric columns to the existing contract. It does not
 * re-implement what already worked, and it does not try to own the ads page's second table, which
 * is a creative-detail table and a different thing.
 */

export type EntityColumn<T> = {
  key: string
  label: string
  /** Given, the header becomes a sort control. Omitted, it is a plain label. */
  sortKey?: string
  align?: 'left' | 'right'
  /** Tailwind width/spacing class, e.g. `w-64`. */
  className?: string
  render: (row: T) => ReactNode
}

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) {
    return <ChevronUp className="w-3 h-3" style={{ color: 'var(--text-tertiary)', opacity: 0.4 }} />
  }
  return dir === 'asc'
    ? <ChevronUp className="w-3 h-3" style={{ color: 'var(--accent)' }} />
    : <ChevronDown className="w-3 h-3" style={{ color: 'var(--accent)' }} />
}

export function EntityTable<T>({
  columns,
  trailingColumns = [],
  rows,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  empty,
  sortKey,
  sortDir,
  onSort,
  metrics,
  onOpen,
  openLabel,
}: {
  /** Entity-specific leading columns. Metric columns are appended from `metrics.defs`. */
  columns: EntityColumn<T>[]
  /**
   * Columns that sit AFTER the metric columns and before the open chevron. /performance/ads puts
   * its Diagnostic column there; added because a real caller needs it, not on spec.
   */
  trailingColumns?: EntityColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  /** The owner-facing error title. `null` means no error. */
  error?: string | null
  onRetry?: () => void
  /** Shown when there is no error and no rows. Never a blank body (bar 3). */
  empty: { icon: ComponentType<{ className?: string }>; title: string; description: string }
  sortKey: string | null
  sortDir: 'asc' | 'desc'
  onSort: (key: string) => void
  metrics?: {
    defs: MetricDef[]
    forRow: (row: T) => EntityMetrics | null
    windowDays: number
    showBands?: boolean
  }
  /** Given, each row gets a trailing chevron that opens detail. */
  onOpen?: (row: T) => void
  openLabel?: (row: T) => string
}) {
  const metricDefs = metrics?.defs ?? []
  // Leading + metric + (chevron). Computed here so no caller keeps an arithmetic constant in sync
  // with its own header row by hand — all three pages did, and a wrong colSpan silently misaligns
  // the empty and error states rather than failing.
  const colCount = columns.length + metricDefs.length + trailingColumns.length + (onOpen ? 1 : 0)

  const headerCell = (col: EntityColumn<T>) => {
    const active = col.sortKey != null && sortKey === col.sortKey
    return (
      <th
        key={col.key}
        aria-sort={col.sortKey
          ? (active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none')
          : undefined}
        className={['whitespace-nowrap', col.className, col.align === 'right' ? 'text-right' : '']
          .filter(Boolean).join(' ')}
        // No inline colour. The old adsets/ads headers used a bare <th> and inherited
        // `.data-table th { color: var(--text-secondary) }`; forcing --text-tertiary here dropped
        // 12px uppercase header contrast on --bg-subtle from 6.87:1 to 4.80:1 — still over the 4.5:1
        // AA floor, but a real regression against the stylesheet the rest of the app agrees on.
      >
        {col.sortKey ? (
          <button
            type="button"
            onClick={() => onSort(col.sortKey as string)}
            aria-label={`Sort by ${col.label}${active ? `, currently ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ''}`}
            // `justify-end` was dropped when SortHead was absorbed. `text-right` on the <th> does
            // nothing to a flex child, so /performance/adsets — whose Budget/d column is both
            // sortKey and align:'right' — rendered its label and chevron hard left over
            // right-aligned numbers, in the same header row where the metric columns (MetricCells
            // .tsx:43, which had it right all along) were correctly justified.
            className={[
              'flex min-h-11 w-full items-center gap-1 text-inherit',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60',
              col.align === 'right' ? 'justify-end' : '',
            ].filter(Boolean).join(' ')}
          >
            {col.label}
            <SortIcon active={active} dir={sortDir} />
          </button>
        ) : (
          col.label
        )}
      </th>
    )
  }

  const bodyCell = (col: EntityColumn<T>, row: T) => (
    <td
      key={col.key}
      className={[col.align === 'right' ? 'text-right' : '', col.className].filter(Boolean).join(' ') || undefined}
    >
      {col.render(row)}
    </td>
  )

  return (
    <div className="card-base overflow-hidden">
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map(headerCell)}
              {metrics && (
                <MetricHeaderCells defs={metricDefs} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              )}
              {trailingColumns.map(headerCell)}
              {onOpen && <th className="w-8" />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skeleton-${i}`}>
                  {Array.from({ length: colCount }).map((_, j) => (
                    <td key={j}><Skeleton className="h-4 w-full" /></td>
                  ))}
                </tr>
              ))
            ) : error ? (
              <tr>
                <td colSpan={colCount} className="p-0">
                  <ErrorState title={error} onRetry={onRetry} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="p-0">
                  <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={rowKey(row)} className="group">
                  {columns.map((col) => bodyCell(col, row))}
                  {metrics && (
                    <MetricBodyCells
                      defs={metricDefs}
                      metrics={metrics.forRow(row)}
                      windowDays={metrics.windowDays}
                      showBands={metrics.showBands ?? false}
                    />
                  )}
                  {trailingColumns.map((col) => bodyCell(col, row))}
                  {onOpen && (
                    <td>
                      <button
                        type="button"
                        onClick={() => onOpen(row)}
                        aria-label={openLabel ? openLabel(row) : 'Open details'}
                        title="Open details"
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        <ChevronRight className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
