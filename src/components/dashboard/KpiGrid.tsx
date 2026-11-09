import { KpiCard } from './KpiCard'
import { computeDelta } from '@/lib/insights/compare'
import type { DashboardMetaOutcomeReadHealth, DashboardMetaReadHealth } from '@/lib/dashboard/read-health'
import { accountCurrency, accountTimezone } from '@/config/business-config'
import { outcomeNoun } from '@/config/outcome-nouns'

export interface KpiSet {
  spend: number | null
  leads: number | null
  /** Meta-attributed bookings (pixel estimate) — the ads-efficiency trend metric, not the business total. */
  bookings: number | null
  /** Canonical bookings from the outcome ledger (all active sources). Null = pre-ledger window. */
  realBookings: number | null
  /** recorded collected value over active appointments. */
  realRevenue: number | null
  cpl: number | null
  cpb: number | null
}

interface KpiGridProps {
  current: KpiSet
  previous: KpiSet
  series: { spend: number[]; leads: number[]; cpl: number[] }
  currency: string
  /** e.g. "vs prior 30d" */
  comparisonLabel: string
  dateLabel?: string
  metaRead: DashboardMetaReadHealth
  metaOutcomeRead: DashboardMetaOutcomeReadHealth
}

function formatCurrency(value: number | null, currency = accountCurrency()): string {
  if (value === null) return '—'
  if (value >= 1000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 1,
      notation: 'compact',
    }).format(value)
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value)
}

export function KpiGrid({ current, previous, series, currency, comparisonLabel, dateLabel, metaRead, metaOutcomeRead }: KpiGridProps) {
  const evidenceDate = dateLabel ?? `Selected window · ${accountTimezone()}`
  const hasReal = current.realBookings !== null
  const deliveryAvailable = metaRead.status === 'available'
  const outcomesAvailable = deliveryAvailable
    && metaOutcomeRead.status === 'available'
    && current.leads !== null
    && current.bookings !== null
  const outcomeUnavailableReason = metaOutcomeRead.status === 'unavailable'
    ? metaOutcomeRead.unavailable_reason
    : 'Meta outcome values are incomplete for the selected window.'
  const deliveryUnavailableReason = metaRead.status === 'unavailable'
    ? metaRead.unavailable_reason
    : undefined
  return (
    <div>
      <div className={`grid grid-cols-2 gap-4 ${hasReal ? 'lg:grid-cols-6' : 'lg:grid-cols-4'}`}>
        <KpiCard
          label="Meta spend"
          value={deliveryAvailable ? formatCurrency(current.spend, currency) : 'Unavailable'}
          delta={deliveryAvailable ? computeDelta(current.spend, previous.spend, true) : undefined}
          subtitle={deliveryAvailable ? comparisonLabel : deliveryUnavailableReason}
          sparkline={deliveryAvailable ? series.spend : undefined}
          evidence={{ source: 'Meta daily_reports + spend window', date: evidenceDate, scope: 'Selected ad account', availability: deliveryAvailable ? 'Available' : 'Unavailable' }}
        />
        <KpiCard
          label="Meta leads"
          value={outcomesAvailable ? current.leads!.toLocaleString() : 'Unavailable'}
          delta={outcomesAvailable ? computeDelta(current.leads, previous.leads, false) : undefined}
          subtitle={outcomesAvailable ? comparisonLabel : outcomeUnavailableReason}
          sparkline={outcomesAvailable ? series.leads : undefined}
          evidence={{ source: 'Meta modelled daily_reports', date: evidenceDate, scope: 'Selected ad account', availability: outcomesAvailable ? 'Available' : 'Unavailable' }}
        />
        <KpiCard
          label="Meta cost per lead"
          value={outcomesAvailable ? formatCurrency(current.cpl, currency) : 'Unavailable'}
          delta={outcomesAvailable ? computeDelta(current.cpl, previous.cpl, true) : undefined}
          subtitle={outcomesAvailable ? `${comparisonLabel} · modelled` : outcomeUnavailableReason}
          sparkline={outcomesAvailable ? series.cpl : undefined}
          evidence={{ source: 'Meta modelled daily_reports', date: evidenceDate, scope: 'Selected ad account', availability: outcomesAvailable ? 'Available' : 'Unavailable' }}
        />
        {/* Business truth: the outcome ledger — active value-bearing bookings, all sources. */}
        {hasReal && (
          <>
            <KpiCard
              label={`Real ${outcomeNoun()}`}
              /* hasReal already proved this is non-null; the ?? 0 was unreachable and read
                 like the laundering bug this file is otherwise careful to avoid. */
              value={current.realBookings!.toLocaleString()}
              delta={computeDelta(current.realBookings, previous.realBookings, false)}
              subtitle={`All sources · ${outcomeNoun({ capitalize: true })} recorded by the business`}
              evidence={{ source: 'Outcome ledger', date: evidenceDate, scope: `All active value-bearing ${outcomeNoun()}`, availability: 'Available' }}
            />
            <KpiCard
              label="Amount Paid · Active Appts"
              value={formatCurrency(current.realRevenue, currency)}
              delta={computeDelta(current.realRevenue, previous.realRevenue, false)}
              subtitle={current.realRevenue === null
                ? 'Unavailable · incomplete amount_paid coverage'
                : `active ${outcomeNoun()} only`}
              evidence={{ source: 'Outcome ledger', date: evidenceDate, scope: `Active ${outcomeNoun()} with amount paid recorded`, availability: current.realRevenue === null ? 'Unavailable' : 'Available' }}
            />
          </>
        )}
        {/* Raw platform context only. No spend/outcome ratio or paid-performance status is inferred. */}
        <KpiCard
          label="Meta modelled events"
          value={outcomesAvailable ? current.bookings!.toLocaleString() : 'Unavailable'}
          delta={outcomesAvailable ? computeDelta(current.bookings, previous.bookings, false) : undefined}
          subtitle={outcomesAvailable ? `${comparisonLabel} · diagnostic only` : outcomeUnavailableReason}
          evidence={{ source: 'Meta modelled daily_reports', date: evidenceDate, scope: 'Selected ad account', availability: outcomesAvailable ? 'Diagnostic only' : 'Unavailable' }}
        />
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
        Real {outcomeNoun()} come from the outcome ledger. Amount paid on active {outcomeNoun()} is shown only when amount-paid coverage is complete. Incomplete coverage is unavailable, never zero. {!deliveryAvailable
          ? `Meta delivery is unavailable (${metaRead.reason_code}); no zero or status is inferred.`
          : outcomesAvailable
            ? 'Meta modelled events are raw platform attribution context with diagnostic-only authority.'
            : `Meta delivery remains available. Meta outcome evidence is unavailable (${metaOutcomeRead.reason_code}); no zero or partial total is inferred.`}{' '}
        GA channel splits are telemetry only; they do not prove Meta platform attribution and omit Meta view-through outcomes.
      </p>
    </div>
  )
}
