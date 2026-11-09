'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, FlaskConical, Layers, Megaphone, PieChart, Target } from 'lucide-react'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/layout/PageHeader'
import { useGlobalControls } from '@/lib/use-global-controls'
import type { Adr056LaunchComparison, Adr056CohortMetrics } from '@/lib/launch/adr056-launch-comparison'
import type { PerformanceCockpitData } from '@/lib/cockpit/contracts'
import {
  AccountScorecardSection,
  PerformancePresetStrip,
} from './PerformanceScorecard'
import { accountCurrency, accountLocale, accountTimezone } from '@/config/business-config'
import { accountTimezoneShortName } from '@/config/timezone-label'
export { AccountScorecardSection, PerformanceHierarchyNav, PerformancePresetStrip } from './PerformanceScorecard'

type MetricLite = {
  spend?: number | null
  leads?: number | null
  bookings?: number | null
}

type EntityWithMetrics = {
  status?: string | null
  metrics?: MetricLite | null
  [key: string]: unknown
}

type FlagLite = {
  id?: string
  flag_type?: string
}

type TestsLite =
  | { readHealth: 'healthy'; count: number }
  | { readHealth: 'unavailable'; errorCode: string }

export interface PerformanceOverviewInput {
  campaigns: EntityWithMetrics[]
  adsets: EntityWithMetrics[]
  ads: EntityWithMetrics[]
  segments: EntityWithMetrics[]
  flags: FlagLite[]
  tests: TestsLite
}

interface MeasuredTotal {
  value: number
  unmeasured: number
}

export function buildPerformanceOverviewSummary(input: PerformanceOverviewInput) {
  const spend = input.campaigns.reduce<MeasuredTotal>((acc, row) => {
    const value = row.metrics?.spend
    return typeof value === 'number' && Number.isFinite(value)
      ? { value: acc.value + value, unmeasured: acc.unmeasured }
      : { value: acc.value, unmeasured: acc.unmeasured + 1 }
  }, { value: 0, unmeasured: 0 })

  const activeCampaigns = input.campaigns.filter((row) => row.status === 'ACTIVE').length
  const activeAds = input.ads.filter((row) => row.status === 'ACTIVE').length
  const diagnosticFlags = input.flags.length

  return {
    spend: { ...spend, sourceGrain: 'campaign' as const },
    activeCampaigns,
    activeAds,
    diagnosticFlags,
    tests: input.tests,
    drilldowns: [
      { label: 'Campaigns', href: '/performance/campaigns', count: input.campaigns.length, icon: Target, scope: 'Meta campaigns' },
      { label: 'Ad sets', href: '/performance/adsets', count: input.adsets.length, icon: Layers, scope: 'Meta ad sets' },
      { label: 'Ads', href: '/performance/ads', count: input.ads.length, icon: Megaphone, scope: 'Meta ads and creative' },
      { label: 'Segments', href: '/performance/segments', count: input.segments.length, icon: PieChart, scope: 'Meta breakdown rows' },
      { label: 'Flags', href: '/performance/flags', count: diagnosticFlags, icon: AlertTriangle, scope: 'Diagnostic flags' },
      {
        label: 'Tests',
        href: '/performance/tests',
        count: input.tests.readHealth === 'healthy' ? input.tests.count : null,
        icon: FlaskConical,
        scope: 'Legacy test audit',
      },
    ],
  }
}

export interface LaunchComparisonAdGroup {
  cohortLabel: 'Cold' | 'Warm / mixed'
  liveAdName: string
  predecessorAdName: string
  launchDate: string
  firstCleanDay: string
  mixedDay: string
  metaResults: number | null
  spend: number | null
  cpa: number | null
  availability: 'available' | 'partial' | 'unavailable'
  blocker?: string
}

export interface LaunchComparisonViewModel {
  generatedAt: string
  dateWindow: { from: string; to: string; timezone: string }
  identityBasis: 'ad_name_tagged_adr_056'
  rows: LaunchComparisonAdGroup[]
}

type LaunchComparisonState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; comparison: Adr056LaunchComparison }

function money(value: number): string {
  return new Intl.NumberFormat(accountLocale(), {
    style: 'currency',
    currency: accountCurrency(),
  }).format(value)
}

function compactMoney(value: number | null): string {
  return value === null ? 'Unavailable' : money(value)
}

function count(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString()
}

function shortDate(value: string | null): string {
  if (!value) return 'Unavailable'
  const parsed = new Date(`${value}T00:00:00-05:00`)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: accountTimezone(),
  })
}

export async function readPerformanceJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { code?: string; error?: string } | null
    throw new Error(body?.code ?? body?.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

async function readLaunchComparison(range: { from: string; to: string }): Promise<LaunchComparisonState> {
  try {
    const params = new URLSearchParams(range)
    const res = await fetch(`/api/performance/launch-comparison?${params}`, { cache: 'no-store' })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { code?: string; error?: string } | null
      return { status: 'error', message: body?.code ?? body?.error ?? `HTTP ${res.status}` }
    }
    return { status: 'loaded', comparison: await res.json() as Adr056LaunchComparison }
  } catch {
    return { status: 'error', message: 'ADR056_LAUNCH_COMPARISON_UNAVAILABLE' }
  }
}

function MetricMiniCard({ title, metrics, windowLabel }: {
  title: string
  metrics: Adr056CohortMetrics
  windowLabel: string
}) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
      <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
      <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{windowLabel}</p>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div>
          <p className="section-label text-[12px]">Spend</p>
          <p className="text-[15px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{money(metrics.spend)}</p>
        </div>
        <div>
          <p className="section-label text-[12px]">Meta Results</p>
          <p className="text-[15px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{count(metrics.metaResults)}</p>
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>modelled 7dc/1dv</p>
        </div>
        <div>
          <p className="section-label text-[12px]">Click / view split</p>
          <p className="text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
            {metrics.attributionSplitAvailable
              ? `${count(metrics.clickResults)} click · ${count(metrics.viewResults)} view`
              : 'Unavailable'}
          </p>
        </div>
        <div>
          <p className="section-label text-[12px]">Cost / Result</p>
          <p className="text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{compactMoney(metrics.metaCostPerResult)}</p>
        </div>
      </div>
    </div>
  )
}

function ComparisonAudience({ label, previous, tagged }: {
  label: 'Cold' | 'Warm-named (name-derived; targeting snapshot unavailable)'
  previous: Adr056CohortMetrics
  tagged: Adr056CohortMetrics
}) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
      <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</p>
      <div className="grid gap-2 md:grid-cols-2 mt-3">
        <MetricMiniCard title="Prior paused" metrics={previous} windowLabel="Same-creative paused predecessors" />
        <MetricMiniCard title="Tagged clean" metrics={tagged} windowLabel="Immutable Meta-ID treatment ads" />
      </div>
    </div>
  )
}

export function LaunchComparisonSection({ state }: { state: LaunchComparisonState }) {
  if (state.status === 'loading') {
    return (
      <section className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
        <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Fresh launch comparison</p>
        <p className="text-[14px] mt-1" style={{ color: 'var(--text-tertiary)' }}>Loading ADR-056 comparison from the authenticated performance endpoint.</p>
        <div className="grid gap-3 md:grid-cols-2 mt-4">
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
        </div>
      </section>
    )
  }

  if (state.status === 'error') {
    return (
      <section className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
        <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Fresh launch comparison</p>
        <p className="text-[14px] mt-1" style={{ color: 'var(--danger)' }}>ADR-056 launch comparison unavailable.</p>
        <p className="text-[12px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
          Source: /api/performance/launch-comparison · Availability: Unavailable · Reason: {state.message}
        </p>
      </section>
    )
  }

  const { comparison } = state
  if (comparison.status !== 'available') {
    const availability = comparison.status === 'partial' ? 'Partial' : 'Unavailable'
    return (
      <section className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Fresh launch comparison</p>
            <p className="text-[14px] mt-1" style={{ color: 'var(--warning)' }}>
              No comparison numbers are shown because the governed ADR-056 evidence contract is incomplete.
            </p>
          </div>
          <span className="text-[12px] font-semibold rounded-full px-2 py-1" style={{ color: 'var(--warning)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
            Availability: {availability}
          </span>
        </div>
        <div className="text-[12px] mt-3 space-y-1" style={{ color: 'var(--text-tertiary)' }}>
          <p>Source: {comparison.source.system} · {comparison.source.role}</p>
          <p>Freshness: {comparison.source.lastSyncedAt ?? 'Unavailable'}</p>
          <p>Blockers: {comparison.blockers.length > 0 ? comparison.blockers.join(', ') : 'source_contract_incomplete'}</p>
          <p>Unavailable is not zero. Refresh the source evidence before comparing prior and tagged delivery.</p>
        </div>
      </section>
    )
  }

  const availability = 'Available'
  const previousWindow = `${shortDate(comparison.windows.previous.from)}–${shortDate(comparison.windows.previous.to)}`
  const taggedWindow = `${shortDate(comparison.windows.tagged.from)}–${shortDate(comparison.windows.tagged.to)}`
  const matchedPrevious = comparison.matched?.previous ?? comparison.previous
  const matchedTagged = comparison.matched?.tagged ?? comparison.tagged
  const matchedDays = comparison.matched?.windows.previous.days ?? 0
  const matchedPreviousWindow = comparison.matched
    ? `${shortDate(comparison.matched.windows.previous.from)}–${shortDate(comparison.matched.windows.previous.to)}`
    : previousWindow
  const matchedTaggedWindow = comparison.matched
    ? `${shortDate(comparison.matched.windows.tagged.from)}–${shortDate(comparison.matched.windows.tagged.to)}`
    : taggedWindow
  const mixedDay = shortDate(comparison.boundary.launchDate)
  const firstClean = shortDate(comparison.boundary.firstCleanTaggedDate)
  const blockers = comparison.blockers.length > 0 ? comparison.blockers.join(', ') : 'none'
  const provenance = comparison.provenance
  const selectedFrom = provenance?.window.requested.from
  const selectedTo = provenance?.window.requested.to
  const warmTagged = comparison.taggedAds.filter((ad) => ad.audience === 'warm_mixed').map((ad) => ad.name).join(', ')
  const coldTagged = comparison.taggedAds.filter((ad) => ad.audience === 'cold').map((ad) => ad.name).join(', ')
  const warmMetrics = matchedTagged.warm.metrics
  const coldMetrics = matchedTagged.cold.metrics
  const warmComposition = warmMetrics.attributionSplitAvailable
    && warmMetrics.viewResults !== null
    && warmMetrics.clickResults !== null
    && warmMetrics.viewResults > warmMetrics.clickResults
    ? 'Warm-named Results skew view-through.'
    : 'Warm-named click/view composition is a platform attribution pattern, not a delivery verdict.'
  const coldComposition = coldMetrics.metaResults === 0
    ? 'Cold has zero modelled Results in this matched clean window.'
    : `Cold has ${coldMetrics.metaResults.toLocaleString()} modelled Result${coldMetrics.metaResults === 1 ? '' : 's'} in this matched clean window.`

  return (
    <section className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>ADR-056 launch evidence</p>
          <p className="text-[14px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Treatment is the immutable ADR-056 Meta-ID cohort; ad names are display metadata. {mixedDay} is mixed and excluded; {firstClean} is first clean.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-semibold rounded-full px-2 py-1" style={{ color: 'var(--warning)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
            {comparison.verdict?.label ?? 'HOLD / INVESTIGATE'}
          </span>
          <span className="text-[12px] font-semibold rounded-full px-2 py-1" style={{ color: 'var(--success)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
            Availability: {availability}
          </span>
        </div>
      </div>

      <div className="rounded-lg px-3 py-2.5 mt-4" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
        <p className="text-[14px] font-semibold" style={{ color: 'var(--warning)' }}>Current decision: hold and investigate</p>
        <p className="text-[14px] leading-relaxed mt-1" style={{ color: 'var(--text-secondary)' }}>
          {warmComposition} {coldComposition} This supports investigation only—no scale, pause, rebalance, or financial conclusion.
        </p>
      </div>

      <div className="rounded-lg px-3 py-2.5 mt-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Matched comparison · {matchedDays || 'same'} closed days each</p>
        <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          Prior {matchedPreviousWindow} · Clean tagged {matchedTaggedWindow} · {mixedDay} excluded
        </p>
      </div>

      <div className="grid gap-3 mt-4">
        <ComparisonAudience
          label="Warm-named (name-derived; targeting snapshot unavailable)"
          previous={matchedPrevious.warm.metrics}
          tagged={matchedTagged.warm.metrics}
        />
        <ComparisonAudience
          label="Cold"
          previous={matchedPrevious.cold.metrics}
          tagged={matchedTagged.cold.metrics}
        />
      </div>

      <div className="rounded-lg p-3 mt-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Launch day kept separate</p>
        <p className="text-[14px] leading-relaxed mt-1" style={{ color: 'var(--text-tertiary)' }}>
          {mixedDay} mixed: prior paused ads spent {money(comparison.launchDay.previous.metrics.spend)} with {comparison.launchDay.previous.metrics.metaResults} Meta Results; tagged ads spent {money(comparison.launchDay.tagged.metrics.spend)} with {comparison.launchDay.tagged.metrics.metaResults} Meta Results. {firstClean} first clean.
        </p>
      </div>

      <div className="text-[12px] mt-3 space-y-1" style={{ color: 'var(--text-tertiary)' }}>
        <p>Source: {comparison.source.system} · {comparison.source.role}</p>
        <p>Canonical immutable-boundary context: prior {previousWindow}; mixed/excluded {mixedDay}; tagged clean {taggedWindow}; timezone {accountTimezone()}.</p>
        <p>Window contract: selected end {shortDate(selectedTo ?? null)} is the closed-day as-of date; selected start {shortDate(selectedFrom ?? null)} is validated but does not redefine these canonical launch windows.</p>
        <p>Matched evidence: prior {matchedPreviousWindow}; tagged {matchedTaggedWindow}; {matchedDays || 'equal'} days per side.</p>
        <p>Freshness: {comparison.source.lastSyncedAt ?? 'Unavailable'}</p>
        <p>Scope: immutable Meta-ID treatment cohort vs same-creative paused predecessors. Ad names only provide the warm/cold name-derived labels; no targeting snapshot is resolved.</p>
        <p>Tagged ads: Warm-named (name-derived; targeting snapshot unavailable) — {warmTagged || 'Unavailable'}; Cold-named — {coldTagged || 'Unavailable'}.</p>
        <p>Immutable treatment Meta IDs ({provenance?.treatment.cohortVersion ?? 'Unavailable'}): {comparison.taggedAds.map((ad) => ad.metaAdId).join(', ')}.</p>
        <p>Meta learning state: {comparison.learning?.status === 'available' ? comparison.learning.states.join(', ') : 'Unavailable'}.</p>
        <p>Blockers: {blockers}</p>
        <p>No uplift claim or financial conclusion. Meta Results are modelled platform results only; this page does not authorize a money action.</p>
      </div>
    </section>
  )
}

export function PerformanceOverview() {
  const { range, setRange, ready } = useGlobalControls()
  const [accountScorecard, setAccountScorecard] = useState<PerformanceCockpitData | null>(null)
  const [launchComparison, setLaunchComparison] = useState<LaunchComparisonState>({ status: 'loading' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    setLaunchComparison({ status: 'loading' })
    const launchPromise = readLaunchComparison({ from: range.from, to: range.to })
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to })
      const account = await readPerformanceJson<{ data: PerformanceCockpitData }>(`/api/cockpit?${params}`)
      if (requestId === requestIdRef.current) setAccountScorecard(account.data)
    } catch {
      if (requestId === requestIdRef.current) setError('Failed to load the performance overview.')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
    const launch = await launchPromise
    if (requestId === requestIdRef.current) setLaunchComparison(launch)
  }, [range.from, range.to])

  useEffect(() => {
    if (!ready) return
    let active = true
    void (async () => {
      await Promise.resolve()
      if (active) await load()
    })()
    return () => { active = false }
  }, [load, ready])

  const dateLabel = `${range.from} → ${range.to}`

  return (
    <div className="space-y-5">
      <PageHeader
        title="Performance"
        icon={Activity}
        subtitle="Account scorecard first, then campaign → ad set → ad → creative evidence using one exact date window."
        controls={<DateRangeControl value={range} onChange={setRange} className="md:hidden" />}
      />

      <div className="rounded-lg px-4 py-3 flex items-start justify-between gap-4 flex-wrap" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <div>
          <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>Selected evidence window</p>
          <p className="text-[15px] font-semibold tabular-nums mt-1" style={{ color: 'var(--text-primary)' }}>{dateLabel} {accountTimezoneShortName()}</p>
        </div>
        <p className="text-[14px] max-w-2xl leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          Meta delivery and Meta modelled attribution use this exact {accountTimezoneShortName()} window. Missing or partial metrics remain unavailable, never zero.
        </p>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading performance overview">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-36 rounded-lg" />)}
        </div>
      ) : error ? (
        <ErrorState title="Couldn't load performance overview" onRetry={load} />
      ) : accountScorecard ? (
        <>
          <AccountScorecardSection scorecard={accountScorecard} />

          <PerformancePresetStrip range={{ from: range.from, to: range.to }} />

          <LaunchComparisonSection state={launchComparison} />

        </>
      ) : null}

      <div className="rounded-lg px-4 py-3" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
        <p className="text-[12px] font-semibold" style={{ color: 'var(--warning)' }}>Read-only performance evidence</p>
        <p className="text-[14px] leading-relaxed mt-1" style={{ color: 'var(--text-secondary)' }}>
          No control on this page changes Meta. ADR-056 remains HOLD / INVESTIGATE; budget moves require a separate governed decision with complete evidence.
        </p>
      </div>
    </div>
  )
}
