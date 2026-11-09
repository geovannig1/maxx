import { describe, it, expect } from 'vitest'
import { resolveDatePreset, resolveRange } from '@/lib/date-range'

// ─────────────────────────────────────────────────────────────────────────────────────────────
// presets resolve in America/New_York, not the server's local/UTC clock.
// These instants are deliberately chosen so UTC and NY disagree on the calendar date.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('preset boundaries use NY time, not UTC', () => {
  it('MTD at 03:00 UTC on Jul 1 (still Jun 30 in NY) covers June, not a 1-day sliver', () => {
    const now = new Date('2026-07-01T03:00:00Z') // 2026-06-30 23:00 in New York → NY-today = Jun 30
    const r = resolveDatePreset('mtd', now)
    expect(r.from).toBe('2026-06-01') // June, because NY is still in June (old UTC code collapsed to 1 day)
    expect(r.to).toBe('2026-06-29') // through NY-yesterday (today Jun 30 is incomplete)
    expect(r.days).toBe(29)
  })

  it('QTD at 03:00 UTC on Jul 1 stays in Q2 (Apr 1) in NY', () => {
    const now = new Date('2026-07-01T03:00:00Z')
    const r = resolveDatePreset('qtd', now)
    expect(r.from).toBe('2026-04-01')
    expect(r.to).toBe('2026-06-29')
  })

  it('YTD at 03:00 UTC on Jan 1 stays in the prior year in NY', () => {
    const now = new Date('2027-01-01T03:00:00Z') // 2026-12-31 22:00 in New York → NY-today = Dec 31
    const r = resolveDatePreset('ytd', now)
    expect(r.from).toBe('2026-01-01')
    expect(r.to).toBe('2026-12-30') // through NY-yesterday
  })

  it('1W is tz-stable through NY-yesterday', () => {
    const now = new Date('2026-07-01T03:00:00Z') // NY-today = Jun 30
    const r = resolveDatePreset('1w', now)
    expect(r.to).toBe('2026-06-29')
    expect(r.from).toBe('2026-06-23')
    expect(r.days).toBe(7)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// custom-range validation: future clamp + invalid-flagging (no silent fallback).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('custom-range guards', () => {
  const NOW = new Date('2026-06-15T12:00:00Z') // NY yesterday = 2026-06-14

  it('clamps a future `to` down to yesterday and flags it', () => {
    const r = resolveRange({ from: '2026-06-01', to: '2030-01-01' }, '1w', NOW)
    expect(r.preset).toBe('custom')
    expect(r.to).toBe('2026-06-14') // clamped to NY-yesterday
    expect(r.clampedFuture).toBe(true)
  })

  it('flags from>to instead of silently showing the default', () => {
    const r = resolveRange({ from: '2026-06-20', to: '2026-06-01' }, '1w', NOW)
    expect(r.preset).not.toBe('custom')
    expect(r.invalidCustom).toBe(true)
  })

  it('flags a malformed custom range', () => {
    const r = resolveRange({ from: 'not-a-date', to: '2026-06-10' }, '1w', NOW)
    expect(r.invalidCustom).toBe(true)
  })

  it('accepts a valid past custom range unchanged (no flags)', () => {
    const r = resolveRange({ from: '2026-06-01', to: '2026-06-10' }, '1w', NOW)
    expect(r.preset).toBe('custom')
    expect(r.from).toBe('2026-06-01')
    expect(r.to).toBe('2026-06-10')
    expect(r.clampedFuture).toBeUndefined()
    expect(r.invalidCustom).toBeUndefined()
  })
})
