import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { websiteReportingFixture } from './reporting-browser/website-fixture'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'

describe('observed paid-touch booking delay review', () => {
  it('explains the measured tail and its sample without inventing a click cohort or maturity threshold', () => {
    const data = websiteReportingFixture(), review = deriveExpertReview(data)
    const finding = review.findings.find(item => item.id === 'journey.measurement.booking_lag')!
    expect(finding.status).not.toBe('unavailable')
    expect(finding.observation.text).toContain('3 sampled bookings')
    expect(finding.observation.text).toContain('median 6 days')
    expect(finding.observation.text).toContain('p90 39 days')
    expect(finding.materiality.text).toContain('3-day')
    expect(finding.limitations.join(' ')).toContain('unconverted')
    expect(finding.observation.text).not.toMatch(/click.*cohort|wait 39|mature after/i)
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    // A smaller event decline and timing consequence both survive the opening review.
    expect(overviewFindings(review).map(item => item.id)).toContain(finding.id)
    expect(overviewFindings(review).some(item => item.area === 'measurement' && item.direction === 'declined')).toBe(true)
  })
  // One case per test: each runs the whole expert review (~250 ms, ~0.6 s under load), and eight in one
  // test took ~14 s on a busy machine. Splitting keeps every assertion and names the case that fails.
  it.each(['unit', 'sample', 'source', 'window', 'denominator', 'linked_scope', 'event', 'future'] as const)(
    'withholds lag interpretation for a corrupt %s', corrupt => {
      const data = structuredClone(websiteReportingFixture()), metrics = data.measurement.data!.paidAssociation
      if (corrupt === 'unit') metrics.median_paid_touch_to_booking_lag_days.current.unit = 'money'
      if (corrupt === 'sample') metrics.paid_touch_booking_lag_sample_bookings.current.value = 6
      if (corrupt === 'source') metrics.p90_paid_touch_to_booking_lag_days.current.attributionScope = 'all_sources'
      if (corrupt === 'window') metrics.p90_paid_touch_to_booking_lag_days.current.window.basis = 'closed_account_days'
      if (corrupt === 'denominator') for (const [key, metric] of Object.entries(metrics)) {
        if (key !== 'linked_value_bearing_bookings') metric.current.coverage.denominator = 5
      }
      if (corrupt === 'linked_scope') metrics.linked_value_bearing_bookings.current.attributionScope = 'all_sources'
      if (corrupt === 'event') metrics.linked_value_bearing_bookings.event = 'unrelated_event'
      if (corrupt === 'future') for (const metric of Object.values(metrics)) metric.current.asOf = '2026-09-05T17:00:00.000000001Z'
      const finding = deriveExpertReview(data).findings.find(item => item.id === 'journey.measurement.booking_lag')
      expect(finding?.status === 'unavailable' || !finding).toBe(true)
    })
})
