import { describe, expect, it } from 'vitest'
import {
  classifyWindowDays, enumerateDays, provenCoveredDays, runsOfState, summariseCoverage,
} from '@/lib/cockpit/window-days'

const WINDOW = { start: '2026-03-09', end: '2026-03-13' }

describe('window day classification', () => {
  it('enumerates an inclusive window and refuses an inverted one', () => {
    expect(enumerateDays('2026-03-09', '2026-03-11')).toEqual(['2026-03-09', '2026-03-10', '2026-03-11'])
    expect(enumerateDays('2026-03-11', '2026-03-09')).toEqual([])
  })

  it('treats an absent day covered by a SUCCESSFUL sync as proven no-delivery', () => {
    const days = classifyWindowDays({
      window: WINDOW,
      rows: [{ date: '2026-03-09', value: 12 }],
      attempts: [{ dateRangeStart: '2026-03-09', dateRangeEnd: '2026-03-13', status: 'success' }],
    })
    expect(days.map((d) => d.state)).toEqual([
      'measured', 'missing_no_delivery', 'missing_no_delivery', 'missing_no_delivery', 'missing_no_delivery',
    ])
  })

  // The fail-closed rule: without proof, a gap is unknown — never a confident zero.
  it('treats an absent day with no covering sync as unknown, not as no-delivery', () => {
    const days = classifyWindowDays({ window: WINDOW, rows: [{ date: '2026-03-09', value: 12 }], attempts: [] })
    expect(days.slice(1).every((d) => d.state === 'missing_not_synced')).toBe(true)
    expect(days.every((d) => d.state === 'measured' || d.value === null)).toBe(true)
  })

  it('refuses to let a failed or partial sync prove anything', () => {
    for (const status of ['failed', 'partial']) {
      const covered = provenCoveredDays([{ dateRangeStart: '2026-03-09', dateRangeEnd: '2026-03-13', status }])
      expect(covered.size, `${status} must prove nothing`).toBe(0)
    }
  })

  it('ignores a sync attempt with no recorded range', () => {
    expect(provenCoveredDays([{ dateRangeStart: null, dateRangeEnd: null, status: 'success' }]).size).toBe(0)
  })

  it('unions overlapping successful attempts', () => {
    const covered = provenCoveredDays([
      { dateRangeStart: '2026-03-09', dateRangeEnd: '2026-03-10', status: 'success' },
      { dateRangeStart: '2026-03-10', dateRangeEnd: '2026-03-12', status: 'success' },
    ])
    expect([...covered].sort()).toEqual(['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12'])
  })

  it('never attaches a value to an absent day', () => {
    const days = classifyWindowDays({
      window: WINDOW, rows: [],
      attempts: [{ dateRangeStart: '2026-03-09', dateRangeEnd: '2026-03-13', status: 'success' }],
    })
    expect(days.every((d) => d.value === null)).toBe(true)
  })

  it('fails loudly on duplicate rows rather than silently double-counting', () => {
    expect(() => classifyWindowDays({
      window: WINDOW,
      rows: [{ date: '2026-03-09', value: 1 }, { date: '2026-03-09', value: 2 }],
      attempts: [],
    })).toThrow(/Duplicate day/)
  })

  it('summarises coverage so it always reconciles to the window length', () => {
    const days = classifyWindowDays({
      window: WINDOW,
      rows: [{ date: '2026-03-09', value: 12 }, { date: '2026-03-13', value: 8 }],
      attempts: [{ dateRangeStart: '2026-03-09', dateRangeEnd: '2026-03-11', status: 'success' }],
    })
    const coverage = summariseCoverage(days)
    expect(coverage).toEqual({ totalDays: 5, measuredDays: 2, noDeliveryDays: 2, notSyncedDays: 1 })
    expect(coverage.measuredDays + coverage.noDeliveryDays + coverage.notSyncedDays).toBe(coverage.totalDays)
  })

  it('finds the contiguous dormant run the chart draws as a band', () => {
    const days = classifyWindowDays({
      window: WINDOW,
      rows: [{ date: '2026-03-09', value: 12 }, { date: '2026-03-13', value: 8 }],
      attempts: [{ dateRangeStart: '2026-03-09', dateRangeEnd: '2026-03-13', status: 'success' }],
    })
    expect(runsOfState(days, 'missing_no_delivery')).toEqual([
      { start: '2026-03-10', end: '2026-03-12', length: 3 },
    ])
  })
})
