'use client'

import { useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import type { ReportingData } from '@/lib/reporting/contracts'
import { OVERVIEW_EVENTS, overviewEvent } from '@/lib/reporting/overview-model'
import { deriveExpertReview } from '@/lib/reporting/review'
import { useSavedReportContext } from './SavedReportContext'
import { OverviewResults } from './OverviewResults'
import { OverviewReading } from './OverviewReading'
import { OverviewCreative } from './OverviewCreative'
import { OverviewHierarchy } from './OverviewHierarchy'
import { OverviewTrends } from './OverviewTrends'
import { OverviewContext } from './OverviewContext'
import { OverviewDelivery } from './OverviewDelivery'

export function OverviewReport({ data, showFindings = true }: { data: ReportingData; showFindings?: boolean }) {
  const saved = useSavedReportContext()
  const search = useSearchParams()
  const selected = overviewEvent(search?.get('overview_event') ?? null)
  const event = OVERVIEW_EVENTS[selected]
  const savedId = saved?.saved.id ?? null
  const review = useMemo(() => showFindings ? saved?.review ?? deriveExpertReview(data) : undefined, [data, saved, showFindings])
  const scope = `${data.context.account.id}:${data.context.range.from}:${data.context.range.to}:${selected}:${savedId ?? 'current'}`
  return <div data-executive-dashboard className="min-w-0 space-y-4 text-[var(--text-primary)]">
    {review && <OverviewReading review={review} data={data} savedId={savedId} />}
    <OverviewResults data={data} selected={selected} savedId={savedId} showMerFallback={!review} />
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <OverviewTrends data={data} savedId={savedId} />
      <OverviewDelivery data={data} savedId={savedId} />
    </div>
    <OverviewCreative key={`creative:${scope}`} data={data} event={event} savedId={savedId} review={review} />
    <OverviewHierarchy key={`hierarchy:${scope}`} data={data} event={event} savedId={savedId} showAudience={false} />
    <OverviewContext data={data} savedId={savedId} />
  </div>
}
