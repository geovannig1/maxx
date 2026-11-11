import { describe, it, expect } from 'vitest'
import {
  reconcileGa4Bookings, renderGa4ReconciliationBlock, exactPaidEvidence,
} from '@/lib/ga4/booking-reconciliation'
import {
  classifyBusinessState, aggregateBusinessFacts, type LedgerAppointmentLite,
} from '@/lib/outcomes/business-facts'
import type { Ga4IdentifiedBookingEvent } from '@/lib/ga4/client'

// The booking-truth contract.
//
// Defect: the GA reader decided an event was a "test" when eventValue <= 0. GA carries the
// value the SCHEDULER DISPLAYED, so a comp (ledger price 0, nominal price_sold 145, canceled) arrived
// as a $145 event and counted as a real $145 booking.
// Defect 2: Maxx held TWO definitions of a booking — acuity/metrics.ts counted active
// zero-value rows, the reconciler did not, and both were labelled "bookings" in the same report.

// Fixtures declare their ORIGIN. 'website' means a by-id payload observed a client booking, so a GA
// confirmation event is EXPECTED — its absence is a real gap. Staff/manual appointments have no
// website session, so their absence from GA is normal. origin_unknown blocks exactness either way.
const appt = (o: Partial<LedgerAppointmentLite> & { id: number }): LedgerAppointmentLite => {
  const price = o.price === undefined ? 300 : o.price
  return {
    price,
    amount_paid: o.amount_paid === undefined ? (price ?? 0) : o.amount_paid,
    canceled: false,
    web_origin_state: 'website',
    ...o,
  }
}

const ev = (o: Partial<Ga4IdentifiedBookingEvent> & { appointmentId: number | null }): Ga4IdentifiedBookingEvent =>
  ({ channel: 'Paid Social', campaign: 'summer_studio', eventDate: '2026-05-10', value: 0, eventCount: 1, ...o })

const gaOk = (events: Ga4IdentifiedBookingEvent[]) => ({ available: true, events })
/** A window fully after a proven boundary — the only context in which anything may be exact. */
const COVERED = { windowStart: '2026-05-01', provenBoundary: '2026-04-01' }
const isPaid = (c: string) => c === 'Paid Social'

describe('business vocabulary — three states, never "test"', () => {
  it('[1] an active value-bearing appointment', () => {
    const f = aggregateBusinessFacts([appt({ id: 1, price: 220 })])
    expect(classifyBusinessState(appt({ id: 1, price: 220 }))).toBe('active_value_bearing')
    expect(f.confirmedAppointments).toBe(1)
    expect(f.valueBearingBookings).toBe(1)
    expect(f.bookedValue).toBe(220)
  })

  it('[2] an active $0 appointment is CONFIRMED but not value-bearing, and is NOT called a test', () => {
    const row = appt({ id: 2, price: 0 })
    expect(classifyBusinessState(row)).toBe('active_zero_value')
    const f = aggregateBusinessFacts([row])
    expect(f.confirmedAppointments).toBe(1)     // it is a real appointment
    expect(f.valueBearingBookings).toBe(0)
    expect(f.zeroValueAppointments).toBe(1)
    expect(f.bookedValue).toBe(0)
    // The state name itself must not assert a cause. It may be a package, gift certificate, staff
    // block, comp or test — the ledger cannot tell, so it must not say.
    expect(classifyBusinessState(row)).not.toMatch(/test|comp/)
  })

  it('[3] a 50%-deposit-shaped appointment keeps booked value and recorded payment DISTINCT', () => {
    const f = aggregateBusinessFacts([appt({ id: 3, price: 400, amount_paid: 200 })])
    expect(f.bookedValue).toBe(400)
    expect(f.observedCollectedValue).toBe(200)
    expect(f.bookedValue).toBeGreaterThan(f.observedCollectedValue)
  })

  it('[4] an UNPAID value-bearing appointment keeps booked value with zero recorded payment', () => {
    const f = aggregateBusinessFacts([appt({ id: 4, price: 300, amount_paid: 0 })])
    expect(f.valueBearingBookings).toBe(1)
    expect(f.bookedValue).toBe(300)
    expect(f.observedCollectedValue).toBe(0)   // NOT "cash collected"
    expect(f.amountPaidCoverage).toEqual({ withRecordedAmount: 1, total: 1 })
  })

  it('[5] a CANCELED PAID appointment leaves active performance, and its payment is not counted', () => {
    // Acuity does not necessarily reflect a processor refund, so its recorded payment on a canceled
    // row proves nothing about whether money was kept. It is excluded from the active figure rather
    // than asserted either way.
    const f = aggregateBusinessFacts([appt({ id: 5, price: 300, amount_paid: 300, canceled: true })])
    expect(f.confirmedAppointments).toBe(0)
    expect(f.canceledAppointments).toBe(1)
    expect(f.bookedValue).toBe(0)
    expect(f.observedCollectedValue).toBe(0)
  })

  it('[14] an active $0 appointment plus a real paid booking', () => {
    const f = aggregateBusinessFacts([appt({ id: 6, price: 0 }), appt({ id: 7, price: 250 })])
    expect(f.confirmedAppointments).toBe(2)
    expect(f.valueBearingBookings).toBe(1)
    expect(f.zeroValueAppointments).toBe(1)
    expect(f.bookedValue).toBe(250)              // only the paid booking
  })

  it('coverage counts recorded-amount PRESENCE, not collection', () => {
    const f = aggregateBusinessFacts([
      appt({ id: 8, price: 100, amount_paid: 0 }), appt({ id: 9, price: 100, amount_paid: null }),
    ])
    expect(f.amountPaidCoverage).toEqual({ withRecordedAmount: 1, total: 2 })
    expect(f.observedCollectedValue).toBe(0)
    expect(f.recordedOutcomeValue).toBeNull()
  })
})

describe('reconcileGa4Bookings — GA attributes, the ledger decides', () => {
  it('[6][7] an exact join contributes ATTRIBUTION only; the ledger contributes the booking and value', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 500, price: 220, amount_paid: 176 })],
      gaOk([ev({ appointmentId: 500, value: 999 })]), COVERED,   // GA's value disagrees and is IGNORED
    )
    expect(r.scope).toBe('exact_appointment_join')
    expect(r.business!.valueBearingBookings).toBe(1)
    expect(r.business!.bookedValue).toBe(220)             // ledger wins over GA's 999
    expect(r.byChannel).toEqual([
      { channel: 'Paid Social', campaign: 'summer_studio', valueBearingBookings: 1, bookedValue: 220, recordedRevenue: 176, zeroValueAppointments: 0 },
    ])
  })

  it('missing amount_paid blocks exact money even when identity and attribution are complete', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 505, price: 300, amount_paid: null })],
      gaOk([ev({ appointmentId: 505 })]), COVERED,
    )
    expect(r.business!.observedCollectedValue).toBe(0)
    expect(r.business!.recordedOutcomeValue).toBeNull()
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(r.scopeReason).toMatch(/collected value/i)
    expect(r.byChannel).toEqual([])
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
  })

  it('attributes a joined zero-price appointment with positive amount_paid without dropping revenue', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 506, price: 0, amount_paid: 25 })],
      gaOk([ev({ appointmentId: 506 })]), COVERED,
    )
    expect(r.scope).toBe('exact_appointment_join')
    expect(exactPaidEvidence(r, isPaid)).toEqual({
      valueBearingBookings: 0,
      bookedValue: 0,
      recordedRevenue: 25,
    })
  })

  it('blocks exact attribution when a website zero-price paid appointment has no GA event', () => {
    const r = reconcileGa4Bookings(
      [
        appt({ id: 507, price: 100, amount_paid: 100 }),
        appt({ id: 508, price: 0, amount_paid: 25 }),
      ],
      gaOk([ev({ appointmentId: 507 })]), COVERED,
    )
    expect(r.business!.recordedOutcomeValue).toBe(125)
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(r.unjoinedWebsiteBookings).toContain(508)
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
  })

  it('the canceled comp reported by GA at its NOMINAL price is excluded from bookings and value', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 501, price: 0, canceled: true })],
      gaOk([ev({ appointmentId: 501, value: 145 })]), COVERED
    )
    expect(r.business!.valueBearingBookings).toBe(0)
    expect(r.business!.bookedValue).toBe(0)
    expect(r.business!.canceledAppointments).toBe(1)
    expect(r.exactJoinedCanceled).toBe(1)                // the join happened; it is not a booking
    expect(r.byChannel).toEqual([])                      // canceled is never allocated
  })

  it('[8] ONE aggregate row with eventCount=2 is one booking with the duplicate surfaced', () => {
    // This is the adapter defect: a single GA row carrying eventCount=2 previously reached the
    // reconciler as one event object with the count discarded, so no duplicate was ever reported.
    const r = reconcileGa4Bookings(
      [appt({ id: 502, price: 300 })],
      gaOk([ev({ appointmentId: 502, eventCount: 2 })]), COVERED
    )
    expect(r.business!.valueBearingBookings).toBe(1)
    expect(r.duplicateAppointments).toEqual([{ appointmentId: 502, eventCount: 2 }])
    expect(r.byChannel[0].valueBearingBookings).toBe(1)  // counted ONCE
    expect(r.warnings.join(' ')).toMatch(/more than one GA confirmation event/)
  })

  it('[9] CONFLICTING attribution blocks exactness — it must not report a fabricated $0', () => {
    // THE review counterexample, and a test that previously ASSERTED the defect: it required
    // exactPaidEvidence to be {0, $0} for an appointment attributed to BOTH Paid Social and Organic
    // Search. The appointment was excluded from allocation while the scope still claimed exactness, so
    // a real booking rendered as "paid produced nothing".
    const r = reconcileGa4Bookings(
      [appt({ id: 503, price: 300 })],
      gaOk([ev({ appointmentId: 503, channel: 'Paid Social' }), ev({ appointmentId: 503, channel: 'Organic Search' })]), COVERED
    )
    expect(r.business!.valueBearingBookings).toBe(1)     // still a business booking
    expect(r.ambiguousAttribution).toEqual([{ appointmentId: 503, channels: ['Organic Search', 'Paid Social'], campaigns: ['summer_studio'] }])
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()      // UNAVAILABLE, not {0, $0}
    expect(r.scopeReason).toMatch(/CONFLICTING channel\/campaign attribution/)
    expect(r.scopeReason).toMatch(/fabricated zero/)
  })

  it('[9c] an UNJOINED website booking blocks exactness — its spend stays in the denominator', () => {
    // The other review counterexample: one identified $300 paid booking plus an unjoined $250 website
    // booking previously returned exact with paid = $300. The $250 left the numerator while its share
    // of spend stayed in the denominator, understating CPA.
    const r = reconcileGa4Bookings(
      [appt({ id: 510, price: 300 }), appt({ id: 511, price: 250 })],
      gaOk([ev({ appointmentId: 510 })]), COVERED
    )
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
    expect(r.unjoinedWebsiteBookings).toEqual([511])
    expect(r.scopeReason).toMatch(/WEBSITE-origin value-bearing outcome\(s\) produced no GA event/)
  })

  it('[9d] a STAFF/MANUAL booking with no GA event does NOT block exactness — it never had a session', () => {
    // Eligibility-aware: only bookings that SHOULD have produced a GA event count as gaps.
    const r = reconcileGa4Bookings(
      [appt({ id: 520, price: 300 }), appt({ id: 521, price: 250, web_origin_state: 'staff_or_manual' })],
      gaOk([ev({ appointmentId: 520 })]), COVERED
    )
    expect(r.scope).toBe('exact_appointment_join')
    expect(r.unjoinedWebsiteBookings).toEqual([])
    expect(exactPaidEvidence(r, isPaid)).toEqual({ valueBearingBookings: 1, bookedValue: 300, recordedRevenue: 300 })
  })

  it('[9e] an UNKNOWN-origin booking blocks exactness — it is neither required nor exempt', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 530, price: 300 }), appt({ id: 531, price: 250, web_origin_state: 'origin_unknown' })],
      gaOk([ev({ appointmentId: 530 })]), COVERED
    )
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
    expect(r.scopeReason).toMatch(/UNKNOWN origin/)
  })

  it('[9f] an UNKNOWN GA channel blocks a paid figure — it cannot be classified paid or organic', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 540, price: 300 })],
      gaOk([ev({ appointmentId: 540, channel: '(not set)' })]), COVERED
    )
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
    expect(r.scopeReason).toMatch(/UNKNOWN GA channel/)
  })

  it('[9g] an UNMATCHED GA id blocks exactness — the planes disagree about what exists', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 550, price: 300 })],
      gaOk([ev({ appointmentId: 550 }), ev({ appointmentId: 999999 })]), COVERED
    )
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
    expect(r.scopeReason).toMatch(/match no ledger appointment/)
  })

  it('[9b] conflicting CAMPAIGNS for one appointment are ambiguous too', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 504, price: 300 })],
      gaOk([ev({ appointmentId: 504, campaign: 'a' }), ev({ appointmentId: 504, campaign: 'b' })]), COVERED
    )
    expect(r.ambiguousAttribution[0].campaigns).toEqual(['a', 'b'])
    expect(r.byChannel).toEqual([])
  })

  it('[10] two appointments in the same minute remain independent', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 600, price: 300 }), appt({ id: 601, price: 250 })],
      gaOk([ev({ appointmentId: 600 }), ev({ appointmentId: 601 })]), COVERED
    )
    expect(r.business!.valueBearingBookings).toBe(2)
    expect(r.business!.bookedValue).toBe(550)
    expect(r.byChannel[0].valueBearingBookings).toBe(2)
  })

  it('[11] a window whose events ALL lack appointment_id is LEGACY_UNLINKED, never an exact zero', () => {
    // THE review counterexample. This previously returned scope=exact_appointment_join and
    // exactPaidEvidence {0 bookings, $0} — an exact-looking zero manufactured from no identity.
    const r = reconcileGa4Bookings(
      [appt({ id: 900, price: 300 })],
      gaOk([ev({ appointmentId: null, eventCount: 5 })]), COVERED
    )
    expect(r.scope).toBe('legacy_unlinked')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()       // NOT {0,0}
    expect(r.coverage).toMatchObject({ totalEvents: 5, identifiedEvents: 0, ratio: 0 })
    expect(r.byChannel).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/LEGACY\/UNLINKED/)
    expect(r.warnings.join(' ')).toMatch(/fabricated zero/)
    // The booking is still real; only its attribution is missing.
    expect(r.business!.valueBearingBookings).toBe(1)
    expect(r.business!.bookedValue).toBe(300)
  })

  it('[11b] PARTIAL coverage never produces money — the subset would meet full-window spend', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 910, price: 300 }), appt({ id: 911, price: 200 })],
      gaOk([ev({ appointmentId: 910 }), ev({ appointmentId: null })]), COVERED
    )
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
    expect(r.byChannel).toEqual([])                       // not allocated at all
    expect(r.warnings.join(' ')).toMatch(/only 1 of 2 GA confirmation event/)
    expect(r.warnings.join(' ')).toMatch(/a partial numerator would be divided by spend for the ENTIRE window/)
  })

  it('[11c] full in-window coverage but a window PREDATING the proven boundary is not exact', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 920, price: 300 })],
      gaOk([ev({ appointmentId: 920 })]),
      { windowStart: '2026-03-01', provenBoundary: '2026-04-01' },
    )
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
    expect(r.scopeReason).toMatch(/before the proven appointment_id boundary 2026-04-01/)
  })

  it('[11d] no boundary proven yet ⇒ nothing is exact, however clean the window looks', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 930, price: 300 })],
      gaOk([ev({ appointmentId: 930 })]),
      { windowStart: '2026-05-01', provenBoundary: null },
    )
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(r.scopeReason).toMatch(/no appointment_id boundary has been proven/)
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
  })

  it('[11e] a window with NO GA events is no_events_observed — not a measured zero', () => {
    const r = reconcileGa4Bookings([appt({ id: 940, price: 300 })], gaOk([]), COVERED)
    expect(r.scope).toBe('no_events_observed')
    expect(exactPaidEvidence(r, isPaid)).toBeNull()
    expect(r.coverage.ratio).toBeNull()
    expect(r.business!.bookedValue).toBe(300)
    expect(r.warnings.join(' ')).toMatch(/not proof of zero|not a measurement that zero bookings occurred|none may be reported as zero/)
  })

  it('a GA event matching no ledger row is unmatched telemetry, never a booking', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 700, price: 300 })],
      gaOk([ev({ appointmentId: 700 }), ev({ appointmentId: 999999 })]), COVERED
    )
    expect(r.business!.valueBearingBookings).toBe(1)
    expect(r.unmatchedGaEvents).toEqual([999999])
    expect(r.warnings.join(' ')).toMatch(/NOT bookings/)
  })

  it('[12] GA configuration failure: ledger totals stand, exact paid evidence is UNAVAILABLE', () => {
    const r = reconcileGa4Bookings(
      [appt({ id: 1300, price: 300 }), appt({ id: 1301, price: 200 })],
      { available: false, reason: 'PENDING CONFIGURATION', events: [] },
    )
    expect(r.scope).toBe('pending_configuration')
    expect(r.business!.valueBearingBookings).toBe(2)      // NOT zero
    expect(r.business!.bookedValue).toBe(500)
    expect(exactPaidEvidence(r, isPaid)).toBeNull()      // money surfaces get NOTHING to substitute
    expect(r.warnings.join(' ')).toMatch(/NOT evidence of zero bookings/)
    const text = renderGa4ReconciliationBlock(r).join('\n')
    expect(text).toMatch(/Web attribution: UNAVAILABLE/)
    expect(text).toMatch(/Paid CPA, paid ROAS and campaign ROAS from exact bookings are therefore UNAVAILABLE/)
    expect(text).toMatch(/Unavailable is NOT zero/)
  })

  it('[13] a native purchase alongside appointment_confirmed can never become a second booking', () => {
    // The native `purchase` family is a DIFFERENT GA event and is never read by this path. Even two
    // confirmation events for one appointment produce one booking.
    const r = reconcileGa4Bookings(
      [appt({ id: 1400, price: 300 })],
      gaOk([ev({ appointmentId: 1400 }), ev({ appointmentId: 1400 })]), COVERED
    )
    expect(r.business!.confirmedAppointments).toBe(1)
    expect(renderGa4ReconciliationBlock(r).join('\n')).toMatch(/NEVER added to these appointments/)
  })
})

describe('rendered block — every number states its source and scope', () => {
  it('names the ledger as the source and separates booked value from recorded payment', () => {
    const r = reconcileGa4Bookings([appt({ id: 1, price: 300, amount_paid: 150 })], gaOk([ev({ appointmentId: 1 })]))
    const text = renderGa4ReconciliationBlock(r).join('\n')
    expect(text).toMatch(/SOURCE: outcome ledger\. GA4 contributes no count and no money/)
    expect(text).toMatch(/scheduled charged price.*separate from checkout revenue/)
    expect(text).toMatch(/Recorded collected value: \$150\.00/)
    expect(text).toMatch(/amount_paid collected at checkout after discounts/)
    expect(text).toMatch(/NOT labelled tests/)
    expect(text).not.toMatch(/excludes \$0/)
  })
})

// ── Review: focused behavioural regressions for the newest contracts ─────────────────
// The broad AST/string guards cannot substitute for output-level behaviour, so each of these asserts
// the VALUE a consumer receives, not the shape of the source.
describe('origin contradictions (behavioural)', () => {
  const isPaidCh = (c: string) => c === 'Paid Social'
  const COV = { windowStart: '2026-05-01', provenBoundary: '2026-04-01' }
  const e = (o: Partial<Ga4IdentifiedBookingEvent> & { appointmentId: number | null }): Ga4IdentifiedBookingEvent =>
    ({ channel: 'Paid Social', campaign: 'c', eventDate: '2026-05-10', value: 0, eventCount: 1, ...o })

  it('a staff/manual appointment with a PAID GA event never becomes paid money', () => {
    const r = reconcileGa4Bookings(
      [{ id: 1, price: 300, canceled: false, web_origin_state: 'staff_or_manual' }],
      { available: true, events: [e({ appointmentId: 1 })] }, COV)
    expect(r.originContradictions).toEqual([1])
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaidCh)).toBeNull()
    expect(r.byChannel).toEqual([])
    expect(r.scopeReason).toMatch(/STAFF\/MANUAL ledger origin yet produced a GA confirmation event/)
  })

  it('the contradiction poisons the WHOLE window, not just that appointment', () => {
    // Otherwise a clean booking beside a contradicted one would still yield an "exact" paid figure.
    const r = reconcileGa4Bookings(
      [{ id: 1, price: 300, amount_paid: 300, canceled: false, web_origin_state: 'website' },
       { id: 2, price: 250, amount_paid: 250, canceled: false, web_origin_state: 'staff_or_manual' }],
      { available: true, events: [e({ appointmentId: 1 }), e({ appointmentId: 2 })] }, COV)
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(exactPaidEvidence(r, isPaidCh)).toBeNull()
  })

  it('a staff/manual appointment with NO GA event is fine — it never had a session', () => {
    const r = reconcileGa4Bookings(
      [{ id: 1, price: 300, amount_paid: 300, canceled: false, web_origin_state: 'website' },
       { id: 2, price: 250, amount_paid: 250, canceled: false, web_origin_state: 'staff_or_manual' }],
      { available: true, events: [e({ appointmentId: 1 })] }, COV)
    expect(r.originContradictions).toEqual([])
    expect(r.scope).toBe('exact_appointment_join')
    expect(exactPaidEvidence(r, isPaidCh)).toEqual({ valueBearingBookings: 1, bookedValue: 300, recordedRevenue: 300 })
  })
})
