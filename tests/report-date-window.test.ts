import { describe, expect, it } from 'vitest'

import { trailingInclusiveWindow } from '@/lib/report/generator'

describe('trailingInclusiveWindow', () => {
  it('labels exactly 30 inclusive calendar dates as date-minus-29 through date', () => {
    expect(trailingInclusiveWindow('2026-08-15', 30)).toEqual({
      from: '2026-07-17',
      to: '2026-08-15',
      days: 30,
    })
  })

  it('stays calendar-correct across month and leap-year boundaries', () => {
    expect(trailingInclusiveWindow('2024-03-01', 2)).toEqual({
      from: '2024-02-29',
      to: '2024-03-01',
      days: 2,
    })
  })

  it('rejects invalid bounds instead of silently shifting the report window', () => {
    expect(() => trailingInclusiveWindow('2026-02-30', 30)).toThrow(/valid YYYY-MM-DD/i)
    expect(() => trailingInclusiveWindow('2026-08-15', 0)).toThrow(/positive integer/i)
  })
})
