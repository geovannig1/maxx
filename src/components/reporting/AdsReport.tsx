'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight, Columns2, X } from 'lucide-react'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { META_DIMENSION_KEYS, type MetaDimension } from '@/lib/reporting/meta-breakdowns'
import { AdDetail } from './AdDetail'
import { HierarchyDetail } from './HierarchyDetail'
import { savedReportHref, useSavedReportContext } from './SavedReportContext'
import { AdReview } from './AdReview'
import { EntityComparison } from './EntityComparison'
import { CreativeAsset } from './CreativeAsset'
import {
  comparisonMetricKeys, filterEntities, InvestigationExport, InvestigationFilters, InvestigationSourceState, MetricGroupControl,
  MetricTable, ReportContextLine, reportButtonClass, scopeComparison, sortEntities, useInvestigation,
} from './MetricTable'

type InvestigationState = ReturnType<typeof useInvestigation>

export function InvestigationSelection({ data, entities, state }: { data: ReportingData; entities: ReportEntity[]; state: InvestigationState }) {
  const detailsLoading = data.meta.data?.detailState === 'loading'
  const allEntities = data.meta.data?.entities ?? entities
  const heading = useRef<HTMLHeadingElement>(null)
  const saved = useSavedReportContext()
  const requestedBreakdown = state.params.get('breakdown')
  const parentDetail = state.params.get('view') === 'detail' && state.level !== 'ad'
  const level = parentDetail ? state.level : 'ad'
  const label = level === 'adset' ? 'Ad set' : level === 'campaign' ? 'Campaign' : 'Ad'
  const adId = state.params.get(level)
  const savedParentMatches = saved?.saved.view?.query.level === level && saved.saved.view.query[level] === adId
  const savedBreakdown = savedParentMatches ? saved.saved.view.query.breakdown : undefined
  const breakdownValue = saved ? savedBreakdown : requestedBreakdown
  const breakdown = META_DIMENSION_KEYS.includes(breakdownValue as MetaDimension) ? breakdownValue as MetaDimension : undefined
  const matches = entities.filter(row => row.level === level && row.id === adId)
  const entity = matches.length === 1 ? matches[0] : undefined
  const close = { ad: null, view: null, breakdown: null, ...(parentDetail ? { [level]: null } : {}) }
  const href = (changes: Parameters<typeof state.href>[0]) => savedReportHref(state.href(changes), saved?.saved.id ?? null)
  const comparing = state.params.get('view') === 'compare'
  const selected = entities.filter(row => state.selected.includes(row.id))
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [adId, level, comparing])
  return <section className="space-y-5" onKeyDown={event => {
    if (event.key === 'Escape') state.update(close)
  }}>
    <Link href={href(close)} scroll={false} className={reportButtonClass}><ArrowLeft size={16} aria-hidden="true" />Back to {state.path === '/creative' ? 'creative' : 'ads'}</Link>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 ref={heading} tabIndex={-1} className="min-w-0 break-words text-xl font-semibold">{comparing ? 'Side-by-side comparison' : entity?.name ?? (detailsLoading ? `Loading selected ${label.toLowerCase()}…` : `${label} not in this view`)}</h2>
      <InvestigationExport entities={comparing ? selected : entity ? [entity] : []} allEntities={allEntities} group={state.group} context={data.context} filename={comparing ? 'comparison' : `${level}-detail`} extraKeys={comparing ? comparisonMetricKeys(state.group) : parentDetail && entity ? Object.keys(entity.metrics) : []} />
    </div>
    {parentDetail && entity && <Link aria-label={level === 'campaign' ? 'All ad sets in this campaign' : 'All ads in this ad set'} href={href({
      level: level === 'campaign' ? 'adset' : 'ad', campaign: level === 'campaign' ? entity.id : entity.campaignId, adset: level === 'adset' ? entity.id : null,
      ad: null, view: null, q: null, status: null, format: null, audience: null, compare: null, entity_trend: null, entity_trend_period: null,
      breakdown: null,
    })} className={reportButtonClass}>{level === 'campaign' ? 'All ad sets in this campaign' : 'All ads in this ad set'}<ArrowRight size={16} aria-hidden="true" /></Link>}
    {comparing ? <EntityComparison entities={selected} allEntities={allEntities} context={data.context} group={state.group} detailsLoading={detailsLoading} />
      : entity && data.meta.data ? <><AdReview key={`review:${entity.id}`} data={data} entity={entity} />{parentDetail ? <HierarchyDetail key={`${level}:${entity.id}`} entity={entity} context={data.context} meta={data.meta.data} sourceAsOf={data.meta.asOf ?? undefined} group={state.group} onGroupChange={group => state.update({ group })}
        breakdown={breakdown} onBreakdownChange={saved ? undefined : value => state.update({ breakdown: value })} savedReport={Boolean(saved)} /> : <AdDetail key={entity.id} entity={entity} context={data.context} meta={data.meta.data} sourceAsOf={data.meta.asOf ?? undefined} initialGroup={state.group} onGroupChange={group => state.update({ group })} />}</>
        : <p role="status" className="max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">{detailsLoading ? `Loading inventory for ${label.toLowerCase()} ${adId}…` : `${label} ${adId} is not in the returned entities for this account, date range and filters. Return to the list to inspect the available entities or adjust the filters.`}</p>}
  </section>
}

export function InvestigationCompareBar({ rows, state }: { rows: ReportEntity[]; state: InvestigationState }) {
  const selected = rows.filter(entity => state.selected.includes(entity.id))
  return <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
    <p role="status" aria-live="polite" className="text-[var(--text-secondary)]">{rows.length} {rows.length === 1 ? 'entity' : 'entities'} · {selected.length === 0 ? 'Select two to four to compare exposure and results.' : `${selected.length} of 4 selected`}</p>
    <div className="flex flex-wrap items-center gap-2">
      {selected.length > 0 && <button type="button" className={reportButtonClass} onClick={() => state.update({ compare: null, view: null })}><X size={14} aria-hidden="true" />Clear selection</button>}
      {selected.length >= 2 ? <Link href={state.href({ view: 'compare', ad: null })} scroll={false} className={`${reportButtonClass} border-[var(--accent)] text-[var(--accent)]`}><Columns2 size={16} aria-hidden="true" />Compare selected</Link>
        : <button type="button" disabled className={reportButtonClass}><Columns2 size={16} aria-hidden="true" />Compare selected</button>}
    </div>
  </div>
}

export function InvestigationEmpty({ state, hasEntities, detailsLoading = false }: { state: InvestigationState; hasEntities: boolean; detailsLoading?: boolean }) {
  return <div role="status" className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-5 py-10 text-center">
    <h3 className="text-base font-semibold">{detailsLoading ? 'Loading ad inventory…' : hasEntities ? 'No matches for these filters' : 'No entities returned for this period'}</h3>
    <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--text-secondary)]">{detailsLoading ? 'Ads and creative details are still loading. Matching results will appear as they arrive.' : hasEntities ? 'Broaden the campaign, ad set or search to inspect the available delivery. Paused and zero-spend ads are included unless filtered.' : 'Try another date range or inspect Meta source coverage. An empty response alone does not establish zero delivery.'}</p>
    {hasEntities && <button type="button" className={`${reportButtonClass} mt-4`} onClick={() => state.update({ campaign: null, adset: null, ad: null, q: null, status: null, audience: null, format: null, compare: null, view: null })}>Clear filters</button>}
  </div>
}

export function AdsReport({ data }: { data: ReportingData }) {
  const detailsLoading = data.meta.data?.detailState === 'loading'
  const controls = useInvestigation(data.context)
  const entities = data.meta.data?.entities ?? []
  const direction = controls.params.get('direction') === 'asc' ? 'asc' : 'desc'
  const sortKey = controls.params.get('sort') ?? 'spend'
  const rows = sortEntities(filterEntities(entities, controls.params, controls.level), sortKey, direction)
  const state = scopeComparison(controls, rows)
  const detail = Boolean(state.params.get('ad')) || ['compare', 'detail'].includes(state.params.get('view') ?? '')
  const drilldown = (entity: ReportEntity) => entity.level === 'campaign'
    ? state.href({ campaign: entity.id, adset: null, ad: null, level: 'campaign', view: 'detail', compare: null, breakdown: null })
    : entity.level === 'adset' ? state.href({ campaign: entity.campaignId, adset: entity.id, ad: null, level: 'adset', view: 'detail', compare: null, breakdown: null })
      : state.href({ ad: entity.id })
  return <div className="min-w-0 space-y-5 text-[var(--text-primary)]">
    <InvestigationSourceState data={data} />
    {data.meta.data && (detail ? <InvestigationSelection data={data} entities={rows} state={state} /> : <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2"><h2 className="text-xl font-semibold">Ad investigation</h2><ReportContextLine context={data.context} asOf={data.meta.asOf} /></div>
        <InvestigationExport entities={rows} allEntities={entities} group={state.group} context={data.context} filename="ads" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-3">
        <nav aria-label="Reporting hierarchy" className="flex flex-wrap gap-1">
          {([['campaign', 'Campaigns'], ['adset', 'Ad sets'], ['ad', 'Ads']] as const).map(([level, label]) => <Link key={level} href={state.href({ level, ad: null, compare: null, view: null, breakdown: null, ...(level === 'campaign' ? { campaign: null, adset: null } : level === 'adset' ? { adset: null } : {}) })} scroll={false}
            aria-current={state.level === level ? 'page' : undefined} className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium ${state.level === level ? 'bg-[var(--accent-dim)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]'}`}>{label}</Link>)}
        </nav>
        <Link href={state.href({ level: null, ad: null }, '/creative')} className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--accent)]">Inspect creative<ArrowRight size={14} aria-hidden="true" /></Link>
      </div>
      <MetricGroupControl group={state.group} groups={['results', 'response', 'delivery', 'clicks', 'engagement', 'attention']} onChange={group => state.update({ group, sort: null })} />
      <InvestigationFilters entities={entities} params={state.params} group={state.group} update={state.update} detailsLoading={detailsLoading} />
      <p className="text-xs leading-5 text-[var(--text-secondary)]">Meta attribution: {data.meta.data.attributionWindow} · Reporting time: {data.meta.data.reportingTime}. Status is observed configuration; paused ads can have delivery in this period.</p>
      <InvestigationCompareBar rows={rows} state={state} />
      {rows.length ? <MetricTable entities={rows} allEntities={entities} group={state.group} selected={state.selected} onSelect={state.toggle} sortKey={sortKey} direction={direction}
        onSort={key => state.update({ sort: key, direction: sortKey === key && direction === 'desc' ? 'asc' : 'desc' })}
        entityLink={entity => <Link href={drilldown(entity)} scroll={false} className="inline-flex min-h-11 items-center gap-3 font-medium text-[var(--accent)] hover:underline">
          {entity.level === 'ad' && <CreativeAsset creative={entity.creative} name={entity.name} compact detailsLoading={detailsLoading} />}<span>{entity.name}</span><ArrowRight size={14} className="shrink-0" aria-hidden="true" />
        </Link>} /> : <InvestigationEmpty state={state} hasEntities={entities.some(entity => entity.level === state.level)} detailsLoading={detailsLoading} />}
      <p className="text-xs leading-5 text-[var(--text-secondary)]">Values show the selected period and previous equal period. Open any supplied value for its definition, availability and evidence. Missing measurements are never treated as zero.</p>
    </>)}
  </div>
}
