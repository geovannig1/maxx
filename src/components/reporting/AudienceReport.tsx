'use client'

import { useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { ReportMetricValue } from './MetricValue'
import { AudienceEvidenceDetails } from './AudienceEvidenceDetails'
import type { ReportBreakdown, ReportMetricMap, ReportingData } from '@/lib/reporting/contracts'

const DIMENSION_LABEL: Record<ReportBreakdown['dimension'], string> = {
  placement: 'Placement',
  age: 'Age',
  gender: 'Gender',
  region: 'Region',
}

const DISPLAY_METRICS = [
  'spend', 'impressions', 'reach', 'frequency', 'outbound_clicks',
  'outbound_ctr', 'outbound_cpc', 'landing_page_views', 'bookings', 'cost_per_booking',
  'appointment_value', 'appointment_roas', 'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas',
] as const

function BreakdownTable({ dimension, rows }: { dimension: ReportBreakdown['dimension']; rows: ReportBreakdown[] }) {
  const metricKeys = DISPLAY_METRICS.filter(key => rows.some(row => row.metrics[key]))
  return (
    <section className="overflow-hidden rounded-lg print:break-inside-avoid" style={{ border: '1px solid var(--border)' }}>
      <h3 className="px-4 py-3 text-[14px] font-bold" style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}>
        {DIMENSION_LABEL[dimension]}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-[12px]">
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th className="px-3 py-2 font-semibold" style={{ color: 'var(--text-tertiary)' }}>{DIMENSION_LABEL[dimension]}</th>
            {metricKeys.map(key => (
              <th key={key} className="px-3 py-2 font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                {rows.find(row => row.metrics[key])?.metrics[key]?.label ?? key}
              </th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td className="px-3 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{row.label}</td>
                {metricKeys.map(key => (
                  <td key={key} className="px-3 py-3"><ReportMetricValue metric={row.metrics[key]} compact /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function BreakdownUnavailable({ dimension, detailsLoading }: { dimension: ReportBreakdown['dimension']; detailsLoading: boolean }) {
  const label = DIMENSION_LABEL[dimension]
  return (
    <section className="rounded-lg px-4 py-3 print:break-inside-avoid" style={{ border: '1px solid var(--border)' }}>
      <h3 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{label}</h3>
      <p role="status" className="mt-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
        {detailsLoading ? `Loading ${label.toLowerCase()} breakdown…` : `${label} breakdown unavailable · Meta did not return supported rows for the selected period.`}
      </p>
    </section>
  )
}

function EntityMetrics({ metrics }: { metrics: ReportMetricMap }) {
  const selected = DISPLAY_METRICS.flatMap(key => metrics[key] ? [metrics[key]] : [])
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {selected.map(metric => (
        <div key={metric.key}>
          <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{metric.label}</p>
          <ReportMetricValue metric={metric} compact />
        </div>
      ))}
    </div>
  )
}

function MetaSourceQualifications({ notes }: { notes: string[] }) {
  const unique = [...new Set(notes.map(note => note.trim()).filter(Boolean))]
  if (unique.length === 0) return null
  return <details data-reporting-source className="mt-2 text-[11px] leading-5" style={{ color: 'var(--warning)' }}>
    <summary className="min-h-11 cursor-pointer py-2">Review {unique.length} Meta source qualification{unique.length === 1 ? '' : 's'}</summary>
    <div className="space-y-2 border-t border-[var(--border)] pt-3">
      {unique.map((note, index) => <p key={index}>{note}</p>)}
    </div>
  </details>
}

export function AudienceReport({ data }: { data: ReportingData }) {
  const query = useSearchParams(), path = usePathname() ?? '/reports'
  const search = query?.get('audience_q') ?? '', needle = search.trim().toLocaleLowerCase()
  const meta = data.meta.data
  const detailsLoading = meta?.detailState === 'loading'
  const audienceEntities = meta?.entities.filter(entity => entity.level === 'adset') ?? []
  const matching = audienceEntities.filter(entity => !needle || [entity.id, entity.name, entity.status,
    ...(entity.audienceEvidence?.members.flatMap(member => [member.id, member.name, member.role, member.subtype,
      String(member.operationCode ?? ''), String(member.deliveryCode ?? ''), ...member.seeds.flatMap(seed => [seed.id, seed.name])]) ?? []),
  ].some(value => value?.toLocaleLowerCase().includes(needle)))
  const updateSearch = (value: string) => {
    const params = new URLSearchParams(window.location.search)
    if (value) params.set('audience_q', value)
    else params.delete('audience_q')
    window.history.replaceState(null, '', `${path}?${params}${window.location.hash}`)
  }
  useEffect(() => {
    // The first source packet may arrive after native hash navigation has already run.
    const id = window.location.hash.slice(1)
    if (id.startsWith('audience-adset-')) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [meta?.entities])
  const grouped = meta?.breakdowns.reduce<Partial<Record<ReportBreakdown['dimension'], ReportBreakdown[]>>>((result, row) => ({
    ...result,
    [row.dimension]: [...(result[row.dimension] ?? []), row],
  }), {}) ?? {}

  return (
    <section aria-labelledby="audience-report-title" className="space-y-5">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--accent)' }}>Prepared report</p>
        <h2 id="audience-report-title" className="mt-1 text-[24px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
          Audience and placement
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
          {data.context.range.from} – {data.context.range.to} · {data.context.timezone}
        </p>
        <p className="mt-2 max-w-3xl text-[13px] leading-5" style={{ color: 'var(--text-secondary)' }}>
          Meta delivery by the dimensions returned for the selected period. Reach is not added across breakdown rows because people can appear in more than one row.
        </p>
      </header>

      {!meta ? (
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Audience evidence {data.meta.state}</h3>
          {data.meta.notes.length
            ? <MetaSourceQualifications notes={data.meta.notes} />
            : <p className="mt-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Meta did not return audience evidence for this period.</p>}
        </div>
      ) : (
        <>
          <article className="rounded-xl p-4 sm:p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-[16px] font-bold" style={{ color: 'var(--text-primary)' }}>Ad-set audiences and readiness</h3>
                <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{meta.sourceDescription}</p>
              </div>
              <span className="rounded-full px-2 py-1 text-[10px]" style={{ background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>
                {data.meta.state === 'partial' ? 'Partial · ' : ''}{data.meta.asOf ? `As of ${data.meta.asOf}` : 'Freshness unavailable'}
              </span>
            </div>
            <MetaSourceQualifications notes={data.meta.notes} />
            <div className="mt-4 flex flex-wrap items-end gap-3 print:hidden">
              <label className="flex min-w-0 flex-1 basis-60 flex-col gap-1 text-xs text-[var(--text-secondary)]">Search ad sets and audiences
                <input type="search" aria-label="Search ad sets and audiences" value={search} onChange={event => updateSearch(event.target.value)}
                  placeholder="Name, ID, role, status code or seed" className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)]" />
              </label>
              <button type="button" onClick={() => updateSearch('')} className="min-h-11 rounded-lg border border-[var(--border)] px-3 text-sm text-[var(--text-primary)]">Clear audience search</button>
            </div>
            <p role="status" className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">{matching.length} matching of {audienceEntities.length} supplied ad sets. Print includes all matching ad sets; CSV includes the full supplied audience report.</p>
            {matching.length === 0 && audienceEntities.length > 0 && <p className="mt-3 text-sm text-[var(--text-secondary)]">No ad sets match this search. Clear audience search to restore the supplied rows.</p>}
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {matching.map(entity => (
                <article key={entity.id} id={`audience-adset-${encodeURIComponent(entity.id)}`} className="min-w-0 scroll-mt-24 rounded-lg p-3 print:break-inside-avoid"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entity.name}</p>
                      <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Ad set · {entity.id}</p>
                      <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{entity.audienceLabel}</p>
                    </div>
                    <span className="rounded-full px-2 py-1 text-[10px]" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                      {entity.status}
                    </span>
                  </div>
                  <AudienceEvidenceDetails evidence={entity.audienceEvidence} asOf={data.context.asOf} />
                  <h4 className="mt-4 text-xs font-semibold text-[var(--text-primary)]">Selected-period performance · {data.context.range.from}–{data.context.range.to}</h4>
                  <EntityMetrics metrics={entity.metrics} />
                </article>
              ))}
            </div>
            {audienceEntities.length === 0 && (
              <p role="status" className="mt-4 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{detailsLoading ? 'Loading ad sets…' : 'No ad sets were returned for this period.'}</p>
            )}
          </article>

          <article className="space-y-4 rounded-xl p-4 sm:p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
            <div>
              <h3 className="text-[16px] font-bold" style={{ color: 'var(--text-primary)' }}>Delivery breakdowns</h3>
              <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>
                Costs and outcomes are Meta-reported under {meta.attributionWindow}. Reporting time: {meta.reportingTime}.
              </p>
            </div>
            {(['placement', 'age', 'gender', 'region'] as const).map(dimension => grouped[dimension]?.length ? (
              <BreakdownTable key={dimension} dimension={dimension} rows={grouped[dimension]!} />
            ) : <BreakdownUnavailable key={dimension} dimension={dimension} detailsLoading={detailsLoading} />)}
            <p className="text-[11px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
              Reach is not added across breakdown rows. A missing metric remains unavailable; it is not treated as zero.
            </p>
          </article>
        </>
      )}
    </section>
  )
}
