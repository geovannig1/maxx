'use client'

import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronLeft, ChevronRight, Expand, Play, Search } from 'lucide-react'
import type { ReportEntity, ReportMetric, ReportingData } from '@/lib/reporting/contracts'
import type { ExpertReportReview } from '@/lib/reporting/review/contracts'
import { overviewHref, overviewNumber, type OverviewEvent } from '@/lib/reporting/overview-model'
import { hierarchyHasNoResults } from '@/lib/reporting/overview-hierarchy'
import { overviewCreativeAmbiguity, overviewCreativeContext, overviewCreativeFocus, overviewCreativeFormat,
  overviewCreativeFocusDescriptions, overviewCreativeMetric, overviewCreativePage, overviewCreativePageSize,
  overviewCreativeReconciliation, overviewCreativeRetention, overviewCreativeRows, overviewCreativeSelectionHref,
  type OverviewCreativeReconciliation, type OverviewCreativeSort } from '@/lib/reporting/overview-creative'
import { CreativeAsset } from './CreativeAsset'
import { OverviewCreativeDetails } from './OverviewCreativeDetails'
import { OverviewCreativeScatter } from './OverviewCreativeScatter'
import { reportMetricValue } from './MetricValue'

const control = 'min-h-11 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] sm:min-h-9'
const cell = 'min-w-0 px-2 py-3 align-top lg:py-4'
const rowId = (id: string) => `overview-creative-${encodeURIComponent(id)}`

function FocusLink({ entity, label, onFocus }: { entity: ReportEntity; label: string; onFocus: (id: string) => void }) {
  return <a href={`#${rowId(entity.id)}`} onClick={click => { click.preventDefault(); onFocus(entity.id) }}
    title={`${label}: ${entity.name}`} aria-label={`${label}: ${entity.name}`}
    className={`inline-flex items-center underline decoration-[var(--border-strong)] underline-offset-4 ${control}`}>{label}</a>
}

function FocusItem({ entity, label, help, onFocus }: {
  entity: ReportEntity; label: string; help: string; onFocus: (id: string) => void
}) {
  return <div className="inline-flex flex-wrap items-center gap-x-2">
    <FocusLink entity={entity} label={label} onFocus={onFocus} />
    <details className="relative">
      <summary aria-label={`Eligibility for ${label.replace(/ \([^)]* eligible\)$/, '')}`}
        className={`inline-flex cursor-pointer items-center text-xs underline decoration-dotted underline-offset-4 ${control}`}>Eligibility</summary>
      <p className="max-w-xl pb-2 text-sm text-[var(--text-secondary)]">{help}</p>
    </details>
  </div>
}

function Reading({ metric, label, value, primary = false, accessibleLabel }: {
  metric?: ReportMetric; label: string; value?: string; primary?: boolean; accessibleLabel?: string
}) {
  const formatted = value ?? reportMetricValue(metric)
  if (!primary) return <div role={accessibleLabel ? 'group' : undefined} aria-label={accessibleLabel} className="min-w-0 break-words text-sm leading-5 lg:text-sm"><span className="font-medium tabular-nums">{formatted}</span>{' '}
    <span className="text-[var(--text-secondary)]">{label}</span></div>
  return <div role={accessibleLabel ? 'group' : undefined} aria-label={accessibleLabel} className="min-w-0 break-words"><p className={`font-semibold tabular-nums ${formatted === 'Unavailable' ? 'text-sm' : 'text-base'}`}>{formatted}</p>
    <p className="text-sm text-[var(--text-secondary)] lg:text-sm">{label}</p></div>
}

function CreativeIdentity({ entity, expanded, toggle, detailsId, loading }: {
  entity: ReportEntity; expanded: boolean; toggle: () => void; detailsId: string; loading: boolean
}) {
  const ambiguity = overviewCreativeAmbiguity(entity)
  const excerpt = entity.creative?.headline || entity.creative?.body
  const duration = entity.creative?.format === 'video' ? entity.creative.durationSeconds : null
  const format = duration !== null && duration !== undefined && Number.isFinite(duration)
    ? `${duration.toLocaleString('en-US', { maximumFractionDigits: duration > 0 && duration < 1 ? 3 : 0 })} s video`
    : overviewCreativeFormat(entity)
  const context = [...new Set([entity.adsetName ?? entity.adsetId ?? 'Ad set unavailable', entity.audienceLabel, format].filter(Boolean))]
  return <div className="flex min-w-0 gap-3">
    <div className="relative h-36 w-28 shrink-0 overflow-hidden rounded-lg bg-[var(--bg-base)] [&>figure>div]:h-36 [&>figure>div]:w-28 [&_[role=status]]:text-sm lg:h-28 lg:w-24 lg:[&>figure>div]:h-28 lg:[&>figure>div]:w-24">
      <CreativeAsset creative={entity.creative} name={entity.name} compact detailsLoading={loading} />
      <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={detailsId}
        aria-label={`${expanded ? 'Close' : 'Expand'} creative preview for ${entity.name}`} className={`absolute inset-0 flex items-end justify-end p-1 ${control}`}>
        <span className="rounded bg-[var(--bg-surface)] p-1.5 text-[var(--text-primary)]">{entity.creative?.format === 'video' ? <Play size={16} aria-hidden="true" /> : <Expand size={16} aria-hidden="true" />}</span>
      </button>
    </div>
    <div className="min-w-0 space-y-1">
      <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={detailsId} className={`-mt-1 flex items-center gap-1 text-left font-semibold ${control}`}>
        <span className="break-words">{entity.name}</span><ChevronDown size={16} className={`shrink-0 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      <p className="break-words text-sm text-[var(--text-secondary)]">{context.map((value, index) => <Fragment key={value}>{index > 0 && ' · '}<span aria-label={value === format && duration !== null && duration !== undefined ? `Preview duration: ${duration} seconds` : undefined}>{value}</span></Fragment>)}</p>
      {excerpt && <p className="line-clamp-2 break-words text-sm">{excerpt}</p>}
      {ambiguity && entity.creative?.identity && <details className="text-[var(--text-secondary)]">
        <summary aria-label="Dynamic creative preview details" className={`inline-flex cursor-pointer items-center text-xs underline decoration-dotted underline-offset-4 ${control}`}>Dynamic variants</summary>
        <p className="pb-1 text-sm">{ambiguity}</p>
      </details>}
    </div>
  </div>
}

function ReconciliationDisclosure({ reconciliation }: { reconciliation: OverviewCreativeReconciliation }) {
  return <details className="text-[var(--text-secondary)]">
    <summary className="cursor-pointer py-1 text-sm text-[var(--warning)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">{reconciliation.label}</summary>
    <p className="pt-1">{reconciliation.detail}</p>
  </details>
}

export function OverviewCreative({ data, event, savedId }: {
  data: ReportingData; event: OverviewEvent; savedId?: string | null; review?: ExpertReportReview
}) {
  const selection = useSearchParams()
  const search = selection?.get('overview_creative_q') ?? ''
  const requestedSort = selection?.get('overview_creative_sort')
  const sort: OverviewCreativeSort = requestedSort === 'cpa' || requestedSort === 'results' ? requestedSort : 'spend'
  const page = Number(selection?.get('overview_creative_page')) || 1
  const pageSize = overviewCreativePageSize(selection?.get('overview_creative_size'))
  const [expanded, setExpanded] = useState<string[]>([])
  const [presentation, setPresentation] = useState<'table' | 'scatter'>('table')
  const heading = useRef<HTMLHeadingElement>(null)
  const controls = useRef<HTMLDetailsElement>(null)
  const focusTarget = useRef<string | null>(null)
  const id = useId()
  const view = overviewCreativePage(data, event, { search, sort, page, pageSize })
  const focus = overviewCreativeFocus(data, event)
  const focusDescriptions = overviewCreativeFocusDescriptions(event)
  const metaContext = overviewCreativeContext(data)
  const retention = new Map(overviewCreativeRetention(view.rows, metaContext).map(row => [row.entity.id, row.points[1]]))
  const loading = data.meta.state === 'loading' || data.meta.data?.detailState === 'loading'
  const sortLabel = sort === 'cpa' ? `${event.label} CPA, lowest first` : sort === 'results' ? `${event.label}, highest first` : 'Spend, highest first'
  function updateSelection(values: Record<string, string | null>, replace = false) {
    window.history[replace ? 'replaceState' : 'pushState'](null, '',
      overviewCreativeSelectionHref(`${window.location.pathname}${window.location.search}${window.location.hash}`, values))
  }
  const toggle = (entityId: string) => setExpanded(previous => previous.includes(entityId) ? previous.filter(value => value !== entityId) : [...previous, entityId])
  const focusAd = (entityId: string) => {
    const rows = overviewCreativeRows(data, event, { sort })
    const index = rows.findIndex(entity => entity.id === entityId)
    if (index < 0) return
    setPresentation('table')
    focusTarget.current = rowId(entityId)
    updateSelection({ overview_creative_q: null, overview_creative_page: String(Math.floor(index / pageSize) + 1) })
    setExpanded(previous => previous.includes(entityId) ? [...previous] : [...previous, entityId])
  }
  useEffect(() => {
    if (!focusTarget.current) return
    const target = document.getElementById(focusTarget.current)
    if (!target) return
    target.focus()
    focusTarget.current = null
  }, [search, page, expanded, presentation])
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 640px)')
    const sync = () => {
      const query = new URLSearchParams(window.location.search)
      if (controls.current) controls.current.open = desktop.matches || Boolean(query.get('overview_creative_q') || query.get('overview_creative_sort'))
    }
    sync()
    desktop.addEventListener('change', sync)
    return () => desktop.removeEventListener('change', sync)
  }, [])
  useEffect(() => {
    if (loading || page === view.page) return
    window.history.replaceState(null, '', overviewCreativeSelectionHref(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
      { overview_creative_page: view.page > 1 ? String(view.page) : null },
    ))
  }, [loading, page, view.page])
  const navigatePage = (next: number) => { updateSelection({ overview_creative_page: next > 1 ? String(next) : null }); heading.current?.focus() }
  return <section aria-labelledby={`${id}-heading`} className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 text-sm leading-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
      <div className="min-w-0"><h2 ref={heading} id={`${id}-heading`} tabIndex={-1} className="text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-[var(--accent)]">Creative comparison</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)] sm:text-sm">Attention, response &amp; Meta-reported results.</p></div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div role="group" aria-label="Creative view" className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--bg-base)] p-0.5">
          <button type="button" aria-pressed={presentation === 'table'} onClick={() => setPresentation('table')}
            className={`px-2 ${control} ${presentation === 'table' ? 'bg-[var(--bg-surface)] font-semibold' : 'text-[var(--text-secondary)]'}`}>Table</button>
          <button type="button" aria-pressed={presentation === 'scatter'} onClick={() => setPresentation('scatter')}
            className={`px-2 ${control} ${presentation === 'scatter' ? 'bg-[var(--bg-surface)] font-semibold' : 'text-[var(--text-secondary)]'}`}>Attention × CPA</button>
        </div>
        <a href={overviewHref(data.context, '/creative', { group: 'response' }, savedId)} className={`inline-flex items-center font-medium text-[var(--accent)] underline-offset-4 hover:underline ${control}`}>All creative detail</a>
      </div>
    </div>
    <details ref={controls} open className="min-w-0">
      <summary className={`cursor-pointer content-center font-medium text-[var(--accent)] sm:hidden ${control}`}>Find, sort and compare ads</summary>
      <div className="space-y-2">
    {(focus.mostResults || focus.lowestCpa || focus.contrast) && <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[var(--text-secondary)] sm:flex sm:flex-wrap sm:gap-x-6" aria-label="Observed creative focus">
      {focus.mostResults && <FocusItem entity={focus.mostResults} label={`Most results (${focus.population.resultsEligible}/${focus.population.supplied} eligible)`} help={focusDescriptions.results} onFocus={focusAd} />}
      {focus.lowestCpa && <FocusItem entity={focus.lowestCpa} label={`Lowest CPA (${focus.population.cpaEligible}/${focus.population.supplied} eligible)`} help={focusDescriptions.cpa} onFocus={focusAd} />}
      {focus.contrast && <div data-creative-contrast className="col-span-2 flex flex-wrap items-center gap-x-1">
        <FocusItem entity={focus.contrast.higherAttention} label={`Attention vs results (${focus.population.contrastEligible}/${focus.population.supplied} eligible)`} help={focusDescriptions.contrast} onFocus={focusAd} /><span>·</span><FocusLink entity={focus.contrast.lowerAttention} label="Comparison ad" onFocus={focusAd} />
      </div>}
    </div>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 basis-60"><span className="sr-only">Search creative</span><span className="relative block">
        <Search size={16} aria-hidden="true" className="absolute left-3 top-3.5 text-[var(--text-secondary)]" />
        <input aria-label="Search creative" type="search" value={search} maxLength={512} placeholder="Search ads, ad sets or copy" onChange={change => updateSelection({ overview_creative_q: change.target.value, overview_creative_page: null }, true)}
          className={`h-11 w-full min-w-0 border border-[var(--border)] bg-[var(--bg-surface)] pl-9 pr-3 text-sm placeholder:text-[var(--text-secondary)] ${control}`} />
      </span></label>
      <label className="flex min-w-0 flex-wrap items-center gap-2"><span className="text-[var(--text-secondary)]">Sort by</span>
        <select aria-label="Sort creative" value={sort} onChange={change => updateSelection({ overview_creative_sort: change.target.value === 'spend' ? null : change.target.value, overview_creative_page: null })} className={`h-11 min-w-0 max-w-full border border-[var(--border)] bg-[var(--bg-surface)] px-3 ${control}`}>
          <option value="spend">Spend, highest first</option><option value="results">{event.label}, highest first</option><option value="cpa">{event.label} CPA, lowest first</option>
        </select>
      </label>
      <label className="flex min-w-0 flex-wrap items-center gap-2"><span className="text-[var(--text-secondary)]">Rows</span>
        <select aria-label="Creative page size" value={pageSize} onChange={change => updateSelection({ overview_creative_size: change.target.value === '25' ? null : change.target.value, overview_creative_page: null })} className={`h-11 min-w-0 max-w-full border border-[var(--border)] bg-[var(--bg-surface)] px-3 ${control}`}>
          <option value="25">25</option><option value="5">5</option>
        </select>
      </label>
    </div>
      </div>
    </details>
    {(search || sort !== 'spend') && <p aria-label="Active creative filters" className="break-words text-sm text-[var(--text-secondary)]">{search ? `Search: “${search}” · ` : ''}{sortLabel}</p>}
    {presentation === 'table' && <p aria-live="polite" className="text-[var(--text-secondary)]">{view.total} ads supplied · {view.filtered} match{view.filtered === 1 ? '' : 'es'} · {view.rows.length} on this page</p>}
    {presentation === 'scatter' && <OverviewCreativeScatter data={data} event={event} search={search} onInspect={focusAd} />}
    <div hidden={presentation !== 'table'}>
    <table className="block w-full table-fixed border-collapse text-left lg:table">
      <caption className="sr-only">Creative attention, response, spend and {event.label} outcomes. {view.total} supplied ads. Search and pagination cover the full population.</caption>
      <colgroup className="hidden lg:table-column-group">{[30, 14, 17, 10, 16, 13].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup>
      <thead className="hidden lg:table-header-group"><tr className="border-b border-[var(--border-strong)] text-[var(--text-secondary)]">
        {['Creative', 'Attention', 'Response', 'Spend', event.label, 'ROAS'].map(label => <th scope="col" key={label} className="break-words px-2 pb-3 font-medium">{label === 'AppointmentConfirmed' ? <>Appointment<wbr />Confirmed</> : label}</th>)}
      </tr></thead>
      <tbody className="block lg:table-row-group">{view.rows.map(entity => {
        const open = expanded.includes(entity.id), detailsId = `${id}-${entity.id}-detail`, halfway = retention.get(entity.id)
        const eventMetric = (key: string) => overviewCreativeMetric(entity, key, event, metaContext)
        const nativeMetric = (key: string) => overviewCreativeMetric(entity, key, undefined, metaContext)
        const outcome = eventMetric(event.count)
        const cpa = eventMetric(event.cpa)
        const roas = eventMetric(event.roas)
        const value = eventMetric(event.value)
        const cpaReconciliation = overviewCreativeReconciliation(entity, cpa, event, metaContext, data.meta.data?.observations ?? [])
        const roasReconciliation = overviewCreativeReconciliation(entity, roas, event, metaContext, data.meta.data?.observations ?? [])
        const zeroResult = !cpaReconciliation && hierarchyHasNoResults(data, entity, event)
        const nonVideo = entity.creative?.format === 'image' || entity.creative?.format === 'carousel'
        const qualified = [outcome?.current, ...(!zeroResult ? [cpa?.current] : [])].some(claim => claim && overviewNumber(outcome) !== null
          && (claim.coverage.state !== 'complete' || claim.freshness.state === 'stale' || claim.maturity.state === 'partial'))
        return <Fragment key={entity.id}>
          <tr id={rowId(entity.id)} tabIndex={-1} aria-label={`${entity.name} comparison`} className="grid min-w-0 grid-cols-6 border-b border-[var(--border)] pb-3 outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)] lg:table-row lg:pb-0 lg:hover:bg-[var(--bg-base)]">
            <td className={`${cell} col-span-6 block lg:table-cell`}><CreativeIdentity entity={entity} expanded={open} toggle={() => toggle(entity.id)} detailsId={detailsId} loading={data.meta.data?.detailState === 'loading'} /></td>
            <td className={`${cell} col-span-3 block space-y-1 border-t border-[var(--border)] lg:table-cell lg:border-t-0`}>
              {nonVideo ? <p className="text-sm text-[var(--text-secondary)]">Video metrics not applicable</p> : <>
                <Reading label="Halfway / starts" value={halfway?.value === null || halfway?.value === undefined ? 'Unavailable' : `${halfway.value.toFixed(1)}%`} primary />
                <Reading label="Average watch" metric={nativeMetric('average_watch_seconds')} />
              </>}
            </td>
            <td className={`${cell} col-span-3 block space-y-1 border-t border-[var(--border)] lg:table-cell lg:border-t-0`}><Reading label="Outbound CTR" metric={nativeMetric('outbound_ctr')} primary />
              <Reading label="Outbound clicks" metric={nativeMetric('outbound_clicks')} /><Reading label="Engagement / impression" metric={nativeMetric('engagement_rate')} />
            </td>
            <td className={`${cell} col-span-2 block border-t border-[var(--border)] lg:table-cell lg:border-t-0`}><Reading label="Spend" metric={nativeMetric('spend')} primary /></td>
            <td className={`${cell} col-span-2 block space-y-1 border-t border-[var(--border)] lg:table-cell lg:border-t-0`}><Reading label="Reported results" accessibleLabel={`${event.label} count`} metric={outcome} primary />
              {zeroResult ? <div role="group" aria-label={`${event.label} CPA`} className="text-sm leading-5"><span className="font-medium" title="CPA is undefined because there are no selected-event results.">— CPA</span><span className="block text-[var(--text-secondary)]">No results</span></div>
                : <><Reading label="CPA" accessibleLabel={`${event.label} CPA`} metric={cpa} value={cpaReconciliation ? 'Withheld' : undefined} />
                  {cpaReconciliation && <ReconciliationDisclosure reconciliation={cpaReconciliation} />}</>}
              {!cpaReconciliation && qualified && <p className="text-[var(--warning)]">Qualified evidence</p>}
            </td>
            <td className={`${cell} col-span-2 block space-y-1 border-t border-[var(--border)] lg:table-cell lg:border-t-0`}><Reading label="ROAS" accessibleLabel={`${event.label} ROAS`} metric={roas} value={roasReconciliation ? 'Withheld' : undefined} primary />
              {roasReconciliation && <ReconciliationDisclosure reconciliation={roasReconciliation} />}
              <Reading label="Reported value" accessibleLabel={`${event.label} value`} metric={value} /></td>
          </tr>
          {open && <tr className="block lg:table-row"><td id={detailsId} colSpan={6} className="block min-w-0 border-b border-[var(--border)] p-0 lg:table-cell"><OverviewCreativeDetails entity={entity} context={metaContext} event={event} savedId={savedId} observations={data.meta.data?.observations ?? []} /></td></tr>}
        </Fragment>
      })}</tbody>
    </table>
    {!view.rows.length && <p role="status" className="py-8 text-[var(--text-secondary)]">{loading ? 'Creative evidence is loading.' : search ? 'No supplied ads match this search.' : data.meta.state === 'unavailable' ? 'Meta creative evidence is unavailable.' : 'No ad executions were supplied for this period.'}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-3xl text-[var(--text-secondary)]">Observed results may still settle. Rankings cover available supplied observations; delivery and video length differ. Expand an ad for metric definitions and evidence.</p>
      <nav aria-label="Creative pages" className="flex shrink-0 items-center gap-2">
        <button type="button" aria-label="Previous creative page" disabled={view.page === 1} onClick={() => navigatePage(view.page - 1)} className={`px-2 disabled:opacity-40 ${control}`}><ChevronLeft size={18} aria-hidden="true" /></button>
        <span className="tabular-nums">Page {view.page} of {view.pages}</span>
        <button type="button" aria-label="Next creative page" disabled={view.page === view.pages} onClick={() => navigatePage(view.page + 1)} className={`px-2 disabled:opacity-40 ${control}`}><ChevronRight size={18} aria-hidden="true" /></button>
      </nav>
    </div>
    </div>
  </section>
}
