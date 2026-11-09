'use client'
import { accountCurrency } from '@/config/business-config'
import { formatMoney, currencyFractionDigits } from '@/lib/utils/format-currency'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReportingData } from '@/lib/reporting/contracts'
import { META_DETAILS_LOADING_NOTE } from '@/lib/reporting/contracts'
import { overviewHref } from '@/lib/reporting/overview-model'
import { overviewMerBins, overviewTrendBins, type OverviewMerBin, type OverviewTrendBin, type OverviewTrendKind, type OverviewTrendValue } from '@/lib/reporting/overview-trends'
import { reportCurrencyValue } from './MetricValue'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const charts = {
  business: { label: 'Booked value', source: OW.Many, basis: `${OW.Many} · All sources · ${OW.One} dates`, color: 'var(--chart-2)', path: '/reports' },
  meta: { label: 'Ad spend', source: 'Meta', basis: 'Meta · Reporting / impression dates', color: 'var(--chart-3)', path: '/performance' },
} as const
const currency = (value: number) => reportCurrencyValue(value, 'spend')
const shortDate = (date: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
const axisCurrency = (value: number) => Math.abs(value) >= 1000
  ? formatMoney(value, { compact: true, minimumFractionDigits: 0, maximumFractionDigits: 1 })
  : formatMoney(value, { minimumFractionDigits: 0, maximumFractionDigits: Math.abs(value) < 1 ? currencyFractionDigits() : Math.min(1, currencyFractionDigits()) })
const reading = (value: OverviewTrendValue, pending: boolean) => value.value === null ? pending ? 'Loading…' : 'Unavailable'
  : `${currency(value.value)}${value.stale ? ' · Stale evidence' : ''}`

function chartScale(rows: OverviewTrendBin[]) {
  const values = rows.flatMap(row => [row.current.value, row.prior.value]).filter((value): value is number => value !== null)
  const high = Math.max(0, ...values), low = Math.min(0, ...values), span = high - low || 1
  const rawStep = span / 3, power = 10 ** Math.floor(Math.log10(rawStep))
  const step = [1, 2, 5, 10].find(value => value * power >= rawStep)! * power
  const min = Math.floor(low / step) * step, max = Math.ceil((high || span) / step) * step
  return { min, max, ticks: Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step) }
}

function TrendChart({ rows, kind, width, pending }: { rows: OverviewTrendBin[]; kind: OverviewTrendKind; width: number; pending: boolean }) {
  const id = useId().replaceAll(':', ''), [active, setActive] = useState<number | null>(null)
  const spec = charts[kind], scale = chartScale(rows), left = 48, right = width - 10, top = 8, bottom = 137
  const slot = (right - left) / Math.max(1, rows.length), bar = Math.min(22, slot * .32)
  const x = (index: number) => left + slot * (index + .5)
  const y = (value: number) => bottom - (value - scale.min) / (scale.max - scale.min) * (bottom - top)
  const labelCount = Math.min(rows.length, Math.max(2, Math.floor((right - left) / 95)))
  const ticks = new Set(Array.from({ length: labelCount }, (_, i) => Math.round(i * (rows.length - 1) / Math.max(1, labelCount - 1))))
  const selected = active === null ? null : rows[active]
  const description = (row: OverviewTrendBin) => `Current ${row.label}: ${reading(row.current, pending)}. Prior ${row.priorLabel}: ${reading(row.prior, pending)}.${row.short ? ` Final bin: ${row.days} days.` : ''}`
  return <div className="relative mt-2" onMouseLeave={() => setActive(null)}>
    <svg data-overview-chart={kind} viewBox={`0 0 ${width} 171`} className="block w-full" role="group" aria-label={`${spec.label} grouped columns; current and preceding period`}>
      <title>{`${spec.label} scale (${accountCurrency()})`}</title>
      <defs><pattern id={`${id}-prior`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
        <rect width="5" height="5" fill="var(--bg-surface)" /><line x1="0" y1="0" x2="0" y2="5" stroke={spec.color} strokeWidth="2" />
      </pattern></defs>
      {scale.ticks.map(tick => <g key={tick} aria-hidden="true"><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" />
        <text x={left - 7} y={y(tick) + 4} textAnchor="end" fill="var(--text-tertiary)" fontSize="13">{axisCurrency(tick)}</text></g>)}
      {rows.map((row, index) => <g key={row.date} tabIndex={0} role="group" aria-label={description(row)} aria-describedby={active === index ? `${id}-tooltip` : undefined}
        className="group outline-none" onFocus={() => setActive(index)} onBlur={() => setActive(null)} onMouseEnter={() => setActive(index)}
        onKeyDown={event => { if (event.key === 'Escape') setActive(null) }}>
        <rect className="group-focus:stroke-[var(--border-focus)]" x={left + slot * index} y={top} width={slot} height={bottom - top} fill={active === index ? 'var(--bg-subtle)' : 'transparent'}
          stroke={active === index ? 'var(--border-focus)' : 'none'} strokeWidth="1" />
        {(['current', 'prior'] as const).map(period => {
          const value = row[period].value, bx = x(index) + (period === 'current' ? -bar - 1 : 1)
          if (value === null) return <path key={period} aria-hidden="true" d={`M${bx + bar / 2 - 2},${bottom - 5}l4,4m-4,0l4,-4`} stroke="var(--text-tertiary)" />
          return <rect key={period} data-series={period} data-value={value} x={bx} y={value === 0 ? y(0) - 1 : Math.min(y(0), y(value))}
            width={bar} height={value === 0 ? 2 : Math.abs(y(value) - y(0))} rx={value === 0 ? 0 : 1}
            fill={period === 'current' ? spec.color : `url(#${id}-prior)`} stroke={spec.color} strokeWidth={period === 'prior' ? 1 : 0} />
        })}
        <title>{description(row)}</title>
      </g>)}
      {[...ticks].map(index => <text key={index} x={index === 0 ? left : index === rows.length - 1 ? right : x(index)} y="160"
        textAnchor={index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'} fill="var(--text-tertiary)" fontSize="13">
        {shortDate(rows[index].date)}{rows[index].short ? '*' : ''}
      </text>)}
    </svg>
    {selected && <div id={`${id}-tooltip`} role="tooltip" className="pointer-events-none absolute right-0 top-0 z-10 max-w-[85%] rounded-lg border border-[var(--border-strong)] bg-[var(--bg-overlay)] px-3 py-2 text-sm leading-5 shadow-md">
      <p className="font-medium">{spec.label}{selected.short ? ` · ${selected.days}-day final bin` : ''}</p>
      <p>Current {selected.label}: <strong>{reading(selected.current, pending)}</strong></p>
      <p>Prior {selected.priorLabel}: <strong>{reading(selected.prior, pending)}</strong></p>
    </div>}
  </div>
}

function SourceTrend({ data, kind, width, rows, savedId }: { data: ReportingData; kind: OverviewTrendKind; width: number; rows: OverviewTrendBin[]; savedId?: string | null }) {
  const section = data[kind], spec = charts[kind], id = useId()
  const pending = section.state === 'loading' || kind === 'meta' && (data.meta.data?.detailState === 'loading'
    || data.meta.notes.includes(META_DETAILS_LOADING_NOTE))
  const observed = rows.filter(row => row.current.value !== null || row.prior.value !== null).length
  const current = rows.filter(row => row.current.value !== null).length, prior = rows.filter(row => row.prior.value !== null).length
  const complete = current === rows.length && prior === rows.length, binned = rows.some(row => row.days > 1)
  const state = pending ? `Loading ${spec.source} daily evidence…` : !observed ? `${spec.source} daily evidence unavailable.`
    : complete ? 'Complete daily coverage' : 'Partial daily coverage'
  const stale = rows.some(row => row.current.stale || row.prior.stale)
  return <section aria-labelledby={`${id}-title`} className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h3 id={`${id}-title`} className="text-sm font-semibold" style={{ color: spec.color }}>{spec.label} <span className="font-normal text-[var(--text-secondary)]">· {spec.source}</span></h3>
      <Link href={overviewHref(data.context, spec.path, {}, savedId)} className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] underline-offset-4 hover:underline sm:min-h-8">
        {kind === 'business' ? 'Business details' : 'Advertising details'}
      </Link>
    </div>
    <p className="text-sm leading-5 text-[var(--text-secondary)]">{kind === 'business' ? `${OW.One} creation dates · All sources` : 'Reporting / impression dates'} · {accountCurrency()} · {binned ? '7-day bins' : 'Daily'}</p>
    {observed ? <TrendChart rows={rows} kind={kind} width={width} pending={pending} />
      : <p role="status" className="flex min-h-40 items-center justify-center text-sm text-[var(--text-secondary)]">{state}</p>}
    <div className="text-sm leading-5 text-[var(--text-secondary)]">
      {observed > 0 && !complete && <p role="status">{state} · Current {current}/{rows.length}; prior {prior}/{rows.length} {binned ? 'bins' : 'days'}.</p>}
      {stale && <p>Stale evidence</p>}
      {rows.at(-1)?.short && <p>* Final bin: {rows.at(-1)!.days} days ({rows.at(-1)!.label}).</p>}
    </div>
    <details className="mt-1">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-[var(--text-secondary)] underline decoration-dotted underline-offset-4 sm:min-h-8">Inspect chart values<span className="sr-only">: {spec.label}</span></summary>
      <p className="text-sm text-[var(--text-secondary)]">{spec.label} scale ({accountCurrency()}) · {spec.basis}. {spec.source} as of {section.asOf ? <time dateTime={section.asOf}>{section.asOf}</time> : 'unavailable'}. {complete ? 'Complete daily coverage.' : state}</p>
      <div className="max-h-72 overflow-auto" role="region" aria-label={`${spec.label} values with prior calendar dates`} tabIndex={0}>
        <table className="w-full min-w-[400px] text-left text-sm tabular-nums">
          <caption className="sr-only">{spec.label} · {spec.basis} · {data.context.timezone}</caption>
          <thead><tr><th scope="col" className="py-2 pr-3">Current dates</th><th scope="col" className="pr-3">Value</th><th scope="col" className="pr-3">Prior dates</th><th scope="col">Prior value</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.date} className="border-t border-[var(--border)] align-top">
            <th scope="row" className="py-2 pr-3 font-normal">{row.label}{row.short ? ` (${row.days} days)` : ''}</th><td className="py-2 pr-3">{reading(row.current, pending)}</td>
            <td className="py-2 pr-3">{row.priorLabel}</td><td className="py-2">{reading(row.prior, pending)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </section>
}

const merReading = (row: OverviewMerBin) => row.state === 'available' ? `${row.value!.toFixed(2)}×`
  : row.state === 'zero_spend' ? 'Zero spend · MER unavailable' : 'Unavailable'

function MerRow({ rows }: { rows: OverviewMerBin[] }) {
  const interval = rows.some(row => row.days > 1), label = interval ? 'Interval MER' : 'Daily MER'
  return <section aria-label={`${label} by aligned interval`} className="border-t border-[var(--border)] pt-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="text-xs leading-5 text-[var(--text-secondary)]">All-source booked value ÷ Meta spend</p>
    </div>
    <div className="mt-2 overflow-x-auto" role="region" aria-label={`${label} values`} tabIndex={0}>
      <div role="list" className="grid gap-px rounded-md bg-[var(--border)]" style={{ minWidth: `${Math.max(360, rows.length * 64)}px`, gridTemplateColumns: `repeat(${Math.max(1, rows.length)}, minmax(64px, 1fr))` }}>
        {rows.map(row => <div role="listitem" key={row.date} className="min-w-0 bg-[var(--bg-surface)] px-2 py-2 text-center" title={`${row.label}: ${merReading(row)}`}>
          <p className="truncate text-xs text-[var(--text-tertiary)]">{shortDate(row.date)}{row.short ? '*' : ''}</p>
          <p className="break-words text-sm font-semibold tabular-nums">{merReading(row)}</p>
        </div>)}
      </div>
    </div>
    <details className="mt-1">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-[var(--text-secondary)] underline decoration-dotted underline-offset-4 sm:min-h-8">Inspect MER values by aligned interval</summary>
      <div className="overflow-x-auto" role="region" aria-label="MER values by aligned interval" tabIndex={0}>
        <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
          <caption className="sr-only">{label}: current all-source booked value divided by current Meta spend for each exact aligned interval</caption>
          <thead><tr><th scope="col" className="py-2 pr-3">Current interval</th><th scope="col" className="pr-3">Booked value</th><th scope="col" className="pr-3">Meta spend</th><th scope="col">MER state</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.date} className="border-t border-[var(--border)] align-top">
            <th scope="row" className="py-2 pr-3 font-normal">{row.label}{row.short ? ` (${row.days} days)` : ''}</th>
            <td className="py-2 pr-3">{row.bookedValue === null ? 'Unavailable' : currency(row.bookedValue)}</td>
            <td className="py-2 pr-3">{row.spend === null ? 'Unavailable' : currency(row.spend)}</td>
            <td className="py-2">{merReading(row)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </section>
}

export function OverviewTrends({ data, savedId }: { data: ReportingData; savedId?: string | null }) {
  const id = useId(), ref = useRef<HTMLDivElement>(null), [width, setWidth] = useState(500)
  const businessRows = overviewTrendBins(data.context, data.business.data?.series ?? [], data.business.data?.comparisonSeries ?? [], 'business')
  const metaRows = overviewTrendBins(data.context, data.meta.data?.series ?? [], data.meta.data?.comparisonSeries ?? [], 'meta')
  const merRows = overviewMerBins(businessRows, metaRows)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(Math.max(220, Math.round(element.getBoundingClientRect().width)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <section aria-labelledby={`${id}-title`} id="overview-trends" className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 sm:p-5">
    <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">Results over time</h2>
    <p className="mt-1 text-sm leading-5 text-[var(--text-secondary)]">{data.context.timezone} · Aligned intervals; each chart has its own dollar scale.</p>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text-secondary)]" aria-label="Chart legend">
      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-[var(--text-secondary)]" aria-hidden="true" />Current · solid</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 border border-[var(--text-secondary)]" style={{ background: 'repeating-linear-gradient(135deg, transparent, transparent 2px, var(--text-secondary) 2px, var(--text-secondary) 3px)' }} aria-hidden="true" />Prior · striped</span>
    </div>
    <div ref={ref} className="mt-2 divide-y divide-[var(--border)] space-y-3 [&>section+section]:pt-3">
      <SourceTrend data={data} kind="business" width={width} rows={businessRows} savedId={savedId} />
      <SourceTrend data={data} kind="meta" width={width} rows={metaRows} savedId={savedId} />
      <MerRow rows={merRows} />
    </div>
    <p className="mt-2 text-sm leading-5 text-[var(--text-tertiary)]">× marks a gap; a flat bar is an observed zero. Missing or incomplete days leave a gap in that interval. Hover or focus a column group for exact values and prior dates.</p>
  </section>
}
