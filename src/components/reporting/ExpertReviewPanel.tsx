'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowUpRight } from 'lucide-react'
import { CLAIM_SOURCE_LABEL } from '@/lib/cockpit/contracts'
import type { ExpertReportReview, ReviewEvidence, ReviewFinding } from '@/lib/reporting/review/contracts'
import { matchesReviewEntity, reviewEntityKey } from '@/lib/reporting/review/entity-selection'
import { findingEvidence } from '@/lib/reporting/review/evidence'
import { overviewFindings } from '@/lib/reporting/review'
import { PERFORMANCE_SIGNALS, matchesPerformanceSignal } from '@/lib/reporting/review/performance-selection'
import { PerformanceReviewIndex } from './PerformanceReviewIndex'
import { ReviewObservation } from './ReviewObservation'
import { ReportMetricValue } from './MetricValue'
import { AudienceEvidenceDetails } from './AudienceEvidenceDetails'
import { BudgetEvidenceCard } from './BudgetEvidenceDetails'
import { savedReportHref, useSavedReportContext } from './SavedReportContext'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const TIME_BASIS = {
  closed_account_days: 'Closed account days', booking_created_date_et: `${OW.One} creation dates`,
  interaction_date_et: 'Interaction dates', impression_date_et: 'Impression dates', service_date_et: 'Service dates', partial_today: 'Partial today',
} as const
const PAGE_SIZE = 20
const AREAS = { business: 'Business', advertising: 'Advertising', audience: 'Audience', creative: 'Creative', website: 'Website', measurement: 'Measurement', coverage: 'Coverage' }
const LEVELS = { campaign: 'Campaign', adset: 'Ad set', ad: 'Ad', source: 'Source / cross-entity' }
const COVERAGE_LEVELS = { ...LEVELS, page: 'Page / device / channel', event: 'Event / device / channel' }
const CONTROL_CLASS = 'min-h-11 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50'
const CLEAR_FILTERS = { review_q: null, review_area: null, review_level: null, review_filter: null, review_signal: null, review_entity: null }

/** Review controls own only their query keys; preserve all other report state and fragments. */
export function reviewControlHref(path: string, search: string | URLSearchParams, hash: string, changes: Record<string, string | null>) {
  const params = new URLSearchParams(search)
  if (!Object.hasOwn(changes, 'review_page')) params.delete('review_page')
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') params.delete(key)
    else params.set(key, value)
  }
  return `${path}${params.size ? `?${params}` : ''}${hash}`
}

/** The browser must see the full matching React tree before taking its print snapshot. */
export function subscribeReviewPrint(target: EventTarget, update: (printing: boolean) => void) {
  const before = () => flushSync(() => update(true))
  const after = () => flushSync(() => update(false))
  target.addEventListener('beforeprint', before)
  target.addEventListener('afterprint', after)
  return () => { target.removeEventListener('beforeprint', before); target.removeEventListener('afterprint', after) }
}

function matches(finding: ReviewFinding, params: URLSearchParams): boolean {
  const area = params.get('review_area'), level = params.get('review_level')
  if ((area && finding.area !== area) || (level && (finding.entity?.level ?? 'source') !== level)
    || (params.get('review_filter') === 'investigate' && finding.priority !== 'investigate')
    || !matchesPerformanceSignal(finding, params.get('review_signal'))
    || !matchesReviewEntity(finding, params.get('review_entity'))) return false
  const query = (params.get('review_q') ?? '').trim().toLocaleLowerCase()
  return !query || [finding.id, finding.title, finding.entity?.id, finding.entity?.name, finding.observation.text,
    finding.materiality.text, finding.counterEvidence.text, finding.nextInspection.question,
    ...finding.explanations.map(item => item.hypothesis), ...finding.limitations]
    .some(text => text?.toLocaleLowerCase().includes(query))
}

function ReviewCoverage({ review }: { review: ExpertReportReview }) {
  if (!review.populationCoverage?.length) return null
  return <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" aria-label="Review coverage">
        <caption className="mb-2 text-left font-semibold text-[var(--text-primary)]">Review coverage</caption>
        <thead className="text-xs text-[var(--text-secondary)]"><tr>
          {['Family', 'Level', 'Supplied', 'Evaluated', 'Limited'].map(label => <th key={label} scope="col" className="px-2 py-2">{label}</th>)}
        </tr></thead>
        <tbody>{review.populationCoverage.map(row => <tr key={`${row.family}:${row.level}`} className="border-t border-[var(--border)]">
          <th scope="row" className="px-2 py-2 font-medium">{row.family}</th><td className="px-2 py-2">{COVERAGE_LEVELS[row.level]}</td>
          <td className="px-2 py-2 tabular-nums">{row.supplied}</td><td className="px-2 py-2 tabular-nums">{row.evaluated}</td><td className="px-2 py-2 tabular-nums">{row.limited}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">Coverage describes the supplied report population before assessment filters. Evaluated means enough eligible native evidence for at least one supported check, not every metric or possible explanation. Limited means evidence was insufficient for those checks; it does not mean zero results.</p>
    {review.populationCoverage.some(row => row.family === 'Creative response') && <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">For Creative response, evaluated and limited may overlap: an ad can have usable observations while still lacking complete compatible comparisons.</p>}
  </div>
}

function EvidenceCard({ evidence, periods }: { evidence: ReviewEvidence; periods?: Array<'current' | 'prior'> }) {
  const current = periods === undefined || periods.includes('current')
  const claim = current ? evidence.metric.current : periods.includes('prior') ? evidence.metric.previous : null
  return <div data-evidence-population={claim?.entity.id ?? evidence.metric.current.entity.id} className="min-w-0 rounded-lg border border-[var(--border)] p-3 print:break-inside-avoid">
    <p className="break-words text-xs font-medium text-[var(--text-primary)]">{evidence.populationLabel}</p>
    <p className="text-xs">{CLAIM_SOURCE_LABEL[(claim ?? evidence.metric.current).source.system]} · {evidence.metric.label}</p>
    <p className="text-xs">{current ? 'Selected-period evidence' : claim ? 'Prior-period evidence' : 'Evidence withheld'}</p>
    {!current && <p className="text-xs">Selected-period value withheld for this assessment.</p>}
    {claim && <>
      <ReportMetricValue metric={{ ...evidence.metric, current: claim, previous: null }} compact comparison={false} />
      <p className="mt-1 break-words text-xs text-[var(--text-tertiary)]">{claim.window.start}–{claim.window.end} · {claim.window.timezone}</p>
      <p className="text-xs text-[var(--text-tertiary)]">{TIME_BASIS[claim.window.basis]}</p>
      <p className="break-words text-xs text-[var(--text-tertiary)]">Source as of {evidence.sourceAsOf ?? 'unavailable'}</p>
    </>}
  </div>
}

export function InvestigationDetails({ finding, expanded, asOf, includeMateriality = false }: { finding: ReviewFinding; expanded: boolean; asOf: string; includeMateriality?: boolean }) {
  const evidence = findingEvidence(finding)
  return <details className="mt-2 text-sm leading-6 text-[var(--text-secondary)]" open={expanded || undefined}>
    <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs underline">{includeMateriality ? 'Evidence and interpretation' : 'Read full observation'}</summary>
    {includeMateriality && <div className="mt-2"><h4 className="font-semibold text-[var(--text-primary)]">Why it matters</h4><p>{finding.materiality.text}</p></div>}
    {finding.explanations.length > 0 && <div className="mt-2">
      <h4 className="font-semibold text-[var(--text-primary)]">Possible explanations</h4>
      <ul className="mt-1 list-disc space-y-2 pl-5">{finding.explanations.map(item => <li key={item.hypothesis}>
        {item.hypothesis}
        {item.missing.length > 0 && <span className="block text-xs">To distinguish this: {item.missing.join(' ')}</span>}
      </li>)}</ul>
    </div>}
    <div className="mt-4">
      <h4 className="font-semibold text-[var(--text-primary)]">What could change this interpretation</h4>
      <p className="mt-1">{finding.counterEvidence.text}</p>
      <ul className="mt-2 list-disc space-y-2 pl-5">{finding.nextInspection.outcomes.map(item => <li key={item.result}>
        <span className="font-medium">{item.result}</span> {item.interpretation}
      </li>)}</ul>
    </div>
    <div className="mt-4">
      <h4 className="font-semibold text-[var(--text-primary)]">Evidence and limits</h4>
      <p className="mt-1 text-xs">Cards label the supported evidence period. Period changes in the observation use supported comparisons.</p>
      {finding.configurationEvidence?.map(ref => <div key={ref.path}>
        <p className="mt-3 break-words text-xs font-medium text-[var(--text-primary)]">{ref.populationLabel}</p>
        <AudienceEvidenceDetails evidence={ref.value} asOf={asOf} />
      </div>)}
      {finding.budgetEvidence?.map(ref => <BudgetEvidenceCard key={ref.path} evidence={ref.value} label={ref.populationLabel} />)}
      {evidence.length > 0 && <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {evidence.map(ref => <EvidenceCard key={ref.id} evidence={ref} periods={finding.evidencePeriods?.[ref.id]} />)}
      </div>}
      {finding.limitations.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-xs">{finding.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>}
    </div>
  </details>
}

export function ReviewFindingCard({ finding, number, printing, asOf, className = '', inspectionHash }: {
  finding: ReviewFinding; number: number; printing: boolean; asOf: string; className?: string; inspectionHash?: string
}) {
  const saved = useSavedReportContext()
  const target = new URL(finding.nextInspection.href, 'https://maxx.invalid')
  const exactAdMetrics = inspectionHash && ['/performance', '/creative'].includes(target.pathname)
    && finding.entity?.level === 'ad' && target.searchParams.get('ad') === finding.entity.id
  const inspectionHref = exactAdMetrics ? `${target.pathname}${target.search}${inspectionHash}` : finding.nextInspection.href
  return <article data-review-id={finding.id}
    className={`min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 ${finding.observation.sections ? 'print:break-inside-auto' : 'print:break-inside-avoid'} ${className}`}>
    <ReviewObservation observation={finding.observation} header={<><div className="flex items-start gap-3 print:break-after-avoid">
      <span className="pt-1 text-xs tabular-nums text-[var(--text-tertiary)]">{String(number).padStart(2, '0')}</span>
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{finding.title}</h3>
    </div>
    <p className="mt-2 text-xs text-[var(--text-secondary)] print:break-after-avoid">{AREAS[finding.area]} · {LEVELS[finding.entity?.level ?? 'source']} · {finding.priority === 'investigate' ? 'Investigation' : 'Context'}
      {finding.entity && <span className="block break-words">{finding.entity.name} · ID {finding.entity.id}</span>}
      {finding.direction && <span className="block">{finding.direction === 'improved' ? 'Observed improvement' : finding.direction === 'declined' ? 'Observed decline' : 'Mixed observed changes'}</span>}
    </p></>} />
    <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
      <h4 className="font-semibold text-[var(--text-primary)]">Why it matters</h4>
      <p>{finding.materiality.text}</p>
    </div>
    <InvestigationDetails finding={finding} expanded={printing} asOf={asOf} />
    <Link href={savedReportHref(inspectionHref, saved?.saved.id ?? null)} className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--accent)]">
      <span>{finding.nextInspection.question}</span><ArrowUpRight size={16} className="shrink-0" />
    </Link>
  </article>
}

export function ExpertReviewPanel({ review, expanded = false, featuredFindingIds = [] }: { review: ExpertReportReview; expanded?: boolean; featuredFindingIds?: string[] }) {
  const saved = useSavedReportContext()
  const query = useSearchParams(), path = usePathname() ?? '/reports'
  const params = new URLSearchParams(query?.toString() ?? '')
  const [printing, setPrinting] = useState(false)
  useEffect(() => subscribeReviewPrint(window, setPrinting), [])
  const matching = expanded ? review.findings.filter(finding => matches(finding, params)) : overviewFindings(review).filter(finding => !featuredFindingIds.includes(finding.id))
  const entityOptions = Object.fromEntries(review.findings.flatMap(finding => finding.entity ? [[reviewEntityKey(finding.entity), `${LEVELS[finding.entity.level]} · ${finding.entity.name} · ID ${finding.entity.id}`]] : []))
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE))
  const requestedPage = Number(params.get('review_page') ?? '1')
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pageCount) : 1
  const offset = expanded && !printing ? (page - 1) * PAGE_SIZE : 0
  const visible = expanded && !printing ? matching.slice(offset, offset + PAGE_SIZE) : matching
  const update = (changes: Record<string, string | null>, replace = false) => {
    const href = reviewControlHref(path, window.location.search, window.location.hash, changes)
    if (replace) window.history.replaceState(null, '', href)
    else window.history.pushState(null, '', href)
    if (Object.hasOwn(changes, 'review_page')) {
      const heading = document.getElementById('full-assessments-heading')
      heading?.focus({ preventScroll: true })
      heading?.scrollIntoView({ block: 'start' })
    }
  }
  const fullParams = new URLSearchParams(params)
  fullParams.set('from', review.context.range.from)
  fullParams.set('to', review.context.range.to)
  const fullHref = savedReportHref(reviewControlHref('/reports', fullParams, '#full-assessments', { ...CLEAR_FILTERS, report: 'results' }), saved?.saved.id ?? null)
  const select = (label: string, key: string, options: Record<string, string>, all: string) => <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
    {label}<select aria-label={label} className={CONTROL_CLASS} value={params.get(key) ?? ''} onChange={event => update({ [key]: event.target.value || null })}>
      <option value="">{all}</option>
      {params.get(key) && !Object.hasOwn(options, params.get(key)!) && <option value={params.get(key)!}>Unknown selection ({params.get(key)})</option>}
      {Object.entries(options).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
  </label>
  return <section id={expanded ? 'full-assessments' : undefined} aria-label={expanded ? 'Full assessment review' : 'What deserves a closer look'} className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">Automatic review</p>
        <h2 id={expanded ? 'full-assessments-heading' : undefined} tabIndex={expanded ? -1 : undefined}
          className="mt-1 scroll-mt-24 text-xl font-semibold text-[var(--text-primary)]">{expanded ? 'Full assessment review' : 'What deserves a closer look'}</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{review.context.range.from}–{review.context.range.to} · {review.context.timezone}. Observations and questions to investigate.</p>
        {!expanded && <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">Overview highlights are a subset of {review.findings.length} assessments. The full review includes descriptive observations and evidence limits.</p>}
      </div>
      {!expanded && <Link href={fullHref}
        className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-[var(--accent)]">See all assessments <ArrowUpRight size={16} /></Link>}
    </div>
    {!expanded && <PerformanceReviewIndex review={review} fullHref={fullHref} />}
    {expanded && <>
      <ReviewCoverage review={review} />
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">Search assessments
          <input type="search" aria-label="Search assessments" placeholder="Entity name, ID, observation or question" className={CONTROL_CLASS}
            value={params.get('review_q') ?? ''} onChange={event => update({ review_q: event.target.value || null }, true)} />
        </label>
        {select('Assessment area', 'review_area', AREAS, 'All areas')}
        {select('Assessment level', 'review_level', LEVELS, 'All levels')}
        {select('Exact entity', 'review_entity', entityOptions, 'All entities')}
        {select('Assessment focus', 'review_filter', { investigate: 'Investigations' }, 'All assessments')}
        {select('Performance signal', 'review_signal', PERFORMANCE_SIGNALS, 'All assessment families')}
        <button type="button" className={CONTROL_CLASS} onClick={() => update(CLEAR_FILTERS)}>Clear assessment filters</button>
      </div>
      <p role="status" className="text-sm text-[var(--text-secondary)]">{matching.length} matching of {review.findings.length} assessments.
        {printing ? ' Printing all matching assessments with their evidence and limits.' : ' Printing includes all matching assessments, across every page.'}</p>
      {matching.length === 0 && <p className="rounded-lg border border-[var(--border)] p-4 text-sm text-[var(--text-secondary)]">No assessments match these filters. Clear assessment filters to see the full supplied review.</p>}
    </>}
    <div className={expanded ? 'grid items-start gap-4 lg:grid-cols-2' : 'grid items-start gap-4 xl:grid-cols-3'}>
      {visible.map((finding, index) => <ReviewFindingCard key={finding.id} finding={finding} number={offset + index + 1}
        printing={printing} asOf={review.context.asOf}
        className={finding.id === 'advertising.allocation' ? expanded ? 'lg:col-span-2' : 'xl:col-span-3' : ''} />)}
    </div>
    {expanded && <nav aria-label="Assessment pages" className="flex flex-wrap items-center justify-between gap-3 print:hidden">
      <button type="button" className={CONTROL_CLASS} disabled={page <= 1} onClick={() => update({ review_page: String(page - 1) })}>Previous assessments</button>
      <p className="text-sm text-[var(--text-secondary)]">Page {page} of {pageCount}</p>
      <button type="button" className={CONTROL_CLASS} disabled={page >= pageCount} onClick={() => update({ review_page: String(page + 1) })}>Next assessments</button>
    </nav>}
  </section>
}
