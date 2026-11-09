'use client'

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { CampaignStatusBadge } from '@/components/campaigns/CampaignStatusBadge'
import { LowDataBanner } from '@/components/ui/LowDataBanner'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { daysInRange } from '@/lib/date-range'
import { useGlobalControls } from '@/lib/use-global-controls'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/layout/PageHeader'
import { SourceBadge } from '@/components/ui/badges'
import { AlertTriangle, Search, Image, ArrowLeft } from 'lucide-react'
import {
  SlidePanel, PanelMetricGrid, PanelMetric, PanelSection,
} from '@/components/ui/slide-panel'
import { PlacementPreview } from '@/components/creative/PlacementPreview'
import { CreativeDiagnosticCard } from '@/components/creative/CreativeDiagnosticCard'
import { RetentionCurve } from '@/components/creative/RetentionCurve'
import type { CreativeDiagnostic } from '@/lib/creative/verdict'
import { type EntityMetrics } from '@/lib/metrics/aggregate'
import { compareUnknownLast, metricSortValue, sumMeasured } from '@/lib/metrics/collation'
import { metricsForLevel } from '@/lib/metrics/catalog'
import { useColumnVisibility } from '@/components/metrics/useColumnVisibility'
import { ColumnChooser } from '@/components/metrics/ColumnChooser'
import { ExportCsvButton } from '@/components/export/ExportCsvButton'
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

interface AdIssue {
  error_code?: number
  error_summary?: string
  error_message?: string
  level?: string
}

interface Ad {
  ad_id: string
  ad_name: string
  status: string
  effective_status: string | null
  thumbnail_url: string | null
  issues_info: AdIssue[] | null
  review_feedback: Record<string, unknown> | null
  metrics: EntityMetrics | null
  diagnostic: CreativeDiagnostic | null
}

interface DailyObservationPoint {
  date: string
  ctr: number | null
  frequency: number | null
  retention_p25_rate: number | null
  completion_rate: number | null
}

// Map Meta's policy rejection codes to plain English
const REVIEW_FEEDBACK_LABELS: Record<string, { label: string; fix: string }> = {
  PERSONAL_ATTRIBUTES: {
    label: 'Implied personal knowledge',
    fix: 'Rephrase copy to avoid implying you know the user\'s health, finances, or beliefs. E.g. change "Struggling with back pain?" to "Back pain solutions for active people."',
  },
  MISLEADING_CLAIMS: {
    label: 'Misleading or unverifiable claims',
    fix: 'Remove guarantees, superlatives, or before/after imagery that can\'t be substantiated. Add disclaimers where required.',
  },
  LANDING_PAGE: {
    label: 'Landing page policy violation',
    fix: 'Verify your URL works, loads quickly, and the page content matches the ad. A broken or mismatched page auto-triggers disapproval.',
  },
  GRAMMAR: {
    label: 'Formatting violation (ALL CAPS / excessive punctuation)',
    fix: 'Remove all-caps text and excessive punctuation (!!!, ???). Normal sentence case only.',
  },
  SENSATIONAL_CONTENT: {
    label: 'Sensationalized or shocking content',
    fix: 'Replace clickbait-style imagery or headlines with factual, straightforward messaging.',
  },
  ADULT_CONTENT: {
    label: 'Adult or explicit content',
    fix: 'Remove suggestive imagery. If advertising an eligible adult product, apply for Meta\'s special ad category approval.',
  },
  ALCOHOL: {
    label: 'Alcohol restrictions not met',
    fix: 'Apply minimum age targeting (21+ in US) and exclude countries where alcohol advertising is prohibited.',
  },
  DISCRIMINATION: {
    label: 'Discriminatory targeting',
    fix: 'Switch to Special Ad Category mode which automatically removes illegal targeting restrictions (common for housing, employment, credit).',
  },
  BRAND_USAGE: {
    label: 'Unauthorized brand or trademark use',
    fix: 'Remove any brand names, logos, or trademarks you don\'t own from the creative.',
  },
}

function IssuesPanel({ issuesInfo, reviewFeedback, effectiveStatus }: {
  issuesInfo: AdIssue[] | null
  reviewFeedback: Record<string, unknown> | null
  effectiveStatus: string | null
}) {
  if (effectiveStatus !== 'WITH_ISSUES' && effectiveStatus !== 'DISAPPROVED') return null

  return (
    <PanelSection title="Why this ad has issues">
      <div className="space-y-3">
        {effectiveStatus === 'WITH_ISSUES' && issuesInfo && issuesInfo.length > 0 ? (
          issuesInfo.map((issue, i) => (
            <div key={i} className="rounded-lg p-3 space-y-1" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
              {issue.error_summary && (
                <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>{issue.error_summary}</p>
              )}
              {issue.error_message && (
                <p className="text-xs leading-relaxed" style={{ color: 'var(--danger)' }}>{issue.error_message}</p>
              )}
              {issue.level && (
                <p className="text-[10px] font-medium uppercase" style={{ color: 'var(--danger)' }}>Source: {issue.level} level</p>
              )}
            </div>
          ))
        ) : effectiveStatus === 'WITH_ISSUES' ? (
          <div className="rounded-lg p-3" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
            <p className="text-xs" style={{ color: 'var(--danger)' }}>Meta flagged this ad with an issue but did not provide a specific code. Open it in Meta Ads Manager → select the ad → look for the issue banner at the top.</p>
          </div>
        ) : null}

        {effectiveStatus === 'DISAPPROVED' && (
          <>
            {(() => {
              const global = (reviewFeedback as Record<string, unknown> | null)?.global
              const reasons = Array.isArray(global) ? global as string[] : []
              if (reasons.length === 0) {
                return (
                  <div className="rounded-lg p-3" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--danger)' }}>Ad disapproved</p>
                    <p className="text-xs" style={{ color: 'var(--danger)' }}>Meta did not return a specific reason code. Open Meta Ads Manager, click this ad, then click &quot;See Details&quot; next to the Disapproved status to read the exact policy that was violated.</p>
                  </div>
                )
              }
              return reasons.map((code, i) => {
                const info = REVIEW_FEEDBACK_LABELS[code]
                return (
                  <div key={i} className="rounded-lg p-3 space-y-1.5" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                    <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                      {info?.label ?? code}
                    </p>
                    {info?.fix && (
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--danger)' }}>{info.fix}</p>
                    )}
                  </div>
                )
              })
            })()}
          </>
        )}
      </div>
    </PanelSection>
  )
}

interface Flag {
  flag_type: string
  reason: string
  confidence: string
  window_days?: number // Surface the flag's evaluation window so it's never silently mismatched
}

type SortDir = 'asc' | 'desc'

const FLAG_DIAGNOSTIC_LABELS: Record<string, string> = {
  winner: 'Modelled efficiency pattern',
  loser: 'Modelled cost pattern',
  scale_candidate: 'Modelled high-volume pattern',
  watchlist: 'Monitoring signal',
  creative_refresh: 'Frequency / creative signal',
  too_early: 'Limited data',
}

function DiagnosticPill({ diagnostic }: { diagnostic: CreativeDiagnostic | null | undefined }) {
  if (!diagnostic) return <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>—</span>
  const evidenceAvailable = diagnostic.state === 'evidence_available'
  const color = evidenceAvailable ? 'var(--accent)' : 'var(--text-tertiary)'
  const background = evidenceAvailable ? 'var(--accent-dim)' : 'var(--border)'
  return (
    <span
      title={diagnostic.reason}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color, background, border: '1px solid var(--border)' }}
    >
      {diagnostic.label}
    </span>
  )
}

function selectedWindowMetrics(metrics: EntityMetrics | null, windowDays: number): EntityMetrics | null {
  if (!metrics || windowDays === 1 || metrics.frequency === null) return metrics
  return { ...metrics, frequency: null }
}

function DailyObservations({ points, loading, unavailable }: { points: DailyObservationPoint[]; loading: boolean; unavailable: boolean }) {
  if (loading) return <Skeleton className="h-40 rounded-lg" />
  if (unavailable) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        Daily observations are unavailable because the trend source could not be read. No zero values are inferred.
      </p>
    )
  }
  if (points.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        No daily observation rows are available for this ad and date range.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        Descriptive daily rows only. Changes between days do not establish creative wear-out or another causal explanation.
      </p>
      <div className="max-h-72 overflow-auto rounded-lg" style={{ border: '1px solid var(--border)' }}>
        <table className="data-table min-w-[520px]">
          <thead>
            <tr>
              <th className="text-left">Date</th>
              <th className="text-right">Daily frequency</th>
              <th className="text-right">CTR</th>
              <th className="text-right">Retention 25%</th>
              <th className="text-right">Completion</th>
            </tr>
          </thead>
          <tbody>
            {[...points].reverse().map((point) => (
              <tr key={point.date}>
                <td className="text-xs" style={{ color: 'var(--text-secondary)' }}>{point.date}</td>
                <td className="text-right text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {point.frequency !== null ? point.frequency.toFixed(2) : 'Unavailable'}
                </td>
                <td className="text-right text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {point.ctr !== null ? `${point.ctr.toFixed(2)}%` : 'Unavailable'}
                </td>
                <td className="text-right text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {point.retention_p25_rate !== null ? `${point.retention_p25_rate.toFixed(1)}%` : 'Unavailable'}
                </td>
                <td className="text-right text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {point.completion_rate !== null ? `${point.completion_rate.toFixed(1)}%` : 'Unavailable'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AdsPageInner() {
  const searchParams = useSearchParams()
  const adsetFilter = searchParams.get('adset') // drill-down from an ad set
  const requestedAdId = searchParams.get('ad') // drill-down from a creative evidence card
  const performancePreset = performancePresetFromSearch(searchParams.toString()) ?? 'funnel'
  // Global date range — shared across all Performance tabs + persisted (URL + localStorage).
  const { range, setRange, ready } = useGlobalControls()
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<string>('spend')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [ads, setAds] = useState<Ad[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Ad | null>(null)
  const [flags, setFlags] = useState<Flag[]>([])
  const [flagsLoading, setFlagsLoading] = useState(false)
  const [trend, setTrend] = useState<DailyObservationPoint[]>([])
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendUnavailable, setTrendUnavailable] = useState(false)
  const openedDeepLink = useRef<string | null>(null)

  const { isVisible, toggle, reset, setVisibleKeys } = useColumnVisibility('ad')
  const visibleDefs = metricsForLevel('ad').filter((d) => isVisible(d.key))
  const savedViews = useSavedViews('ad')

  function captureState(): TableViewState {
    return { columns: visibleDefs.map((d) => d.key), sortKey, sortDir, search }
  }
  function applyState(s: TableViewState) {
    if (s.columns) setVisibleKeys(s.columns)
    if (s.sortKey) setSortKey(s.sortKey)
    if (s.sortDir) setSortDir(s.sortDir)
    setSearch(s.search ?? '')
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
  usePerformancePresetColumns('ad', setVisibleKeys)

  const { from, to } = range
  const days = useMemo(() => daysInRange(from, to), [from, to])

  const fetchAds = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSelected(null)
    try {
      const q = adsetFilter ? `&adset=${encodeURIComponent(adsetFilter)}` : ''
      const res = await fetch(`/api/ads?from=${from}&to=${to}${q}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('ADS_READ_FAILED')
      const data = await res.json()
      if (!Array.isArray(data.ads)) throw new Error('ADS_RESPONSE_INVALID')
      setAds(data.ads)
    } catch {
      setAds([])
      setError('Failed to load ads.')
    }
    finally { setLoading(false) }
  }, [from, to, adsetFilter])

  useEffect(() => {
    if (!ready) return
    // Defer past the synchronous effect tick so fetchAds's setState isn't synchronous-in-effect.
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchAds() })()
    return () => { active = false }
  }, [fetchAds, ready])

  const openPanel = useCallback(async (ad: Ad) => {
    setSelected(ad)
    setFlags([])
    setTrend([])
    setTrendUnavailable(false)
    setFlagsLoading(true)
    setTrendLoading(true)
    // Flags and descriptive daily rows load in parallel; the panel is already open.
    fetch(`/api/flags?${new URLSearchParams({ limit: '10', from, to })}`, { cache: 'no-store' })
      .then(res => res.ok ? res.json() : { flags: [] })
      .then(data => setFlags((data.flags ?? []).filter((f: Record<string, unknown>) => f.meta_ad_id === ad.ad_id)))
      .catch(() => setFlags([]))
      .finally(() => setFlagsLoading(false))
    fetch(`/api/ads/trend?ad_id=${ad.ad_id}&from=${from}&to=${to}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('AD_TREND_READ_FAILED')
        return res.json()
      })
      .then((data) => {
        if (!Array.isArray(data.points)) throw new Error('AD_TREND_RESPONSE_INVALID')
        setTrend(data.points)
      })
      .catch(() => {
        setTrend([])
        setTrendUnavailable(true)
      })
      .finally(() => setTrendLoading(false))
  }, [from, to])

  useEffect(() => {
    if (!requestedAdId || loading || error) return
    const requestKey = `${requestedAdId}:${from}:${to}`
    if (openedDeepLink.current === requestKey) return
    const requestedAd = ads.find((ad) => ad.ad_id === requestedAdId)
    if (!requestedAd) return
    openedDeepLink.current = requestKey
    let active = true
    void (async () => {
      await Promise.resolve()
      if (active) void openPanel(requestedAd)
    })()
    return () => { active = false }
  }, [ads, error, from, loading, openPanel, requestedAdId, to])

  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const filtered = ads.filter(a =>
    !search || a.ad_name.toLowerCase().includes(search.toLowerCase())
  )

  function sortVal(a: Ad): number | string | null {
    if (sortKey === 'ad_name') return a.ad_name ?? ''
    return metricSortValue(selectedWindowMetrics(a.metrics, days), sortKey)
  }

  const sorted = [...filtered].sort((a, b) => compareUnknownLast(sortVal(a), sortVal(b), sortDir))

  // Summary stats
  const spendSum = sumMeasured(ads, a => a.metrics, 'spend')
  const totalSpend = spendSum.total
  const totalModelledResults = sumMeasured(ads, a => a.metrics, 'bookings').total
  // Ads contributing nothing to the totals above because they carry no delivery row.
  const unmeasuredAds = spendSum.unmeasured
  const measuredEntityCount = ads.length - unmeasuredAds
  const metaCostPerResult = measuredEntityCount > 0 && totalModelledResults > 0
    ? totalSpend / totalModelledResults
    : null


  function exportData() {
    const headers = ['Status', 'Ad', 'Diagnostic', ...visibleDefs.map((d) => d.label)]
    const rows = sorted.map((ad) => {
      const displayMetrics = selectedWindowMetrics(ad.metrics, days)
      return [
        ad.status, ad.ad_name, ad.diagnostic?.label ?? '',
        ...visibleDefs.map((d) => (displayMetrics ? (displayMetrics[d.key] as number | null) : null)),
      ]
    })
    return { headers, rows }
  }

  const sel = selectedWindowMetrics(selected?.metrics ?? null, days)

  return (
    <div className="space-y-4">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
      <PageHeader
        title="Ads"
        icon={Image}
        subtitle="Meta-reported ad delivery, engagement, and cost estimates — click a row for creative detail."
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
            <ColumnChooser level="ad" isVisible={isVisible} onToggle={toggle} onReset={reset} />
            <ExportCsvButton filename={`ads_${from}_${to}.csv`} getData={exportData} disabled={loading || sorted.length === 0} />
            <DateRangeControl value={range} onChange={setRange} className="md:hidden" />
          </div>
        }
      />

      {/* Honest low-data calibration banner — shows only when delivering but still too thin to judge. */}
      <LowDataBanner spend={totalSpend} windowDays={days} entity="ads" />

      {/* Drill-down banner — when scoped to one ad set's ads */}
      {adsetFilter && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-2.5" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-focus)' }}>
          <span className="text-xs" style={{ color: 'var(--accent)' }}>Showing ads in one ad set</span>
          <Link href={buildPerformanceDrilldownHref('/performance/ads', performancePreset, range)} className="flex min-h-11 items-center gap-1 px-2 text-xs transition-opacity hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft className="w-3 h-3" /> All ads
          </Link>
        </div>
      )}

      {/* Summary + search row */}
      {!loading && !error && ads.length > 0 && (
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
          <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="card-base px-4 py-3">
              <p className="section-label">{unmeasuredAds > 0 ? 'Measured spend' : 'Spend'}</p>
              <p className="text-xl font-bold mt-1 tabular-nums" style={{ color: 'var(--text-primary)' }}>
                {measuredEntityCount > 0 ? `${formatMoney(totalSpend)}` : 'Unavailable'}
              </p>
              {/* A total summed over rows where some rows are missing is not a complete total.
                  Say so rather than letting the figure read as the whole account. */}
              {unmeasuredAds > 0 && (
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  excludes {unmeasuredAds} ad{unmeasuredAds === 1 ? '' : 's'} with no delivery data
                </p>
              )}
            </div>
            <div className="card-base px-4 py-3">
              <p className="section-label">Meta Results (modelled 7dc/1dv)</p>
              <p className="text-xl font-bold mt-1 tabular-nums" style={{ color: 'var(--text-primary)' }}>
                {measuredEntityCount > 0 ? totalModelledResults : 'Unavailable'}
              </p>
              {unmeasuredAds > 0 && (
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  excludes {unmeasuredAds} ad{unmeasuredAds === 1 ? '' : 's'} with no delivery data
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
          {/* Search */}
          <div className="relative w-full xl:w-60">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search ads…"
              className="h-11 w-full rounded-lg pl-8 pr-3 text-xs transition-colors focus:outline-none"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
        </div>
      )}

      {/* Table — shell shared with /performance/campaigns and /adsets via EntityTable. Diagnostic
          sits AFTER the metric columns, which is what `trailingColumns` exists for. */}
      <EntityTable<Ad>
        columns={[
          {
            key: 'status',
            label: 'Status',
            render: (ad) => (
              <div className="flex items-center gap-1.5">
                <CampaignStatusBadge status={ad.status} />
                {(ad.effective_status === 'WITH_ISSUES' || ad.effective_status === 'DISAPPROVED') && (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--danger)' }} />
                )}
              </div>
            ),
          },
          {
            key: 'art',
            label: 'Art',
            className: 'w-12',
            render: (ad) => ad.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ad.thumbnail_url}
                alt={ad.ad_name}
                className="w-10 h-10 rounded-md object-cover"
                style={{ border: '1px solid var(--border)' }}
              />
            ) : (
              <div
                className="w-10 h-10 rounded-md flex items-center justify-center"
                style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}
              >
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>—</span>
              </div>
            ),
          },
          {
            key: 'name',
            label: 'Ad Name',
            sortKey: 'ad_name',
            className: 'max-w-[200px]',
            render: (ad) => (
              <p className="text-sm font-medium truncate group-hover:text-[var(--accent)] transition-colors" style={{ color: 'var(--text-primary)' }}>
                {ad.ad_name}
              </p>
            ),
          },
        ]}
        trailingColumns={[
          { key: 'diagnostic', label: 'Diagnostic', render: (ad) => <DiagnosticPill diagnostic={ad.diagnostic} /> },
        ]}
        rows={sorted}
        rowKey={(ad) => ad.ad_id}
        loading={loading}
        error={error ? "Couldn't load ads" : null}
        onRetry={fetchAds}
        empty={{
          icon: Image,
          title: 'No ads found',
          description: search
            ? `No ads matching "${search}". Try a different search term.`
            : 'No ads delivered in this window. This usually means the account is paused/pre-launch or the range is narrow — try a wider range or run a sync. It is not necessarily a filter problem.',
        }}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        metrics={{
          defs: visibleDefs,
          forRow: (ad) => selectedWindowMetrics(ad.metrics, days),
          windowDays: days,
          showBands: false,
        }}
        onOpen={openPanel}
        openLabel={(ad) => `Open details for ${ad.ad_name}`}
      />

      {!loading && !error && (
        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          Meta Results (modelled 7dc/1dv) are Meta&apos;s attributed {EVENT} actions. Meta cost / Result is spend divided by those modelled Results for this exact selected window.
        </p>
      )}

      {/* Detail panel */}
      <SlidePanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.ad_name ?? ''}
        subtitle={selected
          ? sel
            ? `Spend: ${formatMoney(sel.spend)} · Meta Results: ${sel.bookings}`
            : 'No delivery data in the selected window'
          : undefined}
        width="md"
      >
        {selected && !sel && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No delivery data was reported for this ad in the selected window.
          </p>
        )}
        {selected && sel && (
          <>
            {/* Thumbnail */}
            {selected.thumbnail_url && (
              <div
                className="rounded-xl overflow-hidden aspect-video flex items-center justify-center"
                style={{ border: '1px solid var(--border)', background: 'var(--bg-overlay)' }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={selected.thumbnail_url}
                  alt={selected.ad_name}
                  className="w-full h-full object-cover"
                />
              </div>
            )}

            {/* Status badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <CampaignStatusBadge status={selected.status} />
            </div>

            {/* Issues explanation — only visible for WITH_ISSUES / DISAPPROVED */}
            <IssuesPanel
              issuesInfo={selected.issues_info}
              reviewFeedback={selected.review_feedback}
              effectiveStatus={selected.effective_status}
            />

            {/* Creative/delivery evidence only. Governed decisions remain on Current Recommendations. */}
            {selected.diagnostic && <CreativeDiagnosticCard diagnostic={selected.diagnostic} />}

            {/* Key metrics */}
            <PanelSection title="Performance">
              <PanelMetricGrid>
                <PanelMetric label="Spend" value={`${formatMoney(sel.spend)}`} />
                <PanelMetric label="Meta Results (modelled 7dc/1dv)" value={String(sel.bookings)} />
                <PanelMetric
                  label="Meta cost / Result"
                  value={sel.cpa !== null ? `${formatMoney(sel.cpa)}` : 'Unavailable'}
                  sub={`Meta spend ÷ modelled ${EVENT} Result`}
                  highlight="neutral"
                />
                <PanelMetric label="Leads" value={String(sel.leads || '—')} />
                <PanelMetric
                  label="Meta CPL estimate"
                  value={sel.cpl !== null ? `${formatMoney(sel.cpl)}` : '—'}
                  sub={sel.cpl !== null ? `Meta-attributed cost per lead — not per ${OW.one}` : undefined}
                  highlight="neutral"
                />
                <PanelMetric
                  label="CTR"
                  value={sel.ctr !== null ? `${sel.ctr.toFixed(2)}%` : '—'}
                  highlight="neutral"
                />
                <PanelMetric
                  label="Daily frequency"
                  value={days === 1 && sel.frequency !== null ? sel.frequency.toFixed(2) : 'Unavailable'}
                  sub={days === 1 ? 'Exact daily Meta observation' : 'Daily-only; selected-period frequency is unavailable'}
                />
                {/* EARLY VIEW, not "hook": Meta's batch insights expose no 3-second field, so this is
                    video STARTS (or continuous-2s views) over impressions — and 'unavailable' when
                    Meta returned neither. p25 is a retention milestone and is never substituted. */}
                <PanelMetric
                  label="Early-view rate"
                  value={sel.hook_rate !== null ? `${sel.hook_rate.toFixed(1)}%` : 'unavailable'}
                  sub={sel.hook_rate !== null
                    ? `${sel.early_view_source === 'video_play_actions' ? 'video starts' : 'continuous 2s views'} ÷ impressions`
                    : 'no early-view field in the Meta response'}
                  highlight="neutral"
                />
                <PanelMetric
                  label="Retention — 25% milestone"
                  value={sel.retention_p25_rate !== null ? `${sel.retention_p25_rate.toFixed(1)}%` : 'unavailable'}
                  sub={`reached 25% of video LENGTH ÷ ${sel.retention_denominator === 'video_starts' ? 'video starts' : 'impressions'}`}
                  highlight="neutral"
                />
                <PanelMetric
                  label="ThruPlay rate"
                  value={sel.thruplay_rate !== null ? `${sel.thruplay_rate.toFixed(1)}%` : 'unavailable'}
                  sub="ThruPlays (15s or full) ÷ impressions"
                  highlight="neutral"
                />
                <PanelMetric
                  label="Completion"
                  value={sel.completion_rate !== null ? `${sel.completion_rate.toFixed(1)}%` : 'unavailable'}
                  sub={`reached 100% ÷ ${sel.retention_denominator === 'video_starts' ? 'video starts' : 'impressions'}`}
                  highlight="neutral"
                />
              </PanelMetricGrid>
            </PanelSection>

            {/* Delivery & engagement — now that the data's aggregated, surface it here too */}
            <PanelSection title="Delivery & Engagement">
              <PanelMetricGrid>
                <PanelMetric label="Impressions" value={sel.impressions.toLocaleString()} />
                <PanelMetric label="Peak daily reach" value={sel.reach.toLocaleString()} sub="Highest daily warehouse row; not deduplicated period reach" />
                <PanelMetric label="CPC" value={sel.cpc !== null ? `${formatMoney(sel.cpc)}` : '—'} />
                <PanelMetric label="CPM" value={sel.cpm !== null ? `${formatMoney(sel.cpm)}` : '—'} />
                <PanelMetric label="Link clicks" value={sel.link_clicks ? sel.link_clicks.toLocaleString() : '—'} />
                <PanelMetric label="LP views" value={sel.landing_page_views ? sel.landing_page_views.toLocaleString() : '—'} />
              </PanelMetricGrid>
            </PanelSection>

            {/* Retention curve — the deepest "is the creative working" view */}
            <PanelSection title="Retention Curve">
              <RetentionCurve
                impressions={sel.impressions}
                p25={sel.p25}
                p50={sel.p50}
                p75={sel.p75}
                p100={sel.p100}
                thruplays={sel.thruplays}
                avgPlayTime={sel.avg_play_time}
                hookRate={sel.hook_rate}
                holdRate={sel.hold_rate}
                // EntityMetrics.video_views now holds video STARTS (the `rev_i` video contract). Passed
                // explicitly with a truthful prop name so the component never re-reads it as "views".
                videoPlays={sel.video_views}
                earlyViewSource={sel.early_view_source}
                thruplayRate={sel.thruplay_rate}
              />
            </PanelSection>

            {/* Daily observations remain descriptive; cross-day movement is not a causal diagnosis. */}
            <PanelSection title="Daily observations">
              <DailyObservations points={trend} loading={trendLoading} unavailable={trendUnavailable} />
            </PanelSection>

            {/* Placement preview */}
            <PanelSection title="Creative Preview">
              <PlacementPreview thumbnailUrl={selected.thumbnail_url ?? null} adName={selected.ad_name ?? 'Ad'} />
            </PanelSection>

            {/* Flags */}
            <PanelSection title="Diagnostic Signals">
              {flagsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 rounded-lg" />
                </div>
              ) : flags.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No active flags for this ad.</p>
              ) : (
                <div className="space-y-2">
                  {flags.map((f, i) => (
                    <div
                      key={i}
                      className="rounded-lg border px-3 py-2.5 space-y-1 bg-[var(--bg-overlay)] border-[var(--border)] text-[var(--text-secondary)]"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">
                          {FLAG_DIAGNOSTIC_LABELS[f.flag_type] ?? 'Diagnostic signal'}
                        </span>
                        <span className="text-[10px] opacity-50">· {f.confidence} confidence</span>
                        {f.window_days != null && <span className="text-[10px] opacity-50">· {f.window_days}d window</span>}
                      </div>
                      <p className="text-xs font-medium">{f.reason}</p>
                    </div>
                  ))}
                  <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                    Flags are observations only. Governed decisions appear in Current Recommendations.
                  </p>
                </div>
              )}
            </PanelSection>

            {/* Actions */}
            <PanelSection title="Actions">
              <a
                href="https://www.facebook.com/adsmanager/manage/ads"
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors"
                style={{
                  background: 'var(--bg-overlay)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                }}
              >
                Open Meta Ads Manager →
              </a>
            </PanelSection>
          </>
        )}
      </SlidePanel>
    </div>
  )
}

export default function AdsPage() {
  return (
    <Suspense fallback={<div className="space-y-4"><Skeleton className="h-8 w-48 rounded" /><Skeleton className="h-96 w-full rounded-lg" /></div>}>
      <AdsPageInner />
    </Suspense>
  )
}
