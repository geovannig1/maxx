import '../_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { buildUserMessage, type ReportInputData } from '@/lib/report/prompt-builder'

const ai = {
  spend: 100, leads: 5, bookings: 2, impressions: 1000, reach: 800, clicks: 20,
  ctr: 2, cpm: 10, cpl: 20, cpb: 50, appointmentValue: 200, roas: 2,
}
const base: ReportInputData = {
  date: '2026-06-29', accountName: 'Example Studio', currency: 'USD',
  accountInsights: ai, prevDayInsights: null, prev7dayInsights: null,
  topCampaigns: [], alerts: [],
  ga4: {
    todayPaidConfirmationEvents: 1, todayPaidEventValue: 250, paidConfirmationEvents30: 30, paidEventValue30: 8000,
    todayOrganicConfirmationEvents: 4, todayOrganicEventValue: 900, organicConfirmationEvents30: 90, organicEventValue30: 20000, zeroValueEvents30: 0
  },
  learnings: null,
}

describe('the LLM report prompt carries the provenance guardrail', () => {
  it('renders the provenance legend above the metrics', () => {
    const msg = buildUserMessage(base)
    expect(msg).toMatch(/METRIC PROVENANCE/)
    // the one rule not previously stated: blended/account/organic must not become a campaign-level ROAS
    expect(msg).toMatch(/NEVER present any of them as a paid CAMPAIGN-LEVEL ROAS/i)
    expect(msg).toMatch(/Do NOT attribute the blended ratio, account-level active booking amount, or organic value to any single campaign/i)
  })

  it('labels the blended amount/spend ratio as account-level and diagnostic', () => {
    expect(buildUserMessage(base)).toMatch(/Blended active-booking amount\/spend ratio/)
    expect(buildUserMessage(base)).toMatch(/amount_paid on active bookings/)
    expect(buildUserMessage(base)).toMatch(/NOT paid performance/)
  })

  it('presents GA as telemetry and derives NO ROAS or MER from it', () => {
    // Before: the block led with "PAID (ad-attributed) — the headline" and printed a "Paid ROAS (30d)
    // ... the real paid efficiency" from GA eventValue, while the reconciliation block in the SAME
    // prompt said GA contributes no booking and no dollar. The model received both.
    const msg = buildUserMessage(base)
    expect(msg).toMatch(/GA4 CONFIRMATION-EVENT TELEMETRY/)
    expect(msg).toMatch(/NOT bookings, NOT revenue, and NOT a basis for CPA, ROAS or MER/)
    expect(msg).toMatch(/Meta paid ROAS is NOT stated here/)
    expect(msg).not.toMatch(/the real paid efficiency/)
    expect(msg).not.toMatch(/PAID \(ad-attributed\) — the headline/)
  })

  it('keeps the guardrail even when GA4 is unavailable (Meta-estimate-only run)', () => {
    expect(buildUserMessage({ ...base, ga4: null })).toMatch(/METRIC PROVENANCE/)
  })
})
