'use client'

import Link from 'next/link'
import type { ExpertReportReview } from '@/lib/reporting/review/contracts'
import { PERFORMANCE_LEVELS, PERFORMANCE_SIGNALS, performanceGroups, type PerformanceSignal } from '@/lib/reporting/review/performance-selection'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export function PerformanceReviewIndex({ review, fullHref }: { review: ExpertReportReview; fullHref: string }) {
  const groups = performanceGroups(review.findings)
  const destination = (level: string, signal: string) => {
    const url = new URL(fullHref, 'https://maxx.invalid')
    url.searchParams.set('review_area', 'advertising')
    url.searchParams.set('review_level', level)
    url.searchParams.set('review_signal', signal)
    return `${url.pathname}${url.search}${url.hash}`
  }
  return <section aria-label="Performance assessment index" className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
    <h3 className="text-base font-semibold text-[var(--text-primary)]">Across campaigns, ad sets and ads</h3>
    <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">Open the complete groups below, including entities outside the selected highlights.</p>
    {groups.some(group => group.counts.all > 0) ? <div className="mt-3 grid gap-4 md:grid-cols-3">
      {groups.map(({ level, counts }) => <div key={level} data-performance-level={level} className="min-w-0">
        <h4 className="font-semibold text-[var(--text-primary)]">{PERFORMANCE_LEVELS[level]}</h4>
        <ul className="mt-1 divide-y divide-[var(--border)]">
          {(Object.keys(PERFORMANCE_SIGNALS) as PerformanceSignal[]).map(signal => <li key={signal}>
            <Link href={destination(level, signal)} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm text-[var(--accent)]">
              <span>{PERFORMANCE_SIGNALS[signal]}</span><span className="shrink-0 tabular-nums">{counts[signal]}</span>
            </Link>
          </li>)}
        </ul>
      </div>)}
    </div> : <p className="mt-3 text-sm text-[var(--text-secondary)]">Entity-level performance assessments were not supplied in this report. The full review explains the available evidence and limits.</p>}
    <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">Counts cover supplied assessments at each separate level. Zero means spend with at least one explicitly zero named Meta event, not zero business {OW.many}. An entity can appear in both a zero-event group and a direction group. Direction groups can include provisional changes while outcomes settle. Unflagged results are not a health verdict; inspect full assessments for missing evidence.</p>
  </section>
}
