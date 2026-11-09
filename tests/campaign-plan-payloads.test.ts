import { describe, expect, it } from 'vitest'
import {
  adBody, adSetBody, assertPaused, campaignBody, creativeBody, hasExactMarker, markerSeed, objectMarker, promotedObject, targetingOf, zonedTime,
} from '@/lib/platforms/meta/campaign-payloads'
import { validSpec } from './_support/campaign-plan-fixtures'

// ADR-062: the Graph bodies that create a plan. Every one is PAUSED and none can be anything else.

describe('campaign creation payloads', () => {
  const spec = validSpec()
  const marker = objectMarker('ffffffffffff', 'adset:as1')

  it('creates every object PAUSED and carries the marker in the name', () => {
    const bodies = [
      campaignBody(spec, 'mxffffffff-campaign'),
      adSetBody(spec, spec.ad_sets[0], '9001', marker, 'America/New_York'),
      adBody(spec.ad_sets[0].ads[0], '9002', '9003', 'mxffffffff-ad-as1-ad1'),
    ]
    for (const body of bodies) {
      expect(body.status).toBe('PAUSED')
      expect(() => assertPaused(body)).not.toThrow()
    }
    expect(bodies[1].name).toBe(`Broad US [${marker}]`)
    expect(marker).toBe('mxffffffffffff-adset-as1')
  })

  it('binds a marker to one creation request, not to the spec (security review H1)', () => {
    const v = '11111111-1111-4111-8111-111111111111'
    expect(markerSeed(v, '22222222-2222-4222-8222-222222222222')).toMatch(/^[0-9a-f]{12}$/)
    expect(markerSeed(v, '22222222-2222-4222-8222-222222222222')).toBe(markerSeed(v, '22222222-2222-4222-8222-222222222222'))
    expect(markerSeed(v, '22222222-2222-4222-8222-222222222222')).not.toBe(markerSeed(v, '33333333-3333-4333-8333-333333333333'))
    expect(objectMarker('ffffffffffff', 'creative:as10:ad10').length).toBeLessThanOrEqual(40)
    expect(hasExactMarker(`Broad US [${marker}]`, marker)).toBe(true)
    expect(hasExactMarker(`Broad US [${marker}] copy`, marker)).toBe(false)
    expect(hasExactMarker(`Broad US [x${marker}]`, marker)).toBe(false)
  })

  it('refuses any body that would leave an object active', () => {
    expect(() => assertPaused({ name: 'x', status: 'ACTIVE' })).toThrow(/never_activates/)
    expect(() => assertPaused({ creative: JSON.stringify({ status: 'ACTIVE' }) })).toThrow(/never_activates/)
    // Copy that merely contains the word is not a status (control).
    expect(() => assertPaused({ object_story_spec: JSON.stringify({ message: 'Stay ACTIVE this winter' }) })).not.toThrow()
  })

  it('maps a standard event and a custom event to promoted_object', () => {
    expect(promotedObject(spec)).toEqual({ pixel_id: '111', custom_event_type: 'PURCHASE' })
    expect(promotedObject({ ...spec, conversion: { pixel_id: '111', custom_event: 'AppointmentConfirmed' } }))
      .toEqual({ pixel_id: '111', custom_event_type: 'OTHER', custom_event_str: 'AppointmentConfirmed' })
  })

  it('turns off audience relaxation when a custom audience is targeted', () => {
    const adSet = { ...spec.ad_sets[0], audience: { ...spec.ad_sets[0].audience, mode: 'custom' as const, custom_audience_ids: ['900'], excluded_audience_ids: [] } }
    expect(targetingOf(adSet)).toMatchObject({ custom_audiences: [{ id: '900' }], targeting_relaxation_types: { lookalike: 0, custom_audience: 0 }, targeting_automation: { advantage_audience: 0 } })
  })

  it('builds a new creative from the account\'s image with the plan copy and tracking parameters', () => {
    const body = creativeBody(spec.ad_sets[0].ads[0], '555', 'mxffffffff-creative-as1-ad1')!
    const story = JSON.parse(body.object_story_spec)
    expect(story).toMatchObject({ page_id: '555', link_data: { image_hash: 'hash001', link: 'https://studio.example/book', call_to_action: { type: 'BOOK_NOW' } } })
    expect(body.url_tags).toContain('meta_ad_id={{ad.id}}')
    expect(creativeBody({ ...spec.ad_sets[0].ads[0], creative: { mode: 'existing_creative', creative_id: '7' }, copy: null }, '555', 'm')).toBeNull()
  })

  it('schedules in the account timezone, daylight saving included', () => {
    expect(zonedTime('2026-11-10', 'America/New_York')).toBe('2026-11-10T00:00:00-05:00')
    expect(zonedTime('2026-07-10', 'America/New_York')).toBe('2026-07-10T00:00:00-04:00')
    expect(zonedTime('2026-07-10', 'Asia/Kolkata', true)).toBe('2026-07-10T23:59:59+05:30')
  })
})
