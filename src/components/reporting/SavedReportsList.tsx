'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { readSavedReportList } from '@/lib/reporting/saved-client'
import type { SavedReportSummary } from '@/lib/reporting/saved-contract'
import { ReportingRequestError } from '@/lib/reporting/request-error'
import { savedReportHome } from './SavedReportContext'

export function SavedReportsList() {
  const [reports, setReports] = useState<SavedReportSummary[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false), [error, setError] = useState<string | null>(null)
  const active = useRef<AbortController | null>(null)
  async function load(next: string | null) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setLoading(true); setError(null)
    try {
      const result = await readSavedReportList(next, controller.signal)
      controller.signal.throwIfAborted()
      setReports(previous => next ? [...previous, ...result.reports.filter(report => !previous.some(item => item.id === report.id))] : result.reports)
      setCursor(result.nextCursor); setLoaded(true)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const denied = failure instanceof ReportingRequestError && failure.kind === 'access'
        if (denied) { setReports([]); setLoaded(false); setCursor(null) }
        setError(denied ? 'Your session does not have access to saved reports for this account.' : 'Saved reports could not load. Please retry.')
      }
    } finally { if (active.current === controller) setLoading(false) }
  }
  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => { if (!cancelled) void load(null) })
    return () => { cancelled = true; active.current?.abort() }
  }, [])
  return <div className="mx-auto max-w-5xl space-y-5 text-[var(--text-primary)]">
    <header><h1 className="text-2xl font-semibold">Saved reports</h1><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Reopen the original numbers and assessment for this account. Each report keeps the evidence and source availability it was saved with.</p></header>
    <Link href="/reports" className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] underline">Open current reports</Link>
    {reports.length > 0 && <ul className="space-y-3">{reports.map(report => <li key={report.id} className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
      <Link href={savedReportHome(report)} className="inline-flex min-h-11 items-center break-words text-base font-semibold text-[var(--accent)] underline">{report.title}</Link>
      <p className="text-xs leading-5 text-[var(--text-secondary)]">{report.range.from} – {report.range.to} · Saved {new Date(report.createdAt).toLocaleString()}</p>
      <p className="mt-2 text-xs text-[var(--text-secondary)]">{Object.entries(report.sourceSummary).map(([source, binding]) => `${{ meta: 'Meta', business: 'Outcomes', website: 'GA4', measurement: 'Tracking' }[source]}: ${{ snapshot: 'Evidence saved', retained_snapshot: 'Previous evidence saved', unavailable: 'Unavailable at save', missing: 'Not included' }[binding.state]}`).join(' · ')}</p>
    </li>)}</ul>}
    {loading && <p role="status" className="text-sm">Loading saved reports…</p>}
    {!loading && !error && loaded && reports.length === 0 && <p className="rounded-lg border border-[var(--border)] p-5 text-sm">No saved reports yet. Open a current report and choose “Save this report.”</p>}
    {error && <div role="alert" className="text-sm"><p>{error}</p><button type="button" onClick={() => void load(reports.length ? cursor : null)} disabled={loading} className="mt-2 min-h-11 rounded-md border border-[var(--border)] px-4">Retry saved reports</button></div>}
    {!error && cursor && <button type="button" onClick={() => void load(cursor)} disabled={loading} className="min-h-11 rounded-md border border-[var(--border)] px-4 text-sm">Load more reports</button>}
  </div>
}
