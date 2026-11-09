'use client'

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { MetaReport, ReportEntity, ReportingContext } from '@/lib/reporting/contracts'
import { EntityHistory } from './EntityHistory'
import { CreativeAsset } from './CreativeAsset'
import { CreativeResponseScope } from './CreativeResponseScope'
import { EntityMetricList, METRIC_GROUPS, MetricGroupControl, metricLabel, ReportContextLine, type MetricGroup } from './MetricTable'
import { ReportMetricValue } from './MetricValue'
import { safeHref } from '@/lib/ui/safe-href'
import { outcomeNoun } from '@/config/outcome-nouns'

function AdBreakdowns({ entity, detailsLoading, group }: { entity: ReportEntity; detailsLoading: boolean; group: MetricGroup }) {
  const placements = entity.breakdowns?.filter(row => row.dimension === 'placement') ?? []
  const other = entity.breakdowns?.filter(row => row.dimension !== 'placement') ?? []
  const keys = [...new Set(['spend', 'impressions', 'bookings', 'outbound_clicks', ...METRIC_GROUPS[group].keys])]
  return <section aria-label="Ad placement and audience detail" className="space-y-3">
    <h3 className="text-base font-semibold">Where this ad delivered</h3>
    {!placements.length ? <p role="status" className="text-sm text-[var(--text-secondary)]">{detailsLoading ? 'Loading ad-level placement detail…' : 'Ad-level placement detail is unavailable in this response. The account placement mix cannot explain where this individual ad delivered.'}</p>
      : <div className="overflow-x-auto print:hidden" role="region" aria-label="Ad placement metrics" tabIndex={0}>
        <table className="w-full min-w-[480px] text-sm"><caption className="sr-only">Meta placement breakdown for this ad and selected dates</caption>
          <thead><tr><th scope="col" className="py-3 text-left">Placement</th>{keys.map(key => <th scope="col" key={key} className="min-w-32 px-3 py-3 text-right">{metricLabel(key)}</th>)}</tr></thead>
          <tbody>{placements.map(row => <tr key={row.id} className="border-t border-[var(--border)]"><th scope="row" className="py-3 text-left font-normal">{row.label}</th>{keys.map(key => <td key={key} className="px-3 py-3 text-right"><ReportMetricValue metric={row.metrics[key]} compact /></td>)}</tr>)}</tbody>
        </table>
      </div>}
    {placements.length > 0 && <div className="hidden space-y-5 print:block">{placements.map(row => <section key={row.id}>
      <h4 className="text-sm font-semibold">{row.label}</h4><EntityMetricList metrics={row.metrics} keys={keys} comparison />
    </section>)}</div>}
    <p className="text-sm leading-6 text-[var(--text-secondary)]">{other.length ? 'Additional supplied audience breakdowns are below.' : detailsLoading ? 'Loading ad audience detail…' : 'Age, gender and region breakdowns were not supplied for this ad.'} Device detail is not available in the ad reporting source.</p>
    {other.length > 0 && <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Additional audience detail</summary>{other.map(row => <div key={row.id} className="border-t border-[var(--border)] py-3"><h4 className="text-sm font-medium">{row.dimension}: {row.label}</h4><EntityMetricList metrics={row.metrics} keys={['spend', 'impressions', 'bookings']} /></div>)}</details>}
  </section>
}

export function AdDetail({ entity, context, meta, initialGroup = 'results', onGroupChange, sourceAsOf }: { entity: ReportEntity; context: ReportingContext; meta: MetaReport; sourceAsOf?: string; initialGroup?: MetricGroup; onGroupChange?: (group: MetricGroup) => void }) {
  const detailsLoading = meta.detailState === 'loading'
  // The destination is Meta-supplied data; only an http(s) URL becomes a link, anything else is shown as text.
  const destinationHref = safeHref(entity.creative?.destination)
  const [localGroup, setLocalGroup] = useState<MetricGroup>(initialGroup)
  const group = onGroupChange ? initialGroup : localGroup
  const observations = meta.observations.filter(observation => observation.entityId === entity.id || observation.entityId === entity.adsetId || observation.entityId === entity.campaignId)
  return <div className="space-y-8">
    <ReportContextLine context={context} asOf={sourceAsOf} />
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <div className="space-y-4">
        <CreativeAsset creative={entity.creative} name={entity.name} detailsLoading={detailsLoading} />
        <div className="space-y-2 text-sm leading-6">
          <h3 className="font-semibold">{entity.creative?.headline ?? 'Creative copy'}</h3>
          <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{entity.creative?.body ?? (detailsLoading ? 'Loading primary text…' : 'Primary text was not supplied by Meta.')}</p>
          {destinationHref ? <a href={destinationHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 max-w-full items-center gap-2 break-all text-[var(--accent)] underline underline-offset-4">{entity.creative?.destination}<ExternalLink size={14} className="shrink-0" aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
            : entity.creative?.destination ? <p className="break-all text-xs text-[var(--text-secondary)]">{entity.creative.destination}</p>
            : <p className="text-xs text-[var(--text-secondary)]">{detailsLoading ? 'Loading destination…' : 'Destination URL unavailable.'}</p>}
        </div>
        <dl className="space-y-2 border-t border-[var(--border)] pt-4 text-xs leading-5 text-[var(--text-secondary)]">
          <div><dt className="font-medium">Campaign / ad set</dt><dd>{entity.campaignName ?? (detailsLoading ? 'Loading campaign…' : 'Campaign unavailable')} / {entity.adsetName ?? (detailsLoading ? 'Loading ad set…' : 'Ad set unavailable')}</dd></div>
          <div><dt className="font-medium">Identity</dt><dd>Ad {entity.id} · Creative {entity.creative?.id ?? (detailsLoading ? 'loading…' : 'unavailable')}</dd></div>
          <div><dt className="font-medium">Audience and observed status</dt><dd>{entity.audienceLabel} · {entity.status}</dd></div>
          <div><dt className="font-medium">Configuration observed</dt><dd>{entity.configurationAsOf ?? (detailsLoading ? 'Loading configuration' : 'Observation time unavailable')}. This is observed configuration, not a live edit.</dd></div>
        </dl>
        {entity.creative?.format === 'video' && <section className="border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-semibold">Watch depth</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">Watch milestones describe the selected ad-report period. The current preview does not establish historical media content or duration. Open a value for its denominator and definition; 25% watched is not a three-second hook rate.</p>
          <EntityMetricList metrics={entity.metrics} keys={['average_watch_seconds', 'video_plays', 'video_2s', 'cost_per_2s_view', 'thruplays', 'cost_per_thruplay', 'watch_p25', 'watch_p50', 'watch_p75', 'watch_p100', 'retention_p25', 'retention_p50', 'retention_p75', 'retention_p100']} />
        </section>}
      </div>
      <section id="ad-metrics" className="min-w-0 scroll-mt-24 space-y-4">
        <MetricGroupControl group={group} groups={['response', 'results', 'delivery', 'clicks', 'engagement', 'attention']} onChange={value => { setLocalGroup(value); onGroupChange?.(value) }} />
        {(group === 'response' || group === 'engagement') && <CreativeResponseScope />}
        <p className="text-xs leading-5 text-[var(--text-secondary)]">Meta attribution: {meta.attributionWindow}. Reporting time: {meta.reportingTime}. Meta {outcomeNoun({ plural: false })} events count your outcome conversion event; Purchase ROAS retains its separate event.</p>
        <EntityMetricList metrics={entity.metrics} keys={METRIC_GROUPS[group].keys} comparison />
        {group === 'results' && <section className="border-t border-[var(--border)] pt-4"><h3 className="text-sm font-semibold">ROAS inputs</h3><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">Each event value is divided by this ad’s matching spend; the events are not added together.</p><EntityMetricList metrics={entity.metrics} keys={['spend', 'appointment_value', 'purchase_value', 'purchase_count']} comparison /></section>}
        {observations.length > 0 && <section className="border-t border-[var(--border)] pt-4"><h3 className="text-sm font-semibold">Observed setup</h3>{observations.map(observation => <div key={observation.id} className="mt-3 text-sm leading-6"><h4 className="font-medium">{observation.title}</h4><p className="text-[var(--text-secondary)]">{observation.detail}</p>{observation.observedAt && <p className="text-xs text-[var(--text-secondary)]">Observed {observation.observedAt}</p>}</div>)}</section>}
      </section>
    </div>
    <EntityHistory entity={entity} context={context} detailsLoading={detailsLoading} group={group} />
    <AdBreakdowns entity={entity} detailsLoading={detailsLoading} group={group} />
  </div>
}
