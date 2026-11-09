'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import type { ReportingData } from '@/lib/reporting/contracts'
import { CreativeAsset } from './CreativeAsset'
import { CreativeGroupPanel } from './CreativeGroupPanel'
import { CreativeResponseScope } from './CreativeResponseScope'
import { InvestigationCompareBar, InvestigationEmpty, InvestigationSelection } from './AdsReport'
import {
  EntityMetricList, filterEntities, InvestigationExport, InvestigationFilters, InvestigationSourceState,
  METRIC_GROUPS, MetricGroupControl, ReportContextLine, reportButtonClass, scopeComparison, sortEntities, useInvestigation,
} from './MetricTable'

export function CreativeReport({ data }: { data: ReportingData }) {
  const detailsLoading = data.meta.data?.detailState === 'loading'
  const controls = useInvestigation(data.context, 'response')
  const entities = data.meta.data?.entities ?? []
  const rows = sortEntities(filterEntities(entities, controls.params, 'ad'), controls.params.get('sort') ?? 'spend', controls.params.get('direction') === 'asc' ? 'asc' : 'desc')
  const state = scopeComparison(controls, rows)
  const grouped = state.params.get('grouping') === 'creative'
  const primaryKeys: readonly string[] = state.group === 'response'
    ? ['spend', 'thruplays', 'messaging_conversations_started', 'cost_per_messaging_conversation_started', 'instagram_profile_visits', 'action_video_views', 'engagements', 'cost_per_engagement', 'outbound_clicks', 'landing_page_views', 'bookings', 'appointment_roas']
    : state.group === 'attention'
    ? ['spend', 'impressions', 'average_watch_seconds', 'thruplays', 'retention_p25', 'retention_p100']
    : state.group === 'clicks' ? ['spend', 'link_clicks', 'outbound_clicks', 'outbound_ctr', 'instagram_profile_visits', 'landing_page_views', 'cost_per_lpv']
      : METRIC_GROUPS[state.group].keys
  const moreKeys = METRIC_GROUPS[state.group].keys.filter(key => !primaryKeys.includes(key))
  const detail = Boolean(state.params.get('ad')) || state.params.get('view') === 'compare'
  return <div className="min-w-0 space-y-5 text-[var(--text-primary)]">
    <InvestigationSourceState data={data} />
    {data.meta.data && (detail ? <InvestigationSelection data={data} entities={rows} state={state} /> : <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2"><h2 className="text-xl font-semibold">Creative performance</h2><ReportContextLine context={data.context} asOf={data.meta.asOf} /></div>
        {!grouped && <InvestigationExport entities={rows} group={state.group} context={data.context} filename="creative" />}
      </div>
      <p className="max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">Connect reported viewing, engagement, clicks and booked outcomes with each execution’s audience and exposure. Current previews retain their observation date; shared creative names are not identity.</p>
      <div role="group" aria-label="Creative grouping" className="flex flex-wrap gap-2">
        <button type="button" className={reportButtonClass} aria-pressed={!grouped} onClick={() => state.update({ grouping: null, ad: null, view: null })}>Ad executions</button>
        <button type="button" className={reportButtonClass} aria-pressed={grouped} onClick={() => state.update({ grouping: 'creative', ad: null, view: null })}>Shared creative</button>
      </div>
      <MetricGroupControl group={state.group} groups={['response', 'attention', 'engagement', 'clicks', 'results']} onChange={group => state.update({ group, sort: null })} />
      {(state.group === 'response' || state.group === 'engagement') && <CreativeResponseScope />}
      <InvestigationFilters entities={entities} params={state.params} group={state.group} update={state.update} creative detailsLoading={detailsLoading} />
      {grouped ? <CreativeGroupPanel data={data} entities={rows} group={state.group} href={changes => state.href(changes)} sortKey={state.params.get('sort') ?? 'spend'} direction={state.params.get('direction') === 'asc' ? 'asc' : 'desc'} /> : <>
      <InvestigationCompareBar rows={rows} state={state} />
      {rows.length ? <div className="grid min-w-0 grid-cols-1 items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(entity => <article key={entity.id} aria-label={entity.name} className="min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
          <div className="p-4 pb-0"><CreativeAsset creative={entity.creative} name={entity.name} detailsLoading={detailsLoading} /></div>
          <div className="space-y-3 p-4">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" aria-label={`Compare ${entity.name}`} checked={state.selected.includes(entity.id)} disabled={state.selected.length >= 4 && !state.selected.includes(entity.id)} onChange={() => state.toggle(entity.id)} />
              Compare this execution
            </label>
            <div>
              <Link href={state.href({ ad: entity.id })} scroll={false} className="inline-flex min-h-11 items-center gap-2 text-base font-semibold text-[var(--accent)] hover:underline"><span className="break-words">{entity.name}</span><ArrowRight size={16} className="shrink-0" aria-hidden="true" /></Link>
              <p className="text-xs leading-5 text-[var(--text-secondary)]">{entity.campaignName ?? (detailsLoading ? 'Loading campaign…' : 'Campaign unavailable')} / {entity.adsetName ?? (detailsLoading ? 'Loading ad set…' : 'Ad set unavailable')}</p>
              <p className="text-xs leading-5 text-[var(--text-secondary)]">{entity.audienceLabel} · {entity.status}</p>
              <p className="text-xs leading-5 text-[var(--text-secondary)]">Ad {entity.id} · Creative {entity.creative?.id ?? (detailsLoading ? 'loading…' : 'unavailable')}</p>
            </div>
            {entity.creative?.headline && <p className="text-sm font-medium">{entity.creative.headline}</p>}
            {entity.creative?.body && <p className="line-clamp-2 text-sm leading-6 text-[var(--text-secondary)]">{entity.creative.body}</p>}
            <EntityMetricList metrics={entity.metrics} keys={primaryKeys} />
            {moreKeys.length > 0 && <details data-reporting-metric-disclosure className="text-sm"><summary className="min-h-11 cursor-pointer py-3 font-medium">More {METRIC_GROUPS[state.group].label.toLowerCase()} metrics</summary><EntityMetricList metrics={entity.metrics} keys={moreKeys} /></details>}
            {state.group === 'attention' && entity.creative?.format !== 'video' && <p className="text-xs leading-5 text-[var(--text-secondary)]">Watch metrics apply to video. Missing values do not indicate no engagement with an image.</p>}
          </div>
        </article>)}
      </div> : <InvestigationEmpty state={state} hasEntities={entities.some(entity => entity.level === 'ad')} detailsLoading={detailsLoading} />}
      </>}
      <p className="max-w-3xl text-xs leading-5 text-[var(--text-secondary)]">Meta attribution: {data.meta.data.attributionWindow}. Reporting time: {data.meta.data.reportingTime}. Low outcome counts remain visible and do not establish a reliable creative ranking. Watch percentage depends on video length.</p>
    </>)}
  </div>
}
