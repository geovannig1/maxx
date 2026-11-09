import { describe, expect, it } from 'vitest'
import { comparableWindows, inclusiveDays } from '@/lib/cockpit/comparison-window'
import { classifyWindowSettle } from '@/lib/insights/settle-window'
import type { CockpitRange } from '@/lib/cockpit/evidence'

const range = (start: string, end: string): CockpitRange => ({
  start, end, basis: 'closed_account_days', timezone: 'America/New_York',
})

describe('inclusiveDays counts both ends', () => {
  it('a single day is one day', () => expect(inclusiveDays('2026-08-01', '2026-08-01')).toBe(1))
  it('Aug 1 to Aug 22 is 22 days', () => expect(inclusiveDays('2026-08-01', '2026-08-22')).toBe(22))
  it('counts across a month boundary', () => expect(inclusiveDays('2026-07-30', '2026-08-02')).toBe(4))
})

describe('a settled claim compares over the whole requested window', () => {
  const pair = comparableWindows(range('2026-08-01', '2026-08-22'), { state: 'settled', matureThrough: '2026-08-22' })!

  it('uses the requested window unchanged', () => {
    expect(pair.current.start).toBe('2026-08-01')
    expect(pair.current.end).toBe('2026-08-22')
  })

  it('compares against the equal-length window ending the day before', () => {
    expect(pair.prior.end).toBe('2026-07-31')
    expect(pair.prior.start).toBe('2026-07-10')
  })

  it('both sides are the same length — the property rate metrics depend on', () => {
    expect(inclusiveDays(pair.prior.start, pair.prior.end))
      .toBe(inclusiveDays(pair.current.start, pair.current.end))
  })

  it('the two windows do not overlap', () => {
    expect(pair.prior.end < pair.current.start).toBe(true)
  })
})

describe('a settling claim compares only the settled part', () => {
  // The manufactured-decline case, with the real classifier rather than a hand-picked date.
  const requested = range('2026-08-01', '2026-08-22')
  const settle = classifyWindowSettle({ from: requested.start, to: requested.end, today: '2026-08-24' })
  const pair = comparableWindows(requested, { state: settle.state, matureThrough: settle.settled_through })!

  it('the classifier really does leave part of this window unsettled (guards the case)', () => {
    expect(settle.state).toBe('settling')
    expect(settle.settled_through < requested.end).toBe(true)
  })

  it('the current side stops at the settle boundary, not at the requested end', () => {
    expect(pair.current.end).toBe(settle.settled_through)
    expect(pair.current.end).not.toBe(requested.end)
  })

  it('the prior side shrinks to match, so no decline can come from length alone', () => {
    expect(inclusiveDays(pair.prior.start, pair.prior.end))
      .toBe(inclusiveDays(pair.current.start, pair.current.end))
    expect(pair.prior.end).toBe('2026-07-31')
  })

  it('a settled and a settling claim over the SAME request get DIFFERENT comparable windows', () => {
    // The whole reason this is per claim. Spend is stamped settled unconditionally; Results is not.
    const settled = comparableWindows(requested, { state: 'settled', matureThrough: requested.end })!
    expect(settled.current.end).not.toBe(pair.current.end)
    expect(settled.prior.start).not.toBe(pair.prior.start)
  })
})

describe('it returns null rather than an untrustworthy comparison', () => {
  it('when nothing in the requested window has settled yet', () => {
    // Requested window sits entirely inside the re-pull boundary.
    const requested = range('2026-08-20', '2026-08-24')
    const settle = classifyWindowSettle({ from: requested.start, to: requested.end, today: '2026-08-24' })
    expect(comparableWindows(requested, { state: settle.state, matureThrough: settle.settled_through })).toBeNull()
  })

  it('when a settling claim states no mature-through date at all', () => {
    expect(comparableWindows(range('2026-08-01', '2026-08-22'), { state: 'settling', matureThrough: null })).toBeNull()
  })

  it('for a partial claim — today is still accruing and has no equal-length prior', () => {
    // `matureThrough` is deliberately NON-null. With null it returns null through the next guard
    // instead, so deleting the `partial` branch entirely left all 18 tests green — the branch was
    // asserted by a case that could not distinguish it. Today-so-far spend compared against a whole
    // prior day is a decline manufactured from the clock.
    expect(comparableWindows(range('2026-08-24', '2026-08-24'), { state: 'partial', matureThrough: '2026-08-24' })).toBeNull()
    expect(comparableWindows(range('2026-08-24', '2026-08-24'), { state: 'partial', matureThrough: null })).toBeNull()
  })

  it('for a claim that declares maturity not applicable', () => {
    // Same reasoning: a non-null boundary, so this case fails on the branch it names.
    expect(comparableWindows(range('2026-08-01', '2026-08-22'), { state: 'not_applicable', matureThrough: '2026-08-22' })).toBeNull()
    expect(comparableWindows(range('2026-08-01', '2026-08-22'), { state: 'not_applicable', matureThrough: null })).toBeNull()
  })
})

describe('the boundary can shorten the window but never extend it', () => {
  it('a matureThrough beyond the requested end is clamped to the request', () => {
    // Otherwise a stale boundary would silently widen what the reader asked for.
    const pair = comparableWindows(range('2026-08-01', '2026-08-10'), { state: 'settling', matureThrough: '2026-08-31' })!
    expect(pair.current.end).toBe('2026-08-10')
    expect(inclusiveDays(pair.prior.start, pair.prior.end)).toBe(10)
  })

  it('a single settled day compares against the single day before it', () => {
    const pair = comparableWindows(range('2026-08-01', '2026-08-01'), { state: 'settled', matureThrough: '2026-08-01' })!
    expect(pair.current).toMatchObject({ start: '2026-08-01', end: '2026-08-01' })
    expect(pair.prior).toMatchObject({ start: '2026-07-31', end: '2026-07-31' })
  })

  it('carries the basis and timezone through, so the pair stays one comparable kind of window', () => {
    const pair = comparableWindows(range('2026-08-01', '2026-08-22'), { state: 'settled', matureThrough: '2026-08-22' })!
    expect(pair.prior.basis).toBe('closed_account_days')
    expect(pair.prior.timezone).toBe('America/New_York')
    expect(pair.current.basis).toBe('closed_account_days')
  })
})

describe('the STATED maturity boundary governs, not the label', () => {
  it('a settled claim whose matureThrough is EARLIER than the request stops at that date', () => {
    // `settled` with a boundary before the requested end is a claim saying it is final only through
    // that date. Reading `range.end` because the label says settled trusts the word over the date,
    // and compares across a boundary the claim itself declared.
    const pair = comparableWindows(range('2026-08-01', '2026-08-22'), { state: 'settled', matureThrough: '2026-08-10' })!
    expect(pair.current.end).toBe('2026-08-10')
    expect(inclusiveDays(pair.current.start, pair.current.end)).toBe(10)
    expect(inclusiveDays(pair.prior.start, pair.prior.end)).toBe(10)
  })

  it('a settled claim that states NO boundary falls back to the requested end', () => {
    const pair = comparableWindows(range('2026-08-01', '2026-08-22'), { state: 'settled', matureThrough: null })!
    expect(pair.current.end).toBe('2026-08-22')
  })
})

describe('the prior window is itself settled — the property the whole design rests on', () => {
  // Never asserted before. It follows from the prior side ending strictly before the current side and
  // settledness being monotonic in date, but "it follows" is the reasoning that produced every defect
  // this branch has found. Checked against the real classifier, not argued.
  const today = '2026-08-24'
  const cases: Array<[string, { state: 'settled' | 'settling', matureThrough: string | null }, string, string]> = [
    ['a fully settled request', { state: 'settled', matureThrough: '2026-08-10' }, '2026-07-20', '2026-08-10'],
    ['a settling request', { state: 'settling', matureThrough: '2026-08-16' }, '2026-08-01', '2026-08-22'],
    ['a single settled day', { state: 'settled', matureThrough: '2026-08-05' }, '2026-08-05', '2026-08-05'],
    ['a long request', { state: 'settling', matureThrough: '2026-08-16' }, '2026-06-01', '2026-08-22'],
  ]

  it.each(cases)('%s: the prior window classifies as settled', (_label, maturity, start, end) => {
    const pair = comparableWindows(range(start, end), maturity)!
    expect(pair).not.toBeNull()
    const priorSettle = classifyWindowSettle({ from: pair.prior.start, to: pair.prior.end, today })
    expect(priorSettle.state).toBe('settled')
    expect(priorSettle.unsettled_days).toBe(0)
  })

  it.each(cases)('%s: the prior window ends strictly before the current one begins', (_label, maturity, start, end) => {
    const pair = comparableWindows(range(start, end), maturity)!
    expect(pair.prior.end < pair.current.start).toBe(true)
  })
})
