import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ADAPTER SEAM. The duplicate proof in the reconciler test injects already-expanded event
// objects, so it never exercised the mapping. This test starts from a REAL-SHAPED GA4 Data API
// response and runs the whole seam:
//
//   BetaAnalyticsDataClient.runReport response
//     -> runBookingEventRows mapping
//     -> getGa4IdentifiedBookingEvents
//     -> reconcileGa4Bookings
//     -> renderGa4ReconciliationBlock (the consumer)
//
// The defect it pins: the adapter mapped every aggregate row to ONE event object and discarded the
// row's eventCount, so GA reporting {appointment_id: 123, eventCount: 2} produced a single event, the
// reconciler saw one, and no duplicate was ever surfaced.

const runReport = vi.fn()
vi.mock('@google-analytics/data', () => ({
  BetaAnalyticsDataClient: class { runReport = (...a: unknown[]) => runReport(...a) },
}))

/** A GA4 runReport response in the real shape: dimensionValues + metricValues as strings. */
/** A window fully after a proven boundary — the only context in which anything may be exact. */
const COVERED = { windowStart: '2026-05-01', provenBoundary: '2026-04-01' }

// The date dimension is `date` (YYYYMMDD), not `dateHourMinute` — the query moved off event-level
// data because GA4's eventDataRetention was silently deleting 82% of it. This mock carried the old
// 12-digit minute string, which the client's date regex no longer matches. `rowCount` and `metadata`
// mirror what the real API always returns.
const gaResponse = (rows: Array<{ apptId: string; channel: string; campaign: string; count: number; value: number }>) => [{
  rows: rows.map((r) => ({
    dimensionValues: [{ value: r.apptId }, { value: r.channel }, { value: r.campaign }, { value: '20260510' }],
    metricValues: [{ value: String(r.count) }, { value: String(r.value) }],
  })),
  rowCount: rows.length,
  metadata: { dataLossFromOtherRow: false, samplingMetadatas: [] },
}]

let getGa4IdentifiedBookingEvents: typeof import('@/lib/ga4/client').getGa4IdentifiedBookingEvents
let reconcileGa4Bookings: typeof import('@/lib/ga4/booking-reconciliation').reconcileGa4Bookings
let renderGa4ReconciliationBlock: typeof import('@/lib/ga4/booking-reconciliation').renderGa4ReconciliationBlock

beforeEach(async () => {
  vi.resetModules()
  runReport.mockReset()
  process.env.GA4_PROPERTY_ID = '123456789'
  // Shape-valid, entirely fake credentials. No real key material in fixtures.
  process.env.GA4_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'test@example.invalid', private_key: 'not-a-real-key',
  })
  const client = await import('@/lib/ga4/client')
  const recon = await import('@/lib/ga4/booking-reconciliation')
  getGa4IdentifiedBookingEvents = client.getGa4IdentifiedBookingEvents
  reconcileGa4Bookings = recon.reconcileGa4Bookings
  renderGa4ReconciliationBlock = recon.renderGa4ReconciliationBlock
})

afterEach(() => {
  delete process.env.GA4_PROPERTY_ID
  delete process.env.GA4_SERVICE_ACCOUNT_JSON
})

describe('GA Data API -> adapter -> reconciler -> consumer', () => {
  it('ONE row with eventCount=2 yields ONE booking, the duplicate visible, ledger value retained once', async () => {
    runReport.mockResolvedValue(gaResponse([
      { apptId: '991001', channel: 'Paid Social', campaign: 'summer_studio', count: 2, value: 600 },
    ]))

    const ga = await getGa4IdentifiedBookingEvents('2026-05-01', '2026-05-31')
    expect(ga.available).toBe(true)
    // The adapter carries the count instead of expanding it into repeated objects.
    expect(ga.events).toHaveLength(1)
    expect(ga.events[0]).toMatchObject({ appointmentId: 991001, channel: 'Paid Social', campaign: 'summer_studio', eventCount: 2 })

    const r = reconcileGa4Bookings([{ id: 991001, price: 300, amount_paid: 250, canceled: false, web_origin_state: 'website' as const }], ga, COVERED)
    expect(r.business!.valueBearingBookings).toBe(1)
    expect(r.business!.bookedValue).toBe(300)            // LEDGER value, once — not GA's 600
    expect(r.duplicateAppointments).toEqual([{ appointmentId: 991001, eventCount: 2 }])
    expect(r.byChannel[0].valueBearingBookings).toBe(1)
    expect(r.byChannel[0].bookedValue).toBe(300)

    const text = renderGa4ReconciliationBlock(r).join('\n')
    expect(text).toMatch(/more than one GA confirmation event/)
    expect(text).toMatch(/991001x2/)
    expect(text).toMatch(/\$250\.00 recorded collected value \(\$300\.00 scheduled booked value\)/)
  })

  it('two rows for ONE appointment across channels are an attribution conflict, not two bookings', async () => {
    runReport.mockResolvedValue(gaResponse([
      { apptId: '991002', channel: 'Paid Social', campaign: 'a', count: 1, value: 300 },
      { apptId: '991002', channel: 'Organic Search', campaign: 'b', count: 1, value: 300 },
    ]))

    const ga = await getGa4IdentifiedBookingEvents('2026-05-01', '2026-05-31')
    const r = reconcileGa4Bookings([{ id: 991002, price: 300, canceled: false, web_origin_state: 'website' as const }], ga, COVERED)

    expect(r.business!.valueBearingBookings).toBe(1)     // ONE booking
    expect(r.ambiguousAttribution).toHaveLength(1)
    expect(r.byChannel).toEqual([])                     // not allocated to either channel
    expect(renderGa4ReconciliationBlock(r).join('\n')).toMatch(/CONFLICTING channels/)
  })

  it("a '(not set)' appointment id maps to legacy/unlinked and carries its full event count", async () => {
    runReport.mockResolvedValue(gaResponse([
      { apptId: '(not set)', channel: 'Paid Social', campaign: 'a', count: 5, value: 900 },
    ]))
    const ga = await getGa4IdentifiedBookingEvents('2026-05-01', '2026-05-31')
    expect(ga.events[0].appointmentId).toBeNull()

    const r = reconcileGa4Bookings([{ id: 991003, price: 300, canceled: false, web_origin_state: 'website' as const }], ga, COVERED)
    // Zero identity coverage ⇒ LEGACY_UNLINKED, never an exact zero.
    expect(r.scope).toBe('legacy_unlinked')
    expect(r.coverage).toMatchObject({ totalEvents: 5, identifiedEvents: 0 })
    expect(r.byChannel).toEqual([])
    expect(r.business!.valueBearingBookings).toBe(1)     // the ledger booking survives
  })

  it('a rejected custom dimension becomes PENDING CONFIGURATION, never zero bookings', async () => {
    runReport.mockRejectedValue(new Error('Field customEvent:appointment_id is not a valid dimension.'))

    const ga = await getGa4IdentifiedBookingEvents('2026-05-01', '2026-05-31')
    expect(ga.available).toBe(false)
    expect(ga.reason).toMatch(/PENDING CONFIGURATION/)
    expect(ga.reason).toMatch(/NOT a statement that there were zero bookings/)

    const r = reconcileGa4Bookings([{ id: 991004, price: 275, canceled: false, web_origin_state: 'website' as const }], ga, COVERED)
    expect(r.scope).toBe('pending_configuration')
    expect(r.business!.valueBearingBookings).toBe(1)     // ledger unaffected
    expect(r.business!.bookedValue).toBe(275)
  })

  it('the adapter requests appointment_id alongside the attribution dimensions it needs', async () => {
    runReport.mockResolvedValue(gaResponse([]))
    await getGa4IdentifiedBookingEvents('2026-05-01', '2026-05-31')
    const dims = (runReport.mock.calls[0][0] as { dimensions: Array<{ name: string }> }).dimensions.map((d) => d.name)
    expect(dims).toContain('customEvent:appointment_id')
    expect(dims).toContain('sessionDefaultChannelGroup')
    expect(dims).toContain('sessionCampaignName')
  })
})
