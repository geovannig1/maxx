import { describe, it, expect } from 'vitest'
import { breakdownTypeFor, prettifySegmentValue, SEGMENT_DIMENSIONS } from '@/lib/segments/dimensions'

describe('segment dimensions', () => {
  it('maps every dimension key to a breakdown_type', () => {
    for (const d of SEGMENT_DIMENSIONS) {
      expect(breakdownTypeFor(d.key)).toBe(d.breakdownType)
    }
  })

  it('maps placement → platform_position and platform → publisher_platform', () => {
    expect(breakdownTypeFor('placement')).toBe('platform_position')
    expect(breakdownTypeFor('platform')).toBe('publisher_platform')
  })

  it('returns null for an unknown dimension', () => {
    expect(breakdownTypeFor('galaxy')).toBeNull()
  })

  it('prettifies breakdown values', () => {
    expect(prettifySegmentValue('audience_network')).toBe('Audience network')
    expect(prettifySegmentValue('female')).toBe('Female')
    expect(prettifySegmentValue('unknown')).toBe('Unknown')
    expect(prettifySegmentValue('')).toBe('Unknown')
    expect(prettifySegmentValue('25-34')).toBe('25-34')
  })
})
