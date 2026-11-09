import { describe, it, expect } from 'vitest'
import { alertMetricLabel, conversionLabel, conversionCategory } from '@/lib/conversions/labels'

describe('conversionLabel', () => {
  it('uses friendly labels for known types', () => {
    expect(conversionLabel('landing_page_view')).toBe('Landing page views')
    expect(conversionLabel('offsite_conversion.fb_pixel_custom')).toBe('Custom pixel conversions')
  })

  it('prettifies unknown types by stripping prefixes', () => {
    expect(conversionLabel('offsite_conversion.fb_pixel_view_content')).toBe('View Content')
    expect(conversionLabel('onsite_conversion.post_unsave')).toBe('Post Unsave')
  })
})

describe('alertMetricLabel', () => {
  it('preserves standard performance metric acronyms', () => {
    expect(alertMetricLabel('cpm')).toBe('CPM')
    expect(alertMetricLabel('ctr')).toBe('CTR')
    expect(alertMetricLabel('cpa')).toBe('CPA')
  })

  it('still labels conversion event names readably', () => {
    expect(alertMetricLabel('appointment_confirmed')).toBe('Appointment Confirmed')
  })
})

describe('conversionCategory', () => {
  it('classifies money events as conversions', () => {
    expect(conversionCategory('offsite_conversion.fb_pixel_purchase')).toBe('conversion')
    expect(conversionCategory('lead')).toBe('conversion')
    expect(conversionCategory('click_to_call_native_call_placed')).toBe('conversion')
  })

  it('classifies traffic, video, messaging, and engagement', () => {
    expect(conversionCategory('link_click')).toBe('traffic')
    expect(conversionCategory('landing_page_view')).toBe('traffic')
    expect(conversionCategory('video_view')).toBe('video')
    expect(conversionCategory('onsite_conversion.messaging_first_reply')).toBe('messaging')
    expect(conversionCategory('post_reaction')).toBe('engagement')
  })

  it('falls back to other', () => {
    expect(conversionCategory('some_unknown_signal')).toBe('other')
  })
})
