'use client'

import type { BusinessCustomerFollowup, ReportMetricMap, ReportingData } from '@/lib/reporting/contracts'
import { deriveCustomerFollowupReview } from '@/lib/reporting/review/business-customer-followup'
import { ReportMetricValue } from './MetricValue'
import { useSavedReportContext } from './SavedReportContext'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const SUMMARY_FIELDS = [
  ['eligible_customers', 'Eligible customers'], ['repeat_customers', 'Repeat customers'],
  ['repeat_rate', 'Repeat rate'], ['repeat_booked_value', 'Repeat booked value'],
] as const
const DETAIL_FIELDS = [
  ['cohort_customers', 'Cohort customers'], ...SUMMARY_FIELDS,
  ['repeat_bookings', `Repeat ${OW.many}`],
  ['repeat_booked_value_per_eligible_customer', 'Repeat value / eligible customer'],
] as const

function SummaryMetrics({ metrics }: { metrics: ReportMetricMap }) {
  return <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-4">
    {SUMMARY_FIELDS.map(([key, label]) => <div key={key} className="min-w-0">
      <h4 className="mb-1 text-xs font-medium leading-5 text-[var(--text-secondary)]">{label}</h4>
      <ReportMetricValue metric={metrics[key]} compact />
    </div>)}
  </div>
}

function FollowupTable({ followup }: { followup: BusinessCustomerFollowup }) {
  return <div role="region" aria-label="Equal follow-up customer results, scroll for columns" tabIndex={0}
    className="mt-4 overflow-x-auto print:overflow-visible">
    <table className="w-full min-w-[980px] text-left text-sm print:min-w-0 print:text-[10px]">
      <caption className="mb-2 text-left text-xs text-[var(--text-secondary)]">First-observed customer results at equal follow-up horizons</caption>
      <thead><tr className="border-b border-[var(--border)] text-xs text-[var(--text-secondary)]">
        <th scope="col" className="sticky left-0 z-10 w-36 min-w-36 bg-[var(--bg-surface)] px-2 py-3">Horizon</th>
        {DETAIL_FIELDS.map(([key, label]) => <th scope="col" key={key} className="px-2 py-3 text-right font-medium">{label}</th>)}
      </tr></thead>
      <tbody>{followup.horizons.map(horizon => <tr key={horizon.id}
        className="border-b border-[var(--border)] align-top print:break-inside-avoid">
        <th scope="row" className="sticky left-0 z-10 w-36 min-w-36 max-w-36 break-words bg-[var(--bg-surface)] px-2 py-3 font-medium">{horizon.name}</th>
        {DETAIL_FIELDS.map(([key]) => <td key={key} className="px-2 py-2 text-right">
          <ReportMetricValue metric={horizon.metrics[key]} compact />
        </td>)}
      </tr>)}</tbody>
    </table>
  </div>
}

export function CustomerFollowupResult({ data, detail = false }: { data: ReportingData; detail?: boolean }) {
  const followup = data.business.data?.intelligence?.customers.data?.followup
  const saved = useSavedReportContext()
  if (!followup) return null
  const finding = saved ? saved.review.findings.find(item => item.id === 'business_customer_followup')
    : deriveCustomerFollowupReview(data)
  return <div id={detail ? 'business-customer-followup' : undefined}
    data-customer-followup-result={finding?.id} className="mt-5 scroll-mt-24 border-t border-[var(--border)] pt-5">
    <h3 className="font-semibold text-[var(--text-primary)]">Equal follow-up</h3>
    <p className="mt-1 text-xs text-[var(--text-secondary)]">Observed through {followup.observedThrough} · {OW.Many} · All sources · First-observed customer cohorts.</p>
    {finding ? <p className="mt-3 break-words text-sm leading-6 text-[var(--text-secondary)]">{finding.observation.text}</p>
      : <p className="mt-3 text-sm text-[var(--text-secondary)]">This assessment was not included in the saved report.</p>}
    {detail ? <FollowupTable followup={followup} /> : <>
      <p className="mt-3 text-xs font-medium text-[var(--text-secondary)]">{followup.horizons[0].name}</p>
      <SummaryMetrics metrics={followup.horizons[0].metrics} />
    </>}
    <div className="mt-3 space-y-1 text-xs leading-5 text-[var(--text-secondary)]">
      <p>Eligible customers have the complete stated calendar-day horizon after their first qualifying {OW.one} in retained history.</p>
      <p>Repeat results use later-date active positive-price {OW.many} through each eligible customer’s deadline. Same-day {OW.many} do not establish a later sequence.</p>
      <p>First observed does not establish acquisition. Earlier retained-history coverage, paid attribution, profit and causality remain unproven.</p>
    </div>
  </div>
}
