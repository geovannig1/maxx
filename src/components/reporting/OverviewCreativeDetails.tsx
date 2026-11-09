'use client'

import type { ReportEntity, ReportMetric, ReportObservation, ReportingContext } from '@/lib/reporting/contracts'
import { overviewHref, overviewNumber, type OverviewEvent } from '@/lib/reporting/overview-model'
import { overviewCreativeAmbiguity, overviewCreativeMetric, overviewCreativeReconciliation, overviewCreativeRetention, overviewCreativeUnavailable } from '@/lib/reporting/overview-creative'
import { CreativeAsset } from './CreativeAsset'
import { ReportMetricValue } from './MetricValue'
import { safeHref } from '@/lib/ui/safe-href'

function MetricDetail({ label, metric, entity, reconciliation }: {
  label: string; metric?: ReportMetric; entity: ReportEntity; reconciliation?: ReturnType<typeof overviewCreativeReconciliation>
}) {
  return <div className="min-w-0"><dt className="text-[var(--text-secondary)]">{label}</dt><dd>
    <ReportMetricValue metric={metric} compact comparison={false} />
    {reconciliation && <p className="text-sm text-[var(--warning)]">{reconciliation.label}. {reconciliation.detail}</p>}
    {overviewNumber(metric) === null && <p className="text-sm text-[var(--text-secondary)]">{overviewCreativeUnavailable(metric, entity)}</p>}
  </dd></div>
}

function Milestones({ entity, context }: { entity: ReportEntity; context: ReportingContext }) {
  const points = overviewCreativeRetention([entity], context)[0]?.points ?? []
  return <section aria-label={`Video milestones for ${entity.name}`} className="min-w-0 space-y-3">
    <h4 className="font-semibold">Video milestones</h4>
    <p className="text-sm text-[var(--text-secondary)]">Plays at each percentage of video length / video starts. These are separate reported milestones, not unique people or exact viewing seconds.</p>
    {points.some(point => point.value !== null) && <svg viewBox="0 0 480 190" className="w-full max-w-xl text-[var(--text-secondary)]" role="img" aria-label="Discrete video milestone rates, with exact values below">
      {[0, 50, 100].map(value => <g key={value}><line x1="42" x2="450" y1={150 - value * 1.2} y2={150 - value * 1.2} stroke="currentColor" opacity="0.2" />
        <text x="36" y={155 - value * 1.2} textAnchor="end" fill="currentColor" fontSize="14">{value}%</text></g>)}
      {points.map((point, index) => <g key={point.milestone}>
        <text x={70 + index * 120} y="178" textAnchor="middle" fill="currentColor" fontSize="14">{point.milestone}%</text>
        {point.value !== null && <circle cx={70 + index * 120} cy={150 - point.value * 1.2} r="5" fill="var(--accent)" data-retention-value={point.value}>
          <title>{`${point.milestone}% length: ${point.value.toFixed(1)}%; ${point.count} / ${point.starts} starts`}</title>
        </circle>}
      </g>)}
    </svg>}
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">{points.map(point => <div key={point.milestone} className="min-w-0">
      <dt className="font-medium">{point.milestone}% length</dt><dd className="tabular-nums">{point.value === null ? 'Unavailable' : `${point.value.toFixed(1)}%`}</dd>
      <dd className="text-[var(--text-secondary)]">{point.count === null ? 'Count unavailable' : point.count.toLocaleString('en-US')} / {point.starts === null ? 'starts unavailable' : `${point.starts.toLocaleString('en-US')} starts`}</dd>
      {point.reason && <dd className="mt-1 text-[var(--text-secondary)]">{point.reason}</dd>}
    </div>)}</dl>
    <p className="text-sm text-[var(--text-secondary)]">Current preview duration does not establish historical duration. Equal percentages of short and long videos represent different viewing time.</p>
  </section>
}

export function OverviewCreativeDetails({ entity, context, event, savedId, observations = [] }: {
  entity: ReportEntity; context: ReportingContext; event: OverviewEvent; savedId?: string | null; observations?: readonly ReportObservation[]
}) {
  const ambiguity = overviewCreativeAmbiguity(entity)
  // The destination is Meta-supplied data; only an http(s) URL becomes a link, anything else is shown as text.
  const destinationHref = safeHref(entity.creative?.destination)
  const fields = [['spend', 'Spend'], [event.count, `${event.label} count`], [event.cpa, `${event.label} CPA`],
    [event.value, `${event.label} value`], [event.roas, `${event.label} ROAS`], ['average_watch_seconds', 'Average watch time'],
    ['retention_p50', 'Halfway / starts'], ['outbound_ctr', 'Outbound CTR'], ['outbound_clicks', 'Outbound clicks'],
    ['engagement_rate', 'Engagement / impression'], ['engagements', 'Post engagements'], ['shares', 'Shares'], ['comments', 'Comments'],
    ['saves', 'Saves'], ['instagram_profile_visits', 'Instagram profile visits'], ['instagram_profile_follows', 'Instagram profile follows'],
    ['messaging_conversations_started', 'Messaging conversations started'], ['messaging_conversations_replied', 'Messaging conversations replied'],
    ['impressions', 'Impressions'], ['cpm', 'CPM'], ['reach', 'Reach'], ['frequency', 'Frequency']]
  return <div className="min-w-0 space-y-7 bg-[var(--bg-subtle)] px-4 py-6 text-sm leading-6 sm:px-6">
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <CreativeAsset creative={entity.creative} name={entity.name} />
      <div className="min-w-0 space-y-3">
        <h4 className="font-semibold">Supplied creative</h4>
        {entity.creative?.headline && <p className="break-words font-medium">{entity.creative.headline}</p>}
        <p className="whitespace-pre-wrap break-words">{entity.creative?.body || 'Ad copy was not supplied.'}</p>
        <p className="text-[var(--text-secondary)]">Call to action was not supplied.</p>
        {destinationHref && <a href={destinationHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">Supplied destination</a>}
        {!destinationHref && entity.creative?.destination && <p className="break-all text-[var(--text-secondary)]">Supplied destination: {entity.creative.destination}</p>}
        {ambiguity && <p className="text-[var(--text-secondary)]">{ambiguity}</p>}
        <p className="text-[var(--text-secondary)]">Current configuration{entity.configurationAsOf ? ` observed ${entity.configurationAsOf}` : ': observation time unavailable'}. Metrics describe this ad during {context.range.from} – {context.range.to}.</p>
        <a href={overviewHref(context, '/creative', { ad: entity.id, group: 'response' }, savedId)} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">Open full ad investigation</a>
      </div>
    </div>
    {entity.creative?.format === 'video' && <Milestones entity={entity} context={context} />}
    <section aria-label={`Metric evidence for ${entity.name}`} className="space-y-4">
      <h4 className="font-semibold">Delivery, response and result evidence</h4>
      <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-4">{fields.map(([key, label]) =>
        <MetricDetail key={key} label={label} entity={entity}
          metric={overviewCreativeMetric(entity, key, new Set<string>([event.count, event.cpa, event.value, event.roas]).has(key) ? event : undefined, context)}
          reconciliation={overviewCreativeReconciliation(entity, overviewCreativeMetric(entity, key, event, context), event, context, observations)} />)}</dl>
    </section>
  </div>
}
