import { describe, expect, it } from 'vitest'
import { normalizeGlobalDateRange } from '@/lib/use-global-controls'

const NOW = new Date('2026-08-21T12:00:00-04:00')

describe('global owner date-range boundary', () => {
  it('clamps custom selections through the last closed New York day', () => {
    expect(normalizeGlobalDateRange({
      preset: 'custom',
      from: '2026-08-01',
      to: '2030-01-01',
    }, NOW)).toEqual({
      preset: 'custom',
      from: '2026-08-01',
      to: '2026-08-20',
    })
  })

  it('rejects malformed stored ranges instead of sending them to reporting APIs', () => {
    expect(normalizeGlobalDateRange({ preset: 'anything', from: 'nope', to: 'never' }, NOW)).toBeNull()
    expect(normalizeGlobalDateRange({ preset: 'custom', from: '2026-08-20', to: '2026-08-01' }, NOW)).toBeNull()
  })

  it('re-resolves presets against the current closed-day boundary', () => {
    expect(normalizeGlobalDateRange({
      preset: '1w',
      from: '2020-01-01',
      to: '2020-01-07',
    }, NOW)).toEqual({
      preset: '1w',
      from: '2026-08-14',
      to: '2026-08-20',
    })
  })
})
