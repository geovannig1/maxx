import type { ReportMetric, ReportSection } from '@/lib/reporting/contracts'
import { reportMetricValue, ReportMetricValue } from './MetricValue'
import { overviewComparison } from '@/lib/reporting/overview-comparison'
import { accountCurrency, accountLocale, accountTimezone } from '@/config/business-config'
import { currencyFractionDigits } from '@/lib/utils/format-currency'
import { accountTimezoneShortName } from '@/config/timezone-label'

export function OverviewMetric({ metric, label, displayLabel, loading = false, omitSettling = false, omitPartial = false, hero = false, comparison = false, movement = false, total = false }: {
  metric?: ReportMetric; label: string; displayLabel?: string; loading?: boolean; omitSettling?: boolean; omitPartial?: boolean; hero?: boolean; comparison?: boolean; movement?: boolean; total?: boolean
}) {
  const claim = metric?.current
  const value = !metric && loading ? 'Loading…' : reportMetricValue(metric)
  const isNumber = claim?.availability.state === 'available'
  const displayed = total && isNumber && claim.unit === 'money' && typeof claim.value === 'number' && Number.isFinite(claim.value)
    ? claim.value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency(), minimumFractionDigits: 0, maximumFractionDigits: currencyFractionDigits() }) : value
  const qualification = (evidence: typeof claim) => [evidence?.coverage.state === 'partial' ? omitPartial ? '' : 'Partial' : evidence?.coverage.state === 'unknown' ? 'Coverage unverified' : '',
    evidence?.freshness.state === 'stale' ? 'Stale' : '', evidence?.maturity.state === 'settling' ? omitSettling ? '' : 'Settling' : evidence?.maturity.state === 'partial' ? 'Partial period' : ''].filter(Boolean).join(' · ')
  const qualifier = qualification(claim), previousQualifier = qualification(metric?.previous ?? undefined)
  const delta = movement && comparison ? overviewComparison(metric) : null
  return <div className="min-w-0">
    <p className={`text-sm leading-5 text-[var(--text-secondary)] ${hero ? 'min-h-5' : ''}`}>{displayLabel ?? label}</p>
    <details className="group min-w-0">
      <summary aria-label={`${label}: ${value}. Definition and source`} title={value}
        className={`inline-flex max-w-full min-h-11 cursor-pointer items-center [overflow-wrap:anywhere] font-semibold tabular-nums decoration-dotted underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${hero && isNumber ? 'text-[28px] leading-9 tracking-tight' : 'text-base leading-6'}`}>
        {displayed}
      </summary>
      <div className="max-w-80 pb-3 text-sm leading-5 text-[var(--text-secondary)]">
        {metric ? <><p>{metric.definition}</p><ReportMetricValue metric={metric} comparison={comparison} compact /></>
          : <p>This source has not supplied a valid measure for this selection.</p>}
      </div>
    </details>
    {comparison && metric?.previous && (metric.current.availability.state === 'available' || metric.previous.availability.state === 'available') && <p className="text-sm tabular-nums leading-5 text-[var(--text-secondary)]">{delta && <strong className="mr-1.5 font-medium text-[var(--text-primary)]">{delta}</strong>}<span>{delta ? 'vs ' : 'Previous: '}{reportMetricValue(metric, true)}{previousQualifier && ` · ${previousQualifier}`}</span></p>}
    {claim?.availability.state === 'available' && qualifier && <p className="text-sm text-[var(--text-secondary)]">{qualifier}</p>}
  </div>
}

export function OverviewSource({ source, label }: { source?: ReportSection<unknown>; label: string }) {
  const date = source?.asOf && Number.isFinite(Date.parse(source.asOf)) ? new Date(source.asOf).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: accountTimezone(),
  }) : null
  return <p className="text-sm leading-5 text-[var(--text-secondary)]">
    {label}{source?.state === 'loading' ? ' · Loading…' : source?.state === 'partial' ? ' · Partial evidence' : !source || source.state === 'unavailable' ? ' · Unavailable' : ''}
    {date && <span title={source?.asOf ?? undefined}> · {date} {accountTimezoneShortName()}</span>}
  </p>
}
