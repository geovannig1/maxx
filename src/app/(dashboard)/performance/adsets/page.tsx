'use client'
import { resolveDisplayAuthority } from '@/lib/authority/legacy-cutover'

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { CampaignStatusBadge } from '@/components/campaigns/CampaignStatusBadge'
import { LowDataBanner } from '@/components/ui/LowDataBanner'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { daysInRange } from '@/lib/date-range'
import { useGlobalControls } from '@/lib/use-global-controls'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { SourceBadge, flagDiagnosticLabel } from '@/components/ui/badges'
import { Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SlidePanel, PanelMetricGrid, PanelMetric, PanelSection,
} from '@/components/ui/slide-panel'
import { type EntityMetrics } from '@/lib/metrics/aggregate'
import { compareUnknownLast, metricSortValue, sumMeasured } from '@/lib/metrics/collation'
import { metricsForLevel } from '@/lib/metrics/catalog'
import { useColumnVisibility } from '@/components/metrics/useColumnVisibility'
import { ColumnChooser } from '@/components/metrics/ColumnChooser'
import { ExportCsvButton } from '@/components/export/ExportCsvButton'
import { PaceCell, PaceBar } from '@/components/insights/PaceCell'
import { computePacing } from '@/lib/insights/pacing'
import { useSavedViews, type TableViewState } from '@/components/views/useSavedViews'
import { EntityTable } from '@/components/ui/EntityTable'
import { SavedViewsControl } from '@/components/views/SavedViewsControl'
import { usePerformancePresetColumns } from '@/components/performance/usePerformancePresetColumns'
import { buildPerformanceDrilldownHref, performancePresetFromSearch } from '@/lib/performance/presets'
import { outcomeWords } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

interface AdSet {
  adset_id: string
  adset_name: string
  campaign_name: string
  status: string
  daily_budget: number | null
  days_delivering?: number
  optimization_goal: string | null
  metrics: EntityMetrics | null
}

interface Flag {
  flag_type: string
  reason: string
  recommended_action: string | null
  confidence: string
  window_days?: number // Surface the flag's evaluation window so it's never silently mismatched
}

type SortDir = 'asc' | 'desc'

const FLAG_STYLES: Record<string, string> = {
  winner: 'bg-[var(--success-bg)] border-[var(--success-border)] text-[var(--success)]',
  loser: 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger)]',
  scale_candidate: 'bg-[var(--accent-dim)] border-[var(--border-focus)] text-[var(--accent)]',
  watchlist: 'bg-[var(--warning-bg)] border-[var(--warning-border)] text-[var(--warning)]',
  creative_refresh: 'bg-orange-500/10 border-orange-500/20 text-orange-400',
  too_early: 'bg-[var(--border)] border-[var(--border)] text-[var(--text-tertiary)]',
}

function selectedWindowMetrics(metrics: EntityMetrics | null, windowDays: number): EntityMetrics | null {
  if (!metrics || windowDays === 1 || metrics.frequency === null) return metrics
  return { ...metrics, frequency: null }
}

function AdSetsPageInner() {
  const searchParams = useSearchParams()
  const campaignFilter = searchParams.get('campaign') // drill-down from a campaign
  const performancePreset = performancePresetFromSearch(searchParams.toString()) ?? 'delivery'
  // Global date range — shared across all Performance tabs + persisted (URL + localStorage).
  const { range, setRange, ready } = useGlobalControls()
  const [sortKey, setSortKey] = useState<string>('spend')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [adsets, setAdsets] = useState<AdSet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AdSet | null>(null)
  const [flags, setFlags] = useState<Flag[]>([])
  const [flagsLoading, setFlagsLoading] = useState(false)

  const { isVisible, toggle, reset, setVisibleKeys } = useColumnVisibility('adset')
  const visibleDefs = metricsForLevel('adset').filter((d) => isVisible(d.key))
  const savedViews = useSavedViews('adset')

  function captureState(): TableViewState {
    return { columns: visibleDefs.map((d) => d.key), sortKey, sortDir }
  }
  function applyState(s: TableViewState) {
    if (s.columns) setVisibleKeys(s.columns)
    if (s.sortKey) setSortKey(s.sortKey)
    if (s.sortDir) setSortDir(s.sortDir)
  }
  const appliedView = useRef(false)
  useEffect(() => {
    if (!savedViews.loaded || appliedView.current) return
    appliedView.current = true
    const v = savedViews.views.find((x) => x.id === savedViews.activeId)
    // Defer the state writes past the synchronous effect tick (avoids set-state-in-effect).
    if (v) void Promise.resolve().then(() => applyState(v.state))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViews.loaded])
  usePerformancePresetColumns('adset', setVisibleKeys)

  const { from, to } = range
  const days = useMemo(() => daysInRange(from, to), [from, to])

  const fetchAdSets = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSelected(null)
    try {
      const q = campaignFilter ? `&campaign=${encodeURIComponent(campaignFilter)}` : ''
      const res = await fetch(`/api/adsets?from=${from}&to=${to}${q}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('ADSETS_READ_FAILED')
      const data = await res.json()
      if (!Array.isArray(data.adsets)) throw new Error('ADSETS_RESPONSE_INVALID')
      setAdsets(data.adsets)
    } catch {
      setAdsets([])
      setError('Failed to load ad sets.')
    }
    finally { setLoading(false) }
  }, [from, to, campaignFilter])

  useEffect(() => {
    if (!ready) return
    // Defer past the synchronous effect tick so fetchAdSets's setState isn't synchronous-in-effect.
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchAdSets() })()
    return () => { active = false }
  }, [fetchAdSets, ready])

  async function openPanel(adset: AdSet) {
    setSelected(adset)
    setFlags([])
    setFlagsLoading(true)
    try {
      const params = new URLSearchParams({ limit: '10', from: range.from, to: range.to })
      const res = await fetch(`/api/flags?${params}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        const relevant = (data.flags ?? []).filter(
          (f: Record<string, unknown>) => f.meta_adset_id === adset.adset_id
        )
        setFlags(relevant)
      }
    } catch { setFlags([]) }
    finally { setFlagsLoading(false) }
  }

  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function sortVal(a: AdSet): number | string | null {
    if (sortKey === 'adset_name') return a.adset_name ?? ''
    // An unset daily budget is unknown (the ad set may be on a campaign budget), not $0.
    if (sortKey === 'daily_budget') return a.daily_budget ?? null
    return metricSortValue(selectedWindowMetrics(a.metrics, days), sortKey)
  }

  const sorted = [...adsets].sort((a, b) => compareUnknownLast(sortVal(a), sortVal(b), sortDir))

  // Summary stats
  const spendSum = sumMeasured(adsets, a => a.metrics, 'spend')
  const totalSpend = spendSum.total
  const resultsSum = sumMeasured(adsets, a => a.metrics, 'bookings')
  const totalModelledResults = resultsSum.total
  const unmeasuredAdsets = spendSum.unmeasured
  const measuredEntityCount = adsets.length - unmeasuredAdsets
  const metaCostPerResult = measuredEntityCount > 0 && totalModelledResults > 0
    ? totalSpend / totalModelledResults
    : null


  function exportData() {
    const headers = ['Status', 'Ad Set', 'Campaign', 'Goal', 'Daily budget', 'Pace %', ...visibleDefs.map((d) => d.label)]
    const rows = sorted.map((a) => {
      const displayMetrics = selectedWindowMetrics(a.metrics, days)
      return [
        a.status, a.adset_name, a.campaign_name, a.optimization_goal ?? '', a.daily_budget,
        a.daily_budget !== null && a.metrics ? Math.round(computePacing(a.metrics.spend, a.daily_budget, days, a.days_delivering).pct) : null,
        ...visibleDefs.map((d) => displayMetrics?.[d.key] ?? null),
      ]
    })
    return { headers, rows }
  }
  const exportName = `adsets_${from}_${to}.csv`

  const sel = selectedWindowMetrics(selected?.metrics ?? null, days)

  return (
    <div className="space-y-4">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
      <PageHeader
        title="Ad Sets"
        icon={Layers}
        subtitle="Every ad set's audience, budget, and pace — click a row to open the ads inside it."
        controls={
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source="meta" />
            <SavedViewsControl
              views={savedViews.views}
              activeId={savedViews.activeId}
              onApply={(v) => applyState(v.state)}
              onSaveNew={(name) => savedViews.saveView(name, captureState())}
              onUpdateActive={() => { if (savedViews.activeId) savedViews.updateView(savedViews.activeId, captureState()) }}
              onDelete={savedViews.removeView}
            />
            <ExportCsvButton filename={exportName} getData={exportData} disabled={loading || sorted.length === 0} />
            <ColumnChooser level="adset" isVisible={isVisible} onToggle={toggle} onReset={reset} />
            <DateRangeControl value={range} onChange={setRange} className="md:hidden" />
          </div>
        }
      />

      {/* Honest low-data calibration banner — shows only when delivering but still too thin to judge. */}
      <LowDataBanner spend={totalSpend} windowDays={days} entity="ad sets" />

      {/* Drill-down banner — when scoped to one campaign's ad sets */}
      {campaignFilter && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-2.5" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-focus)' }}>
          <span className="text-xs" style={{ color: 'var(--accent)' }}>
            Showing ad sets in <span className="font-semibold">{adsets[0]?.campaign_name ?? 'one campaign'}</span>
          </span>
          <Link href={buildPerformanceDrilldownHref('/performance/adsets', performancePreset, range)} className="flex min-h-11 items-center gap-1 px-2 text-xs transition-opacity hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft className="w-3 h-3" /> All ad sets
          </Link>
        </div>
      )}

      {/* Summary row */}
      {!loading && !error && adsets.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="card-base px-4 py-3">
            <p className="section-label">{unmeasuredAdsets > 0 ? 'Measured spend' : 'Spend'}</p>
            <p className="text-xl font-bold mt-1 tabular-nums" style={{ color: 'var(--text-primary)' }}>
              {measuredEntityCount > 0 ? `${formatMoney(totalSpend)}` : 'Unavailable'}
            </p>
            {unmeasuredAdsets > 0 && (
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                excludes {unmeasuredAdsets} ad set{unmeasuredAdsets === 1 ? '' : 's'} with no delivery data
              </p>
            )}
          </div>
          <div className="card-base px-4 py-3">
            <p className="section-label">Meta Results (modelled 7dc/1dv)</p>
            <p className="text-xl font-bold mt-1 tabular-nums" style={{ color: 'var(--text-primary)' }}>
              {measuredEntityCount > 0 ? totalModelledResults : 'Unavailable'}
            </p>
            {unmeasuredAdsets > 0 && (
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                excludes {unmeasuredAdsets} ad set{unmeasuredAdsets === 1 ? '' : 's'} with no delivery data
              </p>
            )}
          </div>
          <div className="card-base px-4 py-3">
            <p className="section-label">Meta cost / Result</p>
            <p className="text-xl font-bold mt-1 tabular-nums" style={{ color: metaCostPerResult === null ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
              {metaCostPerResult !== null ? `${formatMoney(metaCostPerResult)}` : 'Unavailable'}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>Meta spend ÷ modelled {EVENT} Result</p>
          </div>
        </div>
      )}

      {/* Table — shell shared with /performance/campaigns via EntityTable; only the ad-set
          specific leading columns are declared here. */}
      <EntityTable<AdSet>
        columns={[
          { key: 'status', label: 'Status', render: (a) => <CampaignStatusBadge status={a.status} /> },
          {
            key: 'name',
            label: 'Ad Set',
            sortKey: 'adset_name',
            className: 'max-w-[200px]',
            render: (a) => (
              <Link
                href={buildPerformanceDrilldownHref('/performance/ads', performancePreset, range, { adset: a.adset_id })}
                className="block text-sm font-medium truncate hover:text-[var(--accent)] transition-colors"
                style={{ color: 'var(--text-primary)' }}
                title="View this ad set's ads"
              >
                {a.adset_name}
              </Link>
            ),
          },
          {
            key: 'campaign',
            label: 'Campaign',
            className: 'max-w-[160px]',
            render: (a) => <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{a.campaign_name}</p>,
          },
          {
            key: 'goal',
            label: 'Goal',
            className: 'whitespace-nowrap',
            render: (a) => (
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {a.optimization_goal?.replace('OFFSITE_', '').replaceAll('_', ' ') ?? '—'}
              </span>
            ),
          },
          {
            key: 'budget',
            label: 'Budget/d',
            sortKey: 'daily_budget',
            align: 'right',
            render: (a) => (
              <span className="text-sm tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {a.daily_budget === null ? 'Unavailable' : formatMoney(a.daily_budget, { maximumFractionDigits: 0 })}
              </span>
            ),
          },
          {
            key: 'pace',
            label: 'Pace',
            align: 'right',
            className: 'whitespace-nowrap',
            render: (a) => a.metrics
              ? <PaceCell spend={a.metrics.spend} dailyBudget={a.daily_budget} days={days} daysDelivering={a.days_delivering} />
              : <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>—</span>,
          },
        ]}
        rows={sorted}
        rowKey={(a) => a.adset_id}
        loading={loading}
        error={error ? "Couldn't load ad sets" : null}
        onRetry={fetchAdSets}
        empty={{
          icon: Layers,
          title: 'No ad sets found',
          description: 'No ad sets delivered in this window. This usually means the account is paused/pre-launch or the range is narrow — try a wider range or run a sync. It is not necessarily a filter problem.',
        }}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        metrics={{
          defs: visibleDefs,
          forRow: (a) => selectedWindowMetrics(a.metrics, days),
          windowDays: days,
          showBands: false,
        }}
        onOpen={openPanel}
        openLabel={(a) => `Open details for ${a.adset_name}`}
      />

      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        Meta Results (modelled 7dc/1dv) are Meta&apos;s attributed {EVENT} actions. Meta cost / Result is spend divided by those modelled Results for this exact selected window.
      </p>

      {/* Detail panel */}
      <SlidePanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.adset_name ?? ''}
        subtitle={selected?.campaign_name}
        width="md"
      >
        {selected && !sel && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No delivery data was reported for this ad set in the selected window.
          </p>
        )}
        {selected && sel && (
          <>
            {/* Status + goal */}
            <div className="flex items-center gap-2 flex-wrap">
              <CampaignStatusBadge status={selected.status} />
              {selected.optimization_goal && (
                <Badge variant="outline" className="text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                  {selected.optimization_goal.replace('OFFSITE_', '').replace(/_/g, ' ')}
                </Badge>
              )}
              {selected.daily_budget !== null ? (
                <Badge variant="outline" className="text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                  {formatMoney(selected.daily_budget, { maximumFractionDigits: 0 })}/day budget
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-tertiary)' }}>
                  budget unavailable
                </Badge>
              )}
            </div>

            {/* Key metrics */}
            <PanelSection title="Performance">
              <PanelMetricGrid>
                <PanelMetric label="Spend" value={`${formatMoney(sel.spend)}`} />
                <PanelMetric label="Meta Results (modelled 7dc/1dv)" value={String(sel.bookings)} />
                <PanelMetric
                  label="Meta cost / Result"
                  value={sel.cpa !== null ? `${formatMoney(sel.cpa)}` : 'Unavailable'}
                  sub={`Meta spend ÷ modelled ${EVENT} Result`}
                />
                <PanelMetric label="Leads" value={String(sel.leads || '—')} />
                <PanelMetric
                  label="CPL"
                  value={sel.cpl !== null ? `${formatMoney(sel.cpl)}` : '—'}
                  sub={sel.cpl !== null ? `cost per lead — not per ${OW.one}` : undefined}
                />
                <PanelMetric label="CTR" value={sel.ctr !== null ? `${sel.ctr.toFixed(2)}%` : '—'} />
                <PanelMetric label="CPC" value={sel.cpc !== null ? `${formatMoney(sel.cpc)}` : '—'} />
                <PanelMetric label="CPM" value={sel.cpm !== null ? `${formatMoney(sel.cpm)}` : '—'} />
                <PanelMetric label="Peak daily reach" value={sel.reach.toLocaleString()} sub="Highest daily warehouse row; not deduplicated period reach" />
                <PanelMetric label="Impr." value={sel.impressions.toLocaleString()} />
                <PanelMetric label="Link clk" value={sel.link_clicks ? sel.link_clicks.toLocaleString() : '—'} />
                <PanelMetric
                  label="Daily frequency"
                  value={days === 1 && sel.frequency !== null ? sel.frequency.toFixed(2) : 'Unavailable'}
                  sub={days === 1 ? 'Exact daily Meta observation' : 'Daily-only; selected-period frequency is unavailable'}
                />
              </PanelMetricGrid>
            </PanelSection>

            {/* Per-entity budget pacing — spend vs this ad-set's own daily budget over the window */}
            <PanelSection title="Budget Pacing">
              <PaceBar spend={sel.spend} dailyBudget={selected.daily_budget} days={days} daysDelivering={selected.days_delivering} />
            </PanelSection>

            {/* Flags */}
            <PanelSection title="Active Flags">
              {flagsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 rounded-lg" />
                  <Skeleton className="h-12 rounded-lg" />
                </div>
              ) : flags.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No active flags for this ad set.</p>
              ) : (
                <div className="space-y-2">
                  {flags.map((f, i) => (
                    <div key={i} className={cn('rounded-lg border px-3 py-2.5 space-y-1', FLAG_STYLES[f.flag_type] ?? FLAG_STYLES.too_early)}>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">{flagDiagnosticLabel(f.flag_type)}</span>
                        <span className="text-[10px] opacity-50">· {f.confidence} confidence</span>
                        {f.window_days != null && <span className="text-[10px] opacity-50">· {f.window_days}d window</span>}
                      </div>
                      <p className="text-xs font-medium">{f.reason}</p>
                      {/* This rendered the STORED action prose. A flag carries no ActionDecision, so it is diagnostic by STRUCTURE — the resolver decides without reading the wording, and the raw text never reaches the owner as an instruction. */}
                      {f.recommended_action && (
                        <p className="text-xs opacity-70">{resolveDisplayAuthority(null, f.recommended_action).copy}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </PanelSection>

          </>
        )}
      </SlidePanel>
    </div>
  )
}

export default function AdSetsPage() {
  return (
    <Suspense fallback={<div className="space-y-4"><Skeleton className="h-8 w-48 rounded" /><Skeleton className="h-96 w-full rounded-lg" /></div>}>
      <AdSetsPageInner />
    </Suspense>
  )
}
