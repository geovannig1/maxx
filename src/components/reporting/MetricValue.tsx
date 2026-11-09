import { accountCurrency, accountLocale } from '@/config/business-config'
import { formatMoney, currencyFractionDigits } from '@/lib/utils/format-currency'
import {
  CLAIM_SOURCE_LABEL, ATTRIBUTION_SCOPE_DESCRIPTIONS, type MetricClaim,
} from '@/lib/cockpit/contracts'
import type { ReportMetric } from '@/lib/reporting/contracts'

export function reportCurrencyValue(value: number, metricKey: string): string {
  const unitCost = metricKey.replace(/^meta\./, '').startsWith('cost_per_')
  // A sub-unit cost per result keeps two digits beyond the currency's minor unit (USD 4, JPY 2, KWD 5).
  const digits = currencyFractionDigits()
  const smallest = 10 ** -(digits + 2)
  if (unitCost && value > 0 && value < smallest) return `<${formatMoney(smallest, { maximumFractionDigits: digits + 2 })}`
  return value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency(), maximumFractionDigits: unitCost && Math.abs(value) < 1 ? digits + 2 : digits })
}

function formatClaim(claim: MetricClaim | null | undefined): string {
  if (!claim || claim.availability.state !== 'available' || claim.value === null) return 'Unavailable'
  if (typeof claim.value === 'string') return claim.value
  if (!Number.isFinite(claim.value)) return 'Unavailable'
  switch (claim.unit) {
    case 'money': return reportCurrencyValue(claim.value, claim.metricKey)
    case 'ratio': return `${claim.value.toFixed(2)}×`
    case 'percent': return `${claim.value.toFixed(1)}%`
    case 'seconds': return `${claim.value.toFixed(1)} s`
    case 'days': return `${claim.value.toFixed(1)} days`
    case 'hours': return `${claim.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} h`
    default: return claim.value.toLocaleString('en-US', { maximumFractionDigits: 1 })
  }
}

export function reportMetricValue(metric?: ReportMetric, prior = false): string {
  return formatClaim(prior ? metric?.previous : metric?.current)
}

function qualification(claim: MetricClaim | undefined | null): string {
  if (!claim || claim.availability.state !== 'available') return ''
  return [claim.coverage.state === 'partial' ? 'Partial evidence' : claim.coverage.state === 'unknown' ? 'Coverage unverified' : '',
    claim.freshness.state === 'stale' ? 'Stale evidence' : '',
    claim.maturity.state === 'settling' ? 'Attribution settling' : claim.maturity.state === 'partial' ? 'Partial period' : '',
  ].filter(Boolean).join(' · ')
}

function Evidence({ metric, comparison }: { metric: ReportMetric; comparison: boolean }) {
  const claim = metric.current
  return (
    <dl className="mt-2 space-y-2 text-left text-xs leading-relaxed font-normal tabular-nums" style={{ color: 'var(--text-secondary)' }}>
      <div><dt className="font-semibold">Definition</dt><dd>{metric.definition}</dd></div>
      <div><dt className="font-semibold">Source{metric.event ? ' and event' : ''}</dt>
        <dd>{CLAIM_SOURCE_LABEL[claim.source.system]}{metric.event ? ` · ${metric.event}` : ''}</dd></div>
      <div><dt className="font-semibold">Period</dt><dd>{claim.window.start} – {claim.window.end} · {claim.window.timezone}</dd></div>
      {comparison && metric.previous && <div><dt className="font-semibold">Comparison</dt>
        <dd>{metric.previous.window.start} – {metric.previous.window.end} · {formatClaim(metric.previous)}</dd></div>}
      <div><dt className="font-semibold">Meaning</dt><dd>{ATTRIBUTION_SCOPE_DESCRIPTIONS[claim.attributionScope]}</dd></div>
      <div><dt className="font-semibold">Evidence as of</dt><dd>{claim.asOf}</dd></div>
      {claim.coverage.state !== 'complete' && <div><dt className="font-semibold">Coverage</dt>
        <dd>{claim.coverage.state === 'partial' ? 'Partial source coverage; the observed amount may be incomplete.'
          : claim.coverage.state === 'unknown' ? 'Complete coverage has not been established.' : 'Not applicable.'}</dd></div>}
      {claim.availability.state === 'unavailable' && <div><dt className="font-semibold">Availability</dt>
        <dd>The source did not supply a valid measure with the coverage needed for this period.</dd></div>}
      {claim.freshness.state === 'stale' && <div><dt className="font-semibold">Freshness</dt><dd>This evidence is stale.</dd></div>}
      {claim.maturity.state === 'settling' && <div><dt className="font-semibold">Attribution</dt><dd>Reported outcomes may still change.</dd></div>}
    </dl>
  )
}

export function ReportMetricValue({ metric, comparison = true, compact = false }: {
  metric?: ReportMetric
  comparison?: boolean
  compact?: boolean
}) {
  const value = reportMetricValue(metric)
  const qualifier = qualification(metric?.current)
  const previousQualifier = qualification(metric?.previous)
  if (compact) {
    if (!metric) return <span className="inline-flex min-h-11 items-center text-sm">Unavailable</span>
    return <div className="min-w-0"><details className="group min-w-0 text-sm tabular-nums">
      <summary className="cursor-pointer min-h-11 inline-flex items-center underline decoration-dotted underline-offset-4"
        aria-label={`${metric?.label ?? 'Metric'}: ${value}. Show definition and source.`}>{value}</summary>
      <div className="max-w-72 break-words pb-3"><Evidence metric={metric} comparison={comparison} /></div>
    </details>{qualifier && <p className="text-xs leading-5 text-[var(--warning)]">{qualifier}</p>}{comparison && metric.previous && <p className="text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>Previous: {reportMetricValue(metric, true)}{previousQualifier ? ` · ${previousQualifier}` : ''}</p>}</div>
  }
  return <div className="min-w-0">
    <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</p>
    {qualifier && <p className="mt-1 text-xs leading-5 text-[var(--warning)]">{qualifier}</p>}
    {comparison && metric?.previous && <p className="mt-1 text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
      Previous: {reportMetricValue(metric, true)}{previousQualifier ? ` · ${previousQualifier}` : ''}
    </p>}
    {metric && <details className="mt-1">
      <summary className="cursor-pointer inline-flex min-h-11 items-center text-xs underline underline-offset-4"
        style={{ color: 'var(--text-secondary)' }} aria-label={`Definition and source for ${metric.label}`}>Definition and source</summary>
      <Evidence metric={metric} comparison={comparison} />
    </details>}
  </div>
}
