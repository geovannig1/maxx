import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * GA4 query granularity must stay on the retained aggregate tables.
 *
 * GA4 serves `date` and `dateHour` from daily aggregates that survive indefinitely. `dateHourMinute`
 * — and any other event-level dimension — forces the query onto raw event data, which the property's
 * `eventDataRetention` setting deletes on a rolling basis: two months by Google's default, one further
 * day gone every day, unrecoverable by any means including a later BigQuery export.
 *
 * `runBookingEventRows` appended `dateHourMinute` unconditionally to every booking query. Over a window
 * longer than the retention period, with an identical event and filter, the channel-only and `date`
 * queries agree while the `dateHourMinute` query returns only the retained tail — most events and
 * most value, dropped with no error, no sampling flag, no `(other)` row. The API
 * returns what exists; retention had deleted the rest. Every consumer of this function was silently
 * understating: the evidence gate, campaign ROAS, the dashboard, the client report, and the coverage
 * ratio behind the learning-confidence gate.
 *
 * The full unit suite passed before AND after the fix, because nothing pinned the dimension. That is
 * why this file is source-level: the defect is invisible to any test that mocks the GA4 client, and a
 * live-API test cannot run in CI. The failure mode is silent under-reporting, which no assertion about
 * returned values can catch without a known-good baseline to compare against.
 */

const CLIENT = readFileSync(resolve(process.cwd(), 'src/lib/ga4/client.ts'), 'utf8')

/** Dimensions GA4 cannot serve from the retained daily aggregates. */
const EVENT_LEVEL_DIMENSIONS = ['dateHourMinute', 'dateHourMinuteSecond', 'nthMinute', 'minute']

describe('GA4 booking queries stay on retained aggregate tables', () => {
  it('reads the client source at all (guards against asserting over an empty string)', () => {
    expect(CLIENT).toContain('runBookingEventRows')
    expect(CLIENT).toContain("dimensionFilter")
  })

  it.each(EVENT_LEVEL_DIMENSIONS)('never requests the event-level dimension %s', (dimension) => {
    expect(CLIENT).not.toMatch(new RegExp(`name: '${dimension}'`))
  })

  it('appends `date` to every booking-event query', () => {
    // The identity join needs a per-event date; `date` supplies it at full fidelity, which is the
    // whole reason the minute granularity bought nothing before.
    expect(CLIENT).toMatch(/dimensions: \[\.\.\.dimensions\.map\(\(name\) => \(\{ name \}\)\), \{ name: 'date' \}\]/)
  })

  it('refuses an (other)-bucketed result', () => {
    // The silent one: GA4 preserves metric totals while destroying the dimension, so a per-campaign
    // split degrades to a bucket and everything still reconciles. Nothing in this file read
    // resp.metadata before.
    expect(CLIENT).toMatch(/dataLossFromOtherRow/)
  })

  it('treats an absent rowCount as a failure, not as zero', () => {
    // `Number(resp.rowCount ?? 0)` made a missing count satisfy the truncation guard forever while
    // limit: 10000 could still be capping.
    expect(CLIENT).not.toMatch(/resp\.rowCount \?\? 0/)
    expect(CLIENT).toMatch(/rowCount === null \|\| resp\.rowCount === undefined/)
  })

  it('refuses a truncated page rather than under-reporting from it', () => {
    // limit: 10000 with no paging. Switching to `date` multiplies row cardinality (several-fold on a
    // single query), and a silently left-truncated aggregate reads exactly like a smaller account.
    expect(CLIENT).toMatch(/rowCount/)
    expect(CLIENT).toMatch(/truncated/i)
  })
})
