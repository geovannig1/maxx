'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { currentMetric as currentAdvertisingMetric } from '@/lib/reporting/review/advertising'
import { savedReportHref, useSavedReportContext } from './SavedReportContext'
import {
  filterEntities, investigationHref, InvestigationExport, InvestigationSourceState, METRIC_GROUPS,
  MetricGroupControl, MetricTable, ReportContextLine, reportButtonClass, reportControlClass,
  sortEntities, type MetricGroup, type QueryChanges,
} from './MetricTable'
import { outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

function hasSpendWithoutBookings(data: ReportingData, entity: ReportEntity) {
  const spend = currentAdvertisingMetric(data, entity, 'spend')?.current
  const bookings = currentAdvertisingMetric(data, entity, 'bookings')?.current
  return spend?.availability.state === 'available' && spend.coverage.state === 'complete'
    && typeof spend.value === 'number' && spend.value > 0
    && bookings?.availability.state === 'available' && bookings.coverage.state === 'complete' && bookings.value === 0
}

export function OverviewPerformance({ data }: { data: ReportingData }) {
  const saved = useSavedReportContext()
  const search = useSearchParams()
  const path = usePathname() ?? '/dashboard'
  const params = new URLSearchParams(search?.toString() ?? '')
  const level = params.get('overview_level') === 'campaign' ? 'campaign' : 'adset'
  const requestedGroup = params.get('overview_group') ?? 'results'
  const group: MetricGroup = Object.hasOwn(METRIC_GROUPS, requestedGroup) ? requestedGroup as MetricGroup : 'results'
  const sortKey = params.get('overview_sort') ?? 'spend'
  const direction = params.get('overview_direction') === 'asc' ? 'asc' : 'desc'
  const query = params.get('overview_q') ?? ''
  const signal = params.get('overview_signal') === 'no_bookings'
  const population = (data.meta.data?.entities ?? []).filter(entity => entity.level === level)
  const exceptions = population.filter(entity => hasSpendWithoutBookings(data, entity))
  const rows = sortEntities(filterEntities(signal ? exceptions : population, new URLSearchParams({ q: query }), level), sortKey, direction)
  const selected = [...new Set((params.get('overview_compare') ?? '').split(','))].filter(id => rows.some(row => row.id === id)).slice(0, 2)
  const update = (changes: QueryChanges, replace = false) => {
    const current = new URLSearchParams(window.location.search)
    const href = investigationHref(path, current, changes)
    if (replace) window.history.replaceState(null, '', href)
    else window.history.pushState(null, '', href)
  }
  const detail = (changes: QueryChanges) => savedReportHref(investigationHref('/performance', new URLSearchParams({
    from: data.context.range.from, to: data.context.range.to, group,
  }), changes), saved?.saved.id ?? null)
  const label = level === 'campaign' ? 'campaigns' : 'ad sets'
  return <section aria-label="Campaign and ad-set performance" className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div><h2 className="text-xl font-semibold">Campaign and ad-set performance</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">ROAS, cost and response across the supplied population. Open a name to investigate its underlying delivery.</p></div>
      <Link className="inline-flex min-h-11 items-center text-sm text-[var(--accent)]" href={detail({ level })}>Full advertising workspace</Link>
    </div>
    <ReportContextLine context={data.context} asOf={data.meta.asOf} />
    <div role="group" aria-label="Performance level" className="flex flex-wrap gap-2">
      {(['adset', 'campaign'] as const).map(key => <button type="button" key={key} className={reportButtonClass} aria-pressed={level === key}
        style={level === key ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
        onClick={() => update({ overview_level: key, overview_compare: null })}>{key === 'adset' ? 'Ad sets' : 'Campaigns'} ({(data.meta.data?.entities ?? []).filter(entity => entity.level === key).length})</button>)}
    </div>
    <MetricGroupControl group={group} groups={['results', 'response', 'delivery', 'clicks', 'engagement', 'attention']}
      onChange={value => update({ overview_group: value, overview_sort: 'spend' })} />
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      <label className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-xs text-[var(--text-secondary)] sm:min-w-60 sm:basis-60">Search {label}
        <input aria-label={`Search ${label}`} type="search" placeholder="Name, ID or campaign" className={`${reportControlClass} w-full min-w-0`}
          value={query} onChange={event => update({ overview_q: event.target.value || null, overview_compare: null }, true)} />
      </label>
      <button type="button" className={reportButtonClass} aria-pressed={signal}
        style={signal ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
        onClick={() => update({ overview_signal: signal ? null : 'no_bookings', overview_compare: null })}>Spend, no Meta {OW.one} events ({exceptions.length})</button>
      <InvestigationExport entities={rows} allEntities={data.meta.data?.entities} group={group} context={data.context} filename={`maxx-overview-${level}`} label="Export table" />
    </div>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">{signal ? `This filter requires positive spend and a complete, explicit zero ${EVENT} count. Missing counts are excluded. It is an investigation signal, not a stop-spend verdict.` : `All supplied statuses are included. Missing values remain visible; unknown results do not count as zero. Purchase and ${EVENT} are separate attribution measures.`}</p>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="text-sm text-[var(--text-secondary)]">{rows.length} of {population.length} {label} · {signal || query ? 'Filtered view' : 'All supplied rows'} · Select two to compare</p>
      {selected.length === 2 && <Link className={reportButtonClass} href={detail({ level, compare: selected.join(','), view: 'compare' })}>Compare selected {label}</Link>}
      {(signal || query) && <button type="button" className={reportButtonClass} onClick={() => update({ overview_signal: null, overview_q: null, overview_compare: null })}>Clear filters</button>}
    </div>
    <InvestigationSourceState data={data} />
    {rows.length > 0 ? <MetricTable entities={rows} allEntities={data.meta.data?.entities} group={group} selected={selected} bounded
      onSelect={id => update({ overview_compare: selected.includes(id) ? selected.filter(value => value !== id).join(',') : [...selected, id].slice(0, 2).join(',') })}
      sortKey={sortKey} direction={direction} onSort={key => update({ overview_sort: key, overview_direction: sortKey === key && direction === 'desc' ? 'asc' : 'desc' })}
      entityLink={entity => <Link className="inline-flex min-h-11 items-center font-medium text-[var(--text-primary)] hover:underline" href={detail(entity.level === 'campaign'
        ? { level: 'campaign', view: 'detail', campaign: entity.id }
        : { level: 'adset', view: 'detail', campaign: entity.campaignId, adset: entity.id })}>{entity.name}</Link>} />
      : <p className="rounded-lg border border-[var(--border)] p-6 text-sm text-[var(--text-secondary)]">{population.length ? 'No rows match these filters.' : data.meta.state === 'loading' || data.meta.data?.detailState === 'loading' ? 'Loading campaign and ad-set performance…' : 'No campaign or ad-set rows were supplied for this selection.'}</p>}
  </section>
}
