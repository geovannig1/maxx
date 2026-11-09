'use client'

import type { KeyboardEvent } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Download, Printer } from 'lucide-react'
import { AudienceReport } from './AudienceReport'
import { BusinessDetailReport } from './BusinessDetailReport'
import { CreativeReport } from './CreativeReport'
import { ExpertReviewPanel } from './ExpertReviewPanel'
import { OverviewReport } from './OverviewReport'
import { WebsiteJourney } from './WebsiteJourney'
import { MeasurementEvidence } from './MeasurementEvidence'
import { deriveExpertReview } from '@/lib/reporting/review'
import { useSavedReportContext } from './SavedReportContext'
import { businessExportRows } from '@/lib/reporting/business-export'
import { audienceExportRows } from '@/lib/reporting/audience-export'
import { budgetExportRows } from '@/lib/reporting/budget-export'
import {
  downloadReportCsv,
  metricsToExportRows,
  type ReportExportRow,
} from '@/lib/reporting/export'
import type { ReportMetricMap, ReportingData } from '@/lib/reporting/contracts'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export type ReportPreset = 'results' | 'business' | 'creative' | 'website' | 'audience'

export const REPORT_PRESETS: Array<{ key: ReportPreset; label: string; description: string }> = [
  { key: 'results', label: 'Results', description: 'Business results, Meta delivery, website response, and findings.' },
  { key: 'business', label: 'Business', description: `Services, customer history, ${OW.one} lead time and recorded upcoming ${OW.many}.` },
  { key: 'creative', label: 'Creative', description: 'Creative identity and date-matched delivery evidence.' },
  { key: 'website', label: 'Website journey', description: `Outbound, website, and ${OW.one} evidence in separate source lanes.` },
  { key: 'audience', label: 'Audience report', description: 'Audience membership, operational readiness, ad-set performance and Meta breakdowns.' },
]

const RESULT_META_METRICS = [
  'spend', 'bookings', 'cost_per_booking', 'appointment_value', 'appointment_roas',
  'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas', 'outbound_clicks',
] as const
const RESULT_WEBSITE_METRICS = ['sessions', 'engagement_rate', 'intent_events', 'confirmation_events'] as const
const AUDIENCE_METRICS = [
  'spend', 'impressions', 'reach', 'frequency', 'outbound_clicks',
  'outbound_ctr', 'outbound_cpc', 'landing_page_views', 'bookings', 'cost_per_booking',
  'appointment_value', 'appointment_roas', 'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas',
] as const

export function reportPresetFromSearch(search: string | URLSearchParams): ReportPreset {
  const value = new URLSearchParams(search).get('report')
  return REPORT_PRESETS.some(item => item.key === value) ? value as ReportPreset : 'results'
}

export function reportUrlForPreset(
  pathname: string,
  search: string | URLSearchParams,
  preset: ReportPreset,
): string {
  const query = new URLSearchParams(search)
  if (preset === 'results') query.delete('report')
  else query.set('report', preset)
  const serialized = query.toString()
  return `${pathname}${serialized ? `?${serialized}` : ''}`
}

function pickMetrics(metrics: ReportMetricMap, keys: readonly string[]): ReportMetricMap {
  return Object.fromEntries(keys.flatMap(key => metrics[key] ? [[key, metrics[key]]] : []))
}

function addRows(
  rows: ReportExportRow[],
  metrics: ReportMetricMap,
  entity: string,
  data: ReportingData,
): void {
  rows.push(...metricsToExportRows(metrics, entity, data.context))
}

export function collectReportExportRows(data: ReportingData, preset: ReportPreset): ReportExportRow[] {
  const rows: ReportExportRow[] = []
  const meta = data.meta.data
  const business = data.business.data
  const website = data.website.data
  const measurement = data.measurement?.data

  if (measurement && (preset === 'results' || preset === 'website')) {
    for (const [metrics, label, notes] of [
      [measurement.paidAssociation, 'First-party paid association', measurement.paidAssociationNotes],
      [measurement.capi, 'CAPI confirmation delivery', measurement.capiNotes],
    ] as const) {
      rows.push(...metricsToExportRows(Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'later_canceled_website_confirmations')), label, data.context).map(row => ({
        ...row, limitations: [row.limitations, ...notes].filter(Boolean).join(' · '),
      })))
    }
  }

  if (preset === 'results' || preset === 'business') rows.push(...businessExportRows(data))
  if (preset === 'results') {
    if (meta) {
      rows.push(...budgetExportRows(meta.entities.filter(item => item.level === 'campaign' || item.level === 'adset'), meta.entities, data.context))
      addRows(rows, pickMetrics(meta.metrics, RESULT_META_METRICS), 'Meta delivery and attributed results', data)
      for (const [period, points] of [['current', meta.series], ['prior', meta.comparisonSeries]] as const) {
        for (const day of points) addRows(rows, day.metrics, `Meta account daily · ${period} · ${day.date}`, data)
      }
      for (const entity of meta.entities) {
        for (const [period, points] of [['current', entity.series], ['prior', entity.comparisonSeries]] as const) {
          for (const day of points ?? []) addRows(rows, day.metrics, `Meta ${entity.level} ${entity.id} · ${entity.name} · daily ${period} · ${day.date}`, data)
        }
      }
      for (const entity of meta.entities.filter(item => item.level === 'campaign' || item.level === 'adset')) {
        addRows(rows, pickMetrics(entity.metrics, [...RESULT_META_METRICS, 'bookings_click', 'bookings_view']), `${entity.name} (${entity.level} ${entity.id}; campaign ${entity.campaignId ?? '—'}; ${entity.status}; ${entity.audienceLabel})`, data)
      }
    }
    if (website) addRows(rows, pickMetrics(website.metrics, RESULT_WEBSITE_METRICS), 'GA4 website response', data)
  }

  if (preset === 'creative' && meta) {
    for (const entity of meta.entities.filter(item => item.level === 'ad')) {
      addRows(rows, entity.metrics, `Creative · ${entity.name}`, data)
    }
  }

  if (preset === 'website') {
    if (meta) addRows(rows, pickMetrics(meta.metrics, ['outbound_clicks', 'landing_page_views']), 'Meta outbound activity', data)
    if (website) {
      addRows(rows, website.metrics, 'GA4 website behavior', data)
      for (const item of website.rows) {
        addRows(rows, item.metrics, `${item.landingPage} · ${item.device} · ${item.channel}`, data)
      }
      for (const event of website.events) {
        addRows(rows, event.metrics, `${event.name} · ${event.device} · ${event.channel}`, data)
      }
    }
    if (business) addRows(rows, pickMetrics(business.metrics, ['paid_bookings', 'amount_paid']), 'Business outcome activity', data)
  }

  if (preset === 'audience' && meta) {
    rows.push(...audienceExportRows(data))
    for (const entity of meta.entities.filter(item => item.level === 'adset')) {
      addRows(rows, pickMetrics(entity.metrics, AUDIENCE_METRICS), `Audience · ${entity.audienceLabel} · ${entity.name} · adset ${entity.id}`, data)
    }
    for (const breakdown of meta.breakdowns) {
      const dimension = `${breakdown.dimension.slice(0, 1).toUpperCase()}${breakdown.dimension.slice(1)}`
      addRows(rows, pickMetrics(breakdown.metrics, AUDIENCE_METRICS), `${dimension} · ${breakdown.label}`, data)
    }
  }

  return rows
}

export function websiteExportPending(data: ReportingData): boolean {
  return [data.meta, data.business, data.website, data.measurement].some(section => section?.state === 'loading')
}

export function ReportsReport({ data }: { data: ReportingData }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const preset = reportPresetFromSearch(search)
  const saved = useSavedReportContext()
  const review = saved?.review ?? deriveExpertReview(data)
  const selected = REPORT_PRESETS.find(item => item.key === preset) ?? REPORT_PRESETS[0]
  const exportRows = collectReportExportRows(data, preset)
  const exportPending = preset === 'website' && websiteExportPending(data)

  function exportReport() {
    if (exportPending) return
    downloadReportCsv(exportRows, `maxx-${preset}-${data.context.range.from}-${data.context.range.to}`)
  }

  function selectPreset(next: ReportPreset) {
    router.push(reportUrlForPreset(pathname, search, next), { scroll: false })
  }

  function selectPresetFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % REPORT_PRESETS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + REPORT_PRESETS.length) % REPORT_PRESETS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = REPORT_PRESETS.length - 1
    else return
    event.preventDefault()
    selectPreset(REPORT_PRESETS[next].key)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5 print:max-w-none print:p-0">
      <header className="rounded-xl p-4 sm:p-5 print:border-0 print:p-0"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--accent)' }}>Reports</p>
            <h1 className="mt-1 text-[28px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>{selected.label}</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-5" style={{ color: 'var(--text-secondary)' }}>{selected.description}</p>
            <p className="mt-2 text-[12px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              Selected {data.context.range.from} – {data.context.range.to} · prior {data.context.comparison.from} – {data.context.comparison.to} · {data.context.timezone} · {data.context.currency}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            {preset !== 'creative' && <button type="button" onClick={exportReport} disabled={exportPending || exportRows.length === 0}
              aria-describedby={exportPending ? 'website-export-pending' : undefined}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              <Download className="h-4 w-4" /> {preset === 'results' ? 'Export full results' : preset === 'business' ? 'Export full business report' : preset === 'website' ? 'Export full website CSV' : 'Export CSV'}
            </button>}
            <button type="button" onClick={() => window.print()}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              <Printer className="h-4 w-4" /> Print report
            </button>
          </div>
        </div>
        {exportPending && <p id="website-export-pending" role="status" className="mt-2 text-xs text-[var(--text-secondary)] print:hidden">
          The full website export will be ready when all requested sources finish loading. Results above remain available.
        </p>}

        <div role="tablist" aria-label="Prepared reports" className="mt-5 grid grid-cols-2 gap-2 xl:grid-cols-5 print:hidden">
          {REPORT_PRESETS.map((item, index) => {
            const active = item.key === preset
            return (
              <button key={item.key} id={`report-tab-${item.key}`} type="button" role="tab" aria-selected={active}
                aria-controls="prepared-report" tabIndex={active ? 0 : -1}
                onClick={() => selectPreset(item.key)}
                onKeyDown={event => selectPresetFromKeyboard(event, index)}
                className="min-h-11 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                style={{ background: active ? 'var(--accent-dim)' : 'var(--bg-subtle)', border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border)'}`, color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                <span className="block text-[12px] font-semibold">{item.label}</span>
                <span className="mt-1 hidden text-[10px] leading-4 sm:block" style={{ color: 'var(--text-tertiary)' }}>{item.description}</span>
              </button>
            )
          })}
        </div>
      </header>

      <div id="prepared-report" role="tabpanel" aria-labelledby={`report-tab-${preset}`}>
        {preset === 'results' && (
          <div className="space-y-5">
            <h2 className="sr-only">Results report</h2>
            <OverviewReport data={data} showFindings={false} />
            <MeasurementEvidence data={data} />
            <ExpertReviewPanel review={review} expanded />
          </div>
        )}
        {preset === 'creative' && <CreativeReport data={data} />}
        {preset === 'business' && <BusinessDetailReport data={data} />}
        {preset === 'website' && <WebsiteJourney data={data} />}
        {preset === 'audience' && <AudienceReport data={data} />}
      </div>
    </div>
  )
}
