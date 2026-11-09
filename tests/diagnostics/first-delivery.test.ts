import { describe, it, expect } from 'vitest'
import { deriveFirstDelivery, LEARNING_WINDOW_DAYS } from '@/lib/insights/first-delivery'

describe('deriveFirstDelivery', () => {
  it('uses the first day with spend>0 as the launch date — NOT the earliest row (the start_time trap)', () => {
    // Rows exist from creation (Mar 2) with $0, but spend starts Mar 9.
    const days = [
      { date: '2026-03-02', spend: 0 },
      { date: '2026-03-03', spend: 0 },
      { date: '2026-03-09', spend: 8 },
      { date: '2026-03-10', spend: 15 },
      { date: '2026-03-11', spend: 40 },
      { date: '2026-03-12', spend: 12 },
    ]
    const r = deriveFirstDelivery(days, '2026-03-12')
    expect(r.firstSpendDate).toBe('2026-03-09')
    expect(r.daysDelivering).toBe(4) // Mar 9,10,11,12 inclusive — the true "4 days in", not 10
    expect(r.deliveringDayCount).toBe(4)
    expect(r.inLearningWindow).toBe(true)
  })

  it('returns nulls/zero when the entity never actually delivered', () => {
    const r = deriveFirstDelivery([{ date: '2026-03-02', spend: 0 }], '2026-03-12')
    expect(r.firstSpendDate).toBeNull()
    expect(r.daysDelivering).toBe(0)
    expect(r.inLearningWindow).toBe(false)
  })

  it('is order-independent and counts distinct delivering days', () => {
    const r = deriveFirstDelivery(
      [
        { date: '2026-07-08', spend: 5 },
        { date: '2026-07-06', spend: 5 },
        { date: '2026-07-06', spend: 5 }, // dup date
      ],
      '2026-07-08',
    )
    expect(r.firstSpendDate).toBe('2026-07-06')
    expect(r.daysDelivering).toBe(3) // 6,7,8 calendar span
    expect(r.deliveringDayCount).toBe(2) // only 6 and 8 had spend
  })

  it('flags exit from the learning window past ~7 days', () => {
    const days = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      spend: 10,
    }))
    const r = deriveFirstDelivery(days, '2026-07-12')
    expect(r.daysDelivering).toBe(12)
    expect(r.inLearningWindow).toBe(false)
    expect(LEARNING_WINDOW_DAYS).toBe(7)
  })
})
