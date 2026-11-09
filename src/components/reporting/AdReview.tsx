'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { deriveExpertReview } from '@/lib/reporting/review'
import { matchesReviewEntity, reviewEntityKey } from '@/lib/reporting/review/entity-selection'
import { ReviewFindingCard, subscribeReviewPrint } from './ExpertReviewPanel'
import { savedReportHref, useSavedReportContext } from './SavedReportContext'

export function AdReview({ data, entity }: { data: ReportingData; entity: ReportEntity }) {
  const search = useSearchParams()
  const prefix = entity.level === 'ad' ? 'ad' : 'entity'
  const historyQuery = Object.fromEntries([`${prefix}_trend`, `${prefix}_trend_period`].flatMap(key => search?.get(key) ? [[key, search.get(key)!]] : []))
  const label = entity.level === 'adset' ? 'ad set' : entity.level
  const metricAnchor = entity.level === 'ad' ? '#ad-metrics' : '#entity-metrics'
  const detailQuery: Record<string, string> = entity.level === 'ad' ? { ad: entity.id } : { view: 'detail', campaign: entity.level === 'campaign' ? entity.id : entity.campaignId ?? '', ...(entity.level === 'adset' ? { adset: entity.id } : {}) }
  const saved = useSavedReportContext()
  const review = useMemo(() => saved ? saved.review : deriveExpertReview(data), [saved, data])
  const [printing, setPrinting] = useState(false)
  useEffect(() => subscribeReviewPrint(window, setPrinting), [])
  const selection = reviewEntityKey(entity)
  const rank = (id: string) => id.startsWith('performance:') ? 0 : id.startsWith('creative_response:') ? 1 : 2
  const findings = review.findings.filter(finding => matchesReviewEntity(finding, selection))
    .sort((left, right) => rank(left.id) - rank(right.id))
  const href = (report: string, extra: Record<string, string> = {}, hash = '') => savedReportHref(
    `/reports?${new URLSearchParams({ from: review.context.range.from, to: review.context.range.to, report, ...extra })}${hash}`, saved?.saved.id ?? null)
  return <section data-ad-review aria-labelledby="ad-review-heading" className="min-w-0 space-y-4">
    <div>
      <h2 id="ad-review-heading" className="text-xl font-semibold">What this {label}’s results show</h2>
      <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{findings.length} prepared assessments for this exact {label}. Results, response and their evidence are kept together.</p>
      <p className="text-xs leading-5 text-[var(--text-secondary)]">{review.context.range.from}–{review.context.range.to} · Compared with {review.context.comparison.from}–{review.context.comparison.to} · {review.context.timezone}</p>
    </div>
    <nav aria-label={`${label} review destinations`} className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      <Link href={savedReportHref(`/performance?${new URLSearchParams({ from: review.context.range.from, to: review.context.range.to,
        level: entity.level, ...detailQuery, ...historyQuery, group: 'results' })}${metricAnchor}`, saved?.saved.id ?? null)} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">Results and ROAS</Link>
      <Link href={href('results', { review_entity: selection }, '#full-assessments')} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">All assessments for this {label}</Link>
      <Link href={href('website')} className="inline-flex min-h-11 items-center text-[var(--accent)] underline">Website context</Link>
    </nav>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">Website context describes the separate GA4 population for these dates; its sessions and events are not attributed to this {label}.</p>
    {findings.length ? <div className="grid items-start gap-4 xl:grid-cols-2">
      {findings.map((finding, index) => <ReviewFindingCard key={finding.id} finding={finding} number={index + 1}
        printing={printing} asOf={review.context.asOf} inspectionHash={metricAnchor} />)}
    </div> : <p role="status" className="text-sm text-[var(--text-secondary)]">{saved
      ? `No ${label}-specific assessments were included in this saved report.`
      : `No ${label}-specific assessments are available for the supplied evidence. Inspect the measured fields and source limits below.`}</p>}
  </section>
}
