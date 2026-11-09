import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { buildUserMessage, type ReportInputData } from '@/lib/report/prompt-builder'

// The daily report must present the Acuity ledger as the canonical business total, with GA4 relegated
// to the ad-attribution lens — the doctrine change behind the truth flip.

const base: ReportInputData = {
  date: '2026-03-11', accountName: 'Example Studio', currency: 'USD',
  accountInsights: { spend: 30, leads: 0, bookings: 2, impressions: 100, reach: 90, clicks: 5, ctr: 5, cpm: 300, cpl: null, cpb: 15, appointmentValue: null, roas: null },
  prevDayInsights: null, prev7dayInsights: null, topCampaigns: [], alerts: [],
}

const ga4 = {
  todayPaidConfirmationEvents: 1, todayPaidEventValue: 140, paidConfirmationEvents30: 9, paidEventValue30: 1180,
  todayOrganicConfirmationEvents: 2, todayOrganicEventValue: 360, organicConfirmationEvents30: 33, organicEventValue30: 7400, zeroValueEvents30: 0
}

describe('buildUserMessage — Acuity truth block', () => {
  it('renders the Acuity ledger block as BUSINESS TRUTH with amount_paid ratio and comp note', () => {
    const msg = buildUserMessage({
      ...base,
      ga4,
      outcomes: { todayConfirmedAppointments: 4, todayValueBearingBookings: 3, todayBookedValue: 687.5, todayObservedCollectedValue: 620, todayRecordedOutcomeValue: 620, todayAmountPaidCoverage: { withRecordedAmount: 4, total: 4 }, todayZeroValueAppointments: 1, confirmedAppointments30: 47, valueBearingBookings30: 47, bookedValue30: 9870, zeroValueAppointments30: 0, observedCollectedValue30: 412, amountPaidCoverage30: { withRecordedAmount: 47, total: 47 }, metaSpend30: 40 },
    })
    expect(msg).toContain('=== OUTCOME LEDGER')     // the business-truth block header
    expect(msg).toContain('$687.50')
    expect(msg).toContain('10.30x')                 // amount_paid on active appointments / Meta spend
    // The vocabulary must be explicit and must NOT call a zero-value appointment a test.
    expect(msg).toContain('zero-value booking')
    expect(msg).toContain('NEVER call one a test')
    expect(msg).toContain('confirmed bookings')
    expect(msg).toContain('value-bearing bookings')
    // Scheduled booked value and amount paid on active appointments stay visibly separate.
    expect(msg).toContain('amount paid on active bookings')
    expect(msg).toContain('scheduled booked value')
    // GA is telemetry, not an attribution "lens" that supplies money.
    expect(msg).toContain('NOT BOOKINGS AND NOT MONEY')
  })

  it('omits the Acuity block cleanly when the ledger read was unavailable', () => {
    const msg = buildUserMessage({ ...base, ga4 })
    expect(msg).not.toContain('=== OUTCOME LEDGER')
  })

  it('withholds the amount/spend ratio when the Meta insight window is incomplete', () => {
    const msg = buildUserMessage({
      ...base,
      ga4,
      outcomes: {
        todayConfirmedAppointments: 1, todayValueBearingBookings: 1, todayBookedValue: 235,
        todayObservedCollectedValue: 235, todayRecordedOutcomeValue: 235,
        todayAmountPaidCoverage: { withRecordedAmount: 1, total: 1 }, todayZeroValueAppointments: 0,
        confirmedAppointments30: 1, valueBearingBookings30: 1, bookedValue30: 235,
        zeroValueAppointments30: 0, observedCollectedValue30: 235,
        amountPaidCoverage30: { withRecordedAmount: 1, total: 1 }, metaSpend30: null,
      },
    })
    expect(msg).toMatch(/amount_paid/i)
    expect(msg).toMatch(/Active-booking amount\/spend ratio \(30d\) = UNAVAILABLE/i)
    expect(msg).not.toMatch(/Real revenue|exact checkout revenue/i)
  })
})

// Value-timing doctrine, REVISED. The mechanism is real — a post-booking upsell moves Acuity
// without re-firing GA4/Meta — but as a blanket explanation it was unfalsifiable: for any given day
// it is indistinguishable from a broken tag, an undelivered CAPI event, or a modelled-attribution
// disagreement. The prompt must now gate the claim on row-level evidence. (The earlier version of
// this test cited a named customer's booking; the name is removed — no customer PII in tests.)
import { SYSTEM_PROMPT } from '@/lib/report/prompt-builder'

describe('SYSTEM_PROMPT — value-timing must be EARNED, not assumed', () => {
  it('restricts the expected-timing label to the PROVEN post-send subset', () => {
    expect(SYSTEM_PROMPT).toMatch(/Value timing is a CLAIM THAT MUST BE EARNED/i)
    expect(SYSTEM_PROMPT).toMatch(/expected value-timing delta ONLY/i)
    expect(SYSTEM_PROMPT).toMatch(/PROVEN post-send change/i)
    expect(SYSTEM_PROMPT).toMatch(/AFTER Meta accepted the event/i)
  })

  it('forces every unproven difference to be labelled unexplained', () => {
    expect(SYSTEM_PROMPT).toMatch(/UNEXPLAINED or not directly reconcilable/i)
    expect(SYSTEM_PROMPT).toMatch(/zero.*proven changes/i)
    expect(SYSTEM_PROMPT).toMatch(/must NOT claim the difference is expected/i)
  })

  it('treats migration snapshots as unknown, never as booking-time value', () => {
    expect(SYSTEM_PROMPT).toMatch(/UNKNOWN, not benign/i)
    expect(SYSTEM_PROMPT).toMatch(/Never describe a backfilled value as a booking-time value/i)
  })

  it('retains the supported value-timing mechanism without excluded post-sale topics', () => {
    expect(SYSTEM_PROMPT).toMatch(/post-booking upsell/i)
    expect(SYSTEM_PROMPT).not.toMatch(/refund|cancell/i)
    // The unconditional claim is gone.
    expect(SYSTEM_PROMPT).not.toMatch(/That gap is EXPECTED, not drift/i)
  })

  it('uses neutral attribution wording — no absolute "under-counts"', () => {
    expect(SYSTEM_PROMPT).toMatch(/can UNDER- or OVER-attribute/i)
    expect(SYSTEM_PROMPT).not.toMatch(/under-counts/i)
    expect(SYSTEM_PROMPT).not.toMatch(/under-counted/i)
  })
})

describe('report prompts — no customer PII', () => {
  it('the system prompt contains no email addresses or personal-name fields', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/[\w.]+@[\w.]+\.\w+/)
    expect(SYSTEM_PROMPT).not.toMatch(/first_name|last_name|customer name/i)
  })
})
