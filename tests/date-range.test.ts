import { describe, it, expect } from 'vitest'
import { resolveDatePreset, resolveRange, daysInRange } from '@/lib/date-range'

// Fixed "now" (local noon to avoid tz edges) so the calendar math is deterministic.
// UTC-anchored (16:00Z = noon EDT / 11am EST) so `now` represents NY-date 2026-06-15 for ANY server
// timezone — a bare 'YYYY-MM-DDTHH:MM:SS' is parsed as LOCAL time and shifts the NY day under large
// positive UTC offsets (e.g. UTC+14), which false-failed this suite. resolveDatePreset itself is TZ-safe.
const NOW = new Date('2026-06-15T16:00:00Z')

describe('resolveDatePreset', () => {
  it('1d → yesterday only', () => {
    const r = resolveDatePreset('1d', NOW)
    expect(r.to).toBe('2026-06-14')
    expect(r.from).toBe('2026-06-14')
    expect(r.days).toBe(1)
  })
  it('1w → 7 days through yesterday', () => {
    const r = resolveDatePreset('1w', NOW)
    expect(r.to).toBe('2026-06-14')
    expect(r.from).toBe('2026-06-08')
    expect(r.days).toBe(7)
  })
  it('1m → 30 days', () => {
    expect(resolveDatePreset('1m', NOW).days).toBe(30)
  })
  it('MTD → first of month through yesterday', () => {
    const r = resolveDatePreset('mtd', NOW)
    expect(r.from).toBe('2026-06-01')
    expect(r.to).toBe('2026-06-14')
    expect(r.days).toBe(14)
  })
  it('QTD → first of quarter (Apr 1) through yesterday', () => {
    const r = resolveDatePreset('qtd', NOW)
    expect(r.from).toBe('2026-04-01')
    expect(r.to).toBe('2026-06-14')
  })
  it('YTD → Jan 1 through yesterday', () => {
    const r = resolveDatePreset('ytd', NOW)
    expect(r.from).toBe('2026-01-01')
    expect(r.to).toBe('2026-06-14')
  })
  it('clamps from ≤ to on the first of a period (MTD on the 1st)', () => {
    const r = resolveDatePreset('mtd', new Date('2026-06-01T16:00:00Z'))
    expect(r.to).toBe('2026-05-31')
    expect(r.from).toBe('2026-05-31') // clamped (month start is in the future vs yesterday)
    expect(r.days).toBe(1)
  })
})

describe('resolveRange (custom from/to vs preset)', () => {
  it('explicit valid from/to → custom range', () => {
    const r = resolveRange({ from: '2026-06-01', to: '2026-06-10' })
    expect(r.preset).toBe('custom')
    expect(r.from).toBe('2026-06-01')
    expect(r.to).toBe('2026-06-10')
    expect(r.days).toBe(10)
  })
  it('from > to or partial → falls back to the named/default preset (not custom)', () => {
    expect(resolveRange({ from: '2026-06-10', to: '2026-06-01' }).preset).not.toBe('custom')
    expect(resolveRange({ from: '2026-06-01' }).preset).not.toBe('custom')
    expect(resolveRange({ range: 'mtd' }).preset).toBe('mtd')
    expect(resolveRange({}).preset).toBe('1w')
    expect(resolveRange({}, '1m').preset).toBe('1m')
  })
})

describe('daysInRange', () => {
  it('inclusive day count; 0 for malformed input', () => {
    expect(daysInRange('2026-06-01', '2026-06-01')).toBe(1)
    expect(daysInRange('2026-06-01', '2026-06-07')).toBe(7)
    expect(daysInRange('bad', '2026-06-07')).toBe(0)
  })
})
