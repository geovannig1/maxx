import { describe, it, expect } from 'vitest'
import {
  findActionValueOrNull,
  findOutcomeEventResults,
  findOutcomeEventViewThrough,
  normalizeOutcome,
} from '@/lib/sync/upsert-insights'

describe('findActionValueOrNull', () => {
  it('keeps a source-observed zero distinct from an unavailable actions payload', () => {
    expect(findActionValueOrNull(undefined, 'landing_page_view')).toBeNull()
    expect(findActionValueOrNull([], 'landing_page_view')).toBe(0)
    expect(findActionValueOrNull([{ action_type: 'link_click', value: '3' }], 'landing_page_view')).toBe(0)
    expect(findActionValueOrNull([{ action_type: 'landing_page_view', value: '0' }], 'landing_page_view')).toBe(0)
    expect(findActionValueOrNull([{ action_type: 'landing_page_view', value: '4' }], 'landing_page_view')).toBe(4)
  })
})

// The actions array no longer reliably carries the per-name custom row (only the generic
// offsite_conversion.fb_pixel_custom aggregate) — the indicator-named "results" field is the
// only bookings source. Action aliases remain diagnostic and never replace an omitted Results value.
//
// THE DOUBLE-COUNT: with action_attribution_windows=['7d_click','1d_view'] (what fetch-insights
// sends), Meta returns the SAME conversions per indicator as per-window entries PLUS a ['default']
// total. The old parser summed every entry, counting each booking twice — the warehouse showed twice
// the bookings Ads Manager showed. The 'default' entry IS Ads Manager's
// Results number; per-window entries are diagnostic only and are never promoted into Results.

describe('findOutcomeEventResults', () => {
  it('THE DOUBLE-COUNT SHAPE: per-window entry + default total = counted ONCE', () => {
    // Campaign-level insights shape for a one-booking day.
    expect(
      findOutcomeEventResults([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [
            { value: '1', attribution_windows: ['1d_view'] },
            { value: '1', attribution_windows: ['default'] },
          ],
        },
      ]),
    ).toBe(1)
  })

  it('multi-window day: 7d_click + 1d_view + default — default wins, no summing across windows', () => {
    // A 3-booking day where 1 came via click and 2 via view; default carries the total.
    expect(
      findOutcomeEventResults([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [
            { value: '1', attribution_windows: ['7d_click'] },
            { value: '2', attribution_windows: ['1d_view'] },
            { value: '3', attribution_windows: ['default'] },
          ],
        },
      ]),
    ).toBe(3)
  })

  it('counts a default-only indicator (the original live Warm ad set shape)', () => {
    expect(
      findOutcomeEventResults([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [{ value: '2', attribution_windows: ['default'] }],
        },
      ]),
    ).toBe(2)
  })

  it('does not promote attribution partitions when the canonical default result is absent', () => {
    expect(
      findOutcomeEventResults([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [
            { value: '1', attribution_windows: ['7d_click'] },
            { value: '2', attribution_windows: ['1d_view'] },
          ],
        },
      ]),
    ).toBe(0)
  })

  it('does not promote untagged diagnostic values into the canonical result', () => {
    expect(
      findOutcomeEventResults([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [{ value: '1' }, { value: '2' }],
        },
      ]),
    ).toBe(0)
  })

  it('deduplicates repeated AppointmentConfirmed result aliases by MAX rather than summing', () => {
    expect(
      findOutcomeEventResults([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [
            { value: '1', attribution_windows: ['1d_view'] },
            { value: '1', attribution_windows: ['default'] },
          ],
        },
        {
          indicator: 'conversions:offsite_conversion.custom.AppointmentConfirmed',
          values: [{ value: '1', attribution_windows: ['default'] }],
        },
      ]),
    ).toBe(1)
  })

  it('ignores indicators for other optimization goals — bookings only', () => {
    expect(
      findOutcomeEventResults([
        { indicator: 'actions:landing_page_view', values: [{ value: '34' }] },
        { indicator: 'conversions:offsite_conversion.fb_pixel_lead', values: [{ value: '3' }] },
      ]),
    ).toBe(0)
  })

  it('is null-safe: missing field, empty array, malformed entries', () => {
    expect(findOutcomeEventResults(undefined)).toBe(0)
    expect(findOutcomeEventResults([])).toBe(0)
    expect(findOutcomeEventResults([{}, { indicator: 'x' }, { values: [{}] }])).toBe(0)
    expect(
      findOutcomeEventResults([
        { indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [{ value: 'oops' }] },
      ]),
    ).toBe(0)
  })
})

describe('normalizeOutcome — booking action alias precedence', () => {
  it('prefers canonical AppointmentConfirmed results when present, even if actions repeat aliases', () => {
    expect(
      normalizeOutcome({
        date_start: '2026-08-20',
        date_stop: '2026-08-20',
        spend: '10',
        impressions: '100',
        reach: '90',
        clicks: '5',
        actions: [
          { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '1' },
          { action_type: 'offsite_conversion.custom.10000000000000002', value: '1' },
        ],
        results: [
          {
            indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
            values: [
              { value: '1', attribution_windows: ['1d_view'] },
              { value: '1', attribution_windows: ['default'] },
            ],
          },
        ],
        action_values: [{ action_type: 'purchase', value: '125' }],
      }).bookings,
    ).toBe(1)
  })

  it('keeps bookings unavailable instead of falling back to appointment action aliases', () => {
    const outcome = normalizeOutcome({
        date_start: '2026-08-20',
        date_stop: '2026-08-20',
        spend: '10',
        impressions: '100',
        reach: '90',
        clicks: '5',
        actions: [
          { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '2' },
          { action_type: 'offsite_conversion.custom.10000000000000002', value: '2' },
        ],
        action_values: [{ action_type: 'purchase', value: '220' }],
      })
    expect(outcome.bookings).toBe(0)
    expect(outcome.resultsPresent).toBe(false)
    expect(outcome.valid).toBe(true)
  })

  it('rejects a split-only AppointmentConfirmed result as non-canonical', () => {
    const outcome = normalizeOutcome({
      date_start: '2026-08-20', date_stop: '2026-08-20',
      spend: '10', impressions: '100', reach: '90', clicks: '5',
      results: [{
        indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
        values: [
          { value: '1', attribution_windows: ['7d_click'] },
          { value: '2', attribution_windows: ['1d_view'] },
        ],
      }],
    })
    expect(outcome.bookings).toBe(0)
    expect(outcome.resultsPresent).toBe(false)
    expect(outcome.valid).toBe(false)
  })

  it('rejects attribution partitions that contradict a canonical zero', () => {
    const outcome = normalizeOutcome({
      date_start: '2026-08-20', date_stop: '2026-08-20',
      spend: '10', impressions: '100', reach: '90', clicks: '5',
      results: [{
        indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
        values: [
          { value: '0', attribution_windows: ['default'] },
          { value: '1', attribution_windows: ['7d_click'] },
          { value: '0', attribution_windows: ['1d_view'] },
        ],
      }],
    })
    expect(outcome.bookings).toBe(0)
    expect(outcome.valid).toBe(false)
  })
})

describe('findOutcomeEventViewThrough', () => {
  it('reads the 1d_view per-window entry (the live all-view-through account shape)', () => {
    expect(
      findOutcomeEventViewThrough([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [
            { value: '3', attribution_windows: ['1d_view'] },
            { value: '3', attribution_windows: ['default'] },
          ],
        },
      ]),
    ).toBe(3)
  })

  it('a click-only day has 0 view-throughs (window entries present, none 1d_view)', () => {
    expect(
      findOutcomeEventViewThrough([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [
            { value: '2', attribution_windows: ['7d_click'] },
            { value: '2', attribution_windows: ['default'] },
          ],
        },
      ]),
    ).toBe(0)
  })

  it('returns null — unknown, not zero — when no per-window breakdown exists', () => {
    expect(
      findOutcomeEventViewThrough([
        {
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [{ value: '2', attribution_windows: ['default'] }],
        },
      ]),
    ).toBeNull()
    expect(findOutcomeEventViewThrough(undefined)).toBeNull()
    expect(findOutcomeEventViewThrough([])).toBeNull()
  })

  it('ignores non-AppointmentConfirmed indicators', () => {
    expect(
      findOutcomeEventViewThrough([
        { indicator: 'actions:landing_page_view', values: [{ value: '9', attribution_windows: ['1d_view'] }] },
      ]),
    ).toBeNull()
  })
})

// ── Alias fixes: breakdown bookings double-count + appointment_value capture ──
// The defect these pin: insight_breakdowns segment bookings could sum to far more than the flat daily
// rows over the same window (the bare fb_pixel_custom aggregate AND an appointment-specific row both
// matched the old BOOKING_TYPES set), and appointment_value could sit NULL account-wide while CAPI was
// sending real prices (action_values carried only the bare aggregate, which the strict matcher
// deliberately excluded).

import { readBookingValue, readBookingValueViewThrough } from '@/lib/sync/upsert-insights'
import {
  buildBreakdownRow,
  findBookingsFromActions,
  bookingsForBreakdownRecord,
} from '@/lib/platforms/meta/fetch-breakdowns'

describe('readBookingValue — the single booking-value reading', () => {
  it('named appointment rows WIN — nothing is ever added on top (alias double-count guard)', () => {
    expect(
      readBookingValue([
        { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '165' },
        { action_type: 'offsite_conversion.fb_pixel_custom', value: '165' },
      ]),
    ).toEqual({ value: 165, valid: true, matched: true })
  })

  it('named AppointmentConfirmed values take precedence over unrelated purchase values', () => {
    expect(
      readBookingValue([
        { action_type: 'offsite_conversion.custom.10000000000000002', value: '125' },
        { action_type: 'purchase', value: '999' },
      ]),
    ).toEqual({ value: 125, valid: true, matched: true })
  })

  it('does not reinterpret the purchase family as AppointmentConfirmed value', () => {
    expect(
      readBookingValue([
        { action_type: 'purchase', value: '218.75' },
        { action_type: 'omni_purchase', value: '218.75' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '218.75' },
        { action_type: 'web_in_store_purchase', value: '0.12' },
      ]),
    ).toEqual({ value: 0, valid: true, matched: false })
  })

  it('THE AGGREGATE MISMATCH: the fb_pixel_custom aggregate is NOT booking value', () => {
    // An ad row carrying only the aggregate, read as booking value, would push the ad-level total
    // above the campaign total and freeze the account. The aggregate sums every custom pixel event on
    // a different attribution basis — it answers a different question, so a row that carries only the
    // aggregate reports NO booking value.
    expect(
      readBookingValue([{ action_type: 'offsite_conversion.fb_pixel_custom', value: '95' }]),
    ).toEqual({ value: 0, valid: true, matched: false })
  })

  it('a reported zero is a value; an absent measure is not', () => {
    expect(readBookingValue([{ action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '0' }]))
      .toEqual({ value: 0, valid: true, matched: true })
    expect(readBookingValue([{ action_type: 'purchase', value: '0' }]))
      .toEqual({ value: 0, valid: true, matched: false })
    expect(readBookingValue(undefined)).toEqual({ value: 0, valid: true, matched: false })
    expect(readBookingValue([])).toEqual({ value: 0, valid: true, matched: false })
  })

  it('a malformed amount fail-stops instead of resolving to zero', () => {
    expect(readBookingValue([{ action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: 'abc' }]))
      .toEqual({ value: 0, valid: false, matched: true })
  })

  it('THE CONVERSION_VALUES SHAPE: conversion_values names the event when action_values only aggregates', () => {
    // A reduced synthetic payload. Meta stopped naming custom events in action_values, so the
    // only entry there is the aggregate — correctly refused by the test above. The value was in
    // `conversion_values` the whole time. Before this fix an account could store $0.00 booking value
    // for a whole month of bookings and spend, while Meta held the real figure.
    expect(
      readBookingValue(
        [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '2900' }],
        undefined,
        [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '3800' }],
      ),
    ).toEqual({ value: 3800, valid: true, matched: true })
  })

  it('conversion_values does NOT license the aggregate — the aggregate refusal still holds there', () => {
    // The new field is not a loophole. An aggregate arriving in conversion_values is the same
    // different-question number it was in action_values and is refused identically.
    expect(
      readBookingValue(undefined, undefined, [
        { action_type: 'offsite_conversion.fb_pixel_custom', value: '2900' },
      ]),
    ).toEqual({ value: 0, valid: true, matched: false })
  })

  it('the VIEW-THROUGH share of booking value is read, and absence is not zero', () => {
    // In this synthetic month 62% of booking value is 1d_view (2356 of 3800). A ROAS built on
    // the total alone reads as click-earned revenue.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
        value: '3800', '1d_view': '2356', '7d_click': '1444' },
    ])).toEqual({ value: 2356, valid: true })

    // A ROW WITH value 640, 7d_click 640, NO 1d_view. Meta omits a zero-valued window
    // rather than withholding the breakdown — so this is a measured ZERO, not unknown. Mirroring the
    // count rule's "absent = unknown" here made a 100%-CLICK row the only kind whose click-through
    // value was uncomputable, inverting the column's purpose.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '640', '7d_click': '640' },
    ])).toEqual({ value: 0, valid: true })

    // NULL only when NO window sub-key is reported at all — that is genuinely unknown.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '3800' },
    ])).toEqual({ value: null, valid: true })

    // A share exceeding its own total is incoherent — fail-stop rather than store it. `value` follows
    // attribution_spec while sub-keys follow the request, so this is possible without a bug here.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '100', '1d_view': '900' },
    ])).toEqual({ value: null, valid: false })

    // A real reported zero IS a measurement and survives.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '125', '1d_view': '0' },
    ])).toEqual({ value: 0, valid: true })
  })

  it('the view-through reader picks the SAME entry readBookingValue does, on an alias pair', () => {
    // `readBookingValue` takes the MAX matching entry; this reader used `.find()` (the first). On an
    // alias pair the total would store 3800 while the view-through stored 100 — a 2.6% share
    // against a true 62%, the exact creative-ranking error this column exists to prevent.
    const aliases = [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '100', '1d_view': '100' },
      { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '3800', '1d_view': '2356' },
    ]
    expect(readBookingValue(undefined, undefined, aliases).value).toBe(3800)
    expect(readBookingValueViewThrough(undefined, undefined, aliases)).toEqual({ value: 2356, valid: true })
  })

  it('malformed view-through money FAIL-STOPS instead of laundering into "unknown"', () => {
    // `null` is DEFINED as "split not reported". Collapsing a corrupt amount into it would store bad
    // input as a legitimate unknown. `readBookingValue` fail-stops on this; so does this reader now.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '125', '1d_view': 'abc' },
    ])).toEqual({ value: null, valid: false })
    // A malformed TOTAL fail-stops too — the entry cannot be ranked, so no entry can be chosen.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: 'abc', '1d_view': '5' },
    ])).toEqual({ value: null, valid: false })
  })

  it('a malformed 1d_view makes the whole row INVALID, instead of storing a laundered null', () => {
    // The reader's `valid` was produced and never consumed, so corrupt money still became a stored
    // `null` — which db.ts and the migration both DEFINE as "no breakdown reported (unknown)". The
    // laundering B named simply moved one layer out. `normalizeOutcome.valid` IS consumed
    // (meta_outcome_${level}_payload_invalid), so folding it in fail-stops for real.
    const outcome = normalizeOutcome({
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
                  values: [{ value: '3', attribution_windows: ['default'] }] }],
      conversion_values: [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
                            value: '615', '1d_view': 'abc' }],
    } as never)
    expect(outcome.valid).toBe(false)
  })

  it('the window sentinel is ANY sub-key, not a hardcoded 7d_click', () => {
    // Testing best['7d_click'] coupled this to ACTION_ATTRIBUTION_WINDOWS_ARR without referencing it:
    // change that const and every absent 1d_view silently reverts to null with no test failing.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '640', '28d_click': '640' },
    ])).toEqual({ value: 0, valid: true })
    // An ENGAGED_VIDEO_VIEW ad set's shape — a third window, no 7d_click, no 1d_view.
    expect(readBookingValueViewThrough(undefined, undefined, [
      { action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '440', 'engaged_video_view': '440' },
    ])).toEqual({ value: 0, valid: true })
  })

  it('normalizeOutcome does not report value UNAVAILABLE when only conversion_values carries it', () => {
    // The gate/writer split, in the inverse direction. `valuePresent` read Array.isArray(action_values)
    // alone, so the terminal Meta shape — conversion_values names the event, action_values absent —
    // made the writer store a real value while the gate said unavailable. reconcileAccountOutcomes
    // then NULLed the account rollup, leaving populated ad rows under a NULL account row.
    const outcome = normalizeOutcome({
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
                  values: [{ value: '3', attribution_windows: ['default'] }] }],
      conversion_values: [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '615' }],
      // action_values deliberately ABSENT — this is the whole point of the case.
    } as never)
    expect(outcome.bookings).toBe(3)
    expect(outcome.value).toBe(615)
    // `valuePresent` is the predicate the `meta_outcome_*_value_unavailable` blocker is derived from,
    // and the one that used to read Array.isArray(action_values) alone.
    expect(outcome.valuePresent).toBe(true)
  })

  it('a genuine gap — NEITHER array present — still freezes the plane', () => {
    // The fix must not become fail-open. With bookings > 0 and no value array at all, the blocker
    // must still fire, or a real Meta outage reads as $0 revenue.
    const outcome = normalizeOutcome({
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
                  values: [{ value: '3', attribution_windows: ['default'] }] }],
    } as never)
    expect(outcome.bookings).toBe(3)
    expect(outcome.valuePresent).toBe(false)
  })

  it('action_values stays the FALLBACK, so re-syncing pre-change windows still reads them', () => {
    // Historical rows DO name the event in action_values. Preferring the new field must not blind
    // the reader to the old one, or a backfill of Apr/May would zero months that currently work.
    expect(
      readBookingValue(
        [{ action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '220' }],
        undefined,
        [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '999' }],
      ),
    ).toEqual({ value: 220, valid: true, matched: true })
  })
})

describe('findBookingsFromActions (breakdown alias double-count fix)', () => {
  it('THE 16-vs-9 SHAPE: aggregate + specific row for the same booking = counted ONCE', () => {
    expect(
      findBookingsFromActions([
        { action_type: 'offsite_conversion.fb_pixel_custom', value: '1' },
        { action_type: 'offsite_conversion.custom.10000000000000002', value: '1' },
      ]),
    ).toBe(1)
  })

  it('never treats the generic custom aggregate as AppointmentConfirmed', () => {
    expect(
      findBookingsFromActions([
        { action_type: 'offsite_conversion.fb_pixel_custom', value: '2' },
      ]),
    ).toBe(0)
  })

  it('specific-only payloads count normally; unrelated actions are ignored', () => {
    expect(
      findBookingsFromActions([
        { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '3' },
        { action_type: 'landing_page_view', value: '50' },
      ]),
    ).toBe(3)
    expect(findBookingsFromActions(undefined)).toBe(0)
  })

  it('uses MAX across repeated appointment-specific aliases, never their sum', () => {
    expect(
      findBookingsFromActions([
        { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '2' },
        { action_type: 'offsite_conversion.custom.10000000000000002', value: '2' },
      ]),
    ).toBe(2)
  })
})

describe('bookingsForBreakdownRecord (results-field preference)', () => {
  it('prefers the indicator-named results field with default-entry dedup over actions', () => {
    expect(
      bookingsForBreakdownRecord({
        results: [
          {
            indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
            values: [
              { value: '1', attribution_windows: ['1d_view'] },
              { value: '1', attribution_windows: ['default'] },
            ],
          },
        ],
        actions: [
          { action_type: 'offsite_conversion.fb_pixel_custom', value: '1' },
          { action_type: 'offsite_conversion.custom.10000000000000002', value: '1' },
        ],
      }),
    ).toBe(1)
  })

  it('keeps Results canonical when action aliases would otherwise inflate the row', () => {
    expect(
      bookingsForBreakdownRecord({
        results: [
          {
            indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
            values: [{ value: '2', attribution_windows: ['default'] }],
          },
        ],
        actions: [
          { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '2' },
          { action_type: 'offsite_conversion.custom.10000000000000002', value: '2' },
        ],
      }),
    ).toBe(2)
  })

  it('returns unavailable when Meta omits canonical results, regardless of action aliases', () => {
    expect(
      bookingsForBreakdownRecord({
        actions: [
          { action_type: 'offsite_conversion.fb_pixel_custom', value: '1' },
          { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '1' },
        ],
      }),
    ).toBeNull()
    expect(bookingsForBreakdownRecord({ results: [], actions: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '1' }] })).toBeNull()
  })
})

describe('buildBreakdownRow (evidence-safe normalization)', () => {
  const valid = {
    campaign_id: 'campaign-1', adset_id: 'adset-1', publisher_platform: 'instagram',
    spend: '10.25', impressions: '100', clicks: '5', actions: [], results: [],
  }

  it.each([
    [{ ...valid, spend: undefined }, 'spend'],
    [{ ...valid, impressions: 'not-a-number' }, 'impressions'],
    [{ ...valid, clicks: '-1' }, 'clicks'],
  ])('rejects missing or malformed required delivery fields', (record, field) => {
    expect(() => buildBreakdownRow(record, 'adset', 'publisher_platform')).toThrow(field)
  })

  it('preserves delivery but keeps both outcomes unknown when Meta omits the actions plane', () => {
    expect(buildBreakdownRow({ ...valid, actions: undefined }, 'adset', 'publisher_platform')).toMatchObject({
      spend: 10.25, impressions: 100, clicks: 5, leads: null, bookings: null,
    })
  })

  it('keeps the outcome pair unavailable when Results has no AppointmentConfirmed indicator', () => {
    expect(buildBreakdownRow(valid, 'adset', 'publisher_platform')).toMatchObject({
      leads: null, bookings: null,
    })
  })

  it('accepts the explicit zero-result indicator as canonical zero', () => {
    expect(buildBreakdownRow({
      ...valid,
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed' }],
    }, 'adset', 'publisher_platform')).toMatchObject({
      leads: 0, bookings: 0,
    })
  })
})
