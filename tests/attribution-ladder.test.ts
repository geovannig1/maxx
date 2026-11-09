import { describe, expect, it } from 'vitest'
import {
  buildAttributionLadder, describeMetaClaim, describeMetaValueSplit, describeMoney,
} from '@/lib/cockpit/attribution-ladder'

/**
 * A synthetic full-range account. Every rung is measured over the value-bearing population, which is
 * why the linked rung is 5 rather than the 7 raw rows in `outcome_paid_touch_links`: 2 of those
 * bookings cancelled.
 */
const FULL_RANGE = {
  counts: { valueBearingBookings: 200, zeroValueBookings: 20, withPaidSignal: 24, withFbclid: 18, webhookLinked: 5, webhookLinkedCancelled: 2 },
  money: { bookedValue: 48000, collectedAmount: 45250.25, amountPaidKnown: 220, amountPaidTotal: 220 },
  // valueAmount 0 / viewThroughValue null models a range synced BEFORE the value split existed, so no
  // value split was ever captured for it. It exercises the "Meta reported no value breakdown" path.
  meta: { results: 40, viewThrough: 26, daysMissingViewThroughSplit: 30, valueAmount: 0, viewThroughValue: null },
}

/** The DEFAULT view the page actually opens on: month-to-date. */
const MTD = {
  counts: { valueBearingBookings: 41, zeroValueBookings: 6, withPaidSignal: 11, withFbclid: 8, webhookLinked: 2, webhookLinkedCancelled: 1 },
  money: { bookedValue: 0, collectedAmount: 0, amountPaidKnown: 0, amountPaidTotal: 0 },
  meta: { results: 14, viewThrough: 6, daysMissingViewThroughSplit: 0, valueAmount: 0, viewThroughValue: null },
}

/**
 * A synthetic month at ACCOUNT level synced with the value split, so it carries the value split —
 * the reason the split exists at all: a window can read well above break-even on all-attributed
 * value and well below it on click-implied value against the same spend.
 */
const MONTH_VALUE_SPLIT = {
  counts: { valueBearingBookings: 41, zeroValueBookings: 6, withPaidSignal: 11, withFbclid: 8, webhookLinked: 2, webhookLinkedCancelled: 1 },
  money: { bookedValue: 0, collectedAmount: 0, amountPaidKnown: 0, amountPaidTotal: 0 },
  meta: { results: 22, viewThrough: 12, daysMissingViewThroughSplit: 0, valueAmount: 3800, viewThroughValue: 2356 },
}

describe('attribution ladder', () => {
  it('descends 200 -> 24 -> 18 -> 5 on the full-range figures', () => {
    const ladder = buildAttributionLadder(FULL_RANGE)
    expect(ladder.rungs.map((r) => r.count)).toEqual([200, 24, 18, 5])
    expect(ladder.basis).toBe('booking_created_date_et')
  })

  it('descends 41 -> 11 -> 8 -> 2 on the default month-to-date view', () => {
    expect(buildAttributionLadder(MTD).rungs.map((r) => r.count)).toEqual([41, 11, 8, 2])
  })

  it('reports paid-linked bookings that cancelled instead of quietly dropping them', () => {
    expect(buildAttributionLadder(FULL_RANGE).cancelledPaidLinked).toBe(2)
  })

  it('gives every rung below the first a reason it is smaller', () => {
    const ladder = buildAttributionLadder(FULL_RANGE)
    expect(ladder.rungs[0].dropReason).toBeNull()
    for (const rung of ladder.rungs.slice(1)) {
      expect(rung.dropReason, rung.label).toBeTruthy()
      expect(rung.dropReason!.length).toBeGreaterThan(20)
    }
  })

  // The category error this module exists to prevent.
  it('keeps Meta OUT of the rungs and on its own date basis', () => {
    const ladder = buildAttributionLadder(FULL_RANGE)
    expect(ladder.rungs.map((r) => r.key)).not.toContain('meta')
    expect(ladder.meta.basis).toBe('closed_account_days')
    expect(ladder.basis).toBe('booking_created_date_et')
    expect(ladder.meta.note).toMatch(/not a subset/)
  })

  it('refuses to render a ladder whose rungs are not nested', () => {
    expect(() => buildAttributionLadder({
      ...FULL_RANGE,
      counts: { ...FULL_RANGE.counts, withFbclid: 40 }, // more fbclid than paid-signal: impossible
    })).toThrow(/not nested/)
  })

  it('splits Meta results into view-through and click-implied', () => {
    const { meta } = buildAttributionLadder(FULL_RANGE)
    expect(meta.viewThrough).toBe(26)
    expect(meta.clickImplied).toBe(14)
  })

  it('marks the view-through split as a floor when Meta withheld it on some days', () => {
    expect(buildAttributionLadder(FULL_RANGE).meta.viewThroughIsFloor).toBe(true)
    expect(describeMetaClaim(buildAttributionLadder(FULL_RANGE).meta)).toMatch(/at least 26 view-through/)

    const complete = buildAttributionLadder(MTD).meta
    expect(complete.viewThroughIsFloor).toBe(false)
    expect(describeMetaClaim(complete)).toMatch(/6 view-through, 8 click-implied/)
  })

  it('handles Meta reporting no split at all without inventing one', () => {
    const { meta } = buildAttributionLadder({ ...FULL_RANGE, meta: { results: 40, viewThrough: null, daysMissingViewThroughSplit: 3, valueAmount: 0, viewThroughValue: null } })
    expect(meta.clickImplied).toBeNull()
    expect(describeMetaClaim(meta)).toMatch(/no view-through split/)
  })

  it('rejects a view-through count larger than total results', () => {
    expect(() => buildAttributionLadder({ ...FULL_RANGE, meta: { results: 10, viewThrough: 11, daysMissingViewThroughSplit: 0, valueAmount: 0, viewThroughValue: null } }))
      .toThrow(/cannot exceed total results/)
  })

  it('reports collected money as exact when amount_paid covers every appointment', () => {
    const ladder = buildAttributionLadder(FULL_RANGE)
    expect(ladder.money.collectedIsLowerBound).toBe(false)
    expect(describeMoney(ladder.money)).toMatch(/\$45,250\.25 collected \(checkout amount recorded for all 220/)
  })

  // A missing checkout amount is never $0.
  it('reports collected money as an observed lower bound when coverage is partial', () => {
    const ladder = buildAttributionLadder({
      ...FULL_RANGE, money: { bookedValue: 48000, collectedAmount: 30000, amountPaidKnown: 150, amountPaidTotal: 220 },
    })
    expect(ladder.money.collectedIsLowerBound).toBe(true)
    expect(describeMoney(ladder.money)).toMatch(/observed lower bound \(checkout amount recorded for 150 of 220/)
  })

  it('carries zero-value bookings separately and never calls them tests', () => {
    const ladder = buildAttributionLadder(FULL_RANGE)
    expect(ladder.zeroValueBookings).toBe(20)
    expect(JSON.stringify(ladder)).not.toMatch(/\btest\b/i)
  })

  it('rejects impossible coverage', () => {
    expect(() => buildAttributionLadder({
      ...FULL_RANGE, money: { ...FULL_RANGE.money, amountPaidKnown: 300, amountPaidTotal: 220 },
    })).toThrow(/coverage cannot exceed/)
  })
})

/**
 * The VALUE split.
 *
 * Counts alone had been on this surface and were not enough: an account can read well above
 * break-even on all-attributed value and well below it on click-implied value, and nothing on any
 * screen said so. `appointment_value_view_through` was written by the sync and read by NOTHING — measured with
 * a control: 8 files read the count split, 2 read the value split and both were the type and the
 * writer.
 */
describe('attribution ladder — Meta value split', () => {
  it('splits a month of value into view-through and click-implied', () => {
    const { meta } = buildAttributionLadder(MONTH_VALUE_SPLIT)
    expect(meta.valueAmount).toBe(3800)
    expect(meta.viewThroughValue).toBe(2356)
    expect(meta.clickImpliedValue).toBe(1444)
  })

  it('states the share and names what a total-based ROAS would include', () => {
    const sentence = describeMetaValueSplit(buildAttributionLadder(MONTH_VALUE_SPLIT).meta)
    expect(sentence).toMatch(/\$3,800\.00/)
    expect(sentence).toMatch(/\$2,356\.00 \(62%\) view-through/)
    expect(sentence).toMatch(/\$1,444\.00 click-implied/)
    expect(sentence).toMatch(/only the click-implied half was earned from a click/)
  })

  it('returns NULL rather than $0.00 when Meta reported no value breakdown', () => {
    // The distinction the `appointment_value_view_through` column comment documents: NULL is "not captured", 0 is a
    // measured zero. Rendering "$0.00 view-through" for an unmeasured window would assert the
    // opposite of the truth — the exact laundering the sync's own fail-stop exists to prevent.
    const { meta } = buildAttributionLadder(FULL_RANGE)
    expect(meta.viewThroughValue).toBeNull()
    expect(meta.clickImpliedValue).toBeNull()
    expect(describeMetaValueSplit(meta)).toBeNull()
  })

  it('rejects a view-through value larger than total value', () => {
    // The must-fail direction. Without this the split is satisfiable by any pair of numbers.
    expect(() => buildAttributionLadder({
      ...MONTH_VALUE_SPLIT,
      meta: { ...MONTH_VALUE_SPLIT.meta, valueAmount: 100, viewThroughValue: 101 },
    })).toThrow(/view-through value cannot exceed total value/)
  })
})
