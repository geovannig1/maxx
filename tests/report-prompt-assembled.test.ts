import { describe, it, expect } from 'vitest'
import { buildUserMessage, SYSTEM_PROMPT, type ReportInputData } from '@/lib/report/prompt-builder'
import { renderReconciliationBlock, summarizeReconciliation, reconcileAppointment } from '@/lib/outcomes/adapters/acuity/value-reconciliation'
import { renderForwardCoverage, computeForwardCoverage } from '@/lib/tracking/forward-coverage'

// FINAL ASSEMBLED PROMPT tests. Asserting on SYSTEM_PROMPT alone is not enough: the thing the model
// actually receives is system + user message + the evidence blocks appended to it. These tests check
// the assembled artefact — for customer PII, and for the honesty rules surviving assembly.

const base: ReportInputData = {
  date: '2026-03-18',
  accountName: 'Example Studio',
  currency: 'USD',
  accountInsights: {
    spend: 655, leads: 0, bookings: 8, impressions: 21500, reach: 12600, clicks: 388,
    ctr: 1.8, cpm: 30.47, cpl: null, cpb: 81.88, appointmentValue: null, roas: null,
  },
  prevDayInsights: null,
  prev7dayInsights: null,
  topCampaigns: [
    { name: 'Leads Campaign', spend: 655, leads: 0, cpl: null, ctr: 1.8, frequency: 1.75, status: 'ACTIVE' },
  ],
  alerts: [
    { severity: 'warning', type: 'attribution', title: 'View-through heavy', message: 'Most attributed conversions are view-through.', entity: 'account' },
  ],
}

const ga4 = {
  todayPaidConfirmationEvents: 0, todayPaidEventValue: 0, paidConfirmationEvents30: 2, paidEventValue30: 560,
  todayOrganicConfirmationEvents: 1, todayOrganicEventValue: 310, organicConfirmationEvents30: 24, organicEventValue30: 7210, zeroValueEvents30: 0
}

const outcomes = {
  todayConfirmedAppointments: 3, todayValueBearingBookings: 3, todayBookedValue: 905, todayObservedCollectedValue: 640, todayRecordedOutcomeValue: 640, todayAmountPaidCoverage: { withRecordedAmount: 3, total: 3 }, todayZeroValueAppointments: 0,
  confirmedAppointments30: 27, valueBearingBookings30: 27, bookedValue30: 8770, zeroValueAppointments30: 0, observedCollectedValue30: 7690, amountPaidCoverage30: { withRecordedAmount: 27, total: 27 }, metaSpend30: 655,
}

/** The complete artefact the model receives. */
function assembledPrompt(over: Partial<ReportInputData> = {}): string {
  return `${SYSTEM_PROMPT}\n\n${buildUserMessage({ ...base, ga4, outcomes, ...over })}`
}

// Patterns that would indicate a real customer leaked into the prompt.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/
const PII_FIELD = /\b(first_name|last_name|customer_name|customer name|phone_number|email_address)\b/i

describe('assembled report prompt — no customer PII', () => {
  const prompt = assembledPrompt()

  it('contains no e-mail address', () => {
    expect(prompt).not.toMatch(EMAIL)
  })

  it('contains no phone number', () => {
    expect(prompt).not.toMatch(PHONE)
  })

  it('names no customer PII field', () => {
    expect(prompt).not.toMatch(PII_FIELD)
  })

  it('the Acuity block carries AGGREGATES only — never a per-customer row', () => {
    expect(prompt).toContain('=== OUTCOME LEDGER')
    expect(prompt).toMatch(/27 value-bearing/)
    // No appointment-level identifiers.
    expect(prompt).not.toMatch(/appointment_id|acuity-\d+/)
  })

  it('stays PII-free when the reconciliation and coverage blocks are appended', () => {
    const recon = renderReconciliationBlock(summarizeReconciliation([
      reconcileAppointment({
        appointmentId: 12345, initialProvenance: 'observed',
        observations: [{ changeKind: 'price_change', observedAtMs: 2, oldPrice: 380, newPrice: 455, oldCanceled: null, newCanceled: null }],
        capiAcceptedAtMs: 1, capiAttempted: true, modeledDiffers: false,
      }),
    ])).join('\n')
    const coverage = renderForwardCoverage(computeForwardCoverage(
      [{
        appointmentId: 12345, createdAtMs: Date.parse('2026-03-02T00:00:00Z'),
        hasFbclid: true, hasFbc: true, hasFbp: false, capiAccepted: true, capiFailed: false,
        hasUtmSource: true, hasUtmCampaign: true, unknownState: false,
      }],
      { goLiveAt: '2026-02-24T00:00:00Z', provenance: 'tracking go-live' },
      { endMs: Date.parse('2026-03-18T00:00:00Z') },
    )).join('\n')

    const full = `${prompt}\n${recon}\n${coverage}`
    expect(full).not.toMatch(EMAIL)
    expect(full).not.toMatch(PHONE)
    expect(full).not.toMatch(PII_FIELD)
  })
})

describe('assembled report prompt — CONTRADICTORY language cannot survive', () => {
  const prompt = assembledPrompt()

  it('contains NO fixed "Meta under-counts" claim', () => {
    expect(prompt).not.toMatch(/under-counts?/i)
    expect(prompt).not.toMatch(/under-counted/i)
    expect(prompt).not.toMatch(/under-report/i)
  })

  it('contains NO fixed "GA4 will be LOWER" direction claim', () => {
    expect(prompt).not.toMatch(/will be LOWER than Acuity/i)
    // ...and states the neutral replacement explicitly.
    expect(prompt).toMatch(/Do NOT assert a fixed direction between them/)
  })

  it('omits owner-excluded post-sale topics', () => {
    expect(prompt).not.toMatch(/refund|cancell|reschedule workaround/i)
  })

  it('contains NO "not a broken pixel" reassurance', () => {
    expect(prompt).not.toMatch(/NOT a broken pixel/i)
    expect(prompt).not.toMatch(/attribution physics, NOT a broken/i)
  })

  it('renders the deterministic VALUE RECONCILIATION block when one is supplied', () => {
    const withBlock = assembledPrompt({
      reconciliation: renderReconciliationBlock(summarizeReconciliation([
        reconcileAppointment({
          appointmentId: 1, initialProvenance: 'observed', observations: [],
          capiAcceptedAtMs: null, capiAttempted: false, modeledDiffers: false,
        }),
      ])),
    })
    expect(withBlock).toMatch(/=== VALUE RECONCILIATION/)
    expect(withBlock).toMatch(/nothing is proven/)
    expect(withBlock).toMatch(/state the difference as UNEXPLAINED/)
    // The block sits ABOVE the money blocks it qualifies.
    expect(withBlock.indexOf('=== VALUE RECONCILIATION')).toBeLessThan(withBlock.indexOf('=== OUTCOME LEDGER'))
  })

  it('GA4 is explicitly NOT the authoritative optimizer-event count', () => {
    expect(prompt).toMatch(/NOT the authoritative count of the events Meta's optimizer received/)
    expect(prompt).toMatch(/accepted server CAPI deliveries and Meta dataset event counts outrank it/)
  })
})

describe('assembled report prompt — honesty rules survive assembly', () => {
  const prompt = assembledPrompt()

  it('carries the earned-value-timing rule end to end', () => {
    expect(prompt).toMatch(/Value timing is a CLAIM THAT MUST BE EARNED/)
    expect(prompt).toMatch(/UNEXPLAINED or not directly reconcilable/)
  })

  it('uses neutral attribution wording throughout the assembled artefact', () => {
    expect(prompt).toMatch(/can UNDER- or OVER-attribute/)
    expect(prompt).not.toMatch(/under-counts/i)
    expect(prompt).not.toMatch(/under-counted/i)
  })

  it('withholds Meta value-derived return fields even when the input object contains them', () => {
    const withMetaValue = assembledPrompt({
      accountInsights: {
        ...base.accountInsights,
        appointmentValue: 999,
        roas: 3.2,
      },
    })

    expect(withMetaValue).toMatch(/Meta value-derived return fields are withheld/)
    expect(withMetaValue).not.toMatch(/AppointmentConfirmed Value:/)
    expect(withMetaValue).not.toMatch(/\bROAS:\s*3\.2/i)
    expect(withMetaValue).not.toMatch(/\$999/)
  })

  it('forbids treating p25 as a three-second hook', () => {
    expect(prompt).toMatch(/NEVER call video_p25 a "3-second view", a "hook"/)
    expect(prompt).toMatch(/RETENTION MILESTONES/)
  })

  it('keeps the provenance legend above the numbers', () => {
    const legendAt = prompt.indexOf('=== METRIC PROVENANCE')
    const outcomeAt = prompt.indexOf('=== OUTCOME LEDGER')
    expect(legendAt).toBeGreaterThan(-1)
    expect(outcomeAt).toBeGreaterThan(-1)
    expect(legendAt).toBeLessThan(outcomeAt)
  })

  it('renders cleanly with no ledger and no GA4 — no crash, no fabricated block', () => {
    const bare = `${SYSTEM_PROMPT}\n\n${buildUserMessage(base)}`
    expect(bare).not.toContain('=== OUTCOME LEDGER')
    expect(bare).not.toMatch(EMAIL)
    expect(bare.length).toBeGreaterThan(100)
  })
})
