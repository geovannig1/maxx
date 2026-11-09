'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { ReportingData } from '@/lib/reporting/contracts'
import { ReportingTrend } from './ReportingTrend'
import { BusinessDrivers } from './BusinessDrivers'
import { CustomerResultSummary } from './CustomerResultSummary'
import { CustomerFollowupResult } from './CustomerFollowupResult'
import {
  BUSINESS_NOTE_CLASS, BUSINESS_PANEL_CLASS, BUSINESS_TOTAL_FIELDS, CUSTOMER_FIELDS, UPCOMING_FIELDS,
  BusinessMetrics, BusinessSourceState, BusinessDurationContext, CustomerHistoryContext, UpcomingContext, businessSectionData,
} from './BusinessDetailReport'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export function BusinessOverview({ data }: { data: ReportingData }) {
  const query = useSearchParams()
  const params = new URLSearchParams(query?.toString() ?? '')
  params.set('from', data.context.range.from)
  params.set('to', data.context.range.to)
  params.set('report', 'business')
  const link = (anchor: string, label: string) => <Link href={`/reports?${params}#${anchor}`}
    className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--accent)] underline underline-offset-4">{label}</Link>
  const business = businessSectionData(data.business), intelligence = business?.intelligence
  const customers = businessSectionData(intelligence?.customers), lead = businessSectionData(intelligence?.leadTime), upcoming = businessSectionData(intelligence?.upcoming)
  return <div className="space-y-4 text-[var(--text-primary)]">
    <section id="business-results" aria-label="Business results" className={BUSINESS_PANEL_CLASS}>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-xl font-semibold">Business results</h2>{link('business-types', 'Explore all services')}</div>
      <p className={BUSINESS_NOTE_CLASS}>{OW.Many} · All sources · {OW.One} dates {data.context.range.from} – {data.context.range.to} · {data.context.timezone}.</p>
      <BusinessSourceState source={data.business} label="Business records" />
      {business && <BusinessMetrics metrics={business.metrics} fields={BUSINESS_TOTAL_FIELDS} />}
      <p className={BUSINESS_NOTE_CLASS}>Amount paid reflects the ledger snapshot, not processor settlement or paid-ad-attributed revenue. Booked value and recorded payments remain separate.</p>
      <div className={BUSINESS_NOTE_CLASS}><BusinessDurationContext /></div>
    </section>
    {business && <ReportingTrend kind="business" context={data.context} series={business.series} comparisonSeries={business.comparisonSeries}
      metrics={business.metrics} sourceAsOf={data.business.asOf} />}
    <BusinessDrivers data={data} />
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <section aria-label="Customer history summary" className={BUSINESS_PANEL_CLASS}>
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-semibold">Customer history</h2>{link('business-customers', 'Explore customer groups')}</div>
        {customers && <CustomerResultSummary data={data} />}
        {customers && <BusinessMetrics metrics={customers.metrics} fields={CUSTOMER_FIELDS} compact />}
        {customers?.followup && <CustomerFollowupResult data={data} />}
        <BusinessSourceState source={intelligence?.customers} label="Customer history" />
        <CustomerHistoryContext customers={customers} />
      </section>
      <section aria-label={`${OW.One} lead-time summary`} className={BUSINESS_PANEL_CLASS}>
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-semibold">{OW.One} lead time</h2>{link('business-lead-time', 'Explore lead-time distribution')}</div>
        <BusinessSourceState source={intelligence?.leadTime} label={`${OW.One} lead time`} />
        {lead && <BusinessMetrics metrics={lead.metrics} fields={[
          ['median_lead_days', 'Median lead time'], ['p90_lead_days', '90th percentile'],
          ['dated_bookings', `${OW.Many} with usable dates`], ['eligible_bookings', `Eligible ${OW.many}`],
        ]} compact />}
        <p className={BUSINESS_NOTE_CLASS}>{OW.One} lead time covers active positive-price {OW.many}. It measures {OW.one} creation to recorded service time for the selected cohort. This is not ad-touch conversion lag.</p>
      </section>
    </div>
    <section aria-label="Recorded upcoming schedule summary" className={BUSINESS_PANEL_CLASS}>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-xl font-semibold">Recorded upcoming schedule</h2>{link('business-upcoming', 'Explore recorded service dates')}</div>
      <BusinessSourceState source={intelligence?.upcoming} label="Recorded upcoming schedule" />
      <UpcomingContext upcoming={upcoming} timezone={data.context.timezone} />
      {upcoming && <BusinessMetrics metrics={upcoming.metrics} fields={UPCOMING_FIELDS} comparison={false} />}
    </section>
  </div>
}
