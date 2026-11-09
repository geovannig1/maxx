'use client'
import { resolveDisplayAuthority } from '@/lib/authority/legacy-cutover'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { useGlobalControls } from '@/lib/use-global-controls'
import { daysInRange } from '@/lib/date-range'
import { CampaignStatusBadge } from '@/components/campaigns/CampaignStatusBadge'
import { LowDataBanner } from '@/components/ui/LowDataBanner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Target, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { SourceBadge, flagDiagnosticLabel } from '@/components/ui/badges'
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

interface Campaign {
  campaign_id: string
  campaign_name: string
  status: string
  daily_budget: number | null
  days_delivering?: number
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

// Module-level (not defined in render — avoids remounting + the static-components lint).
function selectedWindowMetrics(metrics: EntityMetrics | null, windowDays: number): EntityMetrics | null {
  if (!metrics || windowDays === 1 || metrics.frequency === null) return metrics
  return { ...metrics, frequency: null }
}

export default function CampaignsPage() {
  const searchParams = useSearchParams()
  const performancePreset = performancePresetFromSearch(searchParams.toString()) ?? 'results'
  // Global date range — shared across all Performance tabs + persisted (URL + localStorage).
  const { range, setRange, ready } = useGlobalControls()
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<string>('spend')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Campaign | null>(null)
  const [flags, setFlags] = useState<Flag[]>([])
  const [flagsLoading, setFlagsLoading] = useState(false)

  const { isVisible, toggle, reset, setVisibleKeys } = useColumnVisibility('campaign')
  const visibleDefs = metricsForLevel('campaign').filter((d) => isVisible(d.key))
  const savedViews = useSavedViews('campaign')

  function captureState(): TableViewState {
    return { columns: visibleDefs.map((d) => d.key), sortKey, sortDir, search, status: statusFilter }
  }
  function applyState(s: TableViewState) {
    if (s.columns) setVisibleKeys(s.columns)
    if (s.sortKey) setSortKey(s.sortKey)
    if (s.sortDir) setSortDir(s.sortDir)
    setSearch(s.search ?? '')
    setStatusFilter(s.status ?? 'all')
  }
  // Re-apply the last-active saved view once, after both this hook and the column hook have loaded.
  const appliedView = useRef(false)
  useEffect(() => {
    if (!savedViews.loaded || appliedView.current) return
    appliedView.current = true
    const v = savedViews.views.find((x) => x.id === savedViews.activeId)
    // Defer the state writes past the synchronous effect tick (avoids set-state-in-effect).
    if (v) void Promise.resolve().then(() => applyState(v.state))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViews.loaded])
  usePerformancePresetColumns('campaign', setVisibleKeys)

  const days = daysInRange(range.from, range.to)

  const fetchCampaigns = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSelected(null)
    try {
      const params = new URLSearchParams({
        from: range.from,
        to: range.to,
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      })
      const res = await fetch(`/api/campaigns?${params}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('CAMPAIGNS_READ_FAILED')
      const data = await res.json()
      if (!Array.isArray(data.campaigns)) throw new Error('CAMPAIGNS_RESPONSE_INVALID')
      setCampaigns(data.campaigns)
    } catch {
      setCampaigns([])
      setError('Failed to load campaigns.')
    } finally {
      setLoading(false)
    }
  }, [range.from, range.to, statusFilter])

  useEffect(() => {
    if (!ready) return
    // Defer past the synchronous effect tick so fetchCampaigns's setState isn't synchronous-in-effect.
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchCampaigns() })()
    return () => { active = false }
  }, [fetchCampaigns, ready])

  async function openPanel(campaign: Campaign) {
    setSelected(campaign)
    setFlags([])
    setFlagsLoading(true)
    try {
      const params = new URLSearchParams({ limit: '20', from: range.from, to: range.to })
      const res = await fetch(`/api/flags?${params}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        const relevant = (data.flags ?? []).filter(
          (f: Record<string, unknown>) => f.meta_campaign_id === campaign.campaign_id
        )
        setFlags(relevant)
      }
    } catch { setFlags([]) }
    finally { setFlagsLoading(false) }
  }

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const filtered = search
    ? campaigns.filter(c => c.campaign_name?.toLowerCase().includes(search.toLowerCase()))
    : campaigns

  function sortVal(c: Campaign): number | string | null {
    if (sortKey === 'campaign_name') return c.campaign_name ?? ''
    return metricSortValue(selectedWindowMetrics(c.metrics, days), sortKey)
  }

  const sorted = [...filtered].sort((a, b) => compareUnknownLast(sortVal(a), sortVal(b), sortDir))


  function exportData() {
    const headers = ['Status', 'Campaign', 'Daily budget', 'Pace %', ...visibleDefs.map((d) => d.label)]
    const rows = sorted.map((c) => {
      const displayMetrics = selectedWindowMetrics(c.metrics, days)
      return [
        c.status, c.campaign_name, c.daily_budget,
        c.daily_budget !== null && c.metrics ? Math.round(computePacing(c.metrics.spend, c.daily_budget, days, c.days_delivering).pct) : null,
        ...visibleDefs.map((d) => displayMetrics?.[d.key] ?? null),
      ]
    })
    return { headers, rows }
  }
  const exportName = `campaigns_${range.from}_${range.to}.csv`

  const sel = selectedWindowMetrics(selected?.metrics ?? null, days)
  // Feeds the low-data banner only; there is no campaign totals card to caveat.
  const totalSpend = sumMeasured(sorted, c => c.metrics, 'spend').total

  return (
    <div className="space-y-4">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
        <PageHeader
          title="Campaigns"
          icon={Target}
          subtitle="Raw Meta delivery and cost observations — open details or drill into ad sets."
      />

      {/* Honest low-data calibration banner — shows only when delivering but still too thin to judge. */}
      <LowDataBanner spend={totalSpend} windowDays={days} entity="campaigns" />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <DateRangeControl value={range} onChange={setRange} className="md:hidden" />
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? 'all')}>
          <SelectTrigger
            className="h-11 w-36 text-xs"
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
            }}
          >
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
            }}
          >
            <SelectItem value="all" className="text-xs" style={{ color: 'var(--text-secondary)' }}>All Statuses</SelectItem>
            <SelectItem value="ACTIVE" className="text-xs" style={{ color: 'var(--text-secondary)' }}>Active</SelectItem>
            <SelectItem value="PAUSED" className="text-xs" style={{ color: 'var(--text-secondary)' }}>Paused</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="h-11 min-w-0 flex-1 rounded-lg px-3 text-xs transition-colors focus:outline-none sm:w-48 sm:flex-none"
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
          />
          <SavedViewsControl
            views={savedViews.views}
            activeId={savedViews.activeId}
            onApply={(v) => applyState(v.state)}
            onSaveNew={(name) => savedViews.saveView(name, captureState())}
            onUpdateActive={() => { if (savedViews.activeId) savedViews.updateView(savedViews.activeId, captureState()) }}
            onDelete={savedViews.removeView}
          />
          <ColumnChooser level="campaign" isVisible={isVisible} onToggle={toggle} onReset={reset} />
          <ExportCsvButton filename={exportName} getData={exportData} disabled={loading || sorted.length === 0} />
        </div>
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {loading ? 'Loading…' : `${sorted.length} campaign${sorted.length !== 1 ? 's' : ''}`}
        </span>
        <SourceBadge source="meta" />
      </div>

      {/* Table — the shell (sortable headers, four-state body, colSpan, open chevron) lives in
          EntityTable; only the campaign-specific leading columns are declared here. */}
      <EntityTable<Campaign>
        columns={[
          { key: 'status', label: 'Status', render: (c) => <CampaignStatusBadge status={c.status} /> },
          {
            key: 'name',
            label: 'Campaign',
            sortKey: 'campaign_name',
            className: 'w-64 max-w-xs truncate',
            render: (c) => (
              <Link
                href={buildPerformanceDrilldownHref('/performance/adsets', performancePreset, range, { campaign: c.campaign_id })}
                className="font-medium hover:text-[var(--accent)] transition-colors"
                style={{ color: 'var(--text-primary)' }}
                title="View this campaign's ad sets"
              >
                {c.campaign_name}
              </Link>
            ),
          },
          {
            key: 'pace',
            label: 'Pace',
            align: 'right',
            render: (c) => c.metrics
              ? <PaceCell spend={c.metrics.spend} dailyBudget={c.daily_budget} days={days} daysDelivering={c.days_delivering} />
              : <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>—</span>,
          },
        ]}
        rows={sorted}
        rowKey={(c) => c.campaign_id}
        loading={loading}
        error={error ? "Couldn't load campaigns" : null}
        onRetry={fetchCampaigns}
        empty={{
          icon: Target,
          title: 'No campaigns found',
          description: "No campaigns delivered in this window. If you've narrowed the status filter, widen it; otherwise the account may be paused/pre-launch or the range is too narrow — try a wider range or run a sync.",
        }}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        metrics={{
          defs: visibleDefs,
          forRow: (c) => selectedWindowMetrics(c.metrics, days),
          windowDays: days,
          showBands: false,
        }}
        onOpen={openPanel}
        openLabel={(c) => `Open details for ${c.campaign_name}`}
      />

      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        Meta Results (modelled 7dc/1dv) are Meta&apos;s attributed {EVENT} actions. Meta cost / Result is spend divided by those modelled Results for this exact selected window.
      </p>

      {/* Detail panel — campaign drilldown (parity with the ad-set / ad panels; S7 entity-detail). */}
      <SlidePanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.campaign_name ?? ''}
        subtitle={selected
          ? sel
            ? `Spend: ${formatMoney(sel.spend)} · Meta Results: ${sel.bookings}`
            : 'No delivery data in the selected window'
          : undefined}
        width="md"
      >
        {selected && !sel && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No delivery data was reported for this campaign in the selected window.
          </p>
        )}
        {selected && sel && (
          <>
            {/* Status + budget */}
            <div className="flex items-center gap-2 flex-wrap">
              <CampaignStatusBadge status={selected.status} />
              {selected.daily_budget !== null ? (
                <Badge variant="outline" className="text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                  ${selected.daily_budget.toFixed(0)}/day budget
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-tertiary)' }}>
                  budget unavailable
                </Badge>
              )}
              <SourceBadge source="meta" />
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

            {/* Per-campaign budget pacing — spend vs this campaign's own daily budget over the window */}
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
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No active flags for this campaign.</p>
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

            {/* Exact-account local drill-down. External account links return only after account identity is supplied by the resolved account contract. */}
            <PanelSection title="Actions">
              <Link
                href={buildPerformanceDrilldownHref('/performance/adsets', performancePreset, range, { campaign: selected.campaign_id })}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors"
                style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-focus)', color: 'var(--accent)' }}
              >
                View this campaign&apos;s ad sets <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </PanelSection>
          </>
        )}
      </SlidePanel>
    </div>
  )
}
