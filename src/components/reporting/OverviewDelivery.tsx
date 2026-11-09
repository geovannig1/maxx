import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportMetric, ReportingData, ReportingRange } from '@/lib/reporting/contracts'
import { OverviewMetric } from './OverviewMetric'
import { AudienceAndDelivery } from './OverviewHierarchy'

/** Native account aggregates; reach and frequency are never added across entities. */
function accountMetric(data: ReportingData, key: string, unit: 'count' | 'ratio' | 'money'): ReportMetric | undefined {
  const metric = data.meta.data?.metrics[key], claim = metric?.current
  function compatible(value: MetricClaim, range: ReportingRange) {
    const observed = Date.parse(value.asOf), sourceTime = Date.parse(data.meta.asOf ?? ''), cutoff = Date.parse(data.context.asOf)
    return value.unit === unit && value.source.system === 'meta' && value.source.role === 'delivery_truth'
      && value.source.evidencePlane === 'meta_delivery' && value.metricKey === `meta.${key}`
      && value.entity.level === 'account' && value.entity.id === data.context.account.id
      && value.window.start === range.from && value.window.end === range.to
      && value.window.timezone === data.context.timezone && value.window.basis === 'impression_date_et'
      && value.attributionScope === 'none'
      && [observed, sourceTime, cutoff].every(Number.isFinite) && observed === sourceTime && observed <= cutoff
      && (!value.freshness.observedAt || Date.parse(value.freshness.observedAt) === observed)
      && (value.value === null || typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0
        && (unit !== 'count' || Number.isSafeInteger(value.value)))
  }
  if (!metric || !claim || metric.key !== key || metric.event !== null || !compatible(claim, data.context.range)) return undefined
  return metric.previous && !compatible(metric.previous, data.context.comparison) ? { ...metric, previous: null } : metric
}

export function OverviewDelivery({ data, savedId }: { data: ReportingData; savedId?: string | null }) {
  const fields = ([['impressions', 'Impressions', 'count'], ['reach', 'Reach', 'count'], ['frequency', 'Frequency', 'ratio'], ['cpm', 'CPM', 'money']] as const)
    .map(([key, label, unit]) => ({ key, label, metric: accountMetric(data, key, unit) }))
  const settling = fields.every(({ metric }) => metric?.current.maturity.state === 'settling' && metric?.previous?.maturity.state === 'settling')
  return <section aria-label="Account delivery" className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 sm:p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-semibold tracking-tight">Delivery at a glance</h2>
      <p className="text-sm text-[var(--text-secondary)]">Meta · Native account totals</p>
    </div>
    <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4 xl:grid-cols-2">
      {fields.map(({ key, label, metric }) => <OverviewMetric key={key} metric={metric} label={label} comparison movement omitSettling={settling} loading={data.meta.state === 'loading'} />)}
    </div>
    {settling && <p className="mt-2 text-sm text-[var(--text-secondary)]">Current and prior delivery evidence is still settling.</p>}
    <div className="mt-4 text-sm leading-5"><AudienceAndDelivery data={data} savedId={savedId} compact /></div>
  </section>
}
