'use client'

import Link from 'next/link'
import type { ReportingData } from '@/lib/reporting/contracts'
import { OVERVIEW_EVENTS, overviewEventMetric, overviewHref, type OverviewEventKey } from '@/lib/reporting/overview-model'
import { OverviewMetric } from './OverviewMetric'
import { overviewBusinessSummary, overviewRatioComparison, overviewRatioValue } from '@/lib/reporting/overview-business-summary'
import { hierarchyHasNoResults } from '@/lib/reporting/overview-hierarchy'
import { reportMetricValue, ReportMetricValue } from './MetricValue'
import { isBookingLikeOutcome, outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export function OverviewResults({ data, selected, savedId, showMerFallback = false }: {
  data: ReportingData
  selected: OverviewEventKey
  savedId?: string | null
  showMerFallback?: boolean
}) {
  const business = data.business.data?.metrics, meta = data.meta.data?.metrics, event = OVERVIEW_EVENTS[selected]
  const bookingLike = isBookingLikeOutcome()
  const blended = overviewBusinessSummary(data), priorBlended = overviewBusinessSummary(data, true)
  const blendedRows = [
    { key: 'spendPerBooking', label: `Ad spend per ${OW.one}`, unit: 'money', definition: `Meta ad spend / paid ${OW.many} from all outcome sources.` },
  ] as const
  const selectedMetric = (key: string) => overviewEventMetric(meta, key, event, data.context, data.meta.asOf)
  const cost = selectedMetric(event.cpa)
  const noResults = meta && hierarchyHasNoResults(data, { id: data.context.account.id, level: 'account', metrics: meta }, event)
    && (cost?.current.availability.state !== 'unavailable' || !cost.current.availability.blockerCodes.includes('meta_outcome_hierarchy_unreconciled'))
  const settlingTogether = [event.count, event.cpa, event.value, event.roas].every(key => {
    const metric = selectedMetric(key)
    return metric?.current.availability.state === 'available' && metric.current.maturity.state === 'settling'
      && metric.previous?.availability.state === 'available' && metric.previous.maturity.state === 'settling'
  })
  function select(value: string) {
    const params = new URLSearchParams(window.location.search)
    if (value === 'purchase') params.set('overview_event', value)
    else params.delete('overview_event')
    window.history.pushState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`)
  }
  const tile = 'min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5 sm:px-4 sm:py-3'
  const visibleQualifications = (items: readonly string[]) => items.filter(item => item !== 'Freshness unverified')
  return <div className="space-y-3" data-overview-event={selected}>
    <section aria-label="Business results" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Business results <span className="ml-2 font-normal text-[var(--text-secondary)]">{OW.Many} · All sources</span></h2>
      <details className="min-w-0 open:basis-full text-sm leading-5 text-[var(--text-secondary)]">
        <summary className="inline-flex min-h-11 cursor-pointer items-center underline decoration-dotted underline-offset-4 sm:min-h-8">Definitions<span className="sr-only"> · Payment record and blended context</span></summary>
        <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
        <Link href={`${overviewHref(data.context, '/reports', { report: 'business' }, savedId)}#business-results`}
          className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] hover:underline sm:min-h-8">Business detail ↗</Link>
          <OverviewMetric metric={business?.amount_paid} label="Recorded amount paid" comparison loading={data.business.state === 'loading'} />
          <p>{OW.One}-created cohort · Payment and hours reflect the retained ledger.</p>
          {blendedRows.map(row => <p key={row.key}>{row.definition} Previous: {overviewRatioValue(priorBlended[row.key], row.unit)}.
            {' '}{blended[row.key].reason}{priorBlended[row.key].qualifications.length > 0 && ` Prior: ${priorBlended[row.key].qualifications.join(' · ')}.`}</p>)}
          <p>All-source {OW.many} can include direct, organic, referral and repeat business; these ratios do not establish Meta-attributed return or margin.</p>
        </div>
      </details>

      </div>
      <div className={`grid grid-cols-2 gap-2.5 ${showMerFallback ? bookingLike ? 'lg:grid-cols-5' : 'lg:grid-cols-4' : bookingLike ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        {showMerFallback && <div aria-label={`All-source booked value ÷ Meta spend: ${overviewRatioValue(blended.mer, 'ratio')}`}
          className={`${tile} col-span-2 lg:col-span-1`}>
          <p className="text-sm font-semibold text-[var(--text-secondary)]">MER</p>
          <p className={`mt-1 text-[28px] font-semibold leading-9 tracking-tight tabular-nums ${blended.mer.value === null ? 'text-[var(--text-secondary)]' : 'text-[var(--chart-2)]'}`}>{overviewRatioValue(blended.mer, 'ratio')}</p>
          <p className="text-sm leading-5 text-[var(--text-secondary)]">All-source booked value ÷ Meta spend</p>
          <p className="text-sm tabular-nums leading-5 text-[var(--text-secondary)]">Prior {overviewRatioValue(priorBlended.mer, 'ratio')}{overviewRatioComparison(data, 'mer') && ` · ${overviewRatioComparison(data, 'mer')}`}</p>
          {blended.mer.reason && <p className="text-sm text-[var(--text-secondary)]">{blended.mer.reason}</p>}
          {blended.mer.qualifications.length > 0 && <p className="text-sm text-[var(--text-secondary)]">{blended.mer.qualifications.join(' · ')}</p>}
        </div>}
        <div className={`${tile} [&_summary]:text-[var(--chart-2)]`}><OverviewMetric metric={business?.booked_value} label="Booked value" total hero comparison movement loading={data.business.state === 'loading'} /></div>
        <div className={tile}><OverviewMetric metric={business?.paid_bookings} label={`${OW.Many} with recorded payment`} displayLabel={`Paid ${OW.many}`} hero comparison movement loading={data.business.state === 'loading'} /></div>
        {bookingLike && <div className={tile}><OverviewMetric metric={business?.recorded_booked_hours} label="Recorded booked hours" displayLabel="Recorded hours" hero comparison movement loading={data.business.state === 'loading'} /></div>}
        <div aria-label="Blended business context" className={tile}>
          <dl>{blendedRows.map((row, index) => <div key={row.key} className={index ? 'mt-1 flex flex-wrap items-baseline gap-x-2 text-sm' : ''}>
            <dt className="text-sm leading-5 text-[var(--text-secondary)]">{row.label}</dt>
            <dd aria-label={`${row.label}: ${overviewRatioValue(blended[row.key], row.unit)}`} className="font-semibold tabular-nums">{overviewRatioValue(blended[row.key], row.unit)}</dd>
            <dd className="text-xs tabular-nums leading-5 text-[var(--text-secondary)]">Prior {overviewRatioValue(priorBlended[row.key], row.unit)}{overviewRatioComparison(data, row.key) && ` · ${overviewRatioComparison(data, row.key)}`}</dd>
            {visibleQualifications(blended[row.key].qualifications).length > 0 && <dd className="text-sm text-[var(--text-secondary)]">{visibleQualifications(blended[row.key].qualifications).join(' · ')}</dd>}
          </div>)}</dl>
        </div>
      </div>
    </section>
    <section aria-label="Advertising results" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Advertising results <span className="ml-2 font-normal text-[var(--text-secondary)]">Meta · Attributed{data.meta.state === 'unavailable' && ' · Unavailable'}</span></h2>

        <details className="min-w-0 open:basis-full text-sm text-[var(--text-secondary)]"><summary className="inline-flex min-h-11 cursor-pointer items-center underline decoration-dotted underline-offset-4 sm:min-h-8">Basis{settlingTogether && ' · Settling'}<span className="sr-only"> · Attribution context</span></summary>
        <Link className="inline-flex min-h-11 items-center text-[var(--accent)] hover:underline sm:min-h-8"
          href={overviewHref(data.context, '/performance', { group: 'results' }, savedId)}>All event results ↗</Link>
          <p className="max-w-3xl pb-2">{data.meta.data?.attributionWindow ?? 'Attribution window unavailable.'}{settlingTogether && ' Current and prior attributed results are still settling.'} Meta-attributed results are separate from all-source recorded {OW.many}.</p>
        </details>

        <label className="flex min-w-0 items-center gap-2 text-sm text-[var(--text-secondary)]"><span>Result</span>
          <select aria-label="Dashboard result event" value={selected} onChange={change => select(change.target.value)}
            className="min-h-11 min-w-0 max-w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 text-sm text-[var(--text-primary)] sm:min-h-9">
            <option value="appointment_confirmed">{EVENT}</option><option value="purchase">Purchase</option>
          </select>
        </label>
      </div>
      <div aria-label={`${event.label} Meta result diagnostic strip`}
        className="grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] lg:grid-cols-5">
        <div className="min-w-0 px-4 py-3"><OverviewMetric metric={meta?.spend} label="Spend" total comparison movement loading={data.meta.state === 'loading'} /></div>
        <div className="min-w-0 border-l border-[var(--border)] px-4 py-3"><OverviewMetric metric={selectedMetric(event.count)} label="Reported results" omitSettling={settlingTogether} comparison movement loading={data.meta.state === 'loading'} /></div>
        <div className="min-w-0 border-t border-[var(--border)] px-4 py-3 lg:border-l lg:border-t-0">{noResults ? <div className="min-w-0">
          <p className="text-sm leading-5 text-[var(--text-secondary)]">Cost / result</p>
          <details><summary aria-label="Cost / result: — · No results. Definition and source" className="inline-flex min-h-11 cursor-pointer items-center font-semibold tabular-nums">— · No results</summary>
            <p className="text-sm text-[var(--text-secondary)]">No reported {event.label} results; cost per result is undefined and cannot support a cost comparison.</p>
            <ReportMetricValue metric={cost} comparison compact />
          </details>
          {cost?.previous && <p className="text-sm leading-5 text-[var(--text-secondary)]">Previous: {reportMetricValue(cost, true)}</p>}
        </div> : <OverviewMetric metric={cost} label="Cost / result" omitSettling={settlingTogether} comparison movement loading={data.meta.state === 'loading'} />}</div>
        <div className="min-w-0 border-l border-t border-[var(--border)] px-4 py-3 lg:border-t-0"><OverviewMetric metric={selectedMetric(event.value)} label={`${event.label} reported value`} displayLabel="Reported value" total omitSettling={settlingTogether} comparison movement loading={data.meta.state === 'loading'} /></div>
        <div className="col-span-2 min-w-0 border-t border-[var(--border)] px-4 py-3 lg:col-span-1 lg:border-l lg:border-t-0"><OverviewMetric metric={selectedMetric(event.roas)} label="Reported ROAS" omitSettling={settlingTogether} comparison movement loading={data.meta.state === 'loading'} /></div>
      </div>
    </section>
  </div>
}
