'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import type { BusinessCustomers, BusinessGroup, BusinessUpcoming, ReportMetricMap, ReportingData, ReportSection } from '@/lib/reporting/contracts'
import { ReportMetricValue } from './MetricValue'
import { ReportingTrend } from './ReportingTrend'
import { BusinessDrivers } from './BusinessDrivers'
import { CustomerResultSummary } from './CustomerResultSummary'
import { CustomerFollowupResult } from './CustomerFollowupResult'
import { isBookingLikeOutcome, outcomeWords } from '@/config/outcome-nouns'
import { visibleBusinessFields } from '@/lib/reporting/booking-only-fields'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Fields = ReadonlyArray<readonly [string, string]>
export const BUSINESS_TOTAL_FIELDS: Fields = [
  ['paid_bookings', `Paid ${OW.many}`], ['amount_paid', 'Amount paid'], ['active_appointments', `Active ${OW.many}`], ['booked_value', 'Booked value'],
  ['recorded_booked_hours', 'Recorded booked hours'], ['hours_per_recorded_booking', `Hours per duration-recorded ${OW.one}`],
  ['duration_recorded_bookings', `${OW.Many} with recorded duration`], ['duration_coverage', 'Duration coverage'],
]
const SERVICE_FIELDS: Fields = [...BUSINESS_TOTAL_FIELDS.slice(0, 4), ['value_bearing_bookings', `Value-bearing ${OW.many}`], ['payment_coverage', 'Payment coverage']]
const SERVICE_DURATION_FIELDS: Fields = [['value_bearing_bookings', `Value-bearing ${OW.many}`], ...BUSINESS_TOTAL_FIELDS.slice(4)]
export const CUSTOMER_FIELDS: Fields = [
  ['identified_customers', 'Identified customer records'], ['prior_booking_customers', `With an earlier ${OW.one}`],
  ['first_observed_customers', 'First observed in retained history'], ['unidentified_bookings', `${OW.Many} without usable identity`],
  ['multiple_booking_customers', `With multiple selected-period ${OW.many}`],
]
export const LEAD_FIELDS: Fields = [
  ['eligible_bookings', `Eligible ${OW.many}`], ['dated_bookings', `${OW.Many} with usable dates`], ['median_lead_days', `Median ${OW.one} lead time`],
  ['p25_lead_days', '25th percentile'], ['p75_lead_days', '75th percentile'], ['p90_lead_days', '90th percentile'],
]
export const UPCOMING_FIELDS: Fields = [
  ['recorded_bookings', `Recorded ${OW.many}`], ['booked_value', 'Scheduled booked value'], ['amount_paid', 'Recorded amount paid'], ['unknown_payment_count', 'Unknown payment records'],
  ['recorded_booked_hours', 'Recorded booked hours'], ['hours_per_recorded_booking', `Hours per duration-recorded ${OW.one}`],
  ['duration_recorded_bookings', `${OW.Many} with recorded duration`],
]
export const BUSINESS_PANEL_CLASS = 'min-w-0 scroll-mt-24 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 sm:p-6'
export const BUSINESS_NOTE_CLASS = 'mt-3 text-xs leading-5 text-[var(--text-secondary)]'
const SOURCE_NOTE_MESSAGES = new Map([
  ['business_customer_read_unavailable', 'Customer history could not be loaded. Refresh the report to try again.'],
  ['business_lead_time_read_unavailable', `${OW.One} lead time could not be loaded. Refresh the report to try again.`],
  ['business_upcoming_read_unavailable', 'The recorded upcoming schedule could not be loaded. Refresh the report to try again.'],
])

export function businessServiceHref(path: string, search: string | URLSearchParams, hash: string, query: string) {
  const params = new URLSearchParams(search)
  if (query) params.set('business_q', query)
  else params.delete('business_q')
  return `${path}${params.size ? `?${params}` : ''}${hash}`
}

export function businessSectionData<T>(source?: ReportSection<T>): T | null {
  return source && (source.state === 'available' || source.state === 'partial') ? source.data : null
}

export function BusinessSourceState({ source, label }: { source?: ReportSection<unknown>; label: string }) {
  const message = !source ? `${label} was not supplied.` : source.state === 'loading' ? `Loading ${label.toLowerCase()}…`
    : source.state === 'unavailable' ? `${label} unavailable.` : source.state === 'partial' ? `${label}: partial evidence.` : null
  return <div className={BUSINESS_NOTE_CLASS}>
    {message && <p role="status">{message}</p>}
    {source && <p>{OW.Many} source as of {source.asOf ?? 'unavailable'}</p>}
    {source?.notes.map((note, index) => <p key={index}>{SOURCE_NOTE_MESSAGES.get(note) ?? note}</p>)}
  </div>
}

export function BusinessMetrics({ metrics, fields, comparison = true, compact = false }: {
  metrics?: ReportMetricMap; fields: Fields; comparison?: boolean; compact?: boolean
}) {
  return <div className={`mt-4 grid grid-cols-2 gap-x-5 gap-y-4 ${compact ? '' : 'lg:grid-cols-4'}`}>
    {visibleBusinessFields(fields).map(([key, label]) => <div key={key} className="min-w-0">
      <h3 className="mb-1 text-xs font-medium leading-5 text-[var(--text-secondary)]">{label}</h3>
      <ReportMetricValue metric={metrics?.[key]} comparison={comparison} compact={compact} />
    </div>)}
  </div>
}

export function CustomerHistoryContext({ customers }: { customers?: BusinessCustomers | null }) {
  return <div className={BUSINESS_NOTE_CLASS}>
    <p>Customer groups cover active positive-price {OW.many}. Headline business totals can also include zero-price {OW.many} and their recorded payments.</p>
    <p>Customer records match lowercase, trimmed email addresses; they are not proven unique people. First observed is not confirmed new.</p>
    {customers && <p>Retained {OW.one} history: {customers.historyFrom ?? 'start unavailable'} – {customers.historyTo}. Earlier {OW.many} outside retained history cannot be established. Missing identity limits customer classification, not the recorded {OW.one} or payment totals.</p>}
  </div>
}

export function UpcomingContext({ upcoming, timezone }: { upcoming?: BusinessUpcoming | null; timezone: string }) {
  return <div className={BUSINESS_NOTE_CLASS}>
    {upcoming && <p>Service dates {upcoming.range.from} – {upcoming.range.to} · {timezone}. The next 28 service dates after the source snapshot are separate from the selected {OW.one} creation period.</p>}
    <p>Recorded schedule metrics cover active positive-price {OW.many} in the retained ledger.</p>
    <p>This is a recorded schedule; upstream completeness is unverified. An omitted date does not establish an open slot.</p>
    <p>Scheduled booked value and recorded amount paid remain separate. Payment observations do not establish receipts dated to this service window.</p>
    <BusinessDurationContext />
  </div>
}

export function BusinessDurationContext() {
  if (!isBookingLikeOutcome()) return null
  return <p>Recorded hours cover active positive-price {OW.many} in the current stored schedule. Missing durations leave a subtotal; hours per {OW.one} uses only {OW.many} with usable duration. These are recorded {OW.one} durations, not attendance, original {OW.one}-time hours or available capacity.</p>
}

function BusinessTable({ rows, fields: allFields, caption, nameLabel, comparison = false, kind }: {
  rows: BusinessGroup[]; fields: Fields; caption: string; nameLabel: string; comparison?: boolean; kind?: 'service' | 'day'
}) {
  const fields = visibleBusinessFields(allFields)
  return <div role="region" aria-label={`${caption}, scroll for columns`} tabIndex={0} className="mt-4 overflow-x-auto print:overflow-visible">
    <table className={`w-full ${fields.length > 2 ? 'min-w-[720px]' : 'min-w-[320px]'} text-left text-sm print:min-w-0 print:text-xs`}>
      <caption className="mb-2 text-left text-xs text-[var(--text-secondary)]">{caption}</caption>
      <thead><tr className="border-b border-[var(--border)] text-xs text-[var(--text-secondary)]">
        <th scope="col" className="px-2 py-3">{nameLabel}</th>
        {fields.map(([key, label]) => <th scope="col" key={key} className="px-2 py-3 text-right font-medium">{label}</th>)}
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} id={kind === 'service' ? `business-service-${encodeURIComponent(row.id)}` : undefined} data-business-service={kind === 'service' ? row.id : undefined}
        data-business-day={kind === 'day' ? row.name : undefined} className="scroll-mt-24 border-b border-[var(--border)] align-top print:break-inside-avoid">
        <th scope="row" className="max-w-64 break-words px-2 py-3 font-medium">{row.name}</th>
        {fields.map(([key]) => <td key={key} className="px-2 py-2 text-right"><ReportMetricValue metric={row.metrics[key]} comparison={comparison} compact /></td>)}
      </tr>)}</tbody>
    </table>
  </div>
}

export function BusinessDetailReport({ data }: { data: ReportingData }) {
  const query = useSearchParams(), path = usePathname() ?? '/reports'
  const serviceQuery = query?.get('business_q') ?? ''
  const normalizedQuery = serviceQuery.trim().toLocaleLowerCase()
  const business = businessSectionData(data.business), intelligence = business?.intelligence
  const customers = businessSectionData(intelligence?.customers), lead = businessSectionData(intelligence?.leadTime), upcoming = businessSectionData(intelligence?.upcoming)
  const types = business?.types ?? []
  const searchKey = query?.toString() ?? ''
  const previousDestination = useRef<{ hash: string; source: typeof business } | null>(null)
  useEffect(() => {
    let frame = 0
    const scroll = (force = false) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const id = window.location.hash.slice(1)
        const target = id.startsWith('business-') ? document.getElementById(id) : null
        if (!target || !force && previousDestination.current?.hash === id && previousDestination.current.source === business) return
        target.scrollIntoView({ block: 'start' })
        previousDestination.current = { hash: id, source: business }
      })
    }
    // Native hash navigation can run before the asynchronously loaded service row exists.
    scroll()
    const navigate = () => scroll(true)
    window.addEventListener('hashchange', navigate)
    window.addEventListener('popstate', navigate)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('hashchange', navigate)
      window.removeEventListener('popstate', navigate)
    }
  }, [business, searchKey])
  const matches = types.filter(type => !normalizedQuery || [type.name, type.id].some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
  const updateSearch = (value: string) => window.history.replaceState(null, '', businessServiceHref(path, window.location.search, window.location.hash, value))
  return <div className="space-y-5 text-[var(--text-primary)]">
    <header>
      <h2 className="text-2xl font-semibold">Business performance</h2>
      <p className={BUSINESS_NOTE_CLASS}>{data.context.account.name ?? data.context.account.id} · {OW.Many} · All sources · {data.context.currency}</p>
      <p className={BUSINESS_NOTE_CLASS}>{OW.One} dates {data.context.range.from} – {data.context.range.to} · {data.context.timezone}. Previous: {data.context.comparison.from} – {data.context.comparison.to}.</p>
    </header>
    <section id="business-results" aria-label="Business results" className={BUSINESS_PANEL_CLASS}>
      <h2 className="text-xl font-semibold">Business results</h2>
      <BusinessSourceState source={data.business} label="Business records" />
      {business && <>
        <BusinessMetrics metrics={business.metrics} fields={[...SERVICE_FIELDS, ...BUSINESS_TOTAL_FIELDS.slice(4)]} />
        <p className={BUSINESS_NOTE_CLASS}>{business.sourceDescription}</p>
        <p className={BUSINESS_NOTE_CLASS}>These totals describe {OW.many} created in the selected period. Amount paid is the recorded payment snapshot, not processor settlement or paid-ad-attributed revenue.</p>
        <div className={BUSINESS_NOTE_CLASS}><BusinessDurationContext /></div>
      </>}
    </section>
    {business && <ReportingTrend kind="business" context={data.context} series={business.series} comparisonSeries={business.comparisonSeries}
      metrics={business.metrics} sourceAsOf={data.business.asOf} />}
    <BusinessDrivers data={data} detail />
    <section id="business-types" aria-label="Service results" className={BUSINESS_PANEL_CLASS}>
      <h2 className="text-xl font-semibold">Service results</h2>
      <p className={BUSINESS_NOTE_CLASS}>Native {OW.one} types across the selected and previous {OW.one} creation periods. Service search applies only to this table; account totals and other perspectives remain unchanged.</p>
      {business ? <>
        <div className="mt-4 flex flex-wrap items-end gap-3 print:hidden">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">Search services
            <input type="search" aria-label="Search services" value={serviceQuery} placeholder="Native service name or ID"
              onChange={event => updateSearch(event.target.value)} className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)]" />
          </label>
          <button type="button" onClick={() => updateSearch('')} className="min-h-11 rounded-lg border border-[var(--border)] px-3 text-sm">Clear service search</button>
        </div>
        <p role="status" className={BUSINESS_NOTE_CLASS}>{matches.length} matching of {types.length} supplied services{serviceQuery.trim() ? ` for “${serviceQuery.trim()}”` : ''}. Print includes all matching rows; the full business export includes all supplied services.</p>
        {matches.length ? <BusinessTable rows={matches} fields={SERVICE_FIELDS} nameLabel="Native service" comparison kind="service" caption={`Services by ${OW.one} creation date; current and previous values`} />
          : <p className={BUSINESS_NOTE_CLASS}>{types.length ? 'No services match this search. Clear service search to restore the supplied rows.' : 'No native service rows were supplied for these periods.'}</p>}
        {matches.length > 0 && isBookingLikeOutcome() && <BusinessTable rows={matches} fields={SERVICE_DURATION_FIELDS} nameLabel="Native service" comparison caption={`Recorded hours by service; current and previous ${OW.one} creation periods`} />}
      </> : <BusinessSourceState source={data.business} label="Service results" />}
    </section>
    <section id="business-customers" aria-label="Customer history" className={BUSINESS_PANEL_CLASS}>
      <h2 className="text-xl font-semibold">Customer history</h2>
      {customers && <CustomerResultSummary data={data} />}
      {customers && <>
        <BusinessMetrics metrics={customers.metrics} fields={CUSTOMER_FIELDS} />
        <BusinessTable rows={customers.groups} fields={[
          ['customers', 'Customer records'], ['bookings', `${OW.Many}`], ['paid_bookings', `Paid ${OW.many}`], ['amount_paid', 'Amount paid'], ['booked_value', 'Booked value'],
        ]} nameLabel="Retained-history group" caption={`Customer groups for selected and previous ${OW.one} creation dates`} comparison />
        <BusinessTable rows={customers.groups} fields={[["bookings", `${OW.Many}`], ...BUSINESS_TOTAL_FIELDS.slice(4)]}
          nameLabel="Retained-history group" caption="Customer-group recorded hours and duration coverage" comparison />
        {customers.followup && <CustomerFollowupResult data={data} detail />}
        {!customers.groups.length && <p className={BUSINESS_NOTE_CLASS}>No customer-group rows were supplied.</p>}
      </>}
      <BusinessSourceState source={intelligence?.customers} label="Customer history" />
      <CustomerHistoryContext customers={customers} />
    </section>
    <section id="business-lead-time" aria-label={`${OW.One} lead time`} className={BUSINESS_PANEL_CLASS}>
      <h2 className="text-xl font-semibold">{OW.One} lead time</h2>
      <BusinessSourceState source={intelligence?.leadTime} label={`${OW.One} lead time`} />
      <p className={BUSINESS_NOTE_CLASS}>{OW.One} lead time covers active positive-price {OW.many}. It measures elapsed time from {OW.one} creation to the recorded service time, among dated {OW.many} created in the selected period. This is not ad-touch conversion lag.</p>
      {lead && <>
        <BusinessMetrics metrics={lead.metrics} fields={LEAD_FIELDS} />
        <BusinessTable rows={lead.buckets} fields={[["bookings", `${OW.Many}`]]} nameLabel="Elapsed time" caption={`${OW.One}-to-service lead-time distribution`} comparison />
        {!lead.buckets.length && <p className={BUSINESS_NOTE_CLASS}>No lead-time bucket rows were supplied.</p>}
      </>}
    </section>
    <section id="business-upcoming" aria-label="Recorded upcoming schedule" className={BUSINESS_PANEL_CLASS}>
      <h2 className="text-xl font-semibold">Recorded upcoming schedule</h2>
      <BusinessSourceState source={intelligence?.upcoming} label="Recorded upcoming schedule" />
      <UpcomingContext upcoming={upcoming} timezone={data.context.timezone} />
      {upcoming && <>
        <BusinessMetrics metrics={upcoming.metrics} fields={UPCOMING_FIELDS} comparison={false} />
        {upcoming.days.length ? <BusinessTable rows={upcoming.days.map(day => ({ id: day.date, name: day.date, metrics: day.metrics }))}
          fields={UPCOMING_FIELDS} nameLabel="Service date" caption={`Recorded upcoming ${OW.many} by service date`} kind="day" />
          : <p className={BUSINESS_NOTE_CLASS}>No recorded service-date rows were supplied. Schedule completeness remains unverified.</p>}
        {upcoming.types.length ? <BusinessTable rows={upcoming.types} fields={UPCOMING_FIELDS} nameLabel="Native service" caption={`Recorded upcoming ${OW.many} by service`} />
          : <p className={BUSINESS_NOTE_CLASS}>No recorded upcoming service-type rows were supplied.</p>}
      </>}
    </section>
  </div>
}
