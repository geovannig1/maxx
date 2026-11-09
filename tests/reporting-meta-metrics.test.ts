import { describe, expect, it } from 'vitest'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import type { ReportingContext } from '@/lib/reporting/contracts'

export const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: '123', name: 'Test' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
const result = (value: string) => [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [{ value, attribution_windows: ['default'] }] }]

describe('Meta metric evidence', () => {
  it('labels native, derived and comparison windows with the queried impression-date basis', () => {
    const metrics = buildMetaMetrics(context, { spend: '100', results: result('2') }, { spend: '90', results: result('1') })
    for (const metric of Object.values(metrics)) {
      expect(metric.current.window.basis).toBe('impression_date_et')
      expect(metric.current.comparison.window?.basis).toBe('impression_date_et')
      expect(metric.previous?.window.basis).toBe('impression_date_et')
    }
  })
  it('keeps appointment and purchase families separate and deduplicates purchase aliases', () => {
    const metrics = buildMetaMetrics(context, {
      spend: '100', results: result('2'), actions: [{ action_type: 'purchase', value: '2' }, { action_type: 'omni_purchase', value: '2' }],
      conversion_values: [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: '200' }],
      action_values: [{ action_type: 'purchase', value: '300' }, { action_type: 'omni_purchase', value: '300' }],
    })
    expect(metrics.bookings.current.value).toBe(2)
    expect(metrics.purchase_count.current.value).toBe(2)
    expect(metrics.appointment_roas.current.value).toBe(2)
    expect(metrics.purchase_roas.current.value).toBe(3)
    expect(metrics.appointment_roas.current.inputClaimIds).toHaveLength(2)
  })
  it('accepts explicit zero but never substitutes link clicks for omitted outbound clicks', () => {
    const metrics = buildMetaMetrics(context, { spend: '0', inline_link_clicks: '10', outbound_clicks: [{ action_type: 'outbound_click', value: '0' }] })
    expect(metrics.outbound_clicks.current.value).toBe(0)
    expect(buildMetaMetrics(context, { inline_link_clicks: '10' }).outbound_clicks.current.value).toBeNull()
    expect(metrics.appointment_value.current.value).toBeNull()
    expect(metrics.cost_per_booking.current.value).toBeNull()
  })
  it.each([undefined, [], [{ action_type: 'purchase', value: 'bad' }], [{ action_type: 'purchase', value: '2' }, { action_type: 'purchase', value: '2' }]])('refuses absent or invalid purchase values %#', action_values => {
    expect(buildMetaMetrics(context, { action_values }).purchase_value.current.value).toBeNull()
  })
  it('refuses malformed, duplicated appointment results and default windows', () => {
    for (const results of [result('bad'), [...result('2'), ...result('2')], [{ ...result('2')[0], values: [...result('2')[0].values, ...result('2')[0].values] }]]) {
      expect(buildMetaMetrics(context, { results }).bookings.current.value).toBeNull()
    }
  })
  it('preserves canonical values-less result zero without inventing an omitted money field', () => {
    const metrics = buildMetaMetrics(context, { results: [{ indicator: 'AppointmentConfirmed' }] })
    expect(metrics.bookings.current.value).toBe(0)
    expect(metrics.appointment_value.current.value).toBeNull()
  })
  it('marks recent conversion estimates as settling and old comparisons as settled', () => {
    const oldContext = { ...context, comparison: { from: '2026-08-01', to: '2026-08-03' } }
    const metrics = buildMetaMetrics(oldContext, { results: result('2') }, { results: result('1') })
    expect(metrics.bookings.current.maturity.state).toBe('settling')
    expect(metrics.bookings.previous?.maturity.state).toBe('settled')
  })
  it('marks action-backed metrics and derived ratios with Meta attribution scope', () => {
    const metrics = buildMetaMetrics(context, { spend: '10', actions: [{ action_type: 'landing_page_view', value: '2' }], outbound_clicks: [{ action_type: 'outbound_click', value: '3' }] })
    expect(metrics.landing_page_views.current.attributionScope).toBe('meta_platform_modelled')
    expect(metrics.outbound_clicks.current.attributionScope).toBe('meta_platform_modelled')
    expect(metrics.cost_per_lpv.current.attributionScope).toBe('meta_platform_modelled')
    expect(metrics.spend.current.attributionScope).toBe('none')
  })
  it('reads only exact supported inquiry/profile action fields and keeps their costs event-specific', () => {
    const metrics = buildMetaMetrics(context, {
      spend: '24', instagram_profile_visits: '8', instagram_profile_follow: '2',
      actions: [
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' },
        { action_type: 'onsite_conversion.messaging_conversation_replied_7d', value: '1' },
        { action_type: 'onsite_conversion.messaging_first_reply', value: '1' },
        { action_type: 'video_view', value: '12' },
        { action_type: 'onsite_conversion.messaging_conversation_started_1d', value: '99' },
      ],
    })
    expect(metrics.messaging_conversations_started.current.value).toBe(3)
    expect(metrics.messaging_conversations_replied.current.value).toBe(1)
    expect(metrics.messaging_first_replies.current.value).toBe(1)
    expect(metrics.instagram_profile_visits.current.value).toBe(8)
    expect(metrics.instagram_profile_follows.current.value).toBe(2)
    expect(metrics.action_video_views.current.value).toBe(12)
    expect(metrics.cost_per_messaging_conversation_started.current.value).toBe(8)
    expect(metrics.cost_per_instagram_profile_visit.current.value).toBe(3)
    expect(metrics.instagram_profile_visits.current.attributionScope).toBe('meta_platform_modelled')
    expect(metrics.instagram_profile_visits.current.measurementKind).toBe('modelled')
    expect(metrics.action_video_views.label).toBe('Meta actions: video_view')
  })
  it('uses native period reach, watch seconds, and strict retention denominator coverage', () => {
    const metrics = buildMetaMetrics(context, { reach: '90', frequency: '1.5', video_avg_time_watched_actions: [{ action_type: 'video_view', value: '4.5' }], video_p25_watched_actions: [{ action_type: 'video_view', value: '10' }] }, { reach: '70' })
    expect(metrics.reach.current.value).toBe(90)
    expect(metrics.reach.previous?.value).toBe(70)
    expect(metrics.reach.previous?.window.start).toBe('2026-08-30')
    expect(metrics.average_watch_seconds.current.unit).toBe('seconds')
    expect(metrics.retention_p25.current.value).toBeNull()
  })
})
