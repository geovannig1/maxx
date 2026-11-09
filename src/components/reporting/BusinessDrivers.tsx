'use client'
import { accountCurrency, accountLocale } from '@/config/business-config'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import type { ReportingData } from '@/lib/reporting/contracts'
import { deriveBusinessDrivers, type BusinessDriverRow } from '@/lib/reporting/business-drivers'
import { isBookingLikeOutcome, outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const panel = 'min-w-0 scroll-mt-24 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 sm:p-6'
const note = 'mt-3 text-xs leading-5 text-[var(--text-secondary)]'
const number = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
const money = (value: number | null) => value === null ? 'Unavailable' : new Intl.NumberFormat(accountLocale(), { style: 'currency', currency: accountCurrency() }).format(value)
const signedMoney = (value: number | null) => value === null ? 'Unavailable' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value))}`

function volumeValueContrast(row: BusinessDriverRow): string {
  if (row.decomposition.state !== 'matched' || row.change.bookedValue === null) return ''
  const count = row.change.bookings!, mean = row.change.valuePerBooking!
  const offset = row.change.bookedValue >= 0 ? 'offsets' : 'partly offsets'
  if (count < 0 && mean > 0) return `Higher value per ${OW.one} ${offset} fewer ${OW.many}.`
  if (count > 0 && mean < 0) return `${OW.One} growth ${offset} lower value per ${OW.one}.`
  if (count > 0 && mean > 0) return `Both ${OW.one} count and value per ${OW.one} increased.`
  if (count < 0 && mean < 0) return `Both ${OW.one} count and value per ${OW.one} decreased.`
  return ''
}

function DriverInputs({ row }: { row: BusinessDriverRow }) {
  const fields = isBookingLikeOutcome() ? ['bookedValue', 'bookings', 'recordedHours'] as const : ['bookedValue', 'bookings'] as const
  return <details className="mt-3 text-xs print:hidden">
    <summary className="min-h-11 cursor-pointer py-3 font-medium">Native calculation inputs</summary>
    <div className="space-y-4 border-l border-[var(--border)] pl-3">
      {fields.map(key => {
        const ref = row.evidence[key]
        const format = key === 'bookedValue' ? money : number
        return <div key={key} className="min-w-0">
          <p className="font-medium">{key === 'bookedValue' ? 'Booked value' : key === 'bookings' ? `Positive-price ${OW.many}` : 'Recorded booked hours'}</p>
          <p>Previous: {format(row.prior[key])} · Selected: {format(row.current[key])}</p>
          {ref && <>
            <p className="mt-2">Source observed {ref.sourceAsOf ?? 'time unavailable'}.</p>
            <p className="mt-2 break-all text-[var(--text-secondary)]">{ref.path}</p>
            <p className="mt-2 break-all text-[var(--text-secondary)]">Selected claim: {ref.metric.current.claimId}. Previous claim: {ref.metric.previous?.claimId ?? 'not supplied'}.</p>
          </>}
        </div>
      })}
      <p>Only compatible numeric inputs are shown. A supplied reference does not make a rejected period usable; coverage limits remain with the calculation.</p>
    </div>
  </details>
}

function Arithmetic({ row }: { row: BusinessDriverRow }) {
  const split = row.decomposition
  return <details data-business-calculation className="mt-2 text-xs">
    <summary className="min-h-11 cursor-pointer py-3 font-medium">Inspect the calculation</summary>
    <div className="space-y-2 leading-5">
      <p>Positive-price {OW.many}: {number(row.prior.bookings)} → {number(row.current.bookings)}.</p>
      <p>Value per {OW.one}: {money(row.prior.valuePerBooking)} → {money(row.current.valuePerBooking)}.</p>
      {split.state === 'matched' ? <>
        <p>{OW.One}-count component: {signedMoney(split.bookingCount)}.</p>
        <p>Value-per-{OW.one} component: {signedMoney(split.valuePerBooking)}.</p>
      </> : <p>{split.state === 'current_only' ? `${OW.Many} occur only in the selected period.`
        : split.state === 'prior_only' ? `${OW.Many} occur only in the previous period.`
          : split.state === 'empty' ? `Neither period contains positive-price ${OW.many}.`
            : 'Compatible count and value inputs are unavailable for this split.'} A period without {OW.many} has no average {OW.one} value.</p>}
      {isBookingLikeOutcome() && <p>Recorded hours: {number(row.prior.recordedHours)} → {number(row.current.recordedHours)}.
        {' '}A matched change requires complete duration coverage in both periods.</p>}
      {row.limitations.map((text, index) => <p key={index} className="text-[var(--text-secondary)]">{text}</p>)}
      <DriverInputs row={row} />
    </div>
  </details>
}

export function BusinessDrivers({ data, detail = false }: { data: ReportingData; detail?: boolean }) {
  const search = useSearchParams()
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!detail) return
    let opened: HTMLDetailsElement[] = []
    const restore = () => { opened.forEach(element => { element.open = false }); opened = [] }
    const prepare = () => {
      restore()
      opened = [...section.current?.querySelectorAll<HTMLDetailsElement>('details[data-business-calculation]:not([open])') ?? []]
      opened.forEach(element => { element.open = true })
    }
    window.addEventListener('beforeprint', prepare)
    window.addEventListener('afterprint', restore)
    return () => { window.removeEventListener('beforeprint', prepare); window.removeEventListener('afterprint', restore); restore() }
  }, [detail])
  const drivers = deriveBusinessDrivers(data)
  const params = new URLSearchParams(search?.toString() ?? '')
  params.set('from', data.context.range.from)
  params.set('to', data.context.range.to)
  params.set('report', 'business')
  const detailHref = `/reports?${params}#business-drivers`
  const serviceHref = (id: string) => {
    const query = new URLSearchParams(params)
    query.set('business_q', id)
    return `/reports?${query}#business-service-${encodeURIComponent(id)}`
  }
  const account = drivers.account
  const valid = drivers.services.filter(row => row.change.bookedValue !== null)
  const decreases = valid.filter(row => row.change.bookedValue! < 0).sort((a, b) => a.change.bookedValue! - b.change.bookedValue!)
  const increases = valid.filter(row => row.change.bookedValue! > 0).sort((a, b) => b.change.bookedValue! - a.change.bookedValue!)
  const reconciled = drivers.reconciliation.current.state === 'reconciled' && drivers.reconciliation.prior.state === 'reconciled'
  const rows = [...drivers.services].sort((a, b) => Number(b.change.bookedValue !== null) - Number(a.change.bookedValue !== null)
    || Math.abs(b.change.bookedValue ?? 0) - Math.abs(a.change.bookedValue ?? 0) || a.id.localeCompare(b.id))
  return <section ref={section} id="business-drivers" aria-label="What explains booked value" className={panel}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-xl font-semibold">What explains booked value</h2>
      {!detail && <Link href={detailHref} className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--accent)] underline underline-offset-4">Explore booked-value drivers</Link>}
    </div>
    <p className={note}>{OW.Many} · All sources · {OW.One} dates {data.context.range.from} – {data.context.range.to} versus {data.context.comparison.from} – {data.context.comparison.to} · {data.context.timezone}.</p>
    <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {[['Previous booked value', money(account.prior.bookedValue)], ['Selected booked value', money(account.current.bookedValue)],
        ['Booked-value change', signedMoney(account.change.bookedValue)], [`Positive-price ${OW.many}`, `${number(account.prior.bookings)} → ${number(account.current.bookings)}`]].map(([label, value]) =>
        <div key={label} className="min-w-0"><p className="text-xs leading-5 text-[var(--text-secondary)]">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p></div>)}
    </div>
    <p className="mt-4 text-sm leading-6">Value per positive-price {OW.one}: {money(account.prior.valuePerBooking)} → {money(account.current.valuePerBooking)}.
      {' '}{volumeValueContrast(account)}</p>
    <p className="mt-4 text-sm leading-6" role="status">{valid.length} of {drivers.services.length} services have a comparable booked-value change.
      {' '}{reconciled ? 'Service values reconcile to the account total in both periods.' : 'The supplied service values do not establish a complete explanation of the account change.'}</p>
    {(increases.length > 0 || decreases.length > 0) && <p className="mt-2 text-sm leading-6">
      {increases[0] && <>Largest measured increase: {increases[0].name}, {signedMoney(increases[0].change.bookedValue)}. </>}
      {decreases[0] && <>Largest measured decrease: {decreases[0].name}, {signedMoney(decreases[0].change.bookedValue)}. </>}
      {increases.length > 0 && decreases.length > 0 && 'Gains and losses offset; the net change does not describe every service.'}
    </p>}
    {detail && <>
      <p className={note}>All supplied service contributors are shown below. Service-table search does not filter this explanation. Booked value is scheduled price; recorded payments remain separate.</p>
      <div role="region" aria-label="Booked-value contributors, scroll for columns" tabIndex={0} className="mt-4 overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[740px] table-fixed text-left text-sm print:min-w-0 print:text-xs">
          <caption className="mb-2 text-left text-xs text-[var(--text-secondary)]">Every supplied service, ordered by the size of its measured booked-value change</caption>
          <thead><tr className="border-b border-[var(--border)] text-xs text-[var(--text-secondary)]">
            <th scope="col" className="w-[40%] px-2 py-3">Service and explanation</th>
            {['Previous booked value', 'Selected booked value', 'Change'].map(label => <th key={label} scope="col" className="px-2 py-3 text-right font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{rows.map((row, index) => <tr key={`${row.id}:${index}`} data-business-driver={row.id} className="border-b border-[var(--border)] align-top print:break-inside-avoid">
            <th scope="row" className="break-words px-2 py-3 font-normal">
              <Link href={serviceHref(row.id)} className="inline-flex min-h-11 items-center font-medium text-[var(--accent)] underline underline-offset-4">{row.name}</Link>
              <p className="break-all text-xs text-[var(--text-secondary)]">Service ID: {row.id}</p>
              <Arithmetic row={row} />
            </th>
            <td className="px-2 py-4 text-right tabular-nums">{money(row.prior.bookedValue)}</td>
            <td className="px-2 py-4 text-right tabular-nums">{money(row.current.bookedValue)}</td>
            <td className="px-2 py-4 text-right font-medium tabular-nums">{signedMoney(row.change.bookedValue)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <details data-business-calculation className="mt-4 text-xs leading-5">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">How the explanation is calculated</summary>
        <p>Previous service sum: {money(drivers.reconciliation.prior.serviceSum)}; account: {money(drivers.reconciliation.prior.headline)}; difference: {signedMoney(drivers.reconciliation.prior.residual)}.</p>
        <p className="mt-2">Selected service sum: {money(drivers.reconciliation.current.serviceSum)}; account: {money(drivers.reconciliation.current.headline)}; difference: {signedMoney(drivers.reconciliation.current.residual)}.</p>
        <p>Each service contributes its selected booked value minus previous booked value. For a service with {OW.many} in both periods, the {OW.one}-count component is the count change multiplied by the average of the two period means. The value-per-{OW.one} component is the mean-value change multiplied by the average of the two {OW.one} counts. The two components sum to that service’s booked-value change.</p>
        <p className="mt-2">This arithmetic describes observed volume and value, including changing {OW.many} within a service. It does not isolate a price change, a between-service mix effect or the effect of advertising. A service present in only one period keeps its whole contribution.</p>
      </details>
    </>}
    {drivers.limitations.map((text, index) => <p key={index} className={note}>{text}</p>)}
    <p className={note}>Source observed {drivers.sourceAsOf ?? 'time unavailable'}. These are the current ledger’s observations for the two {OW.one}-created periods.</p>
  </section>
}
