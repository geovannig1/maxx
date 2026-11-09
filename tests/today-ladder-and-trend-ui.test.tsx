import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AttributionLadderPanel } from '@/components/dashboard/AttributionLadderPanel'
import { DeliverySeriesChart } from '@/components/charts/DeliverySeriesChart'
import { buildAttributionLadder } from '@/lib/cockpit/attribution-ladder'
import { assembleDeliverySeries } from '@/lib/cockpit/series-loader'

const LADDER = buildAttributionLadder({
  counts: { valueBearingBookings: 200, zeroValueBookings: 20, withPaidSignal: 24, withFbclid: 18, webhookLinked: 5, webhookLinkedCancelled: 2 },
  money: { bookedValue: 48000, collectedAmount: 45250.25, amountPaidKnown: 220, amountPaidTotal: 220 },
  meta: { results: 40, viewThrough: 26, daysMissingViewThroughSplit: 30, valueAmount: 0, viewThroughValue: null },
})

const RANGE = {
  start: '2026-03-09', end: '2026-03-13',
  basis: 'closed_account_days' as const, timezone: 'America/New_York' as const,
}
const SERIES = assembleDeliverySeries({
  metric: 'spend', range: RANGE, asOf: '2026-03-14T12:00:00.000Z', metaAccountId: 'act_123',
  inputs: {
    rows: [{ date: '2026-03-09', value: 120 }, { date: '2026-03-13', value: 80 }],
    attempts: [{ dateRangeStart: '2026-03-09', dateRangeEnd: '2026-03-11', status: 'success' }],
  },
})

describe('attribution ladder panel', () => {
  const markup = renderToStaticMarkup(AttributionLadderPanel({ ladder: LADDER }))

  it('renders every rung with its count', () => {
    for (const count of ['200', '24', '18', '5']) expect(markup).toContain(`>${count}<`)
  })

  it('states why each rung is smaller than the one above it', () => {
    expect(markup).toMatch(/without a utm tag or fbclid/)
    expect(markup).toMatch(/no signed webhook/)
  })

  it('labels both date bases and keeps the Meta claim visually separated', () => {
    expect(markup).toContain('counted on the booking date (ET)')
    expect(markup).toContain('counted on impression date')
    expect(markup).toMatch(/not a subset/)
  })

  it('shows the money line with its coverage, and never calls a booking a test', () => {
    expect(markup).toContain('$48,000.00 booked')
    expect(markup).toContain('$45,250.25 collected')
    expect(markup).toContain('all 220')
    expect(markup).toContain('zero-value booking')
    expect(markup).not.toMatch(/refund|cancell/i)
    expect(markup).not.toMatch(/\btest\b/i)
  })

  it('reports the view-through split as a floor when Meta withheld it on some days', () => {
    expect(markup).toMatch(/at least 26 view-through/)
  })

  // design rule: never nest a card inside a surface, and use the canonical type classes.
  it('uses the design system rather than bespoke type', () => {
    expect(markup).toContain('stat-value')
    expect(markup).toContain('section-label')
    // No bespoke KPI-sized type: figures come from .stat-value, not a hardcoded 26/28/34px.
    expect(markup).not.toMatch(/text-\[(2[4-9]|3\d)px\]/)
  })
})

describe('delivery series chart', () => {
  const markup = renderToStaticMarkup(DeliverySeriesChart({ series: SERIES }))

  it('renders bars only for measured days', () => {
    // Two measured days in a five-day window.
    expect(markup.match(/<rect[^>]*fill="var\(--chart-1\)"/g) ?? []).toHaveLength(2)
  })

  it('draws proven no-delivery and never-synchronised spans differently', () => {
    expect(markup).toContain('No delivery ·')
    expect(markup).toContain('Never synchronised ·')
    expect(markup).toContain('url(#unknown-hatch)')
  })

  it('says out loud that an unsynchronised day is unknown rather than zero', () => {
    expect(markup).toMatch(/unknown — not zero/)
  })

  it('carries a text alternative describing the whole series', () => {
    expect(markup).toMatch(/aria-label="[^"]*days with delivery/)
    expect(markup).toMatch(/aria-label="[^"]*never synchronised and are unknown/i)
  })

  it('uses only themed tokens, never a literal hex', () => {
    expect(markup).not.toMatch(/#[0-9A-Fa-f]{6}/)
  })
})
