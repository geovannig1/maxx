import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import { getGa4IdentifiedBookingEvents, GA4_BOOKINGS_SCOPE_NOTE, type Ga4IdentifiedBookingEvent } from './client'
import {
  aggregateBusinessFacts, classifyBusinessState, webOriginOf,
  type BusinessFacts, type LedgerAppointmentLite as OutcomeLedgerRow,
} from '@/lib/outcomes/business-facts'
import { requireOutcomeLedgerHealth } from '@/lib/outcomes/source-health'
import { listOutcomeAdapters } from '@/lib/outcomes/registry'
import { requireOutcomeCurrency } from '@/lib/outcomes/aggregation'
import { formatMoney } from '@/lib/utils/format-currency'

/** A ledger row the GA join can use: its source's analytics event carries the numeric external id. */
type LedgerAppointmentLite = OutcomeLedgerRow & { id: number }

/** Outcome source kinds whose website analytics event carries the outcome's external id (the GA join
 *  key). Other sources' outcomes are outside this reconciliation, never mis-joined by a look-alike id. */
export function gaJoinableKinds(): string[] {
  return listOutcomeAdapters().filter((a) => a.capabilities.analyticsEventCarriesExternalId).map((a) => a.kind)
}

/** PURE. Rows of GA-joinable sources, keyed by their numeric external id for the GA join. */
export function gaJoinableLedger<T extends Omit<OutcomeLedgerRow, 'id'> & { externalId: string; sourceKind: string }>(
  rows: readonly T[],
): Array<T & { id: number }> {
  const kinds = new Set(gaJoinableKinds())
  return rows.filter((row) => kinds.has(row.sourceKind)).map((row) => {
    const id = Number(row.externalId)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('ga_join_external_id_not_numeric')
    return { ...row, id }
  })
}

// GA4 <-> outcome ledger reconciliation.
//
//   outcome ledger = booking existence, lifecycle/zero-value state, booked value.
//   GA4           = browser/session attribution FOR a ledger appointment. It never creates a booking,
//                   never supplies value, never removes one.
//   Meta          = modelled/delivery attribution, kept elsewhere and never merged in here.
//
// Business facts are computed by the SHARED classifier (src/lib/outcomes/business-facts.ts, mirroring
// v_business_outcomes) so this module cannot hold a second definition of a booking — which is exactly what
// An earlier reader counted active $0 rows as bookings while this module did
// not, and both numbers were labelled "bookings" in the same report.

/** Why an exact, unit-scoped attribution answer is or is not available.
 *
 *  `legacy_unlinked` was declared here and NEVER assigned — a successful GA query always
 *  produced `exact_appointment_join`, so a window whose events all lacked appointment_id yielded an
 *  exact-looking {0 bookings, $0}. Identity coverage is now measured and every state is reachable.
 *
 *  ONLY `exact_appointment_join` may back a money figure, and it requires all three:
 *    1. at least one GA confirmation event in the window,
 *    2. EVERY event carries appointment_id (no partial coverage), and
 *    3. the window starts at or after the PROVEN appointment_id boundary (`ga4_identity_boundary`) — otherwise
 *       ledger bookings that predate identity can never be joined, and dividing full-window spend by
 *       the identified subset manufactures an incomplete CPA. */
export type AttributionScope =
  | 'exact_appointment_join'
  /** Events exist, NONE carry appointment_id. Historical data. Never money-actionable. */
  | 'legacy_unlinked'
  /** Some events carry appointment_id and some do not, or the window straddles the boundary. */
  | 'mixed_partial_coverage'
  /** GA returned no confirmation events at all: nothing to attribute, and not proof of zero bookings. */
  | 'no_events_observed'
  | 'pending_configuration'
  | 'unavailable'

/** Identity coverage over the window. Reported on every result so a consumer can never mistake
 *  "unmeasured" for "measured zero". */
export interface IdentityCoverage {
  totalEvents: number
  identifiedEvents: number
  /** identifiedEvents / totalEvents, or null when there were no events to measure. */
  ratio: number | null
  /** The proven boundary, when one exists. Null means appointment_id has never been observed. */
  provenBoundary: string | null
  /** True when the requested window begins at or after the proven boundary. */
  windowStartsAfterBoundary: boolean
}

export interface ChannelAttribution {
  channel: string
  /** GA sessionCampaignName. Allocation is keyed by the (channel, campaign) PAIR, so one channel
   *  spanning two campaigns produces two rows rather than a blended one. */
  campaign: string
  /** Distinct ledger appointments, active and value-bearing, joined by exact appointment id. */
  valueBearingBookings: number
  /** LEDGER booked value for those appointments. Never a GA eventValue. */
  bookedValue: number
  /** Owner-confirmed outcome-source checkout revenue (`amount_paid`) for those appointments. */
  recordedRevenue: number
  /** Distinct ledger appointments, active but zero-value, joined by exact id. */
  zeroValueAppointments: number
}

export interface Ga4LedgerReconciliation {
  scope: AttributionScope
  /** Present whenever scope is not exact. Never means "zero bookings". */
  scopeReason: string | null
  coverage: IdentityCoverage
  /** ALWAYS from the ledger, computed BEFORE GA is consulted.
   *
   *  NULL when the ledger could not be read. This used to fall back to EMPTY_BUSINESS_FACTS
   *  on a failed read, so a ledger OUTAGE rendered as "Confirmed appointments: 0, Booked value: $0.00"
   *  above a "ledger read failed" line, and economics — seeing no exception and a non-null object —
   *  presented those zeros as outcome-source facts. Absence is no longer encoded as a factual payload. */
  business: BusinessFacts | null
  /** Present exactly when `business` is null. */
  businessUnavailableReason: string | null
  /** Exact per-channel allocation. EMPTY unless scope === 'exact_appointment_join'. */
  byChannel: ChannelAttribution[]
  /** Ledger appointments joined to a GA event, by state. */
  exactJoinedValueBearing: number
  exactJoinedZeroValue: number
  exactJoinedCanceled: number
  /** GA appointment ids matching NO ledger row — a reconciliation defect, not bookings. */
  unmatchedGaEvents: number[]
  /** Active outcome-bearing appointments with no GA event: kept in totals, attribution unavailable. */
  ledgerWithoutGa: number[]
  /** The subset of ledgerWithoutGa whose origin says a WEBSITE session created them, so a GA event was
   *  expected and is genuinely missing. These block exactness; staff/manual ones do not. */
  unjoinedWebsiteBookings: number[]
  /** Outcome-bearing appointments whose origin was never established. They can be placed in neither group,
   *  so they block exactness rather than being assumed joinable or exempt. */
  unknownOriginBookings: number[]
  /** Allocated events whose GA channel is a placeholder ((not set)/(direct)/unknown). An unknown
   *  channel cannot be classified paid or organic, so it blocks a paid figure. */
  unknownChannelAppointments: number[]
  /** Appointments whose LEDGER ORIGIN says staff/manual — no website session — yet which DID produce a
   *  GA confirmation event. The two planes contradict each other, so neither can be trusted for this
   *  appointment: it is never allocated, and the window is not exact until one of them is corrected. */
  originContradictions: number[]
  /** Active appointments for which the outcome source did not supply amount_paid. Any one blocks exact money. */
  missingAmountPaidAppointments: number[]
  /** GA events carrying no appointment identity. Never exact, never money-actionable. */
  legacyUnlinkedEvents: number
  /** Appointments whose GA rows summed to more than one confirmation event. */
  duplicateAppointments: Array<{ appointmentId: number; eventCount: number }>
  /** Appointments whose GA rows disagree on channel OR on campaign. Still business bookings, still
   *  in every business total; EXCLUDED from byChannel, because picking the first row would be a coin
   *  flip presented as attribution. */
  ambiguousAttribution: Array<{ appointmentId: number; channels: string[]; campaigns: string[] }>
  warnings: string[]
}

const NO_COVERAGE: IdentityCoverage = {
  totalEvents: 0, identifiedEvents: 0, ratio: null, provenBoundary: null, windowStartsAfterBoundary: false,
}

const emptyRecon = (
  scope: AttributionScope, reason: string, business: BusinessFacts | null, warnings: string[],
  coverage: IdentityCoverage = NO_COVERAGE, businessUnavailableReason: string | null = null,
): Ga4LedgerReconciliation => ({
  scope, scopeReason: reason, coverage, business, businessUnavailableReason, byChannel: [],
  unjoinedWebsiteBookings: [], unknownOriginBookings: [], unknownChannelAppointments: [],
  originContradictions: [], missingAmountPaidAppointments: [],
  exactJoinedValueBearing: 0, exactJoinedZeroValue: 0, exactJoinedCanceled: 0,
  unmatchedGaEvents: [], ledgerWithoutGa: [], legacyUnlinkedEvents: 0,
  duplicateAppointments: [], ambiguousAttribution: [], warnings,
})

/** PURE. Joins GA confirmation events to ledger appointments by exact id.
 *
 *  Business facts are computed from the ledger before GA is read and are never adjusted by it, so no
 *  GA condition — absent, duplicated, unmatched or unavailable — can move a business number. */
export function reconcileGa4Bookings(
  ledger: LedgerAppointmentLite[],
  ga: { available: boolean; reason?: string; events: Ga4IdentifiedBookingEvent[] },
  /** The window being measured and the PROVEN boundary. Omitted only by callers that do not have
   *  them; without a boundary no window can qualify as exact, which is the safe direction. */
  ctx: { windowStart?: string; provenBoundary?: string | null } = {},
): Ga4LedgerReconciliation {
  const business = aggregateBusinessFacts(ledger)
  const stateOf = (r: LedgerAppointmentLite) => r.business_state ?? classifyBusinessState(r)

  if (!ga.available) {
    return emptyRecon('pending_configuration', ga.reason ?? 'GA appointment identity unavailable.', business, [
      `GA web attribution is UNAVAILABLE (${ga.reason ?? 'no reason given'}). The business facts below are ledger facts and are unaffected. This is NOT evidence of zero bookings, and no unit-level money action may rely on it.`,
    ])
  }

  // ── IDENTITY COVERAGE, measured before anything is called exact ─────────────────────────────────
  const totalEvents = ga.events.reduce((n, e) => n + e.eventCount, 0)
  const identifiedEvents = ga.events.filter((e) => e.appointmentId !== null).reduce((n, e) => n + e.eventCount, 0)
  const provenBoundary = ctx.provenBoundary ?? null
  const windowStartsAfterBoundary =
    provenBoundary !== null && ctx.windowStart !== undefined && ctx.windowStart >= provenBoundary
  const coverage: IdentityCoverage = {
    totalEvents, identifiedEvents,
    ratio: totalEvents === 0 ? null : identifiedEvents / totalEvents,
    provenBoundary, windowStartsAfterBoundary,
  }

  if (totalEvents === 0) {
    return emptyRecon('no_events_observed',
      'GA returned no confirmation events for this window. That is an absence of ATTRIBUTION data, not a measurement that zero bookings occurred.',
      business,
      ['No GA confirmation events in this window. Ledger facts below are unaffected; no paid CPA, ROAS or MER can be computed, and none may be reported as zero.'],
      coverage)
  }
  if (identifiedEvents === 0) {
    return emptyRecon('legacy_unlinked',
      `All ${totalEvents} GA confirmation event(s) in this window lack appointment_id — historical data predating the custom dimension.`,
      business,
      [`${totalEvents} GA confirmation event(s) carry NO appointment identity. They cannot be joined, deduplicated against the ledger, or valued. LEGACY/UNLINKED: never an exact join, never a business booking, and NOT usable to justify a money action. Reporting "0 exact paid bookings" from this window would be a fabricated zero.`],
      coverage)
  }

  const ledgerById = new Map(ledger.map((r) => [r.id, r]))
  // eventCount is SUMMED per appointment, not counted per row: GA returns aggregate rows, so one row
  // with eventCount=2 is two emissions of the same confirmation, not one.
  const counts = new Map<number, number>()
  const channels = new Map<number, Set<string>>()
  const campaigns = new Map<number, Set<string>>()
  let legacyUnlinkedEvents = 0

  for (const e of ga.events) {
    if (e.appointmentId === null) { legacyUnlinkedEvents += e.eventCount; continue }
    counts.set(e.appointmentId, (counts.get(e.appointmentId) ?? 0) + e.eventCount)
    if (!channels.has(e.appointmentId)) channels.set(e.appointmentId, new Set())
    channels.get(e.appointmentId)!.add(e.channel)
    if (!campaigns.has(e.appointmentId)) campaigns.set(e.appointmentId, new Set())
    campaigns.get(e.appointmentId)!.add(e.campaign)
  }

  const unmatchedGaEvents = [...counts.keys()].filter((id) => !ledgerById.has(id)).sort((a, b) => a - b)
  const matchedIds = [...counts.keys()].filter((id) => ledgerById.has(id))

  const duplicateAppointments = matchedIds
    .filter((id) => (counts.get(id) ?? 0) > 1)
    .map((id) => ({ appointmentId: id, eventCount: counts.get(id)! }))
    .sort((a, b) => a.appointmentId - b.appointmentId)

  // Ambiguous on EITHER axis: conflicting channels or conflicting campaigns for one appointment.
  const ambiguousAttribution = matchedIds
    .filter((id) => (channels.get(id)?.size ?? 0) > 1 || (campaigns.get(id)?.size ?? 0) > 1)
    .map((id) => ({ appointmentId: id, channels: [...channels.get(id)!].sort(), campaigns: [...campaigns.get(id)!].sort() }))
    .sort((a, b) => a.appointmentId - b.appointmentId)
  const ambiguousIds = new Set(ambiguousAttribution.map((x) => x.appointmentId))

  // A staff/manual appointment has NO website session by definition, so a GA confirmation event for it
  // is a contradiction between the origin plane and the GA plane — not evidence of a paid booking.
  // A review reproduced this: origin staff_or_manual + a Paid Social event became an exact paid
  // booking of $300. Origin was only ever consulted about ABSENT events; a PRESENT one was never
  // validated against it.
  const originContradictions = matchedIds
    .filter((id) => webOriginOf(ledgerById.get(id)!) === 'staff_or_manual')
    .sort((a, b) => a - b)
  const contradicted = new Set(originContradictions)

  let exactJoinedValueBearing = 0, exactJoinedZeroValue = 0, exactJoinedCanceled = 0
  const perChannel = new Map<string, ChannelAttribution>()
  for (const id of matchedIds) {
    const row = ledgerById.get(id)!
    const st = stateOf(row)
    if (st === 'active_value_bearing') exactJoinedValueBearing += 1
    else if (st === 'active_zero_value') exactJoinedZeroValue += 1
    else exactJoinedCanceled += 1

    // Never allocated: source-excluded, ambiguous, or origin-contradicted.
    if (st === 'canceled' || ambiguousIds.has(id) || contradicted.has(id)) continue
    const channel = [...channels.get(id)!][0]
    const campaign = [...campaigns.get(id)!][0]
    const key = `${channel}\u0000${campaign}`
    const a = perChannel.get(key) ?? {
      channel, campaign, valueBearingBookings: 0, bookedValue: 0, recordedRevenue: 0,
      zeroValueAppointments: 0,
    }
    if (st === 'active_value_bearing') {
      a.valueBearingBookings += 1
      a.bookedValue += row.price ?? 0
      if (row.amount_paid != null) a.recordedRevenue += row.amount_paid
    } else {
      a.zeroValueAppointments += 1
      if (row.amount_paid != null) a.recordedRevenue += row.amount_paid
    }
    perChannel.set(key, a)
  }

  const joined = new Set(matchedIds)
  const outcomeBearingUnjoined = ledger.filter((row) => {
    if (stateOf(row) === 'canceled' || joined.has(row.id)) return false
    return (row.price ?? 0) > 0 || (row.amount_paid ?? 0) > 0
  })
  const ledgerWithoutGa = outcomeBearingUnjoined.map((r) => r.id).sort((a, b) => a - b)
  // ORIGIN decides whether an absent GA event is a gap or expected. A staff/manual appointment has no
  // website session, so its absence is normal and must not block exactness.
  const unjoinedWebsiteBookings = outcomeBearingUnjoined.filter((r) => webOriginOf(r) === 'website').map((r) => r.id).sort((a, b) => a - b)
  const unknownOriginBookings = ledger
    .filter((row) => stateOf(row) !== 'canceled'
      && ((row.price ?? 0) > 0 || (row.amount_paid ?? 0) > 0)
      && webOriginOf(row) === 'origin_unknown')
    .map((r) => r.id).sort((a, b) => a - b)
  const UNKNOWN_CHANNELS = new Set(['(unknown)', '(not set)', '(direct)', '(none)', ''])
  const unknownChannelAppointments = matchedIds
    .filter((id) => { const row = ledgerById.get(id)!; return stateOf(row) !== 'canceled' })
    .filter((id) => [...(channels.get(id) ?? [])].some((c) => UNKNOWN_CHANNELS.has(c.toLowerCase()) || UNKNOWN_CHANNELS.has(c)))
    .sort((a, b) => a - b)
  const missingAmountPaidAppointments = ledger
    .filter((row) => stateOf(row) !== 'canceled' && row.amount_paid == null)
    .map((row) => row.id)
    .sort((a, b) => a - b)

  const warnings: string[] = []
  if (unmatchedGaEvents.length) warnings.push(`${unmatchedGaEvents.length} GA confirmation event id(s) match NO ledger appointment — a reconciliation defect (GA fired for something the ledger never recorded). Unmatched telemetry, NOT bookings.`)
  if (duplicateAppointments.length) warnings.push(`${duplicateAppointments.length} appointment(s) emitted more than one GA confirmation event (${duplicateAppointments.map((d) => `${d.appointmentId}x${d.eventCount}`).join(', ')}). Each counts ONCE; the duplicates indicate a missing per-page latch in the browser handler.`)
  if (ambiguousAttribution.length) warnings.push(`${ambiguousAttribution.length} appointment(s) appear under CONFLICTING channels. They remain business bookings but are EXCLUDED from channel allocation — choosing one would be a guess presented as attribution.`)
  if (legacyUnlinkedEvents) warnings.push(`${legacyUnlinkedEvents} GA confirmation event(s) carry no appointment_id (they predate the custom dimension). LEGACY/UNLINKED — never exact, and not usable to justify a money action.`)
  if (ledgerWithoutGa.length) warnings.push(`${ledgerWithoutGa.length} outcome-bearing appointment(s) have no GA confirmation event. Appointment and outcome-source values are RETAINED; only their web attribution is unavailable.`)

  // ── EXACTNESS: every way the picture can be incomplete ──────────────────────────────────────────
  //
  // This previously required only (a) every OBSERVED event carries an id and (b) the window
  // is after the boundary. It never asked whether every booking that SHOULD have produced an event
  // actually did, nor whether the events it did have were unambiguous. Both reproduced:
  //   * an unjoined $250 website booking left the numerator while its spend stayed in the denominator
  //   * an appointment attributed to BOTH Paid Social and Organic Search produced an exact {0, $0}
  //
  // A paid figure is only complete when NOTHING is unresolved.
  const blockers: string[] = []
  const fullCoverage = identifiedEvents === totalEvents
  if (!fullCoverage) blockers.push(`only ${identifiedEvents} of ${totalEvents} GA confirmation event(s) carry appointment_id`)
  if (!windowStartsAfterBoundary) {
    blockers.push(provenBoundary === null
      ? 'no appointment_id boundary has been proven for this account yet'
      : `the window starts ${ctx.windowStart ?? '(unknown)'}, before the proven appointment_id boundary ${provenBoundary}`)
  }
  if (unjoinedWebsiteBookings.length > 0) {
    blockers.push(`${unjoinedWebsiteBookings.length} WEBSITE-origin outcome-bearing appointment(s) produced no GA event (${unjoinedWebsiteBookings.slice(0, 5).join(', ')}${unjoinedWebsiteBookings.length > 5 ? ', …' : ''}) — they belong in the numerator but are missing from it`)
  }
  if (unknownOriginBookings.length > 0) {
    blockers.push(`${unknownOriginBookings.length} outcome-bearing appointment(s) have an UNKNOWN origin, so they can be neither required to join nor exempted`)
  }
  if (ambiguousAttribution.length > 0) {
    blockers.push(`${ambiguousAttribution.length} appointment(s) carry CONFLICTING channel/campaign attribution — excluding them from allocation while calling the result exact would report a fabricated zero`)
  }
  if (unmatchedGaEvents.length > 0) {
    blockers.push(`${unmatchedGaEvents.length} GA event id(s) match no ledger appointment, so the two planes disagree about what exists`)
  }
  if (unknownChannelAppointments.length > 0) {
    blockers.push(`${unknownChannelAppointments.length} joined appointment(s) carry an UNKNOWN GA channel, which cannot be classified paid or organic`)
  }
  if (originContradictions.length > 0) {
    blockers.push(`${originContradictions.length} appointment(s) have a STAFF/MANUAL ledger origin yet produced a GA confirmation event (${originContradictions.slice(0, 5).join(', ')}${originContradictions.length > 5 ? ', …' : ''}) — the origin and GA planes CONTRADICT each other, so neither can be trusted for them until one is corrected`)
  }
  if (missingAmountPaidAppointments.length > 0) {
    blockers.push(`${missingAmountPaidAppointments.length} active appointment(s) lack recorded collected value (${missingAmountPaidAppointments.slice(0, 5).join(', ')}${missingAmountPaidAppointments.length > 5 ? ', …' : ''}); checkout revenue is an observed lower bound, not an exact numerator`)
  }

  if (blockers.length > 0) {
    const why = blockers.join('; ')
    warnings.push(`Attribution is INCOMPLETE — ${why}. Exact paid CPA/ROAS are UNAVAILABLE for this window: a partial numerator would be divided by spend for the ENTIRE window. This is NOT a measurement of zero.`)
    return {
      scope: 'mixed_partial_coverage', scopeReason: why, coverage, business, businessUnavailableReason: null,
      byChannel: [], // deliberately NOT allocated — partial allocation reads as complete
      exactJoinedValueBearing, exactJoinedZeroValue, exactJoinedCanceled,
      unmatchedGaEvents, ledgerWithoutGa, unjoinedWebsiteBookings, unknownOriginBookings,
      unknownChannelAppointments, originContradictions, missingAmountPaidAppointments,
      legacyUnlinkedEvents,
      duplicateAppointments, ambiguousAttribution, warnings,
    }
  }

  return {
    scope: 'exact_appointment_join', scopeReason: null, coverage, business, businessUnavailableReason: null,
    byChannel: [...perChannel.values()].sort((a, b) => b.valueBearingBookings - a.valueBearingBookings),
    exactJoinedValueBearing, exactJoinedZeroValue, exactJoinedCanceled,
    unmatchedGaEvents, ledgerWithoutGa, unjoinedWebsiteBookings, unknownOriginBookings,
    unknownChannelAppointments, originContradictions, missingAmountPaidAppointments,
    legacyUnlinkedEvents,
    duplicateAppointments, ambiguousAttribution, warnings,
  }
}

/** PURE: report lines that always state their evidence scope. */
export function renderGa4ReconciliationBlock(r: Ga4LedgerReconciliation): string[] {
  const lines: string[] = ['=== BOOKING TRUTH (outcome ledger) vs WEB ATTRIBUTION (GA4) ===']

  // A ledger OUTAGE is not a business fact. It must never render as counts of zero.
  if (r.business === null) {
    lines.push(`  Business facts: UNAVAILABLE — the outcome ledger could not be read (${r.businessUnavailableReason ?? 'no reason given'}).`)
    lines.push('  There are NO booking counts and NO booked value in this report. UNAVAILABLE is not zero: do not describe business performance, and do not substitute GA telemetry.')
    lines.push(`  SCOPE: ${GA4_BOOKINGS_SCOPE_NOTE}.`)
    for (const w of r.warnings) lines.push(`  NOTE: ${w}`)
    return lines
  }

  const b = r.business
  lines.push(`  Confirmed appointments: ${b.confirmedAppointments} — of which ${b.valueBearingBookings} value-bearing and ${b.zeroValueAppointments} zero-value. SOURCE: outcome ledger. GA4 contributes no count and no dollar to this line.`)
  lines.push(`  Booked value: ${formatMoney(b.bookedValue)} (scheduled charged price over value-bearing appointments; separate from checkout revenue).`)
  if (b.recordedOutcomeValue === null) {
    lines.push(`  Recorded collected value: UNAVAILABLE — amount_paid exists for ${b.amountPaidCoverage.withRecordedAmount}/${b.amountPaidCoverage.total} active appointments. Observed amount_paid lower bound: ${formatMoney(b.observedCollectedValue)}. Never use that lower bound for MER or ROAS.`)
  } else {
    lines.push(`  Recorded collected value: ${formatMoney(b.recordedOutcomeValue)} across ${b.amountPaidCoverage.withRecordedAmount}/${b.amountPaidCoverage.total} active appointments. Owner-confirmed basis: amount_paid collected at checkout after discounts.`)
  }
  lines.push('  Zero-value appointments are REAL appointments that charged nothing (package, gift certificate, staff block, comp or test). The ledger cannot tell those apart, so they are NOT labelled tests.')
  if (r.scope !== 'exact_appointment_join') {
    lines.push(`  Web attribution: UNAVAILABLE (${r.scope}) — ${r.scopeReason}`)
    lines.push(`  Identity coverage: ${r.coverage.identifiedEvents}/${r.coverage.totalEvents} GA confirmation event(s) carry appointment_id${r.coverage.provenBoundary ? `; proven boundary ${r.coverage.provenBoundary}` : '; no boundary proven yet'}.`)
    lines.push('  Paid CPA, paid ROAS and campaign ROAS from exact bookings are therefore UNAVAILABLE. Unavailable is NOT zero, and no exact figure may be reported as 0.')
  } else {
    lines.push(`  Exact appointment-id joins: ${r.exactJoinedValueBearing} value-bearing and ${r.exactJoinedZeroValue} zero-value. Attribution is COMPLETE: every website-origin active appointment joined, no ambiguity, no unmatched ids, no unknown channels.`)
    for (const c of r.byChannel) {
      lines.push(`    ${c.channel} / ${c.campaign}: ${c.valueBearingBookings} value-bearing booking(s), ${formatMoney(c.recordedRevenue)} recorded collected value (${formatMoney(c.bookedValue)} scheduled booked value).`)
    }
  }
  lines.push(`  SCOPE: ${GA4_BOOKINGS_SCOPE_NOTE}.`)
  for (const w of r.warnings) lines.push(`  NOTE: ${w}`)
  lines.push('  Native `purchase` events from the scheduler\'s own GA4 integration are telemetry from a different event family and are NEVER added to these appointments.')
  return lines
}

/** A database failure as the model and the owner see it: a stable code. The raw database text
 *  (table, column, SQL state) goes to the server log only. */
function readFailure(code: string, detail: unknown): string {
  const text = detail instanceof Error ? detail.message
    : detail && typeof detail === 'object' && 'message' in detail ? String((detail as { message: unknown }).message)
    : String(detail)
  console.error(`[ga4-reconciliation] ${code}:`, text)
  return `${code} (details in the server log)`
}

/** Account-scoped ledger read + GA read + join. The one production entry point. */
export async function buildGa4ReconciliationBlock(
  adAccountDbId: string,
  startDate: string,
  endDate: string,
  supabase: SupabaseClient = getAdminClient(),
): Promise<{ reconciliation: Ga4LedgerReconciliation; lines: string[] }> {
  try {
    await requireOutcomeLedgerHealth(supabase, adAccountDbId, startDate, endDate)
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    // Domain reasons (stale, incomplete) are written by ledger-health and carry no database text;
    // a failed health read wraps the database error, so it is reduced to its code.
    const message = raw.startsWith('outcome_ledger_health_read_failed')
      ? readFailure('outcome_ledger_health_read_failed', raw)
      : raw
    const r = emptyRecon('unavailable', `ledger authority unavailable: ${message}`, null,
      [`The outcome ledger is not authoritative for this window (${message}). NO business or attribution number is available; every figure is UNAVAILABLE, never zero.`],
      NO_COVERAGE, message)
    return { reconciliation: r, lines: renderGa4ReconciliationBlock(r) }
  }
  // Paged AND ordered: an unpaged read silently truncates at Supabase's 1000-row default, which would
  // understate every business figure on a wide window; .range() without ORDER BY has no defined order.
  const ledgerRows: LedgerAppointmentLite[] = []
  let error: { message: string } | null = null
  for (let from = 0; ; from += 1000) {
    const page = await supabase
      .from('v_business_outcomes')
      .select('external_id, currency, price:gross_value, amount_paid:collected_value, status, business_state, web_origin_state')
      .eq('ad_account_id', adAccountDbId)
      .eq('source_enabled', true)
      .in('source_kind', gaJoinableKinds())
      .gte('business_date', startDate)
      .lte('business_date', endDate)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (page.error) { error = page.error; break }
    const rows = (page.data ?? []) as LedgerOutcomeRow[]
    requireOutcomeCurrency(rows)
    ledgerRows.push(...rows.map(toLedgerAppointment))
    if (rows.length < 1000) break
  }
  // GA joins on the source appointment id (external_id). Restore the old numeric-id order so every
  // downstream fold sees the rows in the same sequence it always did.
  ledgerRows.sort((a, b) => a.id - b.id)
  if (error) {
    // NULL business facts, not empty ones: absence must not be encodable as a factual payload.
    const reason = readFailure('ledger_read_failed', error)
    const r = emptyRecon('unavailable', `ledger read failed: ${reason}`, null,
      [`The outcome ledger could not be read (${reason}). NO business or attribution number is available; every figure is UNAVAILABLE, never zero.`],
      NO_COVERAGE, reason)
    return { reconciliation: r, lines: renderGa4ReconciliationBlock(r) }
  }
  const ledger = ledgerRows
  const ga = await getGa4IdentifiedBookingEvents(startDate, endDate)

  // Record the boundary from what was ACTUALLY OBSERVED, then read back the effective value. The RPC
  // only ever moves it earlier, so a later window cannot push it forward to make itself look covered.
  let provenBoundary: string | null = null
  try {
    const observed = ga.events
      .filter((e) => e.appointmentId !== null && e.eventDate)
      .map((e) => e.eventDate!)
      .sort()[0] ?? null
    const { data: b, error: bErr } = await supabase.rpc('record_ga4_identity_boundary', {
      p_account: adAccountDbId, p_date: observed,
    })
    if (bErr) throw new Error(bErr.message)
    provenBoundary = (b as string | null) ?? null
  } catch (e) {
    // Fail CLOSED: with no boundary, no window qualifies as exact.
    const msg = readFailure('identity_boundary_read_failed', e)
    const r = reconcileGa4Bookings(ledger, ga, { windowStart: startDate, provenBoundary: null })
    r.warnings.push(`the appointment_id boundary could not be read (${msg}) — exact attribution is treated as UNAVAILABLE rather than assumed`)
    return { reconciliation: r, lines: renderGa4ReconciliationBlock(r) }
  }

  const reconciliation = reconcileGa4Bookings(ledger, ga, { windowStart: startDate, provenBoundary })
  return { reconciliation, lines: renderGa4ReconciliationBlock(reconciliation) }
}

/** A `v_business_outcomes` row as read for the GA join (state 'cancelled' in the database). */
interface LedgerOutcomeRow {
  external_id: string
  currency: string
  price: number | null
  amount_paid: number | null
  status: string
  business_state: string | null
  web_origin_state: LedgerAppointmentLite['web_origin_state']
}

/** Read boundary: map an outcome row back to the appointment-flavoured pure type the join is written in. */
function toLedgerAppointment(row: LedgerOutcomeRow): LedgerAppointmentLite {
  const id = Number(row.external_id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('ga_join_external_id_not_numeric')
  return {
    id,
    price: row.price,
    amount_paid: row.amount_paid,
    canceled: row.status === 'cancelled',
    business_state: (row.business_state === 'cancelled' ? 'canceled' : row.business_state) as LedgerAppointmentLite['business_state'],
    web_origin_state: row.web_origin_state,
  }
}

/** Exact paid-channel evidence for money surfaces (economics, campaign ROAS, evidence gate).
 *
 *  Returns null unless the scope is an exact appointment-id join. Callers MUST render "unavailable"
 *  rather than substituting GA telemetry — that substitution is the defect this round removed. */
export function exactPaidEvidence(
  r: Ga4LedgerReconciliation,
  isPaidChannel: (channel: string) => boolean,
): { valueBearingBookings: number; bookedValue: number; recordedRevenue: number } | null {
  if (r.scope !== 'exact_appointment_join') return null
  const paid = r.byChannel.filter((c) => isPaidChannel(c.channel))
  return {
    valueBearingBookings: paid.reduce((s, c) => s + c.valueBearingBookings, 0),
    bookedValue: paid.reduce((s, c) => s + c.bookedValue, 0),
    recordedRevenue: paid.reduce((s, c) => s + c.recordedRevenue, 0),
  }
}
