'use client'

import { useSearchParams } from 'next/navigation'
import type { ReportMetricMap, ReportSeriesPoint, ReportingContext } from '@/lib/reporting/contracts'
import { temporalViewHref } from '@/lib/reporting/trend'
import { ReportTrend } from './ReportTrend'

/** Native history preserves the report/saved/source selection and supports ordinary Back. */
export function ReportingTrend(props: {
  kind: 'meta' | 'business'; series: ReportSeriesPoint[]; comparisonSeries: ReportSeriesPoint[];
  metrics: ReportMetricMap; context: ReportingContext; detailsLoading?: boolean; sourceAsOf?: string | null
}) {
  const search = useSearchParams(), key = `${props.kind}_trend`
  return <ReportTrend {...props} selectedMetric={search?.get(key) ?? undefined} onMetricChange={value => {
    window.history.pushState(null, '', temporalViewHref(window.location.pathname, window.location.search, window.location.hash, key, value))
  }} />
}
