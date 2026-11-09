import { describe, it, expect } from 'vitest'
import { classifyWindowSettle, ATTRIBUTION_SETTLE_DAYS } from '@/lib/insights/settle-window'

// A number's trustworthiness depends on how old its dates are, and nothing said so.
//
// Grouping daily_insights.synced_at by date age shows the rolling re-pull: dates 1-7 days old are
// rewritten by every sync (still mutable), and a date stops being rewritten once it ages past 7 days
// and never moves again. That boundary is ATTRIBUTION_SETTLE_DAYS.
//
// Day 0 is not merely unsettled: today's account row is usually absent until a sync writes it, which
// reads as "$0 spent" if left unlabeled.

const TODAY = '2026-08-01'

describe('window settle classification', () => {
  it('a window ending 8+ days ago is settled — those rows are never rewritten again', () => {
    const r = classifyWindowSettle({ from: '2026-07-10', to: '2026-07-24', today: TODAY })
    expect(r.state).toBe('settled')
    expect(r.unsettled_days).toBe(0)
    expect(r.detail).toMatch(/settled/i)
  })

  it('a window ending yesterday is still settling, and says how many days are provisional', () => {
    const r = classifyWindowSettle({ from: '2026-07-25', to: '2026-07-31', today: TODAY })
    expect(r.state).toBe('settling')
    // 07-25..07-31 are all within 7 days of today → all 7 provisional.
    expect(r.unsettled_days).toBe(7)
    expect(r.settled_through).toBe('2026-07-24')
    expect(r.detail).toMatch(/provisional|still restating|may still/i)
  })

  it('a mixed window reports only the provisional tail as unsettled', () => {
    // 07-20..07-31: 07-20..07-24 are frozen, 07-25..07-31 are not.
    const r = classifyWindowSettle({ from: '2026-07-20', to: '2026-07-31', today: TODAY })
    expect(r.state).toBe('settling')
    expect(r.unsettled_days).toBe(7)
    expect(r.settled_through).toBe('2026-07-24')
  })

  it('a window including today flags that today is usually absent, not zero', () => {
    const r = classifyWindowSettle({ from: '2026-07-26', to: TODAY, today: TODAY })
    expect(r.includes_today).toBe(true)
    expect(r.detail).toMatch(/today/i)
    expect(r.detail).toMatch(/absent|not yet synced|incomplete/i)
    // The trap this exists to stop.
    expect(r.detail).not.toMatch(/\$0 spent|zero spend/i)
  })

  it('the boundary is exact: exactly 7 days old is still settling, 8 is settled', () => {
    expect(classifyWindowSettle({ from: '2026-07-25', to: '2026-07-25', today: TODAY }).state).toBe('settling')
    expect(classifyWindowSettle({ from: '2026-07-24', to: '2026-07-24', today: TODAY }).state).toBe('settled')
  })

  it('exposes the constant it is built on so callers cannot drift from the sync', () => {
    expect(ATTRIBUTION_SETTLE_DAYS).toBe(7)
  })
})
