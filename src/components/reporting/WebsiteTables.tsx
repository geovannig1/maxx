'use client'

import { useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import type { WebsiteReport, WebsiteRow, WebsiteEventRow, ReportingContext } from '@/lib/reporting/contracts'
import { websiteRowAnchor, websiteEventAnchor } from '@/lib/reporting/website-identity'
import { ReportMetricValue } from './MetricValue'

const KEYS = ['website_q', 'website_page', 'website_device', 'website_channel', 'website_event'] as const
const CONTROL = 'min-h-11 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-primary)]'

export function selectedWebsiteRows(report: WebsiteReport, params: URLSearchParams) {
  const query = (params.get('website_q') ?? '').trim().toLocaleLowerCase()
  const common = (row: WebsiteRow | WebsiteEventRow) => (!params.get('website_device') || row.device === params.get('website_device'))
    && (!params.get('website_channel') || row.channel === params.get('website_channel'))
  const text = (values: string[]) => !query || values.some(value => value.toLocaleLowerCase().includes(query))
  return {
    rows: report.rows.filter(row => common(row) && (!params.get('website_page') || row.landingPage === params.get('website_page'))
      && text([row.landingPage, row.device, row.channel])),
    events: report.events.filter(row => common(row) && (!params.get('website_event') || row.name === params.get('website_event'))
      && text([row.name, row.device, row.channel])),
  }
}

export function WebsiteTables({ report, context }: { report: WebsiteReport; context: ReportingContext }) {
  const path = usePathname() ?? '/reports', search = useSearchParams(), searchKey = search?.toString() ?? ''
  const params = new URLSearchParams(searchKey)
  const selected = selectedWebsiteRows(report, params)
  useEffect(() => {
    let frame = 0
    const scroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const id = window.location.hash.slice(1)
        if (id.startsWith('website-')) document.getElementById(id)?.scrollIntoView({ block: 'start' })
      })
    }
    scroll()
    window.addEventListener('hashchange', scroll)
    window.addEventListener('popstate', scroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('hashchange', scroll)
      window.removeEventListener('popstate', scroll)
    }
  }, [report, searchKey])
  const update = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    const href = `${path}${next.size ? `?${next}` : ''}${window.location.hash}`
    if (replace) window.history.replaceState(null, '', href)
    else window.history.pushState(null, '', href)
  }
  const select = (label: string, key: typeof KEYS[number], values: string[]) => {
    const options = [...new Set(values)].sort(), value = params.get(key) ?? ''
    return <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]">{label}
      <select aria-label={label} className={CONTROL} value={value} onChange={event => update({ [key]: event.target.value })}>
        <option value="">All</option>
        {value && !options.includes(value) && <option value={value}>Not in supplied rows: {value}</option>}
        {options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  }
  return <div className="mt-5 space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 print:hidden">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]">Search website rows
        <input aria-label="Search website rows" type="search" className={CONTROL} value={params.get('website_q') ?? ''}
          placeholder="Page, device, channel or event" onChange={event => update({ website_q: event.target.value }, true)} />
      </label>
      {select('Landing page filter', 'website_page', report.rows.map(row => row.landingPage))}
      {select('Device filter', 'website_device', [...report.rows, ...report.events].map(row => row.device))}
      {select('Channel filter', 'website_channel', [...report.rows, ...report.events].map(row => row.channel))}
      {select('Event filter', 'website_event', report.events.map(row => row.name))}
      <button type="button" className={`${CONTROL} self-end`} onClick={() => update(Object.fromEntries(KEYS.map(key => [key, null])))}>Clear website filters</button>
    </div>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">
      Current: {context.range.from}–{context.range.to}. Previous: {context.comparison.from}–{context.comparison.to}. {context.timezone}.
      {' '}Filters apply to these tables; account summaries and full CSV retain the complete supplied report.
      {' '}The page filter scopes page rows; the event filter scopes event rows. Events have no page identity here.
      {' '}Rows present in only one period retain an unavailable value for the other period.
    </p>
    {KEYS.some(key => params.get(key)) && <p className="break-words text-xs text-[var(--text-secondary)]">
      Selected filters: {KEYS.filter(key => params.get(key)).map(key => `${key.replace('website_', '')}: ${params.get(key)}`).join(' · ')}
    </p>}
    <div id="website-pages" className="scroll-mt-24 overflow-x-auto print:overflow-visible">
      <table className="w-full min-w-[880px] border-collapse text-left text-xs print:min-w-0 print:table-fixed print:text-[9px]" aria-label="Landing pages by device and channel">
        <caption className="mb-2 text-left text-sm font-semibold text-[var(--text-primary)]">
          Landing pages by device and channel <span className="font-normal text-[var(--text-secondary)]">· {selected.rows.length} of {report.rows.length} supplied rows</span>
        </caption>
        <thead><tr className="border-b border-[var(--border)]">
          {['Landing page', 'Device', 'Channel', 'Sessions', 'Engaged sessions', 'Engagement rate', 'Users', 'Page views'].map(label =>
            <th key={label} className="break-words px-2 py-2 font-semibold text-[var(--text-secondary)]">{label}</th>)}
        </tr></thead>
        <tbody>{selected.rows.map(row => <tr key={row.id} id={websiteRowAnchor(row)} className="scroll-mt-24 border-b border-[var(--border)] target:bg-[var(--bg-subtle)]">
          <th scope="row" className="break-all px-2 py-3 font-medium text-[var(--text-primary)]">{row.landingPage}</th>
          <td className="break-words px-2 py-3">{row.device}</td><td className="break-words px-2 py-3">{row.channel}</td>
          {['sessions', 'engaged_sessions', 'engagement_rate', 'users', 'page_views'].map(key =>
            <td key={key} className="px-2 py-3 align-top"><ReportMetricValue metric={row.metrics[key]} compact /></td>)}
        </tr>)}</tbody>
      </table>
      {!selected.rows.length && <p role="status" className="py-4 text-sm text-[var(--text-secondary)]">{report.rows.length ? 'No landing-page rows match these filters.' : 'No landing-page rows were supplied.'}</p>}
    </div>
    <div id="website-events" className="scroll-mt-24 overflow-x-auto print:overflow-visible">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs print:min-w-0 print:table-fixed print:text-[9px]" aria-label="Observed website events">
        <caption className="mb-2 text-left text-sm font-semibold text-[var(--text-primary)]">
          Observed website events <span className="font-normal text-[var(--text-secondary)]">· {selected.events.length} of {report.events.length} supplied rows</span>
        </caption>
        <thead><tr className="border-b border-[var(--border)]">
          {['Event', 'Device', 'Channel', 'Event count'].map(label => <th key={label} className="px-2 py-2 font-semibold text-[var(--text-secondary)]">{label}</th>)}
        </tr></thead>
        <tbody>{selected.events.map(event => <tr key={websiteEventAnchor(event)} id={websiteEventAnchor(event)} className="scroll-mt-24 border-b border-[var(--border)] target:bg-[var(--bg-subtle)]">
          <th scope="row" className="break-all px-2 py-3 font-medium text-[var(--text-primary)]">{event.name}</th>
          <td className="break-words px-2 py-3">{event.device}</td><td className="break-words px-2 py-3">{event.channel}</td>
          <td className="px-2 py-3"><ReportMetricValue metric={event.metrics.event_count} compact /></td>
        </tr>)}</tbody>
      </table>
      {!selected.events.length && <p role="status" className="py-4 text-sm text-[var(--text-secondary)]">{report.events.length ? 'No event rows match these filters.' : 'No named-event rows were supplied.'}</p>}
    </div>
  </div>
}
