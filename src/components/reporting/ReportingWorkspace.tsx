'use client'

import { CheckCircle2, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { REPORT_SOURCES, useReportingData } from '@/lib/reporting/use-reporting-data'
import { ReportContext } from './ReportContext'
import { OverviewReport } from './OverviewReport'
import { AdsReport } from './AdsReport'
import { CreativeReport } from './CreativeReport'
import { ReportsReport } from './ReportsReport'
import { SAVED_SOURCE_MESSAGES } from '@/lib/reporting/saved-contract'
import { SavedReportProvider, savedReportHome } from './SavedReportContext'
import { SavedReportControls } from './SavedReportControls'
import './reporting-print.css'
import { accountTimezone } from '@/config/business-config'
import { outcomeWords } from '@/config/outcome-nouns'
import { accountTimezoneShortName } from '@/config/timezone-label'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const names = { meta: 'Meta advertising', business: `${OW.One} records`, website: 'GA4 website', measurement: `${OW.One} links & tracking` }
type ReportingTrustSource = { label: string; state: string; asOf: string | null }

export function reportingTrustRecency(sources: readonly ReportingTrustSource[]): string {
  return sources.map(({ label, state, asOf }) => {
    if (!asOf) return `${label} ${state}`
    const parsed = new Date(asOf)
    const day = Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: accountTimezone() })
      : asOf
    if (state === 'refresh failed') {
      const retainedAt = Number.isFinite(parsed.getTime())
        ? `${day}, ${parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: accountTimezone() })} ${accountTimezoneShortName()}`
        : asOf
      return `${label} · refresh failed · retained ${retainedAt}`
    }
    return state === 'available' ? `${label} ${day}` : `${label} ${day} (${state})`
  }).join(' · ')
}

export interface ReportingSourceNoteGroup {
  key: 'dynamic_assets' | 'configured_preview' | 'playback_duration' | 'other'
  title: string
  consequence: string
  entityIds: string[]
  notes: string[]
}

const sourceNoteKinds = [
  { key: 'dynamic_assets' as const, title: 'Dynamic asset ambiguity',
    consequence: 'Ad totals cannot identify one asset’s performance.', pattern: /^Creative ([A-Za-z0-9_-]+) has multiple dynamic assets;/ },
  { key: 'configured_preview' as const, title: 'Configured story-video previews',
    consequence: 'The readable preview does not establish delivered combinations or assign results to that member.', pattern: /^Creative ([A-Za-z0-9_-]+) configured story-video preview uses exact readable member / },
  { key: 'playback_duration' as const, title: 'Playback or duration unavailable',
    consequence: 'Thumbnail and metrics remain available, while playback or duration evidence is unavailable.', pattern: /^Video playback or duration unavailable for creative ([A-Za-z0-9_-]+);/ },
] as const
const sourceNoteEntityId = (note: string, pattern: RegExp) => {
  const id = note.match(pattern)?.[1]
  if (!id) return undefined
  const time = Date.parse(`${id}T00:00:00Z`)
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(id) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === id
  return isoDate ? undefined : id
}

export function groupReportingSourceNotes(input: readonly string[]): ReportingSourceNoteGroup[] {
  const notes = [...new Set(input)]
  const classified = notes.map(note => ({ note, match: sourceNoteKinds.map(kind => ({ kind, id: sourceNoteEntityId(note, kind.pattern) }))
    .find(result => result.id) }))
  const groups: ReportingSourceNoteGroup[] = sourceNoteKinds.flatMap(kind => {
    const members = classified.filter(item => item.match?.kind.key === kind.key)
    return members.length ? [{ key: kind.key, title: kind.title, consequence: kind.consequence,
      entityIds: [...new Set(members.map(item => item.match!.id!))].sort(), notes: members.map(item => item.note) }] : []
  })
  const other = classified.filter(item => !item.match).map(item => item.note)
  return other.length ? [...groups, { key: 'other', title: 'Other source notes',
    consequence: 'Review the original source detail; no supported issue template or entity identity was inferred.', entityIds: [], notes: other }] : groups
}

export function ReportingSourceNotes({ notes }: { notes: readonly string[] }) {
  const groups = groupReportingSourceNotes(notes)
  if (!groups.length) return null
  return <div className="pb-2 text-xs leading-5 text-[var(--text-secondary)]">
    <ul className="space-y-2">{groups.map(group => <li key={group.key} className="break-words">
      <p><span className="font-medium text-[var(--text-primary)]">{group.title}</span> · {group.entityIds.length
        ? `${group.entityIds.length} affected ${group.entityIds.length === 1 ? 'entity' : 'entities'}` : 'affected entities not identified'}</p>
      <p>{group.consequence}</p>
      <details className="mt-1"><summary className="inline-flex min-h-11 cursor-pointer items-center underline decoration-dotted underline-offset-4">Affected IDs and original notes</summary>
        {group.entityIds.length > 0 && <p>Creative IDs: {group.entityIds.join(', ')}</p>}
        <ul className="list-disc space-y-1 pl-4">{group.notes.map(note => <li key={note}>{note}</li>)}</ul>
      </details>
    </li>)}</ul>
    {groups.length > 1 && <p className="mt-2">Issue groups may overlap; each count is unique within its group.</p>}
  </div>
}

/**
 * The collapsed Trust line. `structuralPartial` counts partial sources whose partiality is the
 * source's design rather than a failed read: the Tracking section is an observed lower bound by
 * construction (no exact-window linker manifest exists), so a successful read is always `partial`.
 * When every partial source is structural and none is unavailable, the line says so positively
 * instead of reading as a fault forever.
 */
export function reportingSourceSummary(unavailable: number, pending: boolean, partial: number, allAvailable: boolean,
  totalSources: number = REPORT_SOURCES.length, structuralPartial = 0) {
  const sources = `${totalSources} source${totalSources === 1 ? '' : 's'}`
  return unavailable ? `${unavailable} source${unavailable === 1 ? ' needs' : 's need'} attention`
    : pending ? 'Updating evidence…'
    : partial && partial > structuralPartial ? `${partial} of ${sources} partial`
    : partial ? `All ${sources} reporting · Tracking is a lower bound`
    : allAvailable ? `All ${sources} healthy` : 'Evidence incomplete'
}

/** True when the summary above is the all-clear (every source reporting, nothing needing attention). */
export function reportingSourcesHealthy(summary: string): boolean {
  return summary.startsWith('All ')
}

export function ReportingWorkspace({ view }: { view: 'overview' | 'ads' | 'creative' | 'reports' }) {
  const { data, errors, pending, accessDenied, retry, retryAll, ready, notes, sources, saveReason, saved, savedId, savedError } = useReportingData()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const frozen = typeof savedId === 'string'
  const failed = REPORT_SOURCES.every(source => errors[source] && !pending[source])
  const currentQuery = new URLSearchParams(search)
  currentQuery.delete('saved')
  if (data && frozen) { currentQuery.set('from', data.context.range.from); currentQuery.set('to', data.context.range.to) }
  const currentHref = `${pathname}${currentQuery.size ? `?${currentQuery}` : ''}`
  const selectedAd = currentQuery.get('ad')
  const savedMeta = saved?.saved.sources.meta
  const missingAdHistory = saved && selectedAd && (!savedMeta || !('receipt' in savedMeta) || !savedMeta.receipt.scope.detailIds.includes(selectedAd))
  const unavailableSources = REPORT_SOURCES.filter(source => errors[source] || data?.[source]?.state === 'unavailable')
  const partialSources = REPORT_SOURCES.filter(source => data?.[source]?.state === 'partial')
  // Tracking's paid-association read is a lower bound by design; partial with no issue note is that design.
  const structuralPartial = partialSources.filter(source => source === 'measurement' && !errors[source] && (data?.[source]?.notes.length ?? 0) === 0).length
  const sourceSummary = reportingSourceSummary(unavailableSources.length, REPORT_SOURCES.some(source => pending[source]), partialSources.length,
    REPORT_SOURCES.every(source => data?.[source]?.state === 'available'), REPORT_SOURCES.length, structuralPartial)
  const sourcesHealthy = reportingSourcesHealthy(sourceSummary)
  const sourceRecency = reportingTrustRecency(REPORT_SOURCES.map(source => {
    const binding = saved?.saved.sources[source]
    const section = data?.[source]
    const asOf = section?.asOf ?? (binding && 'receipt' in binding ? binding.receipt.sourceAsOf : null)
    const state = binding?.state === 'missing' ? 'not included'
      : !frozen && errors[source] && section?.data ? 'refresh failed'
      : errors[source] && !section?.data ? 'unavailable'
      : section?.state ?? 'loading'
    return { label: { meta: 'Meta', business: 'Outcomes', website: 'GA4', measurement: 'Tracking' }[source], state, asOf }
  }))
  const sourceControls = <div className={view === 'overview' ? 'space-y-3 rounded-lg border border-[var(--border)] p-3' : undefined}>
    <div aria-label="Reporting source status" className={view === 'overview' ? 'grid w-full min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-1 sm:flex sm:w-auto sm:flex-wrap' : 'grid grid-cols-2 gap-2 xl:grid-cols-4'}>
      {REPORT_SOURCES.map(source => {
        const section = data?.[source]
        const error = errors[source]
        const binding = saved?.saved.sources[source]
        const retained = Boolean(section?.data)
        const detailsLoading = source === 'meta' && data?.meta.data?.detailState === 'loading'
        const detailsUnavailable = source === 'meta' && data?.meta.data?.detailState === 'unavailable'
        const state = error && !retained ? 'unavailable' : section?.state ?? 'loading'
        const label = binding?.state === 'retained_snapshot' ? 'Saved previous evidence' : binding?.state === 'missing' ? 'Not included'
          : pending[source] && retained ? detailsLoading ? 'Details loading…' : 'Refreshing…' : error && retained ? 'Refresh failed'
          : detailsUnavailable ? 'Details unavailable'
          : state === 'loading' ? 'Loading…' : state === 'available' ? 'Available' : state === 'partial' ? 'Partial evidence' : 'Unavailable'
        return <div key={source} className={view === 'overview' ? 'flex min-w-0 items-start' : 'flex min-w-0 items-start rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1 sm:px-3'}>
          <details data-reporting-source className="min-w-0 flex-1"><summary className={`min-h-11 cursor-pointer items-center ${view === 'overview' ? 'text-sm' : 'text-xs'} inline-flex flex-wrap gap-x-2`} aria-label={`${names[source]} source details`}><span className="font-semibold">{view === 'overview' ? { meta: 'Meta', business: 'Outcomes', website: 'GA4', measurement: 'Tracking' }[source] : names[source]}</span><span className="text-[var(--text-secondary)] underline decoration-dotted" role="status">{label}</span></summary>
            {section?.asOf && <p className="pb-2 break-words text-xs text-[var(--text-secondary)]">Evidence as of {section.asOf}</p>}
            {binding?.state === 'retained_snapshot' && <p className="pb-2 text-xs">At save time: {SAVED_SOURCE_MESSAGES[binding.code]}</p>}
            {detailsLoading && pending[source] && <p className="pb-2 text-xs">Validated totals are available. Creative details, configuration and trends are still loading.</p>}
            {retained && (error || pending[source] && !detailsLoading) && <p className="pb-2 text-xs">Showing the previous report while fresh data is unavailable.</p>}
            <ReportingSourceNotes notes={[...(error ? [error] : []), ...(section?.notes ?? [])]} />
          </details>
          {!frozen && <button type="button" aria-label={`Refresh ${names[source]}`} onClick={() => retry(source)} disabled={!ready || pending[source] || state === 'loading'} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-[var(--bg-subtle)] disabled:opacity-40 print:hidden"><RefreshCw size={14} aria-hidden="true" /></button>}
        </div>
      })}
    </div>
    {!frozen && view === 'overview' && <div className="min-w-0"><SavedReportControls data={data} sources={sources} reason={saveReason} /></div>}
    </div>
  return <SavedReportProvider value={saved}><div data-reporting-workspace className={view === 'overview' ? 'space-y-3 text-[var(--text-primary)]' : 'space-y-5 text-[var(--text-primary)]'}>
    {frozen && <section aria-label="Saved report" className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 text-sm">
      <p className="font-semibold break-words">{saved ? saved.saved.title : 'Saved report'}</p>
      {saved && <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">Saved {new Date(saved.saved.createdAt).toLocaleString()}. Original evidence and assessment remain fixed across investigations.</p>}
      <div className="mt-2 flex flex-wrap gap-x-4 print:hidden">
        {saved && <Link href={savedReportHome(saved.saved)} className="inline-flex min-h-11 items-center underline text-[var(--accent)]">Original saved view</Link>}
        <Link href="/reports/saved" className="inline-flex min-h-11 items-center underline text-[var(--accent)]">Saved reports</Link>
        <Link href={currentHref} className="inline-flex min-h-11 items-center underline text-[var(--accent)]">Open current report</Link>
      </div>
    </section>}
    {view === 'overview' ? <div className="flex flex-wrap items-start gap-x-5 gap-y-1">
      <div className="min-w-0 flex-1 basis-[600px]"><ReportContext context={data?.context ?? null} failed={failed} frozen={frozen} compact /></div>
    <details id="reporting-trust" open={failed || undefined} className="group min-w-0 basis-auto max-w-full scroll-mt-4" data-overview-sources>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 text-sm text-[var(--text-secondary)]">
        <span className="font-medium">Trust</span><span role="status" data-sources-healthy={sourcesHealthy || undefined} className={sourcesHealthy ? 'inline-flex items-center gap-1 font-medium text-[var(--success)]' : undefined}>{sourcesHealthy && <CheckCircle2 size={14} aria-hidden="true" />}{sourceSummary}</span><span className="basis-full text-xs sm:basis-auto">Evidence: {sourceRecency}</span><span aria-hidden="true" className="text-[var(--accent)]">⌄</span>
      </summary>
    {sourceControls}
    </details>
    </div> : <ReportContext context={data?.context ?? null} failed={failed} frozen={frozen} />}
    {!frozen && view !== 'overview' && <SavedReportControls data={data} sources={sources} reason={saveReason} />}
    {notes.map(note => <p key={note} role="status" className={view === 'overview' ? 'text-sm leading-5 text-[var(--text-secondary)]' : 'rounded-lg border border-[var(--border)] p-3 text-sm'}>{note}</p>)}
    {missingAdHistory && <p role="status" className="rounded-lg border border-[var(--border)] p-3 text-sm">Additional daily history and placement breakdowns for this ad were not included in the saved report. Available period metrics remain below. Open the current report to request new detail.</p>}
    {view !== 'overview' && <section id="reporting-trust" className="scroll-mt-4" aria-label="Reporting source status">{sourceControls}</section>}
    {!data ? <div role="status" className="flex min-h-72 flex-col items-center justify-center gap-3 text-center text-sm text-[var(--text-secondary)]">
      <p>{frozen ? savedError ?? 'Loading the original saved report…' : failed ? 'Reporting could not load. Inspect source details above and retry.' : 'Loading the selected account and period…'}</p>
      {failed ? <div className="flex items-center gap-4">
        {accessDenied && <Link className="underline text-[var(--text-primary)]" href={`/login?next=${encodeURIComponent(`${pathname}${search ? `?${search}` : ''}`)}`}>Sign in</Link>}
        {frozen ? <button type="button" className="rounded-md border border-[var(--border)] px-4 py-2 text-[var(--text-primary)]" onClick={() => window.location.reload()}>Retry saved report</button>
          : <button type="button" className="rounded-md border border-[var(--border)] px-4 py-2 text-[var(--text-primary)]" onClick={retryAll}>Retry reports</button>}
      </div> : !frozen && <p>Each source loads independently. Results appear as soon as a source responds.</p>}
    </div> : view === 'overview' ? <OverviewReport data={data} /> : view === 'ads' ? <AdsReport data={data} /> : view === 'creative' ? <CreativeReport data={data} /> : <ReportsReport data={data} />}
  </div></SavedReportProvider>
}
