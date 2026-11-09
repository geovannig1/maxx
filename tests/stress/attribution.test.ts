import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ga4Resp, FAKE_GA4_SA_JSON } from '../_support/ga4'
import { matchGa4Campaign } from '@/lib/analytics/campaign-roas'

// Mock the GA4 SDK so getGa4ConfirmationTelemetryBySource runs its REAL bucketing logic against scripted rows.
const { runReportMock } = vi.hoisted(() => ({ runReportMock: vi.fn() }))
vi.mock('@google-analytics/data', () => ({
  // Must be constructable (`new BetaAnalyticsDataClient(...)`), so use a class, not an arrow fn.
  BetaAnalyticsDataClient: class {
    runReport = runReportMock
  },
}))

import { getGa4ConfirmationTelemetryBySource, getGa4ConfirmationTelemetryByCampaign, classifyChannel } from '@/lib/ga4/client'

beforeEach(() => {
  vi.stubEnv('GA4_PROPERTY_ID', '123456')
  vi.stubEnv('GA4_SERVICE_ACCOUNT_JSON', FAKE_GA4_SA_JSON)
  runReportMock.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE canonical regression: the $12,000 organic booking must never count as paid.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the $12,000 organic booking never enters paid revenue', () => {
  it('puts a $12k Direct booking in ORGANIC and ZERO in PAID', async () => {
    runReportMock.mockResolvedValueOnce(
      ga4Resp([
        { dims: ['Paid Social'], metrics: [2, 300] }, // 2 bookings, $300 — genuinely paid
        { dims: ['Direct'], metrics: [1, 12000] }, // the canonical $12k organic booking
      ]),
    )
    const r = await getGa4ConfirmationTelemetryBySource('2026-06-01', '2026-06-30')
    expect(r.available).toBe(true)
    expect(r.paid.eventValue).toBe(300) // paid excludes the $12k entirely
    expect(r.paid.confirmationEvents).toBe(2)
    expect(r.organic.eventValue).toBe(12000) // the $12k lands in organic
    expect(r.organic.confirmationEvents).toBe(1)
    // Hard invariant: the organic dollars are NOT inside the paid figure.
    expect(r.paid.eventValue).toBeLessThan(r.organic.eventValue)
  })

  it('classifies Direct / Referral / Organic* / Unassigned / (unknown) / "" all as organic', async () => {
    runReportMock.mockResolvedValueOnce(
      ga4Resp([
        { dims: ['Paid Social'], metrics: [5, 1000] },
        { dims: ['Direct'], metrics: [1, 4000] },
        { dims: ['Referral'], metrics: [1, 2000] },
        { dims: ['Organic Search'], metrics: [1, 1500] },
        { dims: ['Unassigned'], metrics: [1, 800] },
        { dims: ['(unknown)'], metrics: [1, 700] },
        { dims: [''], metrics: [1, 600] },
      ]),
    )
    const r = await getGa4ConfirmationTelemetryBySource('2026-06-01', '2026-06-30')
    expect(r.paid.eventValue).toBe(1000) // ONLY the paid social
    expect(r.organic.eventValue).toBe(4000 + 2000 + 1500 + 800 + 700 + 600)
    // Every non-paid channel landed in organic.
    expect(r.byChannel.filter((c) => c.source === 'paid')).toHaveLength(1)
  })

  it('does not invent paid revenue when GA4 returns only organic', async () => {
    runReportMock.mockResolvedValueOnce(ga4Resp([{ dims: ['Direct'], metrics: [1, 12000] }]))
    const r = await getGa4ConfirmationTelemetryBySource('2026-06-01', '2026-06-30')
    expect(r.paid.eventValue).toBe(0)
    expect(r.paid.confirmationEvents).toBe(0)
  })
})

// N2 — the report / weekly / operating-mode / monitoring surfaces derive their paid ROAS headline from
// getGa4ConfirmationTelemetryBySource(...).metaPaid (23B). This pins the arithmetic: organic can inflate MER (labeled)
// but can NEVER inflate the paid ROAS a surface presents as ad performance.
describe('N2 — organic inflates MER (labeled) but never the paid ROAS the surfaces headline', () => {
  it('a big organic booking leaves paid ROAS untouched while MER balloons', async () => {
    runReportMock.mockResolvedValueOnce(
      ga4Resp([
        { dims: ['Paid Social'], metrics: [2, 300] }, // paid — what the headline uses
        { dims: ['Direct'], metrics: [1, 12000] }, // organic — context only
      ]),
    )
    const r = await getGa4ConfirmationTelemetryBySource('2026-06-01', '2026-06-30')
    const metaSpend = 200
    const paidRoas = r.metaPaid.eventValue / metaSpend // report/weekly/operating-mode paid headline (Meta-scoped)
    const mer = (r.paid.eventValue + r.organic.eventValue) / metaSpend // blended, labeled "not a paid ROAS"
    expect(paidRoas).toBeCloseTo(1.5) // 300 / 200 — organic excluded
    expect(mer).toBeCloseTo(61.5) // (300 + 12000) / 200 — organic included, but only ever labeled MER
    expect(paidRoas).toBeLessThan(mer) // organic can never make the paid read look better
  })
})

// 23B — the paid-ROAS numerator is META-scoped (Paid Social), so NON-Meta paid channels (Google
// Cross-network / Paid Search) can't inflate a "Meta paid ROAS" that is divided by Meta spend. They stay
// inside the broad `paid` bucket (for the paid/organic split) but out of `metaPaid`.
describe('23B — non-Meta paid revenue (Google) is excluded from the Meta ROAS numerator', () => {
  it('metaPaid = Paid Social only; Google Cross-network / Paid Search never reach the Meta ROAS', async () => {
    runReportMock.mockResolvedValueOnce(
      ga4Resp([
        { dims: ['Paid Social'], metrics: [2, 300] }, // Meta — the only channel in metaPaid
        { dims: ['Cross-network'], metrics: [3, 5000] }, // Google PMax — paid, but NOT Meta
        { dims: ['Paid Search'], metrics: [2, 4000] }, // Google search — paid, but NOT Meta
        { dims: ['Direct'], metrics: [1, 12000] }, // organic
      ]),
    )
    const r = await getGa4ConfirmationTelemetryBySource('2026-06-01', '2026-06-30')
    expect(r.paid.eventValue).toBe(300 + 5000 + 4000) // broad paid bucket still includes Google
    expect(r.metaPaid.eventValue).toBe(300) // but the Meta-scoped numerator does NOT
    expect(r.metaPaid.confirmationEvents).toBe(2)
    const metaSpend = 200
    const metaRoas = r.metaPaid.eventValue / metaSpend // what every surface now headlines
    const leakyRoas = r.paid.eventValue / metaSpend // the OLD, leaky computation
    expect(metaRoas).toBeCloseTo(1.5)
    expect(leakyRoas).toBeGreaterThan(metaRoas) // Google would have massively inflated the "Meta" ROAS
  })
})

describe('classifyChannel allow-list', () => {
  it('treats only the documented paid groups as paid', () => {
    for (const g of ['Paid Social', 'Paid Search', 'Display', 'Cross-network', 'Paid Other']) {
      expect(classifyChannel(g)).toBe('paid')
    }
    for (const g of ['Direct', 'Referral', 'Organic Search', 'Organic Social', 'Email', 'Unassigned', '(unknown)', '']) {
      expect(classifyChannel(g)).toBe('organic')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// token-overlap leak in per-campaign attribution (characterization → fix tracked in report).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('matchGa4Campaign token-subset can attribute a non-paid utm_campaign as paid', () => {
  const META = ['QZ Studios | Creators & Videographers | Spring Launch', 'Holiday Gift Cards 2026']

  it('LEAK: a bare single-token utm value that is a subset matches the paid campaign', () => {
    // If an organic/email session carried utm_campaign=studios, its revenue would be assigned to a paid campaign.
    expect(matchGa4Campaign('studios', META)).toBe(META[0])
  })

  it('is safe when the value is NOT a token-subset of any campaign name', () => {
    expect(matchGa4Campaign('studios_newsletter_july', META)).toBeNull() // "newsletter"/"july" not in any name
  })

  it('still rejects GA4 placeholders and ambiguous matches', () => {
    expect(matchGa4Campaign('(direct)', META)).toBeNull()
    expect(matchGa4Campaign('studios', ['Example Studio Alpha', 'Example Studio Beta'])).toBeNull() // ambiguous
  })
})

describe('per-campaign GA4 attribution is channel-aware', () => {
  it('excludes a non-paid (email) utm_campaign from the paid per-campaign rows', async () => {
    runReportMock.mockResolvedValueOnce(
      ga4Resp([
        { dims: ['Summer Sale', 'Paid Social'], metrics: [2, 300] }, // genuine paid campaign
        { dims: ['studios', 'Email'], metrics: [1, 12000] }, // organic email utm — must NOT count as paid
        { dims: ['(not set)', 'Paid Social'], metrics: [1, 150] }, // paid but unattributed-to-campaign
      ]),
    )
    const r = await getGa4ConfirmationTelemetryByCampaign('2026-06-01', '2026-06-30')
    const campaigns = r.rows.map((x) => x.campaign)
    expect(campaigns).toContain('Summer Sale')
    expect(campaigns).not.toContain('studios') // the email utm is excluded from paid rows
    expect(r.totals.eventValue).toBe(300 + 12000 + 150) // totals stay BLENDED for MER
    // attributedShare = attribution HEALTH: named paid purchases (2) / ALL PAID purchases (3).
    // Organic/email purchases are excluded from the denominator — they correctly carry no campaign,
    // and counting them made organic-heavy accounts read as "attribution broken" forever
    // (a single fully attributed paid booking could show as a single-digit share).
    expect(r.attributedShare).toBeCloseTo(2 / 3)
  })
})
