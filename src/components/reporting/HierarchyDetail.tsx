'use client'

import type { MetaReport, ReportEntity, ReportingContext } from '@/lib/reporting/contracts'
import { META_DIMENSION_KEYS, type MetaDimension } from '@/lib/reporting/meta-breakdowns'
import { downloadReportCsv, metricsToExportRows } from '@/lib/reporting/export'
import { EntityHistory } from './EntityHistory'
import { CreativeResponseScope } from './CreativeResponseScope'
import { EntityMetricList, METRIC_GROUPS, MetricGroupControl, ReportContextLine, type MetricGroup } from './MetricTable'
import { BudgetEvidenceDetails } from './BudgetEvidenceDetails'
import { ReportMetricValue } from './MetricValue'
import { outcomeNoun } from '@/config/outcome-nouns'

const BREAKDOWN_LABELS: Record<MetaDimension, string> = {
  placement: 'Placement', age: 'Age', gender: 'Gender', region: 'Region',
}

function HierarchyBreakdowns({ entity, context, group, breakdown, onBreakdownChange, detailsLoading, savedReport }: {
  entity: ReportEntity; context: ReportingContext; group: MetricGroup; breakdown?: MetaDimension
  onBreakdownChange?: (breakdown: MetaDimension) => void; detailsLoading: boolean; savedReport?: boolean
}) {
  const label = entity.level === 'campaign' ? 'Campaign' : 'Ad set'
  const rows = breakdown ? entity.breakdowns?.filter(row => row.dimension === breakdown) ?? [] : []
  const keys = [...new Set(['spend', 'impressions', ...METRIC_GROUPS[group].keys])]
  return <section aria-label={`${label} placement and audience detail`} className="space-y-4 border-t border-[var(--border)] pt-6">
    <div className="space-y-1">
      <h3 className="text-base font-semibold">Placement, age, gender and region</h3>
      <p className="text-sm leading-6 text-[var(--text-secondary)]">Inspect this {label.toLowerCase()}’s own Meta breakdown for the selected and previous periods. Account-level mix is not substituted for this entity.</p>
    </div>
    <div role="group" aria-label={`${label} breakdown dimension`} className="flex flex-wrap gap-1 print:hidden">
      {META_DIMENSION_KEYS.map(dimension => <button key={dimension} type="button" aria-pressed={breakdown === dimension}
        disabled={!onBreakdownChange} onClick={() => onBreakdownChange?.(dimension)}
        className={`min-h-11 rounded-lg px-4 text-sm font-medium ${breakdown === dimension ? 'bg-[var(--accent-dim)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]'} disabled:cursor-not-allowed disabled:opacity-60`}>
        {BREAKDOWN_LABELS[dimension]}
      </button>)}
    </div>
    {savedReport && <p role="status" className="text-sm text-[var(--text-secondary)]">{breakdown
      ? `${BREAKDOWN_LABELS[breakdown]} was captured in this saved report. Open the current report to request a different breakdown.`
      : 'A parent breakdown was not included in this saved report. Open the current report to request one.'}</p>}
    {!breakdown ? !savedReport && <p role="status" className="text-sm text-[var(--text-secondary)]">Choose a breakdown to load this entity’s detail. No additional Meta request is made until you choose one.</p>
      : !rows.length ? <p role="status" className="text-sm text-[var(--text-secondary)]">{detailsLoading ? `Loading ${breakdown} detail…`
        : `No validated ${breakdown} rows were returned for this ${label.toLowerCase()} and period. This does not establish zero delivery.`}</p>
        : <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-[var(--text-secondary)]">{BREAKDOWN_LABELS[breakdown]} · selected period with the previous equal period shown beneath each value.</p>
            <button type="button" className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-sm font-medium print:hidden"
              onClick={() => downloadReportCsv(rows.flatMap(row => metricsToExportRows(row.metrics,
                `Meta ${entity.level} ${entity.id} · ${breakdown} ${row.label}`, context)),
              `maxx-${entity.level}-${entity.id}-${breakdown}-${context.range.from}-${context.range.to}`)}>
              Export {breakdown} CSV
            </button>
          </div>
          <div className="overflow-x-auto" role="region" aria-label={`${label} ${breakdown} metrics`} tabIndex={0}>
            <table className="w-full min-w-[720px] text-sm"><caption className="sr-only">Meta {breakdown} breakdown for {label.toLowerCase()} {entity.name}</caption>
              <thead><tr><th scope="col" className="py-3 text-left">{BREAKDOWN_LABELS[breakdown]}</th>{keys.map(key => <th scope="col" key={key} className="min-w-36 px-3 py-3 text-right">{entity.breakdowns?.[0]?.metrics[key]?.label ?? key.replaceAll('_', ' ')}</th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.id} className="border-t border-[var(--border)] align-top print:break-inside-avoid"><th scope="row" className="py-3 text-left font-normal">{row.label}</th>{keys.map(key => <td key={key} className="px-3 py-3 text-right"><ReportMetricValue metric={row.metrics[key]} compact /></td>)}</tr>)}</tbody>
            </table>
          </div>
        </>}
  </section>
}

export function HierarchyDetail({ entity, context, meta, group, onGroupChange, sourceAsOf, breakdown, onBreakdownChange, savedReport }: {
  entity: ReportEntity; context: ReportingContext; meta: MetaReport; sourceAsOf?: string; group: MetricGroup; onGroupChange: (group: MetricGroup) => void
  breakdown?: MetaDimension; onBreakdownChange?: (breakdown: MetaDimension) => void; savedReport?: boolean
}) {
  const label = entity.level === 'campaign' ? 'campaign' : 'ad set'
  const observations = meta.observations.filter(row => row.entityId === entity.id || (entity.level === 'adset' && row.entityId === entity.campaignId))
  const grouped = new Set<string>(Object.values(METRIC_GROUPS).flatMap(preset => [...preset.keys]))
  const additional = Object.keys(entity.metrics).filter(key => !grouped.has(key))
  return <div className="min-w-0 space-y-8">
    <ReportContextLine context={context} asOf={sourceAsOf} />
    <dl className="grid gap-4 text-xs leading-5 text-[var(--text-secondary)] sm:grid-cols-2">
      <div><dt className="font-semibold">Identity</dt><dd>{label} {entity.id}{entity.level === 'adset' && <> · Campaign {entity.campaignName ?? entity.campaignId ?? 'unavailable'}</>}</dd></div>
      <div><dt className="font-semibold">Audience and observed status</dt><dd>{entity.audienceLabel} · {entity.status}</dd></div>
      <div className="sm:col-span-2"><dt className="font-semibold">Configuration observed</dt><dd>{entity.configurationAsOf ?? 'Observation time unavailable'}. Current observed configuration does not establish historical settings.</dd></div>
    </dl>
    <BudgetEvidenceDetails entity={entity} entities={meta.entities} />
    <section id="entity-metrics" className="min-w-0 scroll-mt-24 space-y-4">
      <h3 className="text-lg font-semibold">Period results</h3>
      <MetricGroupControl group={group} groups={['results', 'response', 'delivery', 'clicks', 'engagement', 'attention']} onChange={onGroupChange} />
      {(group === 'response' || group === 'engagement') && <CreativeResponseScope />}
      <p className="text-xs leading-5 text-[var(--text-secondary)]">Meta attribution: {meta.attributionWindow}. Reporting time: {meta.reportingTime}. Meta {outcomeNoun({ plural: false })} events count your outcome conversion event; Purchase retains its separate event.</p>
      <EntityMetricList metrics={entity.metrics} keys={METRIC_GROUPS[group].keys} comparison />
      {group === 'results' && <section className="border-t border-[var(--border)] pt-4">
        <h4 className="text-sm font-semibold">ROAS inputs</h4>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">Each event value is divided by this {label}’s matching spend. These events are not added together or treated as verified recorded revenue.</p>
        <EntityMetricList metrics={entity.metrics} keys={['spend', 'appointment_value', 'purchase_value', 'purchase_count']} comparison />
      </section>}
      {additional.length > 0 && <details className="border-t border-[var(--border)]"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Additional supplied period metrics</summary><EntityMetricList metrics={entity.metrics} keys={additional} comparison /></details>}
    </section>
    <section className="space-y-2 text-sm leading-6 text-[var(--text-secondary)]">
      <h3 className="font-semibold text-[var(--text-primary)]">Daily and period results are independent observations</h3>
      <p>History shows this {label}’s own reported days. Missing days remain unavailable. Reach, frequency and rates cannot be added across days; period results are not reconstructed from children or daily values.</p>
    </section>
    <EntityHistory entity={entity} context={context} detailsLoading={meta.detailState === 'loading'} group={group} />
    <HierarchyBreakdowns entity={entity} context={context} group={group} breakdown={breakdown}
      onBreakdownChange={onBreakdownChange} detailsLoading={meta.detailState === 'loading'} savedReport={savedReport} />
    {observations.length > 0 && <section className="border-t border-[var(--border)] pt-4"><h3 className="text-base font-semibold">Observed setup</h3>{observations.map(observation => <div key={observation.id} className="mt-3 text-sm leading-6"><h4 className="font-medium">{observation.title}</h4><p className="text-[var(--text-secondary)]">{observation.detail}</p>{observation.observedAt && <p className="text-xs text-[var(--text-secondary)]">Observed {observation.observedAt}</p>}</div>)}</section>}
  </div>
}
