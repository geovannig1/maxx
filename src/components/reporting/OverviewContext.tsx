import { accountCurrency, accountLocale } from '@/config/business-config'
import { currencyFractionDigits } from '@/lib/utils/format-currency'
import Link from 'next/link'
import type { ReportingData, ReportMetricMap } from '@/lib/reporting/contracts'
import { deriveBusinessDrivers, type BusinessDriverRow } from '@/lib/reporting/business-drivers'
import { overviewHref, overviewNumber } from '@/lib/reporting/overview-model'
import { OverviewMetric, OverviewSource } from './OverviewMetric'
import { isBookingLikeOutcome, outcomeWords } from '@/config/outcome-nouns'
import { visibleBusinessFields } from '@/lib/reporting/booking-only-fields'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const linkClass = 'inline-flex min-h-11 items-center text-sm text-[var(--accent)] hover:underline'
const noteClass = 'mt-2 text-sm leading-6 text-[var(--text-secondary)]'
const dollars = (value: number, cents = true) => value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency(),
  minimumFractionDigits: cents ? currencyFractionDigits() : 0, maximumFractionDigits: cents ? currencyFractionDigits() : 0 })
const signed = (value: number | null, unit: 'money' | 'count') => value === null ? 'Change unavailable'
  : value === 0 ? 'No change' : `${value > 0 ? '+' : '−'}${unit === 'money' ? dollars(Math.abs(value)) : Math.abs(value).toLocaleString('en-US')}`
const periodDollars = (value: number | null) => value === null ? 'Unavailable' : dollars(value)
const periodCount = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US')
function compatibleCurrentClaims(rows: BusinessDriverRow[]) {
  const pairs = rows.map(row => ({ value: row.evidence.bookedValue?.metric.current, count: row.evidence.bookings?.metric.current }))
  const anchor = pairs[0]?.value
  const sameObservation = (claim: NonNullable<typeof anchor>) => Boolean(anchor) && claim.source.head === anchor!.source.head
    && claim.source.system === anchor!.source.system && claim.source.role === anchor!.source.role
    && claim.source.evidencePlane === anchor!.source.evidencePlane && claim.asOf === anchor!.asOf
    && claim.setupFingerprint === anchor!.setupFingerprint && claim.window.start === anchor!.window.start
    && claim.window.end === anchor!.window.end && claim.window.timezone === anchor!.window.timezone
    && claim.window.basis === anchor!.window.basis
  return Boolean(anchor) && pairs.every(({ value, count }) => value && count && sameObservation(value) && sameObservation(count)
    && value.entity.id === count.entity.id && value.entity.level === count.entity.level
    && value.coverage.state === 'complete' && count.coverage.state === 'complete'
    && value.coverage.denominator === count.coverage.denominator
    && value.coverage.numerator === value.coverage.denominator && count.coverage.numerator === count.coverage.denominator)
}
function sharedQualification(metrics: ReportMetricMap | undefined, fields: ReadonlyArray<readonly [string, string]>, state: 'partial' | 'settling') {
  const claims = fields.map(([key]) => metrics?.[key]?.current).filter(claim => claim?.availability.state === 'available')
  return claims.length > 0 && claims.every(claim => state === 'partial' ? claim!.coverage.state === 'partial' : claim!.maturity.state === 'settling')
}
function Metrics({ metrics, fields, omitPartial = false, omitSettling = false }: {
  metrics?: ReportMetricMap; fields: ReadonlyArray<readonly [string, string]>; omitPartial?: boolean; omitSettling?: boolean
}) {
  return <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
    {visibleBusinessFields(fields).map(([key, label]) => <OverviewMetric key={key} metric={metrics?.[key]} label={label} omitPartial={omitPartial} omitSettling={omitSettling} />)}
  </div>
}

const customerFields = [
  ['first_observed_customers', 'First observed'], ['prior_booking_customers', `With earlier ${OW.many}`], ['unidentified_bookings', 'Identity unavailable'],
] as const
const upcomingFields = [
  ['recorded_bookings', `Recorded ${OW.many}`], ['booked_value', 'Scheduled booked value'], ['recorded_booked_hours', 'Recorded hours'],
] as const
const responseFields = [
  ['outbound_clicks', 'Outbound clicks'], ['landing_page_views', 'Landing-page views'], ['messaging_conversations_started', 'Message conversations'],
] as const
const paidFields = [
  ['linked_value_bearing_bookings', `Paid-linked ${OW.many}`], ['paid_touch_booking_lag_sample_bookings', 'Usable lag sample'],
] as const

export function OverviewContext({ data, savedId }: { data: ReportingData; savedId?: string | null }) {
  const business = data.business.data, intelligence = business?.intelligence
  const bookingLike = isBookingLikeOutcome()
  const customers = intelligence?.customers.data, lead = intelligence?.leadTime.data, upcoming = intelligence?.upcoming.data
  const drivers = deriveBusinessDrivers(data), aov = drivers.account.current.valuePerBooking
  const services = [...drivers.services].filter(service => service.current.bookedValue !== null).sort((a, b) => {
    const reversal = (row: typeof a) => row.change.bookings !== null && row.change.bookings > 0 && row.change.recordedHours !== null && row.change.recordedHours < 0 ? 1 : 0
    return reversal(b) - reversal(a) || Math.abs(b.change.bookedValue ?? 0) - Math.abs(a.change.bookedValue ?? 0)
      || (b.current.bookedValue ?? 0) - (a.current.bookedValue ?? 0)
  }).slice(0, 3)
  const currentValue = drivers.account.current.bookedValue, currentBookings = drivers.account.current.bookings
  const allServiceValues = drivers.services.map(service => service.current.bookedValue)
  const allServiceBookings = drivers.services.map(service => service.current.bookings)
  const countSum = allServiceBookings.every(value => value !== null) ? allServiceBookings.reduce<number>((sum, value) => sum + value!, 0) : null
  const reconciled = drivers.reconciliation.current.state === 'reconciled' && currentValue !== null && currentBookings !== null
    && allServiceValues.every(value => value !== null) && countSum === currentBookings
    && compatibleCurrentClaims([drivers.account, ...drivers.services])
    && services.every(service => service.current.bookedValue !== null && service.current.bookings !== null)
  const selectedValue = reconciled ? services.reduce((sum, service) => sum + service.current.bookedValue!, 0) : null
  const selectedBookings = reconciled ? services.reduce((sum, service) => sum + service.current.bookings!, 0) : null
  const paid = data.measurement?.data?.paidAssociation, linked = paid?.linked_value_bearing_bookings
  const coverage = linked?.current.coverage
  const canDescribeCoverage = overviewNumber(linked) !== null && coverage?.numerator !== null && coverage?.denominator !== null
    && coverage?.denominator !== undefined && coverage.denominator > 0
  const lagAvailable = overviewNumber(paid?.median_paid_touch_to_booking_lag_days) !== null
    || overviewNumber(paid?.p90_paid_touch_to_booking_lag_days) !== null
  const customerPartial = sharedQualification(customers?.metrics, customerFields, 'partial')
  const upcomingPartial = sharedQualification(upcoming?.metrics, upcomingFields, 'partial')
  const responseSettling = sharedQualification(data.meta.data?.metrics, responseFields, 'settling')
  const paidPartial = sharedQualification(paid, paidFields, 'partial')
  const businessLink = (anchor: string) => `${overviewHref(data.context, '/reports', { report: 'business' }, savedId)}#${anchor}`
  return <div className="grid items-start gap-5 sm:gap-6 xl:grid-cols-2">
    <section aria-label={`${OW.One} economics and outlook`} className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <h2 className="text-xl font-semibold">{OW.One} economics &amp; outlook</h2>
        <Link href={businessLink('business-types')} className={linkClass}>Explore business ↗</Link>
      </div>
      <OverviewSource source={data.business} label={`${OW.Many} · Cohort by ${OW.one} date`} />
      <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3">
        <div><p className="text-sm leading-5 text-[var(--text-secondary)]">Value / eligible {OW.one}</p>
          <details><summary className="inline-flex min-h-11 cursor-pointer items-center text-lg font-semibold tabular-nums underline decoration-dotted underline-offset-4">
            {aov === null ? 'Unavailable' : aov.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })}</summary>
            <p className={noteClass}>Booked value divided by value-bearing {OW.many} from matching, complete outcome evidence. Missing or incompatible inputs leave the average unavailable.</p>
          </details>
        </div>
        {bookingLike && <OverviewMetric metric={business?.metrics.hours_per_recorded_booking} label={`Hours / duration-recorded ${OW.one}`} />}
      </div>
      {bookingLike && <p className={noteClass}>Hours cover recorded {OW.one} durations; missing durations leave a subtotal.</p>}
      <div data-overview-service-changes className="mt-5 border-t border-[var(--border)] pt-4">
        <div className="flex items-center justify-between gap-4"><h3 className="text-sm font-semibold">Largest service changes</h3>
          <Link href={businessLink('business-types')} className={linkClass}>All services ↗</Link></div>
        {services.length ? <ul className="space-y-3 text-sm">{services.map(service => <li key={service.id} className="border-t border-[var(--border)] pt-2 first:border-0 first:pt-0">
          <span className="min-w-0 break-words font-medium">{service.name}{bookingLike && service.change.bookings !== null && service.change.bookings > 0 && service.change.recordedHours !== null && service.change.recordedHours < 0 && <span className="block font-normal text-[var(--text-secondary)]">More {OW.many}, fewer recorded hours</span>}</span>
          <span className="block tabular-nums">Prior {periodDollars(service.prior.bookedValue)} → Current {periodDollars(service.current.bookedValue)} <span className="text-[var(--text-secondary)]">· {signed(service.change.bookedValue, 'money')}</span></span>
          <span className="block tabular-nums text-[var(--text-secondary)]">Prior {periodCount(service.prior.bookings)} → Current {periodCount(service.current.bookings)} {OW.many} · {signed(service.change.bookings, 'count')}</span>
        </li>)}</ul> : <p className={noteClass}>Comparable service value and {OW.one} counts are unavailable.</p>}
        {reconciled ? <div className="mt-3 space-y-1 text-sm tabular-nums text-[var(--text-secondary)]">
          <p>{selectedBookings!.toLocaleString('en-US')} of {currentBookings!.toLocaleString('en-US')} {OW.many} · {dollars(selectedValue!, false)} of {dollars(currentValue!, false)}</p>
          <p>Remaining services · {(currentBookings! - selectedBookings!).toLocaleString('en-US')} {OW.many} · {dollars(currentValue! - selectedValue!, false)}</p>
        </div> : <p className={noteClass}>Reconciliation unavailable: compatible full business totals and complete displayed service inputs are required.</p>}
        <p className={noteClass}>Up to three services with the largest value changes or opposing {OW.one} and hours trends. Categories shown here are a change-ranked subset.</p>
      </div>
      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <h3 className="text-sm font-semibold">Customer history</h3>
        <OverviewSource source={intelligence?.customers} label={`${OW.Many} · Retained customer history`} />
        {customers && <Metrics metrics={customers.metrics} fields={customerFields} omitPartial={customerPartial} />}
        <p className={noteClass}>First observed is not confirmed new. {customers ? `Retained history ${customers.historyFrom ?? '(start unavailable)'} – ${customers.historyTo}.` : 'Retained customer history is unavailable.'}</p>
        <Link href={businessLink('business-customers')} className={linkClass}>New and repeat context ↗</Link>
      </div>
      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <h3 className="text-sm font-semibold">{OW.One} → service date</h3>
        {lead ? <Metrics metrics={lead.metrics} fields={[
          ['median_lead_days', 'Median lead time'], ['p90_lead_days', '90th percentile'], ['dated_bookings', `${OW.Many} with dates`],
        ]} /> : <p className={noteClass}>{OW.One}-to-service timing is unavailable for this selection.</p>}
        <p className={noteClass}>Timing for {OW.many} created in this period; separate from paid-touch conversion lag.</p>
        <Link href={businessLink('business-lead-time')} className={linkClass}>Timing detail ↗</Link>
      </div>
      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <h3 className="text-sm font-semibold">Recorded upcoming demand</h3>
        <OverviewSource source={intelligence?.upcoming} label={upcoming ? `Service dates ${upcoming.range.from} – ${upcoming.range.to}` : 'Upcoming schedule'} />
        {upcoming && <Metrics metrics={upcoming.metrics} fields={upcomingFields} omitPartial={upcomingPartial} />}
        <p className={noteClass}>Retained {OW.many}, including those created before this reporting period. Schedule completeness is unverified; omitted dates do not establish open slots.</p>
        <Link href={businessLink('business-upcoming')} className={linkClass}>Recorded schedule ↗</Link>
      </div>
    </section>
    <section aria-label="After the click" className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <h2 className="text-xl font-semibold">After the click</h2>
        <Link href={overviewHref(data.context, '/reports', { report: 'website' }, savedId)} className={linkClass}>Website journey ↗</Link>
      </div>
      <p className="text-sm leading-5 text-[var(--text-secondary)]">Independent observations of response and {OW.one} evidence.</p>
      <div className="mt-5">
        <h3 className="text-sm font-semibold">Advertising response</h3>
        <OverviewSource source={data.meta} label={`Meta · Selected reporting dates${responseSettling ? ' · Settling' : ''}`} />
        <Metrics metrics={data.meta.data?.metrics} fields={responseFields} omitSettling={responseSettling} />
      </div>
      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <h3 className="text-sm font-semibold">Website behavior</h3>
        <OverviewSource source={data.website} label="GA4 · All website channels" />
        <Metrics metrics={data.website.data?.metrics} fields={[
          ['sessions', 'Sessions'], ['engagement_rate', 'Engagement rate'], ['intent_events', 'Intent events'], ['confirmation_events', 'Confirmation events'],
        ]} />
        <p className={noteClass}>Website events are observed behavior; they are not recorded {OW.one} counts.</p>
      </div>
      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <h3 className="text-sm font-semibold">Paid-{OW.one} evidence</h3>
        <OverviewSource source={data.measurement} label={`First-party paid links · ${OW.One}-created cohort`} />
        <Metrics metrics={paid} fields={paidFields} omitPartial={paidPartial} />
        <p className={noteClass}>{canDescribeCoverage ? `${coverage!.numerator} of ${coverage!.denominator} eligible ${OW.many} carry an observed paid link.` : 'Paid-link coverage is not established for this selection.'} A paid link establishes an association, not payment or causal lift.</p>
        <h4 className="mt-4 text-sm font-semibold">Paid touch → {OW.one}</h4>
        {lagAvailable ? <Metrics metrics={paid} fields={[
          ['median_paid_touch_to_booking_lag_days', 'Median lag'], ['p90_paid_touch_to_booking_lag_days', '90th percentile'],
        ]} /> : <p className={noteClass}>Lag is unmeasured: matched paid-touch and {OW.one} timestamps are unavailable.</p>}
        <p className={noteClass}>The observed linked sample does not establish when a click cohort has fully matured. Recent Meta results may still settle within their attribution window.</p>
        <Link href={`${overviewHref(data.context, '/reports', { report: 'website' }, savedId)}#measurement-evidence`} className={linkClass}>Measurement detail ↗</Link>
      </div>
      <p className="mt-5 border-l-2 border-[var(--border)] pl-4 text-sm leading-6 text-[var(--text-secondary)]">These sources use different populations and clocks. A gap between clicks, website events and linked {OW.many} cannot by itself locate a conversion drop-off.</p>
    </section>
  </div>
}
