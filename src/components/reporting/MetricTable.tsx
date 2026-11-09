'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Download, Search } from 'lucide-react'
import type { ReportEntity, ReportMetricMap, ReportingContext, ReportingData } from '@/lib/reporting/contracts'
import { downloadReportCsv, metricsToExportRows } from '@/lib/reporting/export'
import { budgetExportRows } from '@/lib/reporting/budget-export'
import { ReportMetricValue } from './MetricValue'
import { BudgetContextSummary } from './BudgetEvidenceDetails'
import { outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export const METRIC_GROUPS = {
  response: { label: 'Response', description: 'Viewing, social response, visits, messaging and named outcomes together; counts do not identify a joined customer journey.', keys: ['spend', 'impressions', 'video_2s', 'cost_per_2s_view', 'thruplays', 'cost_per_thruplay', 'action_video_views', 'cost_per_action_video_view', 'engagements', 'engagement_rate', 'cost_per_engagement', 'reactions', 'comments', 'shares', 'share_rate', 'cost_per_share', 'saves', 'messaging_conversations_started', 'cost_per_messaging_conversation_started', 'messaging_conversations_replied', 'messaging_first_replies', 'instagram_profile_visits', 'cost_per_instagram_profile_visit', 'instagram_profile_follows', 'cost_per_instagram_profile_follow', 'outbound_clicks', 'outbound_ctr', 'landing_page_views', 'bookings', 'cost_per_booking', 'appointment_value', 'appointment_roas', 'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas'] },
  results: { label: 'Results', description: 'Named-event counts, value, CPA and ROAS reported by Meta.', keys: ['spend', 'bookings', 'cost_per_booking', 'appointment_value', 'appointment_roas', 'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas', 'bookings_click', 'bookings_view'] },
  delivery: { label: 'Delivery', description: 'Exposure and delivery cost for the selected period.', keys: ['spend', 'impressions', 'reach', 'frequency', 'cpm'] },
  clicks: { label: 'Clicks', description: 'All clicks, link clicks, outbound visits, profile visits and landing-page views are separate measures.', keys: ['spend', 'clicks', 'ctr', 'cpc', 'link_clicks', 'link_ctr', 'link_cpc', 'outbound_clicks', 'outbound_ctr', 'outbound_cpc', 'instagram_profile_visits', 'cost_per_instagram_profile_visit', 'landing_page_views', 'cost_per_lpv'] },
  engagement: { label: 'Engagement', description: 'Named social and inquiry actions with costs. Actions can overlap; these are not unique people or customers.', keys: ['spend', 'impressions', 'engagements', 'engagement_rate', 'cost_per_engagement', 'reactions', 'comments', 'shares', 'share_rate', 'cost_per_share', 'saves', 'messaging_conversations_started', 'cost_per_messaging_conversation_started', 'messaging_conversations_replied', 'messaging_first_replies', 'instagram_profile_visits', 'instagram_profile_follows', 'video_plays', 'video_2s', 'thruplays'] },
  attention: { label: 'Attention', description: 'Reported watch depth and viewing cost beside the current creative preview.', keys: ['spend', 'impressions', 'action_video_views', 'cost_per_action_video_view', 'video_plays', 'video_2s', 'cost_per_2s_view', 'thruplays', 'cost_per_thruplay', 'average_watch_seconds', 'retention_p25', 'retention_p50', 'retention_p75', 'retention_p100'] },
} as const
export type MetricGroup = keyof typeof METRIC_GROUPS
export function comparisonMetricKeys(group: MetricGroup): string[] {
  return [...new Set(['spend', 'impressions', 'reach', 'frequency', 'engagements', 'outbound_clicks', 'outbound_ctr',
    'landing_page_views', 'messaging_conversations_started', 'instagram_profile_visits', 'bookings', 'cost_per_booking', 'appointment_value', 'appointment_roas',
    'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas', ...METRIC_GROUPS[group].keys,
    ...(group === 'attention' ? ['watch_p25', 'watch_p50', 'watch_p75', 'watch_p100'] : [])])]
}
export type QueryChanges = Record<string, string | null>
const LABELS: Record<string, string> = {
  spend: 'Spend', bookings: `Meta ${OW.one} events`, cost_per_booking: `Cost / Meta ${OW.one} event`,
  appointment_value: `Meta ${OW.one} event value`, appointment_roas: `${EVENT} ROAS`, purchase_count: 'Reported purchases', cost_per_purchase: 'Cost per reported Purchase', purchase_value: 'Reported purchase value', purchase_roas: 'Purchase ROAS', bookings_click: `Click-attributed Meta ${OW.one} events`, bookings_view: `View-attributed Meta ${OW.one} events`,
  impressions: 'Impressions', reach: 'Reach', frequency: 'Frequency', cpm: 'CPM', clicks: 'All clicks', ctr: 'All-click CTR', cpc: 'All-click CPC',
  link_clicks: 'Link clicks', link_ctr: 'Link CTR', link_cpc: 'Link CPC', outbound_clicks: 'Outbound clicks', outbound_ctr: 'Outbound CTR', outbound_cpc: 'Outbound CPC',
  landing_page_views: 'Landing-page views', cost_per_lpv: 'Cost / landing-page view', engagements: 'Post engagements', reactions: 'Reactions', comments: 'Comments', shares: 'Shares', saves: 'Saves',
  messaging_conversations_started: 'Messaging conversations started', messaging_conversations_replied: 'Messaging conversations replied', messaging_first_replies: 'Messaging first replies',
  instagram_profile_visits: 'Instagram profile visits', instagram_profile_follows: 'Instagram profile follows', action_video_views: 'Meta actions: video_view',
  cost_per_messaging_conversation_started: 'Cost per messaging conversation started', cost_per_instagram_profile_visit: 'Cost per Instagram profile visit',
  cost_per_instagram_profile_follow: 'Cost per Instagram profile follow', cost_per_action_video_view: 'Cost per Meta actions: video_view',
  video_plays: 'Video starts', video_2s: '2-second continuous plays', thruplays: 'ThruPlays', average_watch_seconds: 'Average watch time',
  cost_per_2s_view: 'Cost per continuous 2-second view', cost_per_thruplay: 'Cost per ThruPlay', cost_per_engagement: 'Cost per post engagement', cost_per_share: 'Cost per post share', engagement_rate: 'Post engagements / impressions', share_rate: 'Post shares / impressions',
  retention_p25: 'Watched 25% / starts', retention_p50: 'Watched 50% / starts', retention_p75: 'Watched 75% / starts', retention_p100: 'Watched 100% / starts',
  watch_p25: '25% video plays', watch_p50: '50% video plays', watch_p75: '75% video plays', watch_p100: '100% video plays',
}
export function metricLabel(key: string, metrics?: ReportMetricMap) {
  return metrics?.[key]?.label ?? LABELS[key] ?? key.replaceAll('_', ' ')
}
export const reportControlClass = 'min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60'
export const reportButtonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] disabled:cursor-not-allowed disabled:opacity-60'

export function investigationHref(path: string, search: URLSearchParams, changes: QueryChanges) {
  const next = new URLSearchParams(search)
  Object.entries(changes).forEach(([key, value]) => {
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
  })
  return `${path}${next.size ? `?${next}` : ''}`
}

export function useInvestigation(context: ReportingContext, defaultGroup: MetricGroup = 'results') {
  const query = useSearchParams()
  const path = usePathname()
  const params = new URLSearchParams(query.toString())
  params.set('from', context.range.from)
  params.set('to', context.range.to)
  const requestedGroup = params.get('group')
  const group = requestedGroup && Object.hasOwn(METRIC_GROUPS, requestedGroup) ? requestedGroup as MetricGroup : defaultGroup
  const requestedLevel = params.get('level')
  const level: ReportEntity['level'] = requestedLevel === 'campaign' || requestedLevel === 'adset' ? requestedLevel : 'ad'
  const selected = [...new Set((params.get('compare') ?? '').split(',').filter(Boolean))].slice(0, 4)
  const update = (changes: QueryChanges, replace = false) => {
    const current = new URLSearchParams(window.location.search)
    current.set('from', context.range.from)
    current.set('to', context.range.to)
    const href = investigationHref(path, current, changes)
    if (replace) window.history.replaceState(null, '', href)
    else window.history.pushState(null, '', href)
  }
  return { params, path, group, level, selected, update,
    href: (changes: QueryChanges, destination = path) => investigationHref(destination, params, changes),
    toggle: (id: string) => update({ compare: selected.includes(id) ? selected.filter(value => value !== id).join(',') : [...selected, id].slice(0, 4).join(','), view: null }),
  }
}

export function filterEntities(entities: ReportEntity[], params: URLSearchParams, level: ReportEntity['level']) {
  const query = (params.get('q') ?? '').trim().toLocaleLowerCase()
  return entities.filter(entity => entity.level === level
    && (!params.get('campaign') || (entity.level === 'campaign' ? entity.id : entity.campaignId) === params.get('campaign'))
    && (!params.get('adset') || (entity.level === 'adset' ? entity.id : entity.adsetId) === params.get('adset'))
    && (!params.get('status') || entity.status === params.get('status'))
    && (!params.get('audience') || entity.audience === params.get('audience'))
    && (!params.get('format') || (entity.creative?.format ?? 'unknown') === params.get('format'))
    && (!query || [entity.name, entity.id, entity.campaignName, entity.adsetName, entity.creative?.body, entity.creative?.headline]
      .some(value => value?.toLocaleLowerCase().includes(query))))
}

export function scopeComparison(state: ReturnType<typeof useInvestigation>, entities: ReportEntity[]) {
  const selected = state.selected.filter(id => entities.some(entity => entity.id === id))
  return { ...state, selected, toggle: (id: string) => state.update({
    compare: selected.includes(id) ? selected.filter(value => value !== id).join(',') : [...selected, id].slice(0, 4).join(','), view: null,
  }) }
}

export function sortEntities(entities: ReportEntity[], key: string, direction: 'asc' | 'desc') {
  const value = (entity: ReportEntity) => {
    const claim = entity.metrics[key]?.current
    return claim?.availability.state === 'available' && typeof claim.value === 'number' ? claim.value : null
  }
  return [...entities].sort((left, right) => {
    if (key === 'name') return (direction === 'asc' ? 1 : -1) * left.name.localeCompare(right.name)
    const a = value(left), b = value(right)
    if (a === null) return b === null ? left.name.localeCompare(right.name) : 1
    if (b === null) return -1
    return (direction === 'asc' ? a - b : b - a) || left.name.localeCompare(right.name)
  })
}

export function ReportContextLine({ context, asOf }: { context: ReportingContext; asOf?: string | null }) {
  return <div className="space-y-1 text-xs leading-5 text-[var(--text-secondary)]">
    <p><span className="font-medium text-[var(--text-primary)]">{context.account.name ?? 'Meta account'}</span> · {context.account.metaAccountId} · Meta-reported · {context.currency}</p>
    <p>{context.range.from} – {context.range.to} · {context.timezone}. Previous: {context.comparison.from} – {context.comparison.to}.</p>
    <p>Source as of {asOf ?? context.asOf}</p>
  </div>
}

function MetaSourceNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null
  return <details className="mt-1"><summary className="min-h-11 cursor-pointer py-2 text-[var(--text-secondary)]">Review {notes.length} Meta source qualification{notes.length === 1 ? '' : 's'}</summary>
    <div className="space-y-2 border-t border-[var(--border)] pt-3">{notes.map((note, index) => <p key={index} className="text-[var(--text-secondary)]">{note}</p>)}</div>
  </details>
}

export function InvestigationSourceState({ data }: { data: ReportingData }) {
  const source = data.meta
  const notes = [...new Set(source.notes)]
  if (source.state === 'loading') return <div role="status" aria-label="Loading Meta investigation" className="space-y-4 py-6">
    <p className="text-sm text-[var(--text-secondary)]">Loading Meta delivery and creative…</p>
    <div className="skeleton h-12 w-full" /><div className="skeleton h-48 w-full" />
  </div>
  if (source.data?.detailState === 'loading') return <div role="status" className="space-y-1 text-sm text-[var(--text-secondary)]">
    <p>Loading Meta details…</p>
    <MetaSourceNotes notes={notes} />
  </div>
  if (source.state === 'available' && source.notes.length === 0) return null
  return <div role="status" className="rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-4 text-sm leading-6">
    <p className="font-medium">{source.state === 'unavailable' ? 'Meta reporting is unavailable' : 'Some Meta evidence is incomplete'}</p>
    {source.state === 'unavailable' ? notes.map((note, index) => <p key={index} className="text-[var(--text-secondary)]">{note}</p>)
      : <MetaSourceNotes notes={notes} />}
    {source.state === 'unavailable' && <p className="text-[var(--text-secondary)]">Delivery cannot be measured from this response. Retry Meta from the source controls.</p>}
  </div>
}

export function MetricGroupControl({ group, groups, onChange }: { group: MetricGroup; groups: MetricGroup[]; onChange: (group: MetricGroup) => void }) {
  const visibleGroups = groups.includes(group) ? groups : [...groups, group]
  return <div className="space-y-2">
    <div role="group" aria-label="Metric presets" className="flex flex-wrap gap-1 border-b border-[var(--border)]">
      {visibleGroups.map(key => <button key={key} type="button" aria-pressed={group === key} onClick={() => onChange(key)}
        className={`min-h-11 rounded-t-md px-4 text-sm font-medium ${group === key ? 'border-b-2 border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]'}`}>{METRIC_GROUPS[key].label}</button>)}
    </div>
    <p className="text-sm text-[var(--text-secondary)]">{METRIC_GROUPS[group].description}</p>
  </div>
}

export function InvestigationFilters({ entities, params, group, update, creative = false, detailsLoading = false }: {
  entities: ReportEntity[]; params: URLSearchParams; group: MetricGroup; update: (changes: QueryChanges, replace?: boolean) => void; creative?: boolean; detailsLoading?: boolean
}) {
  const campaigns = new Map(entities.flatMap(entity => entity.level === 'campaign' ? [[entity.id, entity.name] as const] : entity.campaignId ? [[entity.campaignId, entity.campaignName ?? entity.campaignId] as const] : []))
  const adsets = new Map(entities.filter(entity => !params.get('campaign') || entity.campaignId === params.get('campaign'))
    .flatMap(entity => entity.level === 'adset' ? [[entity.id, entity.name] as const] : entity.adsetId ? [[entity.adsetId, entity.adsetName ?? entity.adsetId] as const] : []))
  const select = (label: string, key: string, options: [string, string][], changes?: QueryChanges) => <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]">
    {label}<select aria-label={label} className={reportControlClass} value={params.get(key) ?? ''} onChange={event => update({ [key]: event.target.value || null, ...changes, compare: null, view: null })}>
      <option value="">All {label.toLowerCase()}</option>
      {params.get(key) && !options.some(([id]) => id === params.get(key)) && <option value={params.get(key)!}>{detailsLoading ? 'Loading option' : 'Not in this response'} ({params.get(key)})</option>}
      {options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
    </select>
  </label>
  return <div className="flex flex-wrap items-end gap-3">
    <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">Search
      <span className="relative"><Search aria-hidden="true" size={16} className="absolute left-3 top-3.5" />
        <input type="search" aria-label="Search ads, names or copy" placeholder="Name, ID or creative copy" className={`${reportControlClass} w-full pl-9 placeholder:text-[var(--text-tertiary)]`}
          value={params.get('q') ?? ''} onChange={event => update({ q: event.target.value || null, compare: null, view: null }, true)} />
      </span>
    </label>
    {select('Campaigns', 'campaign', [...campaigns], { adset: null, ad: null })}
    {select('Ad sets', 'adset', [...adsets], { ad: null, level: 'ad' })}
    {select('Statuses', 'status', [...new Set(entities.map(entity => entity.status))].sort().map(value => [value, value]))}
    {select('Audiences', 'audience', [['cold', 'Cold'], ['warm', 'Warm'], ['mixed', 'Mixed'], ['unknown', 'Unknown']])}
    {creative && select('Formats', 'format', [['video', 'Video'], ['image', 'Image'], ['carousel', 'Carousel'], ['unknown', 'Unknown']])}
    <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">Sort by
      <select className={reportControlClass} aria-label="Sort by" value={params.get('sort') ?? 'spend'} onChange={event => update({ sort: event.target.value })}>
        <option value="name">Name</option>
        {[...new Set(['spend', ...METRIC_GROUPS[group].keys])].map(key => <option key={key} value={key}>{metricLabel(key)}</option>)}
      </select>
    </label>
    <button type="button" className={reportButtonClass} aria-label={params.get('direction') === 'asc' ? 'Sort descending' : 'Sort ascending'}
      onClick={() => update({ direction: params.get('direction') === 'asc' ? 'desc' : 'asc' })}>
      {params.get('direction') === 'asc' ? <ArrowUp size={16} aria-hidden="true" /> : <ArrowDown size={16} aria-hidden="true" />}
      {params.get('direction') === 'asc' ? 'Low to high' : 'High to low'}
    </button>
  </div>
}

export function InvestigationExport({ entities, allEntities = entities, group, context, filename, extraKeys = [], label = 'Export CSV' }: { entities: ReportEntity[]; allEntities?: ReportEntity[]; group: MetricGroup; context: ReportingContext; filename: string; extraKeys?: string[]; label?: string }) {
  return <button type="button" className={reportButtonClass} disabled={!entities.length} onClick={() => {
    const keys = [...new Set([...METRIC_GROUPS[group].keys, ...extraKeys])]
    const rows = entities.flatMap(entity => metricsToExportRows(Object.fromEntries(keys.flatMap(key => entity.metrics[key] ? [[key, entity.metrics[key]]] : [])),
      `${entity.name} (${entity.level} ${entity.id}; campaign ${entity.campaignId ?? '—'}; ad set ${entity.adsetId ?? '—'}; ${entity.status}; ${entity.audienceLabel})`, context))
    downloadReportCsv([...rows, ...budgetExportRows(entities, allEntities, context)], `${filename}-${group}-${context.range.from}-${context.range.to}.csv`)
  }}><Download size={16} aria-hidden="true" />{label}</button>
}

export function MetricTable({ entities, allEntities = entities, group, selected, onSelect, entityLink, sortKey, direction, onSort, bounded = false }: {
  entities: ReportEntity[]; allEntities?: ReportEntity[]; group: MetricGroup; selected: string[]; onSelect: (id: string) => void;
  entityLink: (entity: ReportEntity) => ReactNode; sortKey: string; direction: 'asc' | 'desc'; onSort: (key: string) => void; bounded?: boolean
}) {
  return <><div className={`min-w-0 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] print:hidden ${bounded ? 'max-h-[38rem] overflow-y-auto' : ''}`} role="region" aria-label="Entity metrics, scroll for more columns" tabIndex={0}>
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{METRIC_GROUPS[group].label} by entity. Unavailable means Meta did not supply a usable value. Select two to four rows to compare.</caption>
      <thead className={`bg-[var(--bg-subtle)] text-xs text-[var(--text-secondary)] ${bounded ? 'sticky top-0 z-10' : ''}`}><tr>
        <th scope="col" className="w-12 px-3 py-2"><span className="sr-only">Compare</span></th>
        <th scope="col" className="min-w-64 px-3 py-2 text-left" aria-sort={sortKey === 'name' ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
          <button className="min-h-11 text-left" onClick={() => onSort('name')}>Name {sortKey === 'name' ? direction === 'asc' ? '↑' : '↓' : ''}</button>
        </th>
        {METRIC_GROUPS[group].keys.map(key => <th scope="col" key={key} className="min-w-36 px-3 py-2 text-right font-medium" aria-sort={sortKey === key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
          <button className="min-h-11 text-right" onClick={() => onSort(key)}>{metricLabel(key, entities.find(entity => entity.metrics[key])?.metrics)} {sortKey === key ? direction === 'asc' ? '↑' : '↓' : ''}</button>
        </th>)}
      </tr></thead>
      <tbody>{entities.map(entity => <tr key={entity.id} className="border-t border-[var(--border)] hover:bg-[var(--bg-row-hover)]">
        <td className="px-3 py-4"><label className="flex min-h-11 min-w-8 items-center justify-center"><span className="sr-only">Compare {entity.name}</span><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={selected.includes(entity.id)} disabled={selected.length >= 4 && !selected.includes(entity.id)} onChange={() => onSelect(entity.id)} /></label></td>
        <th scope="row" className="px-3 py-4 text-left font-normal">
          {entityLink(entity)}
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{entity.adsetName ?? entity.campaignName ?? entity.level} · {entity.audienceLabel}</p>
          <p className="text-xs leading-5 text-[var(--text-secondary)]">{entity.status} · ID {entity.id}</p>
          <BudgetContextSummary entity={entity} entities={allEntities} />
        </th>
        {METRIC_GROUPS[group].keys.map(key => <td key={key} className="px-3 py-4 text-right align-top tabular-nums"><ReportMetricValue metric={entity.metrics[key]} comparison compact /></td>)}
      </tr>)}</tbody>
    </table>
  </div>
    <div className="hidden print:block" data-reporting-entity-print>
      {entities.map(entity => <section key={entity.id} data-reporting-print-entity={entity.id} className="mb-8">
        <h3 className="font-semibold">{entity.name}</h3>
        <p className="text-xs">{entity.level} {entity.id} · {entity.adsetName ?? entity.campaignName ?? entity.level} · {entity.audienceLabel} · {entity.status}</p>
        <BudgetContextSummary entity={entity} entities={allEntities} />
        <EntityMetricList metrics={entity.metrics} keys={METRIC_GROUPS[group].keys} comparison />
      </section>)}
    </div>
  </>
}

export function EntityMetricList({ metrics, keys, comparison = false }: { metrics: ReportMetricMap; keys: readonly string[]; comparison?: boolean }) {
  return <dl className="divide-y divide-[var(--border)]">{keys.map(key => <div key={key} className="flex items-start justify-between gap-4 py-1 text-sm">
    <dt className="min-w-0 break-words py-3 text-[var(--text-secondary)]">{metricLabel(key, metrics)}</dt>
    <dd className="min-w-0 max-w-[65%] shrink-0 text-right tabular-nums"><ReportMetricValue metric={metrics[key]} comparison={comparison} compact /></dd>
  </div>)}</dl>
}
