'use client'
import { accountCurrency, accountLocale, metaOutcomeEventName } from '@/config/business-config'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { ATTRIBUTION_SCOPE_DESCRIPTIONS } from '@/lib/cockpit/contracts'
import type { MetricClaim, PerformanceCockpitData } from '@/lib/cockpit/contracts'
import {
  PERFORMANCE_PRESETS,
  buildPerformanceDrilldownHref,
  type PerformancePresetKey,
} from '@/lib/performance/presets'
import { accountTimezoneShortName } from '@/config/timezone-label'

// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

function money(value: number): string {
  return new Intl.NumberFormat(accountLocale(), {
    style: 'currency', currency: accountCurrency(),
  }).format(value)
}

function count(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString()
}

function claimValue(claim: MetricClaim): string {
  if (claim.availability.state !== 'available' || claim.value === null) return 'Unavailable'
  if (typeof claim.value === 'string') return claim.value
  if (claim.unit === 'money') return money(claim.value)
  if (claim.unit === 'ratio') return `${claim.value.toFixed(2)}×`
  if (claim.unit === 'percent') return `${claim.value.toFixed(1)}%`
  return count(claim.value)
}

function evidence(claim: MetricClaim) {
  return {
    source: `${claim.source.system} · ${claim.source.head ?? claim.source.evidencePlane}`,
    date: `${claim.window.start} → ${claim.window.end} ${accountTimezoneShortName()}`,
    // The shared description, not the raw enum token. Rendering `account · all_sources` here while
    // chat says "all sources (paid + organic)" would describe one number two different ways.
    scope: `${claim.entity.level} · ${ATTRIBUTION_SCOPE_DESCRIPTIONS[claim.attributionScope]}`,
    availability: claim.availability.state === 'available'
      ? `Available · ${claim.coverage.state}`
      : `Unavailable · ${(claim.availability.blockerCodes[0] ?? 'source_unavailable').replaceAll('_', ' ')}`,
  }
}

export function AccountScorecardSection({ scorecard }: { scorecard: PerformanceCockpitData }) {
  const spend = scorecard.claims[scorecard.paidPerformance.spendClaimId]
  const results = scorecard.claims[scorecard.paidPerformance.resultsClaimId]
  const costPerResult = scorecard.claims[scorecard.paidPerformance.costPerResultClaimId]
  const purchaseRoas = scorecard.claims[scorecard.paidPerformance.purchaseRoasClaimId]
  const frequency = scorecard.claims[scorecard.paidPerformance.frequencyClaimId]
  const date = `${scorecard.controls.range.start} → ${scorecard.controls.range.end} ${accountTimezoneShortName()}`

  return (
    <section aria-labelledby="account-scorecard-heading" className="space-y-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p id="account-scorecard-heading" className="section-label text-[12px]">Account scorecard</p>
          <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{date}</p>
        </div>
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Synchronized {scorecard.clocks.synchronizedAt ?? 'Unavailable'}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div data-primary-performance-fact="meta-spend"><KpiCard label={spend.label} value={claimValue(spend)} subtitle="authoritative account delivery" evidence={evidence(spend)} /></div>
        <div data-primary-performance-fact="meta-results"><KpiCard label={results.label} value={claimValue(results)} subtitle={`${EVENT} · modelled 7dc/1dv`} evidence={evidence(results)} /></div>
        <div data-primary-performance-fact="meta-cost-per-result"><KpiCard label={costPerResult.label} value={claimValue(costPerResult)} subtitle="spend ÷ canonical Meta Results" evidence={evidence(costPerResult)} /></div>
        <div data-primary-performance-fact="meta-purchase-roas"><KpiCard label={purchaseRoas.label} value={claimValue(purchaseRoas)} subtitle="canonical Meta purchase value ÷ same-window Meta spend" evidence={evidence(purchaseRoas)} /></div>
      </div>
      <details className="rounded-lg px-4 py-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <summary className="flex min-h-11 items-center rounded-md text-[12px] font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60" style={{ color: 'var(--text-secondary)' }}>Delivery metric scope</summary>
        <div className="text-[14px] leading-relaxed mt-2 space-y-1" style={{ color: 'var(--text-tertiary)' }}>
          <p>Selected-period reach remains unavailable until a native Meta all-days claim exists; daily reach is non-additive.</p>
          <p>Selected-period frequency: {claimValue(frequency)}. Native Meta period read only; daily frequency is not a period metric.</p>
          <p>Placement outcomes stay unavailable unless both placement dimensions reconcile to campaign authority. Partial placement outcomes are never shown as zero.</p>
        </div>
      </details>
    </section>
  )
}

const PRESET_ROUTE: Record<PerformancePresetKey, string> = {
  results: '/performance/campaigns', delivery: '/performance/adsets', funnel: '/performance/ads', creative: '/creative',
}

export function PerformancePresetStrip({ range }: { range: { from: string; to: string } }) {
  return (
    <section aria-labelledby="performance-presets-heading">
      <div className="mb-3">
        <p id="performance-presets-heading" className="section-label text-[12px]">Choose the decision lens</p>
        <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>Every lens carries {range.from} → {range.to}; no child route chooses a hidden window.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {PERFORMANCE_PRESETS.map((preset) => (
          <Link key={preset.key} href={buildPerformanceDrilldownHref(PRESET_ROUTE[preset.key], preset.key, range)} className="group rounded-lg p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
            <div className="flex items-center justify-between gap-3"><p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{preset.label}</p><ArrowRight className="h-4 w-4" aria-hidden="true" style={{ color: 'var(--accent)' }} /></div>
            <p className="text-[14px] leading-relaxed mt-2" style={{ color: 'var(--text-tertiary)' }}>{preset.description}</p>
          </Link>
        ))}
      </div>
    </section>
  )
}

export function PerformanceHierarchyNav({ range }: { range: { from: string; to: string } }) {
  const destinations: Array<{ label: string; href: string; preset: PerformancePresetKey; current?: boolean }> = [
    { label: 'Account', href: '/performance', preset: 'results', current: true },
    { label: 'Campaigns', href: '/performance/campaigns', preset: 'results' },
    { label: 'Ad sets', href: '/performance/adsets', preset: 'delivery' },
    { label: 'Ads', href: '/performance/ads', preset: 'funnel' },
    { label: 'Creative', href: '/creative', preset: 'creative' },
  ]
  return (
    <nav aria-label="Performance hierarchy" className="flex items-center gap-2 overflow-x-auto pb-1">
      {destinations.map((destination) => destination.current ? (
        <span key={destination.label} aria-current="page" className="inline-flex min-h-11 items-center rounded-lg px-4 text-[12px] font-semibold whitespace-nowrap" style={{ color: 'var(--accent)', background: 'var(--accent-dim)', border: '1px solid var(--border-focus)' }}>{destination.label}</span>
      ) : (
        <Link key={destination.label} href={buildPerformanceDrilldownHref(destination.href, destination.preset, range)} className="inline-flex min-h-11 items-center rounded-lg px-4 text-[12px] font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60" style={{ color: 'var(--text-secondary)', background: 'var(--bg-input)', border: '1px solid var(--border)' }}>{destination.label}</Link>
      ))}
    </nav>
  )
}
