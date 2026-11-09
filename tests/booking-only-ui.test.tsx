import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isBookingLikeOutcome, OUTCOME_NOUN_ENV } from '@/config/outcome-nouns'
import { executiveFixture } from './reporting-browser/executive-fixture'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard' }))

/**
 * Booking-only measures (recorded hours, durations) belong to a business whose outcome is a booked
 * slot. A shop counting orders or a team counting leads must not see a "Recorded hours" tile, and
 * every other label must use the business's own noun.
 */

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('isBookingLikeOutcome', () => {
  it.each([
    ['booking/bookings', true], ['appointment/appointments', true], ['studio booking/studio bookings', true],
    ['reservation/reservations', true], ['session/sessions', true],
    ['order/orders', false], ['lead/leads', false], ['qualified lead/qualified leads', false], ['', false],
  ])('%s → %s', (noun, expected) => {
    vi.stubEnv(OUTCOME_NOUN_ENV, noun)
    expect(isBookingLikeOutcome()).toBe(expected)
  })
})

async function overview(noun: string): Promise<string> {
  vi.stubEnv(OUTCOME_NOUN_ENV, noun)
  vi.resetModules()
  const { OverviewReport } = await import('@/components/reporting/OverviewReport')
  return renderToStaticMarkup(<OverviewReport data={executiveFixture()} />)
}

describe('the overview', () => {
  it('shows the recorded-hours tile and hour measures to a booking business', async () => {
    const html = await overview('booking/bookings')
    expect(html).toContain('Recorded hours')
    expect(html).toContain('Hours / duration-recorded booking')
  })

  it('hides every hour measure from a business that counts orders, and names orders', async () => {
    const html = await overview('order/orders')
    expect(html).not.toContain('Recorded hours')
    expect(html).not.toContain('Recorded booked hours')
    expect(html).not.toContain('duration-recorded')
    expect(html).toContain('Paid orders')
    expect(html).toContain('Paid-linked orders')
    // Source labels follow the noun too (they read "recorded bookings" for every business before).
    expect(html).not.toContain('recorded bookings')
  })
})

describe('the Truth page attribution ladder', () => {
  async function ladder(noun: string) {
    vi.stubEnv(OUTCOME_NOUN_ENV, noun)
    vi.resetModules()
    const mod = await import('@/lib/cockpit/attribution-ladder')
    const built = mod.buildAttributionLadder({
      counts: { valueBearingBookings: 5, withPaidSignal: 3, withFbclid: 0, webhookLinked: 0, zeroValueBookings: 0, webhookLinkedCancelled: 0 },
      money: { bookedValue: 1330, collectedAmount: 810, amountPaidKnown: 5, amountPaidTotal: 5 },
      meta: { results: 9, viewThrough: 2, daysMissingViewThroughSplit: 0, valueAmount: 2100, viewThroughValue: null },
    })
    return { built, money: mod.describeMoney(built.money), value: mod.describeMetaValueSplit(built.meta) }
  }

  it('uses the configured noun for every rung and sentence', async () => {
    const { built, money, value } = await ladder('order/orders')
    expect(built.rungs[0].label).toBe('Value-bearing orders')
    expect(money).toContain('recorded for all 5 orders')
    expect(value).toContain('of order value')
    expect(built.meta.note).toContain('not order date')
    expect(JSON.stringify(built) + money + value).not.toMatch(/\b(?:booking|appointment)s?\b/i)
  })

  it('keeps booking wording for a booking business', async () => {
    const { built, money } = await ladder('booking/bookings')
    expect(built.rungs[0].label).toBe('Value-bearing bookings')
    expect(money).toContain('recorded for all 5 bookings')
  })
})
