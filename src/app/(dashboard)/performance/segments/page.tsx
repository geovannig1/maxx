'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { PageHeader } from '@/components/layout/PageHeader'
import { daysInRange } from '@/lib/date-range'
import { LowDataBanner } from '@/components/ui/LowDataBanner'
import { useGlobalControls } from '@/lib/use-global-controls'
import { ChevronUp, ChevronDown, PieChart } from 'lucide-react'
import { emptyMetrics, type EntityMetrics } from '@/lib/metrics/aggregate'
import { compareUnknownLast, metricSortValue } from '@/lib/metrics/collation'
import { METRIC_BY_KEY } from '@/lib/metrics/catalog'
import { MetricHeaderCells, MetricBodyCells } from '@/components/metrics/MetricCells'
import { ExportCsvButton } from '@/components/export/ExportCsvButton'
import { SEGMENT_DIMENSIONS, SEGMENT_METRIC_KEYS, DIMENSION_BY_KEY } from '@/lib/segments/dimensions'
import { DaypartHeatmap, type DaypartRow } from '@/components/charts/DaypartHeatmap'
import { metaOutcomeEventName } from '@/config/business-config'

// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

interface Segment {
  value: string
  label: string
  metrics: EntityMetrics
}

const TABS: Array<{ key: string; label: string }> = [
  ...SEGMENT_DIMENSIONS.map((d) => ({ key: d.key, label: d.label })),
  { key: 'daypart', label: 'Day-part' },
]

const segmentDefs = SEGMENT_METRIC_KEYS.map((k) => METRIC_BY_KEY[k]).filter(Boolean)

// Module-level (not defined in render — avoids remounting each render).
function SortIcon({ col, sortKey, sortDir }: { col: string; sortKey: string; sortDir: 'asc' | 'desc' }) {
  if (sortKey !== col) return <ChevronUp className="w-3 h-3" style={{ color: 'var(--text-tertiary)', opacity: 0.4 }} />
  return sortDir === 'asc' ? <ChevronUp className="w-3 h-3" style={{ color: 'var(--accent)' }} /> : <ChevronDown className="w-3 h-3" style={{ color: 'var(--accent)' }} />
}

export default function SegmentsPage() {
  // Global date range — shared across all Performance tabs + persisted (URL + localStorage).
  const { range, setRange, ready } = useGlobalControls()
  const [dim, setDim] = useState<string>('platform')
  const [segments, setSegments] = useState<Segment[]>([])
  const [totals, setTotals] = useState<EntityMetrics>(emptyMetrics())
  const [daypart, setDaypart] = useState<DaypartRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<string>('spend')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const { from, to } = range
  const days = useMemo(() => daysInRange(from, to), [from, to])
  const isDaypart = dim === 'daypart'

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (dim === 'daypart') {
        const res = await fetch(`/api/daypart?from=${from}&to=${to}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('daypart')
        const data = await res.json()
        setDaypart(data.data ?? [])
      } else {
        const res = await fetch(`/api/segments?dimension=${dim}&from=${from}&to=${to}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('segments')
        const data = await res.json()
        setSegments(data.segments ?? [])
        setTotals(data.totals ?? emptyMetrics())
      }
    } catch {
      setError('Failed to load segment data.')
    } finally {
      setLoading(false)
    }
  }, [dim, from, to])

  useEffect(() => {
    if (!ready) return
    // Defer past the synchronous effect tick so fetchData's setState isn't synchronous-in-effect.
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchData() })()
    return () => { active = false }
  }, [fetchData, ready])

  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  function sortVal(s: Segment): number | string | null {
    if (sortKey === 'label') return s.label
    return metricSortValue(s.metrics, sortKey)
  }

  const sorted = [...segments].sort((a, b) => compareUnknownLast(sortVal(a), sortVal(b), sortDir))

  const maxSpend = segments.reduce((m, s) => Math.max(m, s.metrics.spend), 0)
  const colCount = 2 + segmentDefs.length // Segment, Share + metrics
  const dimDef = DIMENSION_BY_KEY[dim]

  function exportData() {
    const headers = [dimDef?.label ?? 'Segment', 'Spend share %', ...segmentDefs.map((d) => d.label)]
    const rows = sorted.map((s) => [
      s.label,
      totals.spend > 0 ? Math.round((s.metrics.spend / totals.spend) * 100) : 0,
      ...segmentDefs.map((d) => s.metrics[d.key]),
    ])
    return { headers, rows }
  }

  // Day-part summary: cheapest hour-block with Meta modelled Results.
  const daypartBest = daypart
    .filter((d) => d.spend > 0 && d.cpa !== null && d.bookings > 0)
    .sort((a, b) => (a.cpa ?? Infinity) - (b.cpa ?? Infinity))[0]
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hourLabel = (h: number) => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`


  return (
    <div className="space-y-4">
      {/* Header — shared PageHeader (freshness + write-mode standardized). */}
      <PageHeader
        title="Segments"
        icon={PieChart}
        subtitle={isDaypart ? 'When your audience converts — hour × day-of-week' : (dimDef?.description ?? 'Performance by audience segment')}
        controls={!isDaypart ? (
          <div className="flex items-center gap-2">
            <ExportCsvButton filename={`segments_${dim}_${from}_${to}.csv`} getData={exportData} disabled={loading || sorted.length === 0} />
            <DateRangeControl value={range} onChange={setRange} className="md:hidden" />
          </div>
        ) : undefined}
      />

      {/* Dimension tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const active = dim === t.key
          return (
            <button
              key={t.key}
              onClick={() => setDim(t.key)}
              className="rounded-lg text-xs font-medium transition-colors"
              style={{
                height: 30, padding: '0 12px',
                background: active ? 'var(--accent-dim)' : 'var(--bg-input)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Honest low-data calibration — shows only when delivering but still too thin to judge (never on
          a dormant/empty view, where the table's EmptyState explains it). Not shown on the day-part tab. */}
      {!isDaypart && <LowDataBanner spend={totals.spend} windowDays={days} entity="segments" />}

      {/* Day-part heatmap */}
      {isDaypart ? (
        <div className="card-base p-5">
          {loading ? (
            <Skeleton className="h-[520px] w-full rounded-lg" />
          ) : error ? (
            <ErrorState title="Couldn't load day-part data" onRetry={fetchData} />
          ) : daypart.length === 0 ? (
            <EmptyState icon={PieChart} title="No exact-range day-part data" description={`No day-part snapshot exactly matches ${from} → ${to}. A rolling snapshot is never substituted for the selected dates.`} />
          ) : (
            <>
              {daypartBest && (
                <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
                  Cheapest Meta Results: <span className="font-medium" style={{ color: 'var(--success)' }}>{DAY_NAMES[daypartBest.day]} {hourLabel(daypartBest.hour)}</span> at ${daypartBest.cpa?.toFixed(0)} cost / Result · {daypartBest.bookings} modelled Results.
                </p>
              )}
              <DaypartHeatmap data={daypart} />
            </>
          )}
        </div>
      ) : (
        <div className="card-base overflow-hidden">
          <div className="overflow-x-auto"><table className="data-table">
            <thead>
              <tr>
                <th aria-sort={sortKey === 'label' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className="text-left" style={{ color: 'var(--text-tertiary)' }}>
                  <button type="button" onClick={() => handleSort('label')} aria-label={`Sort by ${dimDef?.label ?? 'Segment'}${sortKey === 'label' ? `, currently ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ''}`} className="flex min-h-11 w-full items-center gap-1 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">{dimDef?.label ?? 'Segment'}<SortIcon col="label" sortKey={sortKey} sortDir={sortDir} /></button>
                </th>
                <th className="text-left w-32" style={{ color: 'var(--text-tertiary)' }}>Share</th>
                <MetricHeaderCells defs={segmentDefs} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: colCount }).map((_, j) => (
                      <td key={j}><Skeleton className="h-4 w-full rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : error ? (
                <tr><td colSpan={colCount} className="p-0"><ErrorState title="Couldn't load segments" onRetry={fetchData} /></td></tr>
              ) : sorted.length === 0 ? (
                <tr><td colSpan={colCount} className="p-0">
                  <EmptyState
                    icon={PieChart}
                    title={`No ${dimDef?.label.toLowerCase() ?? ''} data yet`}
                    description="Segment breakdowns sync nightly at ad-set level. If this dimension was just added, it will populate after the next sync."
                  />
                </td></tr>
              ) : (
                sorted.map((s) => {
                  const share = maxSpend > 0 ? (s.metrics.spend / maxSpend) * 100 : 0
                  const sharePct = totals.spend > 0 ? (s.metrics.spend / totals.spend) * 100 : 0
                  return (
                    <tr key={s.value}>
                      <td className="font-medium" style={{ color: 'var(--text-primary)' }}>{s.label}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 rounded-full overflow-hidden w-16" style={{ background: 'var(--bg-overlay)' }}>
                            <div className="h-full rounded-full" style={{ width: `${share}%`, background: 'var(--accent)' }} />
                          </div>
                          <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{sharePct.toFixed(0)}%</span>
                        </div>
                      </td>
                      <MetricBodyCells defs={segmentDefs} metrics={s.metrics} windowDays={days} showBands={false} />
                    </tr>
                  )
                })
              )}
            </tbody>
          </table></div>
        </div>
      )}

      {!isDaypart && !loading && !error && sorted.length > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          Breakdowns are captured at ad-set level and aggregated account-wide. Meta Results are modelled {EVENT} attribution; cost / Result is spend divided by modelled Results. Native period reach and frequency aren&apos;t available at the segment level.
        </p>
      )}
    </div>
  )
}
