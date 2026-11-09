'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { ReportingData } from '@/lib/reporting/contracts'
import { overviewCreativeFormat } from '@/lib/reporting/overview-creative'
import { overviewScatter, type OverviewScatterRow, type OverviewScatterLane } from '@/lib/reporting/overview-scatter'
import type { OverviewEvent } from '@/lib/reporting/overview-model'
import { accountCurrency, accountLocale, accountTimezone } from '@/config/business-config'
import { formatMoney } from '@/lib/utils/format-currency'

const control = 'min-h-11 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'
const money = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })
const count = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US')
const percent = (value: number | null) => value === null ? 'Unavailable' : `${value.toFixed(1)}%`
const multiplier = (value: number | null) => value === null ? 'Unavailable' : `${value.toFixed(2)}×`
const axisMoney = (value: number) => value >= 1e12 ? `${value.toExponential(1)} ${accountCurrency()}` : value >= 1000
  ? formatMoney(value, { compact: true, maximumFractionDigits: 1 }) : formatMoney(value)
const observationTime = new Intl.DateTimeFormat('en-US', { timeZone: accountTimezone(),
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const laneLabels: Record<OverviewScatterLane, string> = {
  numeric: 'Plotted ads', attention: 'Attention unavailable or not applicable', cpa: 'CPA undefined or unavailable', spend: 'Spend unavailable or zero',
}

function summary(row: OverviewScatterRow, event: OverviewEvent) {
  return `${row.entity.name} · Ad ${row.entity.id} · ${row.entity.adsetName ?? row.entity.adsetId ?? 'Ad set unavailable'} · ${overviewCreativeFormat(row.entity)} · ${money(row.spend)} spend · ${count(row.results)} ${event.label} results · ${money(row.cpa)} CPA · ${percent(row.halfway)} halfway-view rate · ${multiplier(row.roas)} ROAS`
}

function Selection({ row, event, onInspect }: { row: OverviewScatterRow; event: OverviewEvent; onInspect: (id: string) => void }) {
  const metrics = [['Spend', money(row.spend)], [`${event.label} results`, count(row.results)],
    [`${event.label} CPA`, row.results === 0 ? 'Undefined · 0 results' : money(row.cpa)],
    [`${event.label} value`, money(row.value)], [`${event.label} ROAS`, multiplier(row.roas)], ['Halfway-view rate', percent(row.halfway)]]
  return <div data-scatter-values={row.entity.id} className="min-w-0 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
    <div className="min-w-0 space-y-1"><h4 className="break-words text-base font-semibold">{row.entity.name}</h4>
      <p className="break-words text-[var(--text-secondary)]">{row.entity.adsetName ?? row.entity.adsetId ?? 'Ad set unavailable'} · {overviewCreativeFormat(row.entity)}</p>
      <p className="break-words text-[var(--text-secondary)]">Ad {row.entity.id}</p></div>
    <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3">{metrics.map(([label, value]) => <div key={label} className="min-w-0">
      <dt className="break-words text-xs leading-4 text-[var(--text-secondary)]">{label}</dt><dd className="mt-1 break-words text-base font-semibold tabular-nums">{value}</dd>
    </div>)}</dl>
    {row.halfway !== null && <p className="text-[var(--text-secondary)]">{count(row.halfwayCount)} halfway views / {count(row.starts)} starts</p>}
    {row.reasons.map(reason => <p key={reason} className="text-[var(--text-secondary)]">{reason}</p>)}
    <button type="button" onClick={() => onInspect(row.entity.id)} className={`w-full border border-[var(--border-strong)] px-3 py-2 font-medium ${control}`}>
      Inspect ad and play creative<span className="sr-only">: {row.entity.name}</span>
    </button>
  </div>
}

export function OverviewCreativeScatter({ data, event, search, onInspect }: {
  data: ReportingData; event: OverviewEvent; search?: string; onInspect: (id: string) => void
}) {
  const id = useId()
  const view = overviewScatter(data, event, search)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = view.rows.find(row => row.entity.id === selectedId) ?? view.plotted[0] ?? view.rows[0]
  const chart = useRef<HTMLDivElement>(null)
  const selection = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!chart.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width
      if (next && next > 0) setWidth(next)
    })
    observer.observe(chart.current)
    return () => observer.disconnect()
  }, [])
  const left = 76, right = Math.max(left + 1, width - 38), top = 42, bottom = 300
  const maxCpa = view.cpaMax > 0 ? Math.min(Number.MAX_VALUE, view.cpaMax * 1.2) : 1
  const observedAt = data.meta.asOf && Number.isFinite(Date.parse(data.meta.asOf)) ? data.meta.asOf : null
  const plotLabel = `Halfway-view rate versus observed ${event.label} CPA. Lower CPA is better and appears at the top. Bubble area represents spend.`
  return <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4 text-sm leading-5">
    <div className="space-y-1"><h3 id={`${id}-title`} className="text-base font-semibold">Attention and reported results</h3>
      <p className="text-[var(--text-secondary)]">Halfway-view rate = views reaching 50% of video length / validated video starts × 100. CPA = spend / reported {event.label} results; lower is better.</p>
      <p aria-live="polite" className="text-[var(--text-secondary)]">{view.total} ads supplied · {view.rows.length} match{view.rows.length === 1 ? '' : 'es'} · {view.plotted.length} plotted · {view.rows.length - view.plotted.length} outside numeric axes</p>
    </div>
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)]">
      <div className="min-w-0 space-y-2">
        <p className="font-medium">{event.label} CPA ({accountCurrency()}) · lower is better ↑</p>
        <div ref={chart} className="hidden min-w-0 sm:block">
          {view.plotted.length > 0 ? <svg width="100%" height="352" viewBox={`0 0 ${width} 352`} role="group" aria-label={plotLabel} data-overview-scatter>
            {[0, 0.5, 1].map(tick => <g key={tick}>
              <line x1={left} x2={right} y1={top + (bottom - top) * tick} y2={top + (bottom - top) * tick} stroke="var(--border)" />
              <text x={left - 10} y={top + (bottom - top) * tick + 5} textAnchor="end" fill="var(--text-secondary)" fontSize="14">{axisMoney(maxCpa * tick)}</text>
            </g>)}
            {[0, 25, 50, 75, 100].map(tick => <g key={tick}>
              <line x1={left + (right - left) * tick / 100} x2={left + (right - left) * tick / 100} y1={top} y2={bottom} stroke="var(--border)" />
              <text x={left + (right - left) * tick / 100} y={bottom + 28} textAnchor="middle" fill="var(--text-secondary)" fontSize="14">{tick}%</text>
            </g>)}
            {view.plotted.map(row => <g key={row.entity.id} data-scatter-point={row.entity.id}
              role="button" tabIndex={0} aria-label={`Inspect ${summary(row, event)}`} className="cursor-pointer outline-none"
              onFocus={() => setSelectedId(row.entity.id)} onMouseEnter={() => setSelectedId(row.entity.id)}
              onClick={() => onInspect(row.entity.id)} onKeyDown={key => {
                if (key.key === 'Enter' || key.key === ' ') { key.preventDefault(); onInspect(row.entity.id) }
              }}>
              <title>{summary(row, event)}</title>
              <circle cx={left + (right - left) * row.halfway! / 100} cy={top + (bottom - top) * (row.cpa! / maxCpa)}
                r={Math.max(22, row.radius)} fill="transparent" />
              <circle cx={left + (right - left) * row.halfway! / 100} cy={top + (bottom - top) * (row.cpa! / maxCpa)}
                r={row.radius} fill="var(--accent)" fillOpacity={selected?.entity.id === row.entity.id ? 0.85 : 0.45}
                stroke={selected?.entity.id === row.entity.id ? 'var(--text-primary)' : 'var(--accent)'} strokeWidth={selected?.entity.id === row.entity.id ? 3 : 1} />
            </g>)}
          </svg> : <p role="status" className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-[var(--border)] p-6 text-[var(--text-secondary)]">No matching ads have compatible attention, CPA and positive spend for a numeric point.</p>}
        </div>
        <p className="text-center font-medium">Halfway-view rate (%) →</p>
        <p className="text-[var(--text-secondary)]">Bubble area = spend{view.maxSpend > 0 ? ` · largest plotted bubble: ${money(view.maxSpend)}` : ''}. Select an ad below for exact values; inspect a point to open its creative.</p>
        <p className="text-[var(--text-secondary)] sm:hidden">On small screens, use the ad lists and exact values below.</p>
      </div>
      {selected && <div ref={selection} id={`${id}-selection`} tabIndex={-1} aria-label="Selected ad values"
        className="min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
        <Selection row={selected} event={event} onInspect={onInspect} />
      </div>}
    </div>
    <div className="min-w-0 space-y-3">{(['numeric', 'attention', 'cpa', 'spend'] as const).map(lane => {
      const rows = view.rows.filter(row => row.lane === lane)
      if (!rows.length) return null
      return <details key={lane} open data-scatter-lane={lane} className="min-w-0 rounded-xl border border-[var(--border)]">
        <summary className={`cursor-pointer px-4 py-3 font-medium ${control}`}>{laneLabels[lane]} · {rows.length} {rows.length === 1 ? 'ad' : 'ads'}</summary>
        {lane !== 'numeric' && <p className="px-4 pb-3 text-[var(--text-secondary)]">These ads are outside both numeric axes. Missing or inapplicable values are not zero.</p>}
        <ul className="min-w-0 border-t border-[var(--border)]">{rows.map(row => <li key={row.entity.id} className="min-w-0 border-b border-[var(--border)] last:border-0">
          <button type="button" data-scatter-ad={row.entity.id} aria-label={`Select ${summary(row, event)}`} aria-pressed={selected?.entity.id === row.entity.id} aria-controls={`${id}-selection`}
            onClick={() => { setSelectedId(row.entity.id); selection.current?.focus() }} className={`w-full min-w-0 px-4 py-3 text-left ${selected?.entity.id === row.entity.id ? 'bg-[var(--bg-elevated)]' : ''} ${control}`}>
            <span className="block break-words font-medium">{row.entity.name}</span>
            <span className="block break-words text-[var(--text-secondary)]">{row.entity.adsetName ?? row.entity.adsetId ?? 'Ad set unavailable'} · {overviewCreativeFormat(row.entity)}</span>
            <span className="block break-words tabular-nums">{money(row.spend)} spend · {count(row.results)} results · {row.results === 0 ? 'CPA undefined' : `${money(row.cpa)} CPA`}</span>
          </button>
        </li>)}</ul>
      </details>
    })}</div>
    {!view.rows.length && <p role="status" className="text-[var(--text-secondary)]">{search ? 'No supplied ads match this search.' : data.meta.state === 'loading' || data.meta.data?.detailState === 'loading' ? 'Creative evidence is loading.' : 'No supplied ad executions are available.'}</p>}
    <p className="break-words text-[var(--text-secondary)]">Meta-attributed · {view.context.account.name ?? view.context.account.id} · {view.context.range.from}–{view.context.range.to} · {view.context.timezone}. {data.meta.data?.attributionWindow ?? 'Attribution window unavailable'} · observed {observedAt ? <time dateTime={observedAt} title={observedAt}>{observationTime.format(new Date(observedAt))}</time> : 'time unavailable'}. Counts and value remain event-specific; outcomes may still settle. Video lengths and delivery differ, so attention alone does not explain results. Duration describes the supplied preview.</p>
  </section>
}
