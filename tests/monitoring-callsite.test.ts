import './_support/outcome-noun-booking'
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A review finding, and its explicit instruction to add CALL-SITE tests rather than only pure
 * detector tests. A detector can be perfectly correct and still be fed the wrong population over the
 * wrong dates — which is exactly what happened: the runner passed ALL-SOURCE confirmed appointments,
 * read to TODAY, into a check comparing PAID and TELEMETRY subsets that both ended YESTERDAY.
 *
 * These tests assert what the runner actually READS, not what the detector does with it.
 */

const WEEK_START = '2026-07-22'
const WEEK_END = '2026-07-28'          // yesterday; both planes end here

/** Every call the runner makes to the business-facts reader, with its window. */
const factsCalls: Array<{ start: string; end: string }> = []
/** Every window the runner passes to the CAPI/booking view. */
const viewWindows: Array<{ start: string; end: string }> = []

// Tracking health reads the CONFIRMATION contract, never the business reader. If the runner
// ever reverts to getBusinessFactsForWindow, this mock is not consulted and factsCalls stays empty.
vi.mock('@/lib/outcomes/confirmation-facts', () => ({
  getConfirmationFacts: vi.fn(async (_acct: string, start: string, end: string) => {
    factsCalls.push({ start, end })
    return {
      totalConfirmations: 9,
      websiteConfirmations: 0,       // nothing GA-eligible
      staffOrManualConfirmations: 8,
      originUnknownConfirmations: 1,
      websiteWithAcceptedCapi: 0,
      websiteLaterCanceled: 0,
    }
  }),
}))
vi.mock('@/lib/outcomes/business-facts-reader', () => ({
  getBusinessFactsForWindow: vi.fn(async () => { throw new Error('business reader must not be used for tracking health') }),
}))

vi.mock('@/lib/outcomes/ledger-account', () => ({ resolveAdAccountId: vi.fn(async () => 'acct-1') }))

vi.mock('@/lib/ga4/client', () => ({
  getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({
    available: true,
    paid: { confirmationEvents: 0, eventValue: 0 },
    organic: { confirmationEvents: 0, eventValue: 0 },
    metaPaid: { confirmationEvents: 0, eventValue: 0 },
    byChannel: [], zeroValueEvents: 0,
  })),
}))

vi.mock('@/lib/tracking/utm-coverage', () => ({ computeUtmCoverage: vi.fn(async () => null) }))
vi.mock('@/lib/utils/date-utils', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, nyDaysAgo: (n: number) => (n === 0 ? '2026-07-29' : n === 1 ? WEEK_END : WEEK_START) }
})

vi.mock('@/lib/supabase/admin', () => {
  const make = (table: string) => {
    const state: { start?: string; end?: string } = {}
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.select = self
    chain.eq = self
    chain.order = self
    chain.limit = () => ({ data: [], error: null })
    chain.gte = (_c: string, v: string) => { state.start = v; return chain }
    chain.lte = (_c: string, v: string) => {
      state.end = v
      if (table === 'v_business_outcomes') viewWindows.push({ start: state.start!, end: state.end! })
      return chain
    }
    chain.then = (res: (v: { data: unknown[]; error: null }) => unknown) => {
      if (table === 'v_business_outcomes') {
        viewWindows.push({ start: state.start ?? '?', end: state.end ?? '?' })
      }
      // $120 spent across the window, and NOTHING on either tracking plane.
      if (table === 'daily_insights') return res({ data: [{ bookings: 0, spend: 120 }], error: null })
      return res({ data: [], error: null })
    }
    return chain
  }
  return { getAdminClient: () => ({ from: (t: string) => make(t) }) }
})

const emitted: Array<{ area: string; severity: string; message: string }> = []
vi.mock('@/lib/monitoring/alerts', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return {
    ...actual,
    emitAlert: vi.fn((f: { area: string; severity: string; message: string }) => {
      emitted.push(f)
      return { emitted: true, deduped: false }   // the shape runMonitoringChecks expects back
    }),
  }
})

beforeEach(() => { factsCalls.length = 0; viewWindows.length = 0; emitted.length = 0 })

describe('monitoring runner — population and window at the CALL SITE', () => {
  it('reads the ledger over the SAME dates as Meta and GA, never through today', async () => {
    const { runMonitoringChecks } = await import('@/lib/monitoring/run')
    await runMonitoringChecks('acct-1')
    expect(factsCalls.length).toBeGreaterThan(0)
    for (const c of factsCalls) {
      expect(c.end, 'ledger window must end where both planes end, not today').toBe(WEEK_END)
      expect(c.start).toBe(WEEK_START)
    }
    // The regression in one line: the old code passed nyDaysAgo(0).
    expect(factsCalls.every((c) => c.end !== '2026-07-29')).toBe(true)
  })

  it('CAPI delivery evidence comes from the confirmation contract, over that same window', async () => {
    const { runMonitoringChecks } = await import('@/lib/monitoring/run')
    await runMonitoringChecks('acct-1')
    for (const w of viewWindows) {
      expect(w.start).toBe(WEEK_START)
      expect(w.end).toBe(WEEK_END)
    }
    expect(factsCalls.length).toBeGreaterThan(0)
  })

  it('unknown-origin confirmations are reported as NOT EVALUABLE, not as "no website bookings"', async () => {
    const { runMonitoringChecks } = await import('@/lib/monitoring/run')
    await runMonitoringChecks('acct-1')
    const tag = emitted.find((f) => f.area === 'ga_tag_health')
    expect(tag?.message).toMatch(/NOT EVALUABLE/)
    expect(tag?.message).toMatch(/NOT a finding that there were no website bookings/i)
  })

  it('does NOT claim a tracking outage from all-source ledger volume', async () => {
    // 9 confirmed appointments, but ZERO of website origin: organic, phone and staff-created bookings
    // cannot contradict a paid or telemetry subset. $120 of spend with nothing on either plane is
    // ordinary poor performance until website-origin evidence says otherwise.
    const { runMonitoringChecks } = await import('@/lib/monitoring/run')
    await runMonitoringChecks('acct-1')
    const all = emitted.map((f) => f.message).join(' ')
    expect(all).not.toMatch(/points to a tracking outage/i)
    expect(all).not.toMatch(/ledger contradicts both tracking planes/i)
    expect(all).not.toMatch(/recorded 9 appointment/i)
    const mismatch = emitted.find((f) => f.area === 'meta_ga4_mismatch')
    expect(mismatch?.severity).toBe('info')
    expect(mismatch?.message).toMatch(/No website-origin bookings were booked/i)
  })

  it('never claims a delivery failure from a population it did not evaluate', async () => {
    const { runMonitoringChecks } = await import('@/lib/monitoring/run')
    await runMonitoringChecks('acct-1')
    // Zero website confirmations => nothing was eligible => no accepted/missing claim is possible.
    const delivery = emitted.filter((f) => f.area === 'meta_delivery_health')
    expect(delivery.every((f) => !/MISSING|failing outright/.test(f.message))).toBe(true)
  })

  it('withholds only the Meta-vs-GA modelled-booking comparison when the current outcome plane is incomplete', async () => {
    const { runMonitoringChecks } = await import('@/lib/monitoring/run')
    const result = await runMonitoringChecks('acct-1', { metaOutcomeMetricsComplete: false })

    expect(result.findings.some((finding) => finding.area === 'meta_ga4_mismatch')).toBe(false)
    expect(result.findings.some((finding) => finding.area === 'ga_tag_health')).toBe(true)
    expect(result.findings.some((finding) => finding.area === 'meta_delivery_health')).toBe(true)
  })
})
