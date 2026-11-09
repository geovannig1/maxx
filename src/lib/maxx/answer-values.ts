import { formatMoneyAmount } from '@/lib/utils/format-currency'
import type { MetricClaim } from '@/lib/cockpit/contracts'

/**
 * How one governed claim's value reads. Shared by the evidence line and the plain-English summary so
 * the two can never print the same figure two different ways.
 */
export function displayValue(claim: MetricClaim): string {
  if (claim.availability.state !== 'available' || claim.value === null) return 'unavailable'
  if (typeof claim.value === 'string') return claim.value
  if (!Number.isFinite(claim.value)) return 'unavailable'
  // A CHANGE carries its sign. `12.4%` and `-12.4%` are a rise and a fall, but only one of them says
  // so, and a reader scanning a column of percentages should not have to notice a minus to learn the
  // direction. Applies only to a prior-period comparison, where the number IS a direction; a plain
  // rate like CTR is a level and a leading `+` on it would be nonsense.
  if (isPriorPeriodChange(claim)) {
    // ROUND FIRST, then take the sign from the number that will actually be shown. Taking the sign
    // from the raw value rendered a change of 0.004 as `+0%` — a figure whose sign says "up" and
    // whose magnitude says "nothing moved", disagreeing with itself on one line.
    const rounded = roundedChange(claim.value)
    return `${rounded > 0 ? '+' : rounded < 0 ? '-' : ''}${changeMagnitude(rounded)}`
  }
  // Whole amounts drop the cents ("$148,978"); anything else keeps both minor digits ("$1,963.40").
  if (claim.unit === 'money') return formatMoneyAmount(claim.value)
  if (claim.unit === 'percent') return `${claim.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
  if (claim.unit === 'ratio') return `${claim.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}x`
  return claim.value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

/** True for a percent change against the equal-length prior period (a `*_change` claim). */
export function isPriorPeriodChange(claim: MetricClaim): boolean {
  return claim.comparison.method === 'prior_equal_period' && claim.unit === 'percent'
}

/** The change exactly as it is displayed, so its sign and magnitude cannot disagree. */
export function roundedChange(value: number): number {
  return Number(value.toFixed(2))
}

/** The unsigned magnitude of an already-rounded change, e.g. `5%` or `0.6%`. */
export function changeMagnitude(rounded: number): string {
  return `${Math.abs(rounded).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}
