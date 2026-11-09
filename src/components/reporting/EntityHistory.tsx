'use client'

import { useSearchParams } from 'next/navigation'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { ReportEntity, ReportingContext } from '@/lib/reporting/contracts'
import { entityDailyDisagreement, entityDailyExportRows, META_TREND_KEYS, temporalViewHref, trendRows, trendValue } from '@/lib/reporting/trend'
import { downloadReportCsv } from '@/lib/reporting/export'
import { METRIC_GROUPS, metricLabel, reportControlClass, type MetricGroup } from './MetricTable'
import { ReportMetricValue, reportCurrencyValue } from './MetricValue'

export function EntityHistory({ entity, context, detailsLoading, group }: { entity: ReportEntity; context: ReportingContext; detailsLoading: boolean; group: MetricGroup }) {
  const search = useSearchParams()
  const label = entity.level === 'adset' ? 'Ad set' : entity.level === 'campaign' ? 'Campaign' : 'Ad'
  const prefix = entity.level === 'ad' ? 'ad' : 'entity'
  const exportRows = () => entityDailyExportRows(entity, context)
  const supplied = new Set([entity.metrics, ...(entity.series ?? []).map(point => point.metrics), ...(entity.comparisonSeries ?? []).map(point => point.metrics)].flatMap(metrics => Object.keys(metrics)))
  const options = [...new Set(['spend', ...META_TREND_KEYS.filter(key => supplied.has(key)), ...METRIC_GROUPS[group].keys])]
  const requested = search?.get(`${prefix}_trend`) ?? 'spend'
  const metricKey = options.includes(requested) ? requested : 'spend'
  const prior = search?.get(`${prefix}_trend_period`) === 'previous'
  const disagreement = entity.level === 'ad' ? null : entityDailyDisagreement(entity, context, metricKey, prior)
  const displaySum = (value: number) => disagreement?.unit === 'money' ? reportCurrencyValue(value, metricKey) : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const update = (key: string, value: string) => window.history.pushState(null, '', temporalViewHref(window.location.pathname, window.location.search, window.location.hash, key, value))
  const suppliedPoints = prior ? entity.comparisonSeries : entity.series
  const range = prior ? context.comparison : context.range
  const points = trendRows(context, entity.series ?? [], entity.comparisonSeries ?? [], metricKey).map(row => ({
    date: prior ? row.priorDate : row.date, metric: prior ? row.previous : row.metric,
  }))
  const chart = points.map(point => ({ date: point.date, value: trendValue(point.metric) }))
  const dailyTable = <table className="w-full text-sm"><caption className="sr-only">{metricLabel(metricKey)} by reported day</caption>
    <thead><tr><th scope="col" className="py-2 text-left">Date</th><th scope="col" className="py-2 text-right">{metricLabel(metricKey)}</th></tr></thead>
    <tbody>{points.map(point => <tr key={point.date} className="border-t border-[var(--border)] print:break-inside-avoid"><th scope="row" className="py-3 text-left font-normal">{point.date}</th>
      <td className="py-3 text-right">{!point.metric && detailsLoading ? 'Loading…' : <ReportMetricValue metric={point.metric} comparison={false} compact />}</td></tr>)}</tbody>
  </table>
  return <section className="space-y-3" aria-label={`${label}-level daily history`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-base font-semibold">Delivery over time</h3>
      <div className="flex flex-wrap gap-2 print:hidden">
        <select aria-label="Daily history metric" className={reportControlClass} value={metricKey} onChange={event => update(`${prefix}_trend`, event.target.value)}>
          {options.map(key => <option key={key} value={key}>{metricLabel(key)}</option>)}
        </select>
        <select aria-label="Daily history period" className={reportControlClass} value={prior ? 'previous' : 'current'} onChange={event => update(`${prefix}_trend_period`, event.target.value)}>
          <option value="current">Selected period</option><option value="previous">Previous period</option>
        </select>
      </div>
    </div>
    <p className="hidden text-sm font-medium print:block">{metricLabel(metricKey)} · {prior ? 'Previous period' : 'Selected period'}</p>
    <p className="text-xs text-[var(--text-secondary)]">{range.from} – {range.to} · {context.timezone} · {entity.name} only</p>
    <button type="button" className={`${reportControlClass} print:hidden`} disabled={detailsLoading || !exportRows().length}
      onClick={() => downloadReportCsv(exportRows(), `maxx-${entity.level}-${entity.id}-daily-${context.range.from}-${context.range.to}`)}>Export {label.toLowerCase()} daily CSV</button>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">Daily observations for this {label.toLowerCase()} only. Gaps are unavailable, not zero. Export includes both periods and every supplied daily metric with its original source and definition.</p>
    {disagreement && <p className="text-sm leading-6 text-[var(--warning)]">Reported daily sum: {displaySum(disagreement.total)}. Period aggregate: {displaySum(disagreement.headline)}. These independent readings disagree; the daily pattern does not fully explain the headline.</p>}
    {!suppliedPoints?.length ? <p role="status" className="rounded-lg bg-[var(--bg-subtle)] p-4 text-sm text-[var(--text-secondary)]">{detailsLoading ? `Loading ${label.toLowerCase()}-level daily history…` : `${label}-level daily history is unavailable for this period. Account totals are not used as a substitute.`}</p>
      : <>
        {chart.some(point => point.value !== null) ? <div role="img" aria-label={`${metricLabel(metricKey)} by day for ${entity.name}; exact values in the daily data table below.`} className="h-52 w-full min-w-0 print:hidden">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={chart} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} tickFormatter={value => String(value).slice(5)} axisLine={false} tickLine={false} />
              <YAxis width={50} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Line dataKey="value" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div> : <p className="text-sm text-[var(--text-secondary)]">This daily metric was not supplied. Choose another metric to inspect the available history.</p>}
        <details className="border-t border-[var(--border)] text-sm print:hidden"><summary className="min-h-11 cursor-pointer py-3 font-medium">Daily values and evidence</summary>{dailyTable}</details>
        <div className="hidden print:block">{dailyTable}</div>
      </>}
  </section>
}
