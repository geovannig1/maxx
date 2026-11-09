import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import { groupOutcomeFacts, readOutcomeFacts, type ScopedOutcomeRow } from './reader'
import { businessFactsFromOutcomeFacts, type BusinessFacts, type LedgerAppointmentLite } from './business-facts'

// Business-outcome reads, expressed in the ONE business vocabulary (./business-facts.ts).
//
// An earlier reader held a SECOND, independent implementation of "what is a booking": it
// counted every non-cancelled row (including zero-value ones) while the business facts counted only
// value-bearing ones. Both were labelled "bookings" and both reached production.
//
// Nothing here classifies: every function delegates to the generic facts aggregation over the
// canonical v_business_outcomes view. An AST test asserts that module is the only classifier.
//
// Reads are ACCOUNT-SCOPED and SOURCE-SCOPED (./aggregation.ts): enabled sources only, each gated by
// its own completeness check, one currency.

export type { BusinessFacts, LedgerAppointmentLite }

/** One window's facts plus the scoped rows they came from. `rows` carry outcome uuids. */
export async function getBusinessFacts(
  adAccountDbId: string,
  startDate: string,
  endDate: string,
  supabase: SupabaseClient = getAdminClient(),
): Promise<{ facts: BusinessFacts; rows: ScopedOutcomeRow[] }> {
  const read = await readOutcomeFacts(supabase, adAccountDbId, startDate, endDate)
  return { facts: businessFactsFromOutcomeFacts(read.facts), rows: read.rows }
}

/** Business facts for a business-date window. */
export async function getBusinessFactsForWindow(
  adAccountDbId: string, start: string, end: string, supabase: SupabaseClient = getAdminClient(),
): Promise<BusinessFacts> {
  return businessFactsFromOutcomeFacts((await readOutcomeFacts(supabase, adAccountDbId, start, end)).facts)
}

export interface BusinessFactsBreakdownRow {
  valueBearingBookings: number
  zeroValueAppointments: number
  bookedValue: number
  observedCollectedValue: number
  recordedOutcomeValue: number | null
  amountPaidCoverage: { withRecordedAmount: number; total: number }
}

function breakdownRow(facts: BusinessFacts): BusinessFactsBreakdownRow {
  return {
    valueBearingBookings: facts.valueBearingBookings,
    zeroValueAppointments: facts.zeroValueAppointments,
    bookedValue: facts.bookedValue,
    observedCollectedValue: facts.observedCollectedValue,
    recordedOutcomeValue: facts.recordedOutcomeValue,
    amountPaidCoverage: facts.amountPaidCoverage,
  }
}

async function fetchWindow(
  adAccountDbId: string, start: string, end: string, supabase: SupabaseClient,
): Promise<ScopedOutcomeRow[]> {
  return (await readOutcomeFacts(supabase, adAccountDbId, start, end)).rows
}

/** Per-day breakdown. Gross value and recorded collected value stay separate. */
export async function getBusinessFactsByDay(
  adAccountDbId: string, start: string, end: string, supabase: SupabaseClient = getAdminClient(),
): Promise<Array<{ date: string } & BusinessFactsBreakdownRow>> {
  const byDay = groupOutcomeFacts(await fetchWindow(adAccountDbId, start, end, supabase), (r) => r.businessDate)
  return [...byDay.keys()].sort().map((date) => ({ date, ...breakdownRow(businessFactsFromOutcomeFacts(byDay.get(date)!)) }))
}

/** Per-outcome-label breakdown, richest gross value first. */
export async function getBusinessFactsByLabel(
  adAccountDbId: string, start: string, end: string, supabase: SupabaseClient = getAdminClient(),
): Promise<Array<{ type: string } & BusinessFactsBreakdownRow>> {
  const byType = groupOutcomeFacts(await fetchWindow(adAccountDbId, start, end, supabase), (r) => r.label ?? '(unknown)')
  return [...byType.entries()]
    .map(([type, outcomeFacts]) => ({ type, ...breakdownRow(businessFactsFromOutcomeFacts(outcomeFacts)) }))
    .sort((a, b) => b.bookedValue - a.bookedValue || b.valueBearingBookings - a.valueBearingBookings)
}
