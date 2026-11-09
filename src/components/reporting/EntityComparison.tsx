'use client'

import type { ReportEntity, ReportMetric, ReportingContext } from '@/lib/reporting/contracts'
import { CreativeAsset } from './CreativeAsset'
import { CreativeRetention } from './CreativeRetention'
import { comparisonMetricKeys, METRIC_GROUPS, metricLabel, ReportContextLine, type MetricGroup } from './MetricTable'
import { ReportMetricValue } from './MetricValue'
import { BudgetContextSummary } from './BudgetEvidenceDetails'

function canCompare(left: ReportMetric | undefined, right: ReportMetric | undefined, context: ReportingContext) {
  if (!left || !right) return true
  return left.event === right.event && left.current.source.system === right.current.source.system
    && left.current.metricKey === right.current.metricKey && left.current.definitionVersion === right.current.definitionVersion
    && left.current.formula === right.current.formula && left.current.measurementKind === right.current.measurementKind
    && left.current.unit === right.current.unit && left.current.attributionScope === right.current.attributionScope
    && left.current.window.basis === right.current.window.basis
    && [left, right].every(metric => metric.current.window.start === context.range.from
      && metric.current.window.end === context.range.to && metric.current.window.timezone === context.timezone)
}

export function EntityComparison({ entities, allEntities = entities, context, group, detailsLoading = false }: { entities: ReportEntity[]; allEntities?: ReportEntity[]; context: ReportingContext; group: MetricGroup; detailsLoading?: boolean }) {
  if (entities.length < 2 || entities.length > 4) return <p role="status" className="py-4 text-sm text-[var(--text-secondary)]">{detailsLoading ? 'Loading selected entities…' : 'Select two to four entities in the same filtered view to compare.'}</p>
  const keys = comparisonMetricKeys(group)
  return <section aria-label="Side-by-side comparison" className="space-y-4">
    <ReportContextLine context={context} />
    <p className="max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">Compare the same period with exposure and audience in view. A higher observed rate alone does not establish a better creative; these executions can reach different people and receive different amounts of delivery.</p>
    {group === 'attention' && <CreativeRetention entities={entities} context={context} />}
    <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]" role="region" aria-label="Side-by-side metrics, scroll to compare" tabIndex={0}>
      <table className="w-full table-fixed border-collapse text-sm" style={{ minWidth: 160 + entities.length * 240 }}>
        <caption className="sr-only">Same-period {METRIC_GROUPS[group].label.toLowerCase()} and exposure comparison. Metric definitions identify the event and source.</caption>
        <thead><tr className="align-top">
          <th scope="col" className="w-40 p-4 text-left font-medium text-[var(--text-secondary)]">{METRIC_GROUPS[group].label}</th>
          {entities.map(entity => <th key={entity.id} scope="col" className="border-l border-[var(--border)] p-4 text-left font-normal">
            {entity.level === 'ad' && <CreativeAsset creative={entity.creative} name={entity.name} detailsLoading={detailsLoading} />}
            <p className="mt-3 break-words font-semibold">{entity.name}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{entity.campaignName} {entity.adsetName ? ` / ${entity.adsetName}` : ''}</p>
            <p className="text-xs leading-5 text-[var(--text-secondary)]">{entity.audienceLabel} · {entity.status}</p>
            <p className="text-xs leading-5 text-[var(--text-secondary)]">{entity.level} ID {entity.id}</p>
            <BudgetContextSummary entity={entity} entities={allEntities} />
            {entity.creative?.headline && <p className="mt-3 text-sm font-medium">{entity.creative.headline}</p>}
            {entity.creative?.body && <details className="mt-1 text-xs leading-5 text-[var(--text-secondary)]"><summary className="min-h-11 cursor-pointer py-2">Creative copy</summary><p className="whitespace-pre-wrap break-words">{entity.creative.body}</p></details>}
          </th>)}
        </tr></thead>
        <tbody>{keys.map(key => {
          const anchor = entities.find(entity => entity.metrics[key])?.metrics[key]
          const comparable = entities.every(entity => canCompare(anchor, entity.metrics[key], context))
          return <tr key={key} className="border-t border-[var(--border)]">
            <th scope="row" className="p-4 text-left font-medium text-[var(--text-secondary)]">{metricLabel(key, entities.find(entity => entity.metrics[key])?.metrics)}</th>
            {entities.map(entity => <td key={entity.id} className="border-l border-[var(--border)] p-4 align-top tabular-nums">
              {!comparable && <p className="mb-2 text-xs leading-5 text-[var(--warning)]">Not directly comparable: source, event or period differs. Inspect each value’s evidence.</p>}
              <ReportMetricValue metric={entity.metrics[key]} comparison />
            </td>)}
          </tr>
        })}</tbody>
      </table>
    </div>
  </section>
}
