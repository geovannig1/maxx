import { ReportMetricValue } from './MetricValue'
import { MeasurementEvidence } from './MeasurementEvidence'
import { WebsiteTables } from './WebsiteTables'
import type { ReportMetricMap, ReportingData } from '@/lib/reporting/contracts'
import { accountTimezone } from '@/config/business-config'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const META_METRICS = ['outbound_clicks', 'landing_page_views'] as const
const WEBSITE_METRICS = [
  'sessions', 'engaged_sessions', 'engagement_rate', 'users', 'page_views',
  'intent_events', 'lead_events', 'confirmation_events',
] as const
const BUSINESS_METRICS = ['paid_bookings', 'amount_paid'] as const

function SourceState({
  title,
  state,
  notes,
}: {
  title: string
  state: ReportingData['meta']['state']
  notes: string[]
}) {
  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
      <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title} {state}</p>
      <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
        {notes.length ? notes.join(' ') : 'This source did not return data for the selected period.'}
      </p>
    </div>
  )
}

function MetricCards({ metrics, keys }: { metrics: ReportMetricMap; keys: readonly string[] }) {
  const selected = keys.flatMap(key => metrics[key] ? [metrics[key]] : [])
  if (selected.length === 0) {
    return <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No supported metrics were supplied.</p>
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {selected.map(metric => (
        <article key={metric.key} className="min-w-0 rounded-lg p-3 print:break-inside-avoid"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
            {metric.label}
          </p>
          <div className="mt-1"><ReportMetricValue metric={metric} /></div>
          {metric.event && <p className="mt-2 break-all text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Event: {metric.event}</p>}
          <p className="mt-2 text-[10px] leading-4" style={{ color: 'var(--text-tertiary)' }}>{metric.definition}</p>
        </article>
      ))}
    </div>
  )
}

function SourceHeader({
  title,
  description,
  asOf,
  state,
  notes,
}: {
  title: string
  description: string
  asOf: string | null
  state: ReportingData['meta']['state']
  notes: string[]
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="text-[16px] font-bold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        <p className="mt-1 max-w-3xl text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{description}</p>
      </div>
      <span className="rounded-full px-2 py-1 text-[10px]" style={{ background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>
        {state === 'partial' ? 'Partial · ' : ''}{asOf ? `As of ${asOf}` : 'Freshness unavailable'}
      </span>
      {notes.length > 0 && <p className="w-full text-[11px] leading-5" style={{ color: 'var(--warning)' }}>{notes.join(' ')}</p>}
    </header>
  )
}

export function WebsiteJourney({ data }: { data: ReportingData }) {
  const { context } = data
  const contextLabel = `${context.range.from} – ${context.range.to} · ${context.timezone} · ${context.currency}`

  return (
    <section aria-labelledby="website-journey-title" className="space-y-5">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--accent)' }}>Prepared report</p>
        <h2 id="website-journey-title" className="mt-1 text-[24px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
          Website journey
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>{contextLabel}</p>
        <p className="mt-2 max-w-3xl text-[13px] leading-5" style={{ color: 'var(--text-secondary)' }}>
          Follow outbound activity, website behavior, and booked business in separate source lanes. Counts describe different populations and are not divided into a cross-source funnel rate.
        </p>
      </header>

      <article data-source="meta" className="rounded-xl p-4 sm:p-5 print:break-inside-avoid"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
        {data.meta.data ? (
          <>
            <SourceHeader title="Meta outbound activity" description={data.meta.data.sourceDescription} asOf={data.meta.asOf} state={data.meta.state} notes={data.meta.notes} />
            <MetricCards metrics={data.meta.data.metrics} keys={META_METRICS} />
            <p className="mt-3 text-[11px] leading-4" style={{ color: 'var(--text-tertiary)' }}>
              Attribution: {data.meta.data.attributionWindow}. Reporting time: {data.meta.data.reportingTime}.
            </p>
          </>
        ) : <SourceState title="Meta outbound activity" state={data.meta.state} notes={data.meta.notes} />}
      </article>

      <article data-source="ga4" className="rounded-xl p-4 sm:p-5"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
        {data.website.data ? (
          <>
            <SourceHeader title="GA4 website behavior" description={data.website.data.sourceDescription} asOf={data.website.asOf} state={data.website.state} notes={data.website.notes} />
            <MetricCards metrics={data.website.data.metrics} keys={WEBSITE_METRICS} />

            <WebsiteTables report={data.website.data} context={context} />

            <details className="mt-4 rounded-lg p-3 text-[11px]" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
              <summary className="cursor-pointer font-semibold">GA4 report coverage</summary>
              <p className="mt-2 leading-5">
                Current source queries: {data.website.data.metadata.returnedRows} rows returned
                {data.website.data.metadata.totalRows === null ? '' : ` of ${data.website.data.metadata.totalRows}`}.
                Sampling: {data.website.data.metadata.sampled === null ? 'not reported' : data.website.data.metadata.sampled ? 'reported' : 'not reported'}.
                Thresholding: {data.website.data.metadata.subjectToThresholding === null ? 'not supplied' : data.website.data.metadata.subjectToThresholding ? 'reported' : 'not reported'}.
              </p>
            </details>
          </>
        ) : <SourceState title="GA4 website behavior" state={data.website.state} notes={data.website.notes} />}
      </article>

      <article data-source="outcomes" className="rounded-xl p-4 sm:p-5 print:break-inside-avoid"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
        {data.business.data ? (
          <>
            <SourceHeader title="Business outcome activity" description={data.business.data.sourceDescription} asOf={data.business.asOf} state={data.business.state} notes={data.business.notes} />
            <MetricCards metrics={data.business.data.metrics} keys={BUSINESS_METRICS} />
            <p className="mt-3 text-[11px] leading-4" style={{ color: 'var(--text-tertiary)' }}>
              {OW.One} creation date in the account timezone ({accountTimezone()}). These are all-source business totals; they are not attributed to Meta or GA4 channels.
            </p>
          </>
        ) : <SourceState title="Business outcome activity" state={data.business.state} notes={data.business.notes} />}
      </article>
      <MeasurementEvidence data={data} />
    </section>
  )
}
