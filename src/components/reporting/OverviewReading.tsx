import { accountCurrency, accountLocale } from '@/config/business-config'
import { currencyFractionDigits } from '@/lib/utils/format-currency'
import Link from 'next/link'
import { overviewFindings } from '@/lib/reporting/review'
import type { ExpertReportReview } from '@/lib/reporting/review/contracts'
import { matchingObservationSections } from '@/lib/reporting/review/observation'
import { overviewHref } from '@/lib/reporting/overview-model'
import type { ReportingData } from '@/lib/reporting/contracts'
import { overviewBusinessMovementReading, overviewMerMovementReading, overviewTemporalReading } from '@/lib/reporting/overview-interpretation'
import { overviewBusinessSummary, overviewInputQualifications, overviewRatioComparison, overviewRatioValue, overviewSummaryInput } from '@/lib/reporting/overview-business-summary'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()


/** Sentence boundaries preserve decimals and the prepared evidence's original wording. */
function firstSentence(text: string) {
  const sentences = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text.trim())
  return sentences[Symbol.iterator]().next().value?.segment.trim() ?? ''
}

/** Only reformat display tokens; the supplied assessment stays available in the evidence disclosure. */
function readingText(text: string, temporal = false) {
  const sentence = temporal ? firstSentence(text).replace('dates contributed', 'days brought in')
    .replace(`; these separate ${OW.one} and impression dates do not establish attribution`, '; ad attribution is unproven') : firstSentence(text)
  const display = sentence.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, date => {
    const parsed = new Date(`${date}T00:00:00Z`)
    return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : date
  }).replace(/(\$[\d,]+)\.00\b/g, '$1')
  return display.split(/(\$[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%)/g).map((part, index) =>
    /^(?:\$|\d+.*%$)/.test(part) ? <strong key={index} className="font-semibold text-[var(--text-primary)]">{part}</strong> : part)
}

function periodReading(data: ReportingData) {
  const value = overviewSummaryInput(data, 'business', 'booked_value', data.business.data?.metrics.booked_value)
  const bookings = overviewSummaryInput(data, 'business', 'paid_bookings', data.business.data?.metrics.paid_bookings)
  const spend = overviewSummaryInput(data, 'meta', 'spend', data.meta.data?.metrics.spend)
  if (!value || !bookings || !spend) return null
  const money = (amount: number) => amount.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency(), minimumFractionDigits: 0, maximumFractionDigits: currencyFractionDigits() })
  return { text: `${money(value.value as number)} in all-source booked value and ${bookings.value} paid ${OW.many}, alongside ${money(spend.value as number)} in Meta spend.`,
    qualifications: overviewInputQualifications([value, bookings, spend]) }
}

function joinedObservation(first?: string, second?: string) {
  if (!first) return second
  if (!second) return first
  const continuation = /^[A-Z]/.test(second) ? `${second[0].toLowerCase()}${second.slice(1)}` : second
  return `${first.replace(/\.$/, '')}; ${continuation}`
}

export function OverviewReading({ review, savedId, data }: { review: ExpertReportReview; savedId?: string | null; data?: ReportingData }) {
  const opening = review.findings.find(item => item.id === 'business_platform_trend' && item.status !== 'unavailable')
  const selected = overviewFindings(review).find(item => item.id !== opening?.id && item.status !== 'unavailable'
    && (item.priority === 'investigate' || item.direction === 'mixed' || item.direction === 'declined'))
  const sections = opening && matchingObservationSections(opening.observation)
  const accepted = data && !savedId && JSON.stringify(data.context) === JSON.stringify(review.context)
    && !review.input.rejectedSources.includes('business') ? review.input.rejectedSources.includes('meta')
      ? { ...data, meta: { state: 'unavailable' as const, data: null, notes: [], asOf: null } } : data : null
  const temporal = accepted ? overviewTemporalReading(accepted) : null
  const movement = accepted ? overviewBusinessMovementReading(accepted) : null
  const efficiency = accepted ? overviewMerMovementReading(accepted) : null
  const period = accepted ? periodReading(accepted) : null
  const mer = data ? overviewBusinessSummary(data) : null
  const priorMer = data ? overviewBusinessSummary(data, true) : null
  const preferSelected = selected && efficiency?.changed === false && movement?.changed === false
  const observation = preferSelected ? temporal?.observation ?? selected.observation.text
    : efficiency ? joinedObservation(efficiency.observation, temporal?.summary ?? temporal?.observation)
    : temporal?.observation ?? movement?.observation ?? sections?.find(section => section.heading === 'Outcome source booked demand')?.paragraphs[0] ?? opening?.observation.text
  const relationship = sections?.find(section => section.heading === 'Relationship between sources')?.paragraphs[0]
  const qualifier = preferSelected && selected.observation.text !== observation ? selected.observation.text
    : movement && movement.observation !== observation ? movement.observation
    : temporal?.qualifier ?? selected?.observation.text ?? relationship
  const merComparison = data ? overviewRatioComparison(data, 'mer') : null
  const qualifications = [...new Set([...(movement?.qualifications ?? []), ...(efficiency?.qualifications ?? []),
    ...(period?.qualifications ?? []), ...(temporal?.qualifications ?? [])])]
  const summaryQualifications = qualifications.filter(item => item !== 'Freshness unverified')
  function inspection(href: string) {
    const url = new URL(href, 'https://maxx.local')
    return `${overviewHref(review.context, url.pathname, Object.fromEntries(url.searchParams), savedId)}${url.hash}`
  }
  const full = `${overviewHref(review.context, '/reports', { report: 'results' }, savedId)}#full-assessments`
  const trends = '#overview-trends'
  return <section aria-label="Executive interpretation" className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3 sm:px-6 sm:py-4">
    <div className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,280px)]">
      <div className="min-w-0">
    <h2 className="mb-2 text-sm font-semibold tracking-wide text-[var(--accent)]">The read <span className="sr-only">— What matters in this period</span></h2>
    {observation ? <p className="max-w-[95ch] text-lg font-medium leading-7 text-[var(--text-primary)] sm:text-[23px] sm:leading-8">{readingText(observation)}</p>
      : <p className="text-[var(--text-secondary)]">{savedId ? 'This assessment was not included in the saved report.' : 'The available business evidence does not support a period assessment.'}</p>}
    {qualifier ? <p className="mt-1.5 max-w-[110ch] text-sm leading-5 text-[var(--text-secondary)] sm:mt-2 sm:text-base sm:leading-6">{readingText(qualifier, Boolean(temporal))}</p>
      : <p className="text-[var(--text-secondary)]">Separate {OW.one} and advertising sources do not establish paid attribution. <Link href={full} className="text-[var(--accent)] underline">Review evidence</Link></p>}
      </div>
      {mer && <aside aria-label={`All-source booked value ÷ Meta spend: ${overviewRatioValue(mer.mer, 'ratio')}`} className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-3 sm:p-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-sm font-semibold text-[var(--text-secondary)]">MER</span>
          <span className={`text-[28px] font-semibold leading-none tracking-tight tabular-nums ${mer.mer.value === null ? 'text-[var(--text-secondary)]' : 'text-[var(--chart-2)]'} sm:text-[32px]`}>{overviewRatioValue(mer.mer, 'ratio')}</span>
          {priorMer && <span className="ml-auto text-xs tabular-nums text-[var(--text-secondary)]">Prior {overviewRatioValue(priorMer.mer, 'ratio')}{merComparison && ` · ${merComparison}`}</span>}
        </div>
        <span className="mt-1 block text-xs leading-5 text-[var(--text-secondary)] sm:mt-2">All-source booked value ÷ Meta spend</span>
      </aside>}
    </div>
    <details className="mt-1 text-sm leading-6 text-[var(--text-secondary)] sm:mt-2">
      <summary className="inline-flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 text-[var(--accent)] sm:min-h-8">Why this read →{summaryQualifications.length ? <span className="text-[var(--text-secondary)]">{summaryQualifications.join(' · ')}</span> : null}</summary>
      <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-3">
        {qualifications.length > 0 && <p>{qualifications.join(' · ')}</p>}
        {observation && <p>{observation}</p>}{qualifier && <p>{qualifier}</p>}
        {preferSelected && <><p>{efficiency.observation}</p><p>{movement.observation}</p></>}
        {movement?.explanation?.map(text => <p key={text}>{text}</p>)}
        {efficiency?.explanation.map(text => <p key={text}>{text}</p>)}
        {(period || movement || temporal) && <p>Business booked value includes direct, organic, referral and repeat {OW.many}; it is not Meta-attributed revenue.</p>}
        {temporal && <><p>{temporal.observation}</p><p>{temporal.qualifier}</p></>}
        {mer?.mer.reason && <p>{mer.mer.reason}</p>}
        {priorMer?.mer.reason && <p>Prior: {priorMer.mer.reason}</p>}
        {period && !temporal && opening && <p>{opening.observation.text}</p>}
        <div className="flex flex-wrap gap-x-5">
          {observation && <Link href={temporal ? trends : opening ? inspection(opening.nextInspection.href) : `${overviewHref(review.context, '/reports', { report: 'business' }, savedId)}#business-results`} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">{temporal ? 'Inspect daily evidence' : 'Inspect business'}</Link>}
          <Link href={temporal ? trends : selected ? inspection(selected.nextInspection.href) : full} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">{temporal ? 'Inspect chart values' : selected ? 'Inspect this evidence' : 'Read the assessment'}</Link>
        </div>
      </div>
    </details>
  </section>
}
