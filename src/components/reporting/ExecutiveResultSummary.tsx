'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import type { ExpertReportReview } from '@/lib/reporting/review/contracts'
import { reportLink } from '@/lib/reporting/review/evidence'
import { InvestigationDetails, subscribeReviewPrint } from './ExpertReviewPanel'
import { savedReportHref, useSavedReportContext } from './SavedReportContext'
import { ReviewObservation } from './ReviewObservation'

export function ExecutiveResultSummary({ review }: { review: ExpertReportReview }) {
  const saved = useSavedReportContext()
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    let originalOpen: boolean | null = null
    return subscribeReviewPrint(window, printing => {
      const details = section.current?.querySelector<HTMLDetailsElement>(':scope > details')
      if (!details) return
      if (printing) {
        originalOpen ??= details.open
        details.open = true
      } else if (originalOpen !== null) {
        details.open = originalOpen
        originalOpen = null
      }
    })
  }, [])
  const finding = review.findings.find(item => item.id === 'business_platform_trend')
  const href = (path: string, filters: Record<string, string>, hash = '') =>
    savedReportHref(`${reportLink(review, path, filters)}${hash}`, saved?.saved.id ?? null)
  return <section ref={section} data-executive-result aria-labelledby="executive-result-heading" className="space-y-3 border-b border-[var(--border)] pb-6">
    <h2 id="executive-result-heading" className="text-xl font-semibold text-[var(--text-primary)]">What the results show</h2>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">{review.context.range.from} – {review.context.range.to}; compared with {review.context.comparison.from} – {review.context.comparison.to} · {review.context.timezone}.</p>
    {finding ? <>
      <div data-executive-observation><ReviewObservation observation={finding.observation} /></div>
      <InvestigationDetails finding={finding} expanded={false} asOf={review.context.asOf} includeMateriality />
      <nav aria-label="Executive assessment destinations" className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <Link href={href('/reports', { report: 'business' }, '#business-results')} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">Business detail</Link>
        <Link href={href('/performance', { level: 'adset', group: 'results' })} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">Ad performance</Link>
        <Link href={href('/reports', { report: 'results', review_q: finding.id }, '#full-assessments')} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">Full assessment</Link>
      </nav>
    </> : <p role="status" className="text-sm text-[var(--text-secondary)]">{saved ? 'This assessment was not included in the saved report.' : 'The business and media assessment is unavailable for this report.'}</p>}
  </section>
}
