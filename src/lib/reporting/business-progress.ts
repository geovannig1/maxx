import type { BusinessIntelligence, BusinessReport, ReportSection } from './contracts'

export const BUSINESS_INTELLIGENCE_LOADING_NOTE = 'Customer history, booking lead time and upcoming appointments are loading.'
export const BUSINESS_INTELLIGENCE_UNAVAILABLE_NOTE = 'Some business details could not finish. Validated booking totals remain available; retry this source.'

export function hasPendingBusinessIntelligence(report?: BusinessReport | null): boolean {
  return !!report?.intelligence && Object.values(report.intelligence).some(section => section.state === 'loading')
}
export function hasUnavailableBusinessIntelligence(report?: BusinessReport | null): boolean {
  return !!report?.intelligence && Object.values(report.intelligence).some(section => section.state === 'unavailable')
}
export function pendingBusinessIntelligence(): BusinessIntelligence {
  const pending = () => ({ state: 'loading' as const, data: null, asOf: null, notes: [BUSINESS_INTELLIGENCE_LOADING_NOTE] })
  return { customers: pending(), leadTime: pending(), upcoming: pending() }
}
export function finishBusinessProgress(result: ReportSection<BusinessReport>, note = BUSINESS_INTELLIGENCE_UNAVAILABLE_NOTE): ReportSection<BusinessReport> {
  if (!result.data) return result
  const unavailable = () => ({ state: 'unavailable' as const, data: null, asOf: null, notes: [note] })
  const intelligence = result.data.intelligence
  return { ...result, state: 'partial', data: { ...result.data, intelligence: {
    customers: !intelligence || intelligence.customers.state === 'loading' ? unavailable() : intelligence.customers,
    leadTime: !intelligence || intelligence.leadTime.state === 'loading' ? unavailable() : intelligence.leadTime,
    upcoming: !intelligence || intelligence.upcoming.state === 'loading' ? unavailable() : intelligence.upcoming,
  } }, notes: [...result.notes.filter(value => value !== BUSINESS_INTELLIGENCE_LOADING_NOTE), note] }
}
