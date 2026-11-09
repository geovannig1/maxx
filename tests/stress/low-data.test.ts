import { describe, it, expect } from 'vitest'
import { assessLowData } from '@/lib/ui/low-data'

describe('assessLowData — warming-up vs dormant vs sufficient', () => {
  it('zero spend ⇒ NOT warming (dormant/empty → EmptyState handles it)', () => {
    expect(assessLowData({ spend: 0, windowDays: 7, entityPlural: 'ad sets' }).warming).toBe(false)
  })

  it('delivering but below the spend floor ⇒ warming up', () => {
    const d = assessLowData({ spend: 12, windowDays: 7, entityPlural: 'ad sets' })
    expect(d.warming).toBe(true)
    expect(d.message).toMatch(/calibration, not an error or a filter problem/)
    expect(d.items[0]).toMatchObject({ label: 'Spend', have: '$12' })
  })

  it('enough spend but too few bookings ⇒ warming up', () => {
    const d = assessLowData({ spend: 500, bookings: 1, windowDays: 7, entityPlural: 'ads' })
    expect(d.warming).toBe(true)
    expect(d.items.some((i) => i.label === 'Bookings')).toBe(true)
  })

  it('enough spend AND enough bookings ⇒ NOT warming (sufficient)', () => {
    expect(assessLowData({ spend: 500, bookings: 6, windowDays: 7, entityPlural: 'ads' }).warming).toBe(false)
  })

  it('enough spend, bookings not provided ⇒ NOT warming on spend alone', () => {
    expect(assessLowData({ spend: 500, windowDays: 7, entityPlural: 'campaigns' }).warming).toBe(false)
  })
})
