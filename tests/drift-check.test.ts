import { describe, it, expect } from 'vitest'
import { diffLayer, DRIFT_TOL_ABS, DRIFT_TOL_PCT, BOOKINGS_TOLERANCE } from '@/lib/diagnostics/drift-check'

// Drift guardrail: the pure per-day diff must catch the real failure classes — frozen
// back-days (live restated, stored didn't), phantom stored spend, missing warehouse rows — while
// tolerating same-day API jitter, so "aligned" is meaningful and drift alerts stay high-signal.

const DAYS = ['2026-03-09', '2026-03-10', '2026-03-11']
const m = (entries: Array<[string, number]> = []) => new Map<string, number>(entries)

describe('diffLayer', () => {
  it('aligned when every day matches within tolerance (jitter under $1 AND under 2%)', () => {
    const live = m([['2026-03-09', 43.6], ['2026-03-10', 66.15], ['2026-03-11', 118.4]])
    const stored = m([['2026-03-09', 43.6], ['2026-03-10', 65.88], ['2026-03-11', 118.4]]) // 27¢ jitter
    const r = diffLayer('daily_insights', live, stored, DAYS)
    expect(r.drifted_days).toBe(0)
    expect(r.worst).toBeNull()
  })

  it('flags the frozen-back-day class: live restated up, stored kept the stale snapshot', () => {
    // Shape: the platform restated the middle day upward while the warehouse kept the earlier snapshot.
    const live = m([['2026-03-09', 43.6], ['2026-03-10', 66.15], ['2026-03-11', 118.4]])
    const stored = m([['2026-03-09', 43.6], ['2026-03-10', 38.0], ['2026-03-11', 118.4]])
    const r = diffLayer('daily_insights', live, stored, DAYS)
    expect(r.drifted_days).toBe(1)
    expect(r.worst?.date).toBe('2026-03-10')
    expect(r.worst?.delta).toBeCloseTo(-28.15, 2)
  })

  it('flags a live-spend day the warehouse never recorded (missing stored row)', () => {
    const live = m([['2026-03-09', 50]])
    const stored = m()
    const r = diffLayer('daily_insights', live, stored, ['2026-03-09'])
    expect(r.drifted_days).toBe(1)
    expect(r.days[0].stored).toBeNull()
  })

  it('flags phantom stored spend Meta no longer reports; both-missing days are aligned', () => {
    const live = m()
    const stored = m([['2026-03-09', 42]])
    const r = diffLayer('daily_reports', live, stored, ['2026-03-09', '2026-03-10'])
    expect(r.days[0].drifted).toBe(true) // stored $42 vs no live row
    expect(r.days[1].drifted).toBe(false) // absent on both sides = no delivery, aligned
  })

  it('tolerance requires exceeding BOTH floors (a $1.50 gap on $200 is 0.75% — jitter, not drift)', () => {
    const live = m([['2026-03-09', 200]])
    const stored = m([['2026-03-09', 201.5]])
    const r = diffLayer('daily_insights', live, stored, ['2026-03-09'])
    expect(r.drifted_days).toBe(0)
    // sanity on the exported constants the rule composes from
    expect(DRIFT_TOL_ABS).toBe(1)
    expect(DRIFT_TOL_PCT).toBe(0.02)
  })

  it('worst picks the largest absolute gap across drifted days', () => {
    const live = m([['2026-03-09', 100], ['2026-03-10', 100], ['2026-03-11', 100]])
    const stored = m([['2026-03-09', 90], ['2026-03-10', 60], ['2026-03-11', 100]])
    const r = diffLayer('daily_insights', live, stored, DAYS)
    expect(r.drifted_days).toBe(2)
    expect(r.worst?.date).toBe('2026-03-10')
  })
})

describe('bookings layer (the stored double-count class)', () => {
  it('flags a 1→2 stored doubling that the SPEND tolerance would miss', () => {
    const live = new Map([['2026-03-16', 1], ['2026-03-17', 1], ['2026-03-18', 3]])
    const stored = new Map([['2026-03-16', 2], ['2026-03-17', 2], ['2026-03-18', 6]])
    const days = ['2026-03-16', '2026-03-17', '2026-03-18']
    // Under the default SPEND tolerance ($1 abs floor) the two 1→2 days read as jitter (delta 1 ≯ 1)
    // and only the 3→6 day flags — the doubling would look like a single odd day, not a pattern.
    // This is exactly why bookings needs its own integer tolerance.
    expect(diffLayer('bookings', live, stored, days).drifted_days).toBe(1)
    // Integer tolerance: every doubled day flags.
    const layer = diffLayer('bookings', live, stored, days, BOOKINGS_TOLERANCE)
    expect(layer.drifted_days).toBe(3)
    expect(layer.worst?.date).toBe('2026-03-18')
    expect(layer.worst?.delta).toBe(3)
  })

  it('exact integer match is aligned; zero-booking days do not false-positive', () => {
    const live = new Map([['2026-03-16', 1], ['2026-03-17', 0]])
    const stored = new Map([['2026-03-16', 1], ['2026-03-17', 0]])
    expect(diffLayer('bookings', live, stored, ['2026-03-16', '2026-03-17'], BOOKINGS_TOLERANCE).drifted_days).toBe(0)
  })

  it('a live booking the warehouse never recorded flags (missing stored row)', () => {
    const live = new Map([['2026-03-16', 1]])
    const stored = new Map<string, number>()
    expect(diffLayer('bookings', live, stored, ['2026-03-16'], BOOKINGS_TOLERANCE).drifted_days).toBe(1)
  })
})
