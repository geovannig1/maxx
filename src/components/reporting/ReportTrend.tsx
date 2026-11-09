'use client'
import { formatMoney } from '@/lib/utils/format-currency'

import { useEffect, useId, useRef, useState } from 'react'
import type { ReportMetric, ReportMetricMap, ReportSeriesPoint, ReportingContext } from '@/lib/reporting/contracts'
import { BUSINESS_TREND_KEYS, META_TREND_KEYS, trendRows, trendValue } from '@/lib/reporting/trend'
import { ReportMetricValue, reportCurrencyValue, reportMetricValue } from './MetricValue'
import { outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

type Props = {
  series: ReportSeriesPoint[]; comparisonSeries: ReportSeriesPoint[]; metrics: ReportMetricMap; context: ReportingContext;
  detailsLoading?: boolean; kind?: 'meta' | 'business'; selectedMetric?: string; onMetricChange?: (key: string) => void; sourceAsOf?: string | null
}

type DailyTrendRow = ReturnType<typeof trendRows>[number]


function completeBinMetric(rows: DailyTrendRow[], prior: boolean): ReportMetric | undefined {
  const values = rows.map(row => prior ? row.previous : row.metric)
  if (values.length === 0 || values.some(metric => trendValue(metric) === null || metric!.current.coverage.state !== 'complete')) return undefined
  return values.length === 1 ? values[0] : undefined
}

function trendBins(rows: DailyTrendRow[]) {
  const result: Array<DailyTrendRow & { label: string; priorLabel: string; days: number }> = []
  for (let index = 0; index < rows.length; index += 7) {
    const bin = rows.slice(index, index + 7)
    const first = bin[0], last = bin.at(-1)!
    const priorFirst = first.priorDate, priorLast = last.priorDate
    result.push({
      ...first,
      label: first.date === last.date ? first.date : `${first.date} – ${last.date}`,
      priorLabel: priorFirst && priorLast ? priorFirst === priorLast ? priorFirst : `${priorFirst} – ${priorLast}` : 'No aligned prior date',
      metric: completeBinMetric(bin, false),
      previous: completeBinMetric(bin, true),
      days: bin.length,
    })
  }
  return result
}

export function ReportTrend({ series, comparisonSeries, metrics, context, detailsLoading = false,
  kind = 'meta', selectedMetric, onMetricChange, sourceAsOf }: Props) {
  const [localKey, setLocalKey] = useState(''), id = useId()
  const chartRef = useRef<SVGSVGElement>(null)
  const [chartWidth, setChartWidth] = useState(730)
  const keys = kind === 'business' ? BUSINESS_TREND_KEYS : META_TREND_KEYS
  const supplied = Object.assign({}, ...series.map(point => point.metrics), ...comparisonSeries.map(point => point.metrics), metrics) as ReportMetricMap
  const options = keys.filter(key => supplied[key])
  const requested = selectedMetric ?? localKey
  const key = options.find(key => key === requested) ?? options[0] ?? (kind === 'business' ? 'booked_value' : 'spend')
  const label = supplied[key]?.label ?? (kind === 'business' ? 'Booked value' : 'Spend')
  const dailyRows = trendRows(context, series, comparisonSeries, key)
  const binned = dailyRows.length > 31
  const rows = binned ? trendBins(dailyRows) : dailyRows.map(row => ({ ...row, label: row.date, priorLabel: row.priorDate ?? 'No aligned prior date', days: 1 }))
  const all = rows.flatMap(row => [trendValue(row.metric), trendValue(row.previous)]).filter((n): n is number => n !== null)
  const hasChart = all.length > 0
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const measure = () => setChartWidth(Math.max(220, Math.min(730, Math.round(chart.getBoundingClientRect().width))))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(chart)
    return () => observer.disconnect()
  }, [hasChart])
  const max = Math.max(1, ...all), min = Math.min(0, ...all), spread = max - min
  const right = chartWidth - 36
  const x = (index: number) => 60 + index / Math.max(1, rows.length - 1) * (right - 60)
  const y = (n: number) => 180 - (n - min) / spread * 145
  const display = (metric?: ReportMetric) => !metric && detailsLoading ? <span>Loading…</span> : <ReportMetricValue metric={metric} comparison={false} compact />
  const values = rows.flatMap(row => [row.metric, row.previous]).filter((metric): metric is ReportMetric => Boolean(metric))
  const appointment = kind === 'meta' && ['bookings', 'appointment_value', 'cost_per_booking', 'appointment_roas', 'bookings_click', 'bookings_view'].includes(key)
  const hasNative = appointment && values.some(metric => !metric.current.source.head?.startsWith('meta-campaign-daily-authority:'))
  const hasCanonical = appointment && values.some(metric => metric.current.source.head?.startsWith('meta-campaign-daily-authority:'))
  const axis = (value: number) => supplied[key]?.current.unit === 'money' ? formatMoney(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : supplied[key]?.current.unit === 'ratio' ? `${value.toFixed(1)}×` : supplied[key]?.current.unit === 'percent' ? `${value.toFixed(0)}%`
      : value.toLocaleString('en-US', { maximumFractionDigits: 1 })
  const authority = (metric?: ReportMetric) => metric?.current.source.head?.startsWith('meta-campaign-daily-authority:') ? 'campaign' : 'native'
  const observedValue = (metric: ReportMetric) => {
    const claim = metric.current
    const notes = [claim.coverage.state === 'partial' ? 'Partial evidence' : claim.coverage.state === 'unknown' ? 'Coverage unverified' : '',
      claim.freshness.state === 'stale' ? 'Stale evidence' : '', claim.maturity.state === 'settling' ? 'Attribution settling' : claim.maturity.state === 'partial' ? 'Partial period' : ''].filter(Boolean)
    return `${reportMetricValue(metric)}${notes.length ? ` (${notes.join(' · ')})` : ''}`
  }
  function lines(prior: boolean) {
    const segments: string[] = [], segment: string[] = []
    const flush = () => { if (segment.length > 1) segments.push(segment.join(' ')); segment.length = 0 }
    let priorAuthority: string | undefined
    for (const [index, row] of rows.entries()) {
      const metric = prior ? row.previous : row.metric, currentAuthority = authority(metric)
      if (priorAuthority && priorAuthority !== currentAuthority) flush()
      priorAuthority = currentAuthority
      const n = trendValue(metric)
      if (n === null) flush()
      else segment.push(`${x(index)},${y(n)}`)
    }
    flush()
    return segments.map((points, index) => <polyline key={index} data-series={prior ? 'prior-line' : 'current-line'} points={points} fill="none"
      stroke={prior ? 'var(--text-tertiary)' : 'var(--accent)'} strokeWidth="2.5" strokeDasharray={prior ? '5 5' : undefined} />)
  }
  function points(prior: boolean) {
    return rows.map((row, index) => {
      const metric = prior ? row.previous : row.metric, n = trendValue(metric), date = prior ? row.priorDate : row.date
      return n === null ? null : <circle key={date} data-series={prior ? 'prior' : 'current'} cx={x(index)} cy={y(n)} r={prior ? 4 : 3}
        fill={prior ? 'var(--bg-surface)' : 'var(--accent)'} stroke={prior ? 'var(--text-tertiary)' : 'var(--accent)'}>
        <title>{`${date}: ${reportMetricValue(metric)}`}</title></circle>
    })
  }
  function disagreement(prior: boolean): string | null {
    if (!['spend', 'bookings', 'appointment_value', 'purchase_count', 'purchase_value', 'booked_value', 'amount_paid', 'paid_bookings', 'active_appointments', 'value_bearing_bookings', 'recorded_booked_hours'].includes(key)) return null
    const headline = prior ? metrics[key]?.previous : metrics[key]?.current
    const daily = rows.map(row => prior ? row.previous : row.metric)
    if (!headline || headline.availability.state !== 'available' || typeof headline.value !== 'number' || headline.coverage.state !== 'complete'
      || !daily.length || daily.some(metric => trendValue(metric) === null || metric!.current.coverage.state !== 'complete'
        || metric!.current.unit !== headline.unit || metric!.current.source.system !== headline.source.system
        || metric!.current.window.basis !== headline.window.basis || appointment && authority(metric) !== 'campaign')) return null
    const sum = daily.reduce((total, metric) => total + trendValue(metric)!, 0)
    if (Math.abs(sum - headline.value) <= Math.max(1, Math.abs(sum), Math.abs(headline.value)) * 1e-10) return null
    const format = (value: number) => headline.unit === 'money' ? reportCurrencyValue(value, key)
      : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${headline.unit === 'hours' ? ' h' : ''}`
    return `Reported daily sum: ${format(sum)}. Period aggregate: ${format(headline.value)}. These independent readings disagree; the daily pattern does not fully explain the headline.`
  }
  function reading(prior: boolean) {
    const observed = rows.flatMap(row => {
      const metric = prior ? row.previous : row.metric, date = prior ? row.priorDate : row.date
      return trendValue(metric) === null ? [] : [{ metric: metric!, date }]
    })
    const first = observed[0], last = observed.at(-1), difference = disagreement(prior)
    return <div><h3 className="font-medium text-[var(--text-primary)]">{prior ? 'Previous period' : 'Selected period'}</h3>
      <p>{observed.length} of {rows.length} {binned ? '7-day bins' : 'days'} have a reported value{detailsLoading ? '; source evidence is still loading' : ''}.</p>
      {first && <p>First observed: {first.date} · {observedValue(first.metric)}. {last !== first && <>Latest observed: {last!.date} · {observedValue(last!.metric)}.</>}</p>}
      {difference && <p className="mt-1 text-[var(--warning)]">{difference}</p>}
    </div>
  }
  const table = <table className="w-full min-w-[410px] text-left text-xs tabular-nums print:min-w-0"><caption className="sr-only">{binned ? '7-day binned' : 'Daily'} {label} with matched prior dates</caption>
    <thead><tr><th scope="col" className="py-2">{binned ? 'Selected bin' : 'Date'}</th><th scope="col">Value</th><th scope="col">{binned ? 'Prior bin' : 'Prior date'}</th><th scope="col">Prior value</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.date} className="border-t border-[var(--border)] align-top print:break-inside-avoid" data-trend-date={row.date}>
      <th scope="row" className="py-3 pr-2 font-normal">{row.label}</th><td className="pr-3">{display(row.metric)}</td>
      <td className="py-3 pr-2">{row.priorLabel}</td><td>{display(row.previous)}</td></tr>)}</tbody></table>
  return <section id={`${kind}-trend`} aria-labelledby={`${id}-title`} className="min-w-0 scroll-mt-24 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id={`${id}-title`} className="text-lg font-semibold">{kind === 'business' ? 'Business results over time' : 'Advertising results over time'}</h2>
      <label className="text-xs print:hidden">Metric <select aria-label={kind === 'business' ? 'Business trend metric' : 'Trend metric'} value={key}
        onChange={event => { setLocalKey(event.target.value); onMetricChange?.(event.target.value) }} className="ml-2 min-h-11 max-w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2">
        {options.length ? options.map(option => <option key={option} value={option}>{supplied[option].label}</option>) : <option value={key}>{label}</option>}
      </select></label></div>
    <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">{kind === 'business' ? `${OW.Many} · All sources · ${OW.One} dates` : 'Meta · Impression dates'} · {context.timezone}. Current period (solid), preceding equal period (dashed), aligned by day. {binned ? 'Ranges longer than 31 days use 7-day bins in the table; incomplete bins remain unavailable.' : ''} {detailsLoading ? 'Daily evidence is still loading.' : 'Gaps mean unavailable.'}</p>
    {sourceAsOf && <p className="text-xs leading-5 text-[var(--text-secondary)]">Source as of {sourceAsOf}</p>}
    {kind === 'business' && <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">Booked value and amount paid describe {OW.many} created on each date. Payments and scheduled durations reflect the retained ledger snapshot; these are not payment-receipt dates, attendance or available capacity.</p>}
    {hasCanonical && <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">Daily {EVENT} outcomes use independently queried exact-day campaign authority. Daily and period reads can differ; this chart is not a guaranteed decomposition of the headline. Missing campaign-day evidence leaves its outcome unavailable; delivery and Purchase remain independent.</p>}
    {hasNative && <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">This report contains native account daily {EVENT} observations. They can disagree with the campaign-authority headline and do not decompose it. Open each value for its original source and definition. Different daily authorities are not connected by a trend line.</p>}
    <div className="mt-3 grid gap-3 text-xs leading-5 text-[var(--text-secondary)] sm:grid-cols-2" aria-label="Daily reading">{reading(false)}{reading(true)}</div>
    {hasChart ? <svg ref={chartRef} viewBox={`0 0 ${chartWidth} 220`} role="img" aria-label={`${label} ${binned ? '7-day binned ' : ''}trend for ${context.range.from} to ${context.range.to}, with preceding period`} className="mt-3 w-full min-h-36">
      {[0, .5, 1].map(tick => <g key={tick}><line x1="60" x2={right} y1={y(min + spread * tick)} y2={y(min + spread * tick)} stroke="var(--border)" />
        <text x="52" y={y(min + spread * tick) + 4} textAnchor="end" fill="var(--text-tertiary)" fontSize="11">{axis(min + spread * tick)}</text></g>)}
      {lines(true)}{lines(false)}{points(true)}{points(false)}
      <text x="60" y="208" fill="var(--text-tertiary)" fontSize="11">{context.range.from}</text><text x={right} y="208" textAnchor="end" fill="var(--text-tertiary)" fontSize="11">{context.range.to}</text>
    </svg> : <p role="status" className="flex min-h-36 items-center justify-center text-sm text-[var(--text-secondary)]">{detailsLoading ? 'Loading daily evidence…' : 'Daily evidence unavailable for this period.'}</p>}
    <p className="text-xs leading-5 text-[var(--text-secondary)]">{label} · {binned ? '7-day bins' : 'Daily observed values'}. Partial, stale and settling evidence is qualified in the table; a gap is not zero or a confirmed decline.</p>
    <details className="mt-2 print:hidden"><summary className="inline-flex min-h-11 cursor-pointer items-center text-xs underline">{binned ? 'Inspect 7-day bins' : 'Inspect daily values'}</summary>
      <div className="max-h-80 overflow-auto" role="region" aria-label={`${kind === 'business' ? 'Business' : 'Advertising'} daily values`} tabIndex={0}>{table}</div></details>
    <div className="hidden print:block print:max-h-none print:overflow-visible">{table}</div>
  </section>
}
