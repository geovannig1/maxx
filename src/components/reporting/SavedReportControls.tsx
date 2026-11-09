'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ReportingData } from '@/lib/reporting/contracts'
import { SAVED_VIEW_KEYS, SavedViewSchema, SavedReportError, type SavedReportSources, type SaveReportingReportInput } from '@/lib/reporting/saved-contract'
import { ReportingRequestError } from '@/lib/reporting/request-error'
import { deriveExpertReview } from '@/lib/reporting/review'
import { savedReportIdentity } from '@/lib/reporting/saved-identity'
import { createSavedReport } from '@/lib/reporting/saved-client'
import { savedReportHome } from './SavedReportContext'

export function SavedReportControls({ data, sources, reason }: {
  data: ReportingData | null; sources: SavedReportSources | null; reason: string | null
}) {
  const pathname = usePathname(), search = useSearchParams().toString(), router = useRouter()
  const [title, setTitle] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const active = useRef<AbortController | null>(null)
  const attempt = useRef<{ key: string; requestId: string } | null>(null)
  useEffect(() => () => { active.current?.abort() }, [data, sources, pathname, search])
  const suggested = data ? `Results ${data.context.range.from} – ${data.context.range.to}` : 'Selected report'
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!data || !sources || busy) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError(null)
    try {
      const query = Object.fromEntries([...new URLSearchParams(search)].filter(([key]) => (SAVED_VIEW_KEYS as readonly string[]).includes(key)))
      const first = Object.values(sources).find(binding => 'receipt' in binding)
      if (first && 'receipt' in first) {
        query.from ??= first.receipt.scope.requestedRange.from
        query.to ??= first.receipt.scope.requestedRange.to
      }
      const view = SavedViewSchema.parse({ pathname, query, ...(window.location.hash ? { hash: window.location.hash } : {}) })
      const reviewIdentity = await savedReportIdentity(deriveExpertReview(data))
      const body = { title: title.trim() || suggested, view, sources, reviewIdentity }
      const key = await savedReportIdentity(body)
      controller.signal.throwIfAborted()
      if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID() }
      const input: SaveReportingReportInput = { ...body, requestId: attempt.current.requestId }
      const saved = await createSavedReport(input, controller.signal)
      controller.signal.throwIfAborted()
      router.push(savedReportHome(saved.saved))
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof SavedReportError || failure instanceof ReportingRequestError
        ? failure.message : 'The report could not be saved. Please retry.')
    } finally { if (active.current === controller) setBusy(false) }
  }
  return <section aria-label="Report actions" className="print:hidden flex flex-wrap items-start gap-x-5 text-sm">
    <details className="min-w-0 flex-1">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-[var(--accent)] underline">Save report</summary>
    <form onSubmit={save} className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] p-3">
      <label className="min-w-0 flex-1 basis-48"><span className="mb-1 block text-xs text-[var(--text-secondary)]">Report name</span>
        <input aria-label="Report name" value={title} placeholder={suggested} maxLength={120} onChange={event => setTitle(event.target.value)}
          className="min-h-11 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3" /></label>
      <button type="submit" disabled={!data || !sources || busy} className="min-h-11 rounded-md bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)] disabled:opacity-50">{busy ? 'Saving…' : 'Save this report'}</button>
    </form>
    <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">{reason ?? 'Save these numbers, source availability and the original assessment together. New source updates will not change this report.'}</p>
    {error && <p role="alert" className="mt-2 text-sm break-words">{error}</p>}
    </details>
    <Link href="/reports/saved" className="inline-flex min-h-11 items-center text-[var(--accent)] underline">Saved reports</Link>
  </section>
}
