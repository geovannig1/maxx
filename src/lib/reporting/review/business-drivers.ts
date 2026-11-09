import { accountCurrency, accountLocale } from '@/config/business-config'
import type { ReportingData } from '../contracts'
import type { ReviewFinding } from './contracts'
import { deriveBusinessDrivers, type BusinessDriverRow } from '../business-drivers'
import { statement } from './evidence'
import { businessDetailHref, unavailableBusiness } from './business-intelligence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const money = (value: number | null) => value === null ? 'unavailable' : value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })
const signed = (value: number) => `${value > 0 ? '+' : ''}${money(value)}`
const refs = (row: BusinessDriverRow) => Object.values(row.evidence)
function contribution(row: BusinessDriverRow): string {
  const split = row.decomposition
  return `${row.name} [${row.id}]: ${signed(row.change.bookedValue!)}${split.state === 'matched'
    ? ` (${OW.one}-count component ${signed(split.bookingCount!)}; value-per-${OW.one} component ${signed(split.valuePerBooking!)})`
    : split.state === 'current_only' || split.state === 'prior_only' ? ` (${split.state === 'current_only' ? 'current-only' : 'prior-only'} whole contribution; no absent-period mean)` : ` (count/value-per-${OW.one} split unavailable)`}.`
}

/** One prepared answer; the shared model and Business detail retain every supplied service. */
export function deriveBusinessDriverReview(data: ReportingData): ReviewFinding {
  const result = deriveBusinessDrivers(data), account = result.account
  if (result.state === 'unavailable') return unavailableBusiness(data, 'business_booked_value_drivers', 'What explains booked-value movement?',
    'Compatible native scheduled booked-value observations are unavailable; missing values cannot establish zero business activity.', 'business-drivers')
  const changes = result.services.filter(row => row.change.bookedValue !== null)
  const sorted = [...changes].sort((a, b) => a.change.bookedValue! - b.change.bookedValue! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const decrease = sorted.find(row => row.change.bookedValue! < 0), gain = [...sorted].reverse().find(row => row.change.bookedValue! > 0)
  const highlighted = [decrease, gain].filter((row): row is BusinessDriverRow => !!row)
  const change = account.change.bookedValue
  const reconciled = Object.values(result.reconciliation).every(value => value.state === 'reconciled')
  const movement = change === null ? 'The signed headline comparison is unavailable.' : change === 0
    ? `The headline is unchanged${decrease && gain ? ', with offsetting service gains and losses' : ''}.`
    : `The headline ${change > 0 ? 'increase' : 'decrease'} is ${money(Math.abs(change))}.`
  const evidence = [account, ...result.services].flatMap(refs)
  const residuals = (['current', 'prior'] as const).map(period => {
    const value = result.reconciliation[period]
    return `${period}: headline ${money(value.headline)}, supplied service sum ${money(value.serviceSum)}, residual ${money(value.residual)} (${value.state}).`
  }).join(' ')
  return {
    id: 'business_booked_value_drivers', area: 'business', title: 'What explains booked-value movement?',
    status: !reconciled || change === null || decrease && gain ? 'mixed' : change === 0 ? 'unchanged' : 'observed', priority: 'context',
    ...(change === null ? {} : change < 0 ? { direction: 'declined' as const } : change > 0 ? { direction: 'improved' as const }
      : decrease && gain ? { direction: 'mixed' as const } : {}),
    observation: statement(`Scheduled booked value: ${money(account.current.bookedValue)} (prior ${money(account.prior.bookedValue)}). ${movement} ${decrease ? `Largest supported decrease: ${contribution(decrease)} ` : ''}${gain ? `Largest supported gain: ${contribution(gain)} ` : ''}${reconciled ? 'Supplied services reconcile to the headline in each period.' : 'The supplied services do not fully reconcile in both periods; the available contributions explain only the returned evidence.'} All-source ${OW.one}-created cohorts, ${data.context.range.from}–${data.context.range.to}, ${data.context.timezone}; the outcome source as of ${result.sourceAsOf ?? 'unavailable'}.`, ...evidence),
    materiality: { ...statement(`${result.services.length} supplied service rows are retained, including smaller and prior-only contributions. ${highlighted.length ? highlighted.map(contribution).join(' ') : 'No supported nonzero service change is available.'}`, ...highlighted.flatMap(refs)),
      priorityReason: 'Signed observed contributions explain the available movement; no business target or urgency threshold is inferred.' },
    explanations: [], counterEvidence: statement(`${residuals} ${decrease && gain ? 'Gains and losses offset; a net headline alone does not describe every service. ' : ''}Missing payment or optional intelligence does not erase supported scheduled value. Count and duration limits qualify only the arithmetic they support.`, ...evidence),
    nextInspection: { question: 'Optional: inspect every service contribution and its exact native inputs.', href: businessDetailHref(data, 'business-drivers'), outcomes: [
      { result: 'Each period reconciles and count/value populations are compatible.', interpretation: 'Read the symmetric components as an arithmetic explanation, with separate service gains and losses.' },
      { result: 'A residual, missing period or incompatible denominator remains.', interpretation: 'Retain supported monetary observations and leave the affected split unresolved.' },
    ] }, limitations: [...result.limitations, ...new Set(result.services.flatMap(row => row.limitations))],
    exposure: account.current.bookedValue !== null && account.evidence.bookedValue
      ? { value: account.current.bookedValue, unit: 'money', evidence: [account.evidence.bookedValue] } : null,
    authority: { state: 'diagnostic', executable: false },
  }
}
