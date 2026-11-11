'use client'

import { useState, useEffect } from 'react'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { PageHeader } from '@/components/layout/PageHeader'
import { LowDataBanner } from '@/components/ui/LowDataBanner'
import { daysInRange } from '@/lib/date-range'
import { useGlobalControls } from '@/lib/use-global-controls'
import { ChevronUp, ChevronDown, ListChecks } from 'lucide-react'
import { ExportCsvButton } from '@/components/export/ExportCsvButton'
import { CATEGORY_LABEL, type ConversionCategory } from '@/lib/conversions/labels'
import { outcomeWords } from '@/config/outcome-nouns'
import { formatMoney, formatMoneyTrim } from '@/lib/utils/format-currency'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

interface ConversionEvent {
  action_type: string
  label: string
  category: ConversionCategory
  count: number
  value: number | null
  cost: number | null
}

const CATEGORY_COLOR: Record<ConversionCategory, string> = {
  conversion: 'var(--success)',
  traffic: 'var(--accent)',
  video: 'var(--chart-5)',
  engagement: 'var(--warning)',
  messaging: 'var(--chart-3)',
  other: 'var(--text-tertiary)',
}

type SortKey = 'label' | 'count' | 'value' | 'cost'

// Module-level (not defined in render — avoids remounting the component each render).
function SortHead({ col, label, right, sortKey, sortDir, onSort }: { col: SortKey; label: string; right?: boolean; sortKey: SortKey; sortDir: 'asc' | 'desc'; onSort: (k: SortKey) => void }) {
  const active = sortKey === col
  return (
    <th aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`whitespace-nowrap ${right ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-tertiary)' }}>
      <button type="button" onClick={() => onSort(col)} aria-label={`Sort by ${label}${active ? `, currently ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ''}`} className={`flex min-h-11 w-full items-center gap-1 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${right ? 'justify-end' : ''}`}>
        {label}
        {active ? (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" style={{ color: 'var(--accent)' }} /> : <ChevronDown className="w-3 h-3" style={{ color: 'var(--accent)' }} />) : <ChevronUp className="w-3 h-3" style={{ color: 'var(--text-tertiary)', opacity: 0.4 }} />}
      </button>
    </th>
  )
}

// Module-level (mirrors SortHead) — one headline tile for the summary strip.
function SummaryTile({ label, value, sub, numeric }: { label: string; value: string; sub?: string; numeric?: boolean }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 'var(--r-md)', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
      <div className="section-label">{label}</div>
      <div className={numeric ? 'tabular-nums' : undefined} style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '1px' }}>{sub}</div>}
    </div>
  )
}

export default function ConversionsPage() {
  // Use the persisted GLOBAL range (URL + localStorage) so the picker no longer silently resets
  // to 1M when you navigate here from another page that had, say, YTD selected.
  const { range, setRange } = useGlobalControls()
  const [events, setEvents] = useState<ConversionEvent[]>([])
  const [spend, setSpend] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cat, setCat] = useState<ConversionCategory | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('count')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const { from, to } = range
  const windowDays = daysInRange(from, to)

  const [nonce, setNonce] = useState(0) // bump to refetch (retry)

  useEffect(() => {
    // await-first IIFE so no setState runs synchronously in the effect (avoids the cascading-render lint).
    let active = true
    void (async () => {
      try {
        const res = await fetch(`/api/conversions?from=${from}&to=${to}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('conversions')
        const data = await res.json()
        if (active) { setEvents(data.events ?? []); setSpend(data.spend ?? 0); setError(null) }
      } catch {
        if (active) setError('Failed to load conversion events.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [from, to, nonce])

  // setState in an event handler is fine — this shows the loading state on retry.
  function onRetry() { setLoading(true); setError(null); setNonce((n) => n + 1) }

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  // Categories present, with counts, for the filter chips.
  const catCounts = new Map<ConversionCategory, number>()
  for (const e of events) catCounts.set(e.category, (catCounts.get(e.category) ?? 0) + 1)
  const cats = [...catCounts.keys()]

  const filtered = cat === 'all' ? events : events.filter((e) => e.category === cat)
  const sorted = [...filtered].sort((a, b) => {
    const av = sortKey === 'label' ? a.label : (a[sortKey] ?? -1)
    const bv = sortKey === 'label' ? b.label : (b[sortKey] ?? -1)
    if (av === bv) return 0
    return (av < bv ? -1 : 1) * (sortDir === 'asc' ? 1 : -1)
  })

  // Headline summary — computed from the same filtered rows the table renders (sorting doesn't change these).
  const totalConversions = filtered.reduce((s, e) => s + e.count, 0)
  const valueRows = filtered.filter((e) => e.value !== null)
  const totalValue = valueRows.reduce((s, e) => s + (e.value ?? 0), 0)
  const topEvent = filtered.reduce<ConversionEvent | null>((top, e) => (top === null || e.count > top.count ? e : top), null)

  function exportData() {
    const headers = ['Event', 'Category', 'Count', 'Value', 'Cost per action']
    const rows = sorted.map((e) => [e.label, CATEGORY_LABEL[e.category], e.count, e.value, e.cost])
    return { headers, rows }
  }

  return (
    <div className="owner-page">
      {/* Header — shared PageHeader (freshness + write-mode standardized). */}
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Meta raw diagnostic"
          icon={ListChecks}
          subtitle={`Every Meta-reported action — counts, value, and cost per action. This is never business ${OW.many} for ${from} → ${to}`}
          controls={
            <div className="flex flex-wrap items-center gap-2">
              <ExportCsvButton filename={`conversions_${from}_${to}.csv`} getData={exportData} disabled={loading || sorted.length === 0} />
              <DateRangeControl value={range} onChange={setRange} />
            </div>
          }
        />
      </div>

      <div className="owner-notice">
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Source: Meta delivery API.</span>
        Counts, values, and cost/action are platform-reported diagnostics. They do not equal recorded {OW.many}, revenue, or owner-booked business.
      </div>

      {/* Category filter chips */}
      {!loading && events.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(['all', ...cats] as Array<ConversionCategory | 'all'>).map((c) => {
            const active = cat === c
            const label = c === 'all' ? `All (${events.length})` : `${CATEGORY_LABEL[c]} (${catCounts.get(c)})`
            return (
              <button
                key={c}
                onClick={() => setCat(c)}
                className="owner-button rounded-lg text-xs font-medium transition-colors"
                style={{
                  padding: '0 11px',
                  background: active ? 'var(--accent-dim)' : 'var(--bg-input)',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {/* Honest low-data calibration — shows only when spend is delivering but still too thin to judge
          (never on a dormant/empty view, where the table's EmptyState explains it). */}
      <LowDataBanner spend={spend} windowDays={windowDays} entity="conversion events" />

      {/* Headline summary — the "what matters" before the raw rows. Reflects the active category filter. */}
      {!loading && !error && filtered.length > 0 && (
        <div className="owner-surface p-5 space-y-3">
          <p className="section-label">Summary{cat !== 'all' ? ` · ${CATEGORY_LABEL[cat]}` : ''}</p>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <SummaryTile
              label="Meta action count"
              value={totalConversions.toLocaleString()}
              sub={`${filtered.length} event type${filtered.length === 1 ? '' : 's'}`}
              numeric
            />
            <SummaryTile
              label="Total value"
              value={valueRows.length > 0 ? `${formatMoneyTrim(totalValue)}` : '—'}
              sub="where Meta reports value"
              numeric
            />
            {topEvent && (
              <SummaryTile
                label="Top event"
                value={topEvent.label}
                sub={`${topEvent.count.toLocaleString()} Meta-reported actions`}
              />
            )}
          </div>
          {/* Load-bearing definition surfaced here (also in the footer fine print) so the table reads without scrolling. */}
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            &ldquo;Cost / action&rdquo; is account spend &divide; that event&rsquo;s count &mdash; a rough per-event figure, not a true CPA.
          </p>
        </div>
      )}

      {/* Table */}
      <div className="owner-surface overflow-hidden">
        <div className="overflow-x-auto"><table className="data-table">
          <thead>
            <tr>
              <SortHead col="label" label="Event" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <th className="text-left" style={{ color: 'var(--text-tertiary)' }}>Category</th>
              <SortHead col="count" label="Count" right sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHead col="value" label="Value" right sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHead col="cost" label="Cost / action" right sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 5 }).map((_, j) => <td key={j}><Skeleton className="h-4 w-full rounded" /></td>)}</tr>
              ))
            ) : error ? (
              <tr><td colSpan={5} className="p-0"><ErrorState title="Couldn't load conversion events" onRetry={onRetry} /></td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={5} className="p-0">
                <EmptyState icon={ListChecks} title="No Meta raw actions" description={`No Meta-reported actions in this range. This is an empty diagnostic result, not zero owner ${OW.many}.`} />
              </td></tr>
            ) : (
              sorted.map((e) => (
                <tr key={e.action_type}>
                  <td className="font-medium" style={{ color: 'var(--text-primary)' }}>{e.label}</td>
                  <td>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="rounded-full" style={{ width: 6, height: 6, background: CATEGORY_COLOR[e.category] }} />
                      <span style={{ color: 'var(--text-secondary)' }}>{CATEGORY_LABEL[e.category]}</span>
                    </span>
                  </td>
                  <td className="text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{e.count.toLocaleString()}</td>
                  <td className="text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{e.value !== null ? `${formatMoneyTrim(e.value)}` : '—'}</td>
                  <td className="text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{e.cost !== null ? `${formatMoney(e.cost)}` : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table></div>
      </div>

      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        Meta-reported actions (7-day click / 1-day view attribution), account-level. Cost per action = spend {formatMoney(spend, { maximumFractionDigits: 0 })} ÷ event count.
        Categories can overlap (e.g. an engagement also counts toward page engagement). Values appear only where Meta reports a conversion value.
      </p>
    </div>
  )
}
