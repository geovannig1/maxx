import { describe, expect, it } from 'vitest'
import {
  ClaimedSeriesSchema, SeriesPointSchema, createClaimedSeries,
  SERIES_CONTRACT_VERSION, type ClaimedSeriesInput,
} from '@/lib/cockpit/series-contract'

const WINDOW = {
  start: '2026-08-01', end: '2026-08-03',
  basis: 'closed_account_days' as const, timezone: 'America/New_York' as const,
}

function baseSeries(overrides: Partial<ClaimedSeriesInput> = {}): ClaimedSeriesInput {
  return {
    seriesId: 'meta.spend.daily:2026-08-01:2026-08-03',
    metricKey: 'meta.spend', label: 'Meta spend', unit: 'money', granularity: 'day',
    source: { system: 'meta', head: 'daily_insights', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'act_123' },
    window: WINDOW, asOf: '2026-08-04T12:00:00.000Z', measurementKind: 'measured',
    availability: { state: 'available', blockerCodes: [] },
    coverage: { totalDays: 3, measuredDays: 2, noDeliveryDays: 1, notSyncedDays: 0 },
    points: [
      { date: '2026-08-01', value: 100, state: 'measured' },
      { date: '2026-08-02', value: null, state: 'missing_no_delivery' },
      { date: '2026-08-03', value: 50, state: 'measured' },
    ],
    ...overrides,
  }
}

describe('ClaimedSeries contract', () => {
  it('is independently versioned so the MCP cockpit contract never has to move', () => {
    expect(SERIES_CONTRACT_VERSION).toBe(1)
  })

  it('accepts and deep-freezes a well-formed series', () => {
    const series = createClaimedSeries(baseSeries())
    expect(series.points).toHaveLength(3)
    expect(Object.isFrozen(series)).toBe(true)
    expect(Object.isFrozen(series.points[0])).toBe(true)
  })

  // The defect this contract exists to make unrepresentable.
  it('refuses to let an absent day carry a value — a gap can never become a fabricated zero', () => {
    for (const state of ['missing_no_delivery', 'missing_not_synced'] as const) {
      const bad = SeriesPointSchema.safeParse({ date: '2026-08-02', value: 0, state })
      expect(bad.success, `${state} must not accept a value`).toBe(false)
      expect(JSON.stringify(bad.error?.issues)).toMatch(/fabricated zero/)
    }
  })

  it('requires a measured day to actually carry a measurement', () => {
    const bad = SeriesPointSchema.safeParse({ date: '2026-08-02', value: null, state: 'measured' })
    expect(bad.success).toBe(false)
  })

  it('rejects coverage that does not sum to the window length', () => {
    const bad = ClaimedSeriesSchema.safeParse(baseSeries({
      coverage: { totalDays: 3, measuredDays: 2, noDeliveryDays: 0, notSyncedDays: 0 },
    }))
    expect(bad.success).toBe(false)
  })

  it('rejects coverage that disagrees with the points it summarises', () => {
    const bad = ClaimedSeriesSchema.safeParse(baseSeries({
      coverage: { totalDays: 3, measuredDays: 1, noDeliveryDays: 2, notSyncedDays: 0 },
    }))
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toMatch(/must match the points/)
  })

  it('rejects a point outside the declared window', () => {
    const bad = ClaimedSeriesSchema.safeParse(baseSeries({
      points: [
        { date: '2026-08-01', value: 100, state: 'measured' },
        { date: '2026-08-02', value: null, state: 'missing_no_delivery' },
        { date: '2026-09-09', value: 50, state: 'measured' },
      ],
    }))
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toMatch(/outside the window/)
  })

  it('rejects duplicate days', () => {
    const bad = ClaimedSeriesSchema.safeParse(baseSeries({
      coverage: { totalDays: 3, measuredDays: 3, noDeliveryDays: 0, notSyncedDays: 0 },
      points: [
        { date: '2026-08-01', value: 100, state: 'measured' },
        { date: '2026-08-01', value: 10, state: 'measured' },
        { date: '2026-08-03', value: 50, state: 'measured' },
      ],
    }))
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toMatch(/duplicate day/)
  })

  it('does not let an unavailable series smuggle points through', () => {
    const bad = ClaimedSeriesSchema.safeParse(baseSeries({
      availability: { state: 'unavailable', blockerCodes: ['meta_delivery_unavailable'] },
    }))
    expect(bad.success).toBe(false)
  })

  it('requires a reason when unavailable, and forbids one when available', () => {
    expect(ClaimedSeriesSchema.safeParse(baseSeries({
      availability: { state: 'unavailable', blockerCodes: [] },
      points: [], coverage: { totalDays: 0, measuredDays: 0, noDeliveryDays: 0, notSyncedDays: 0 },
      window: { ...WINDOW, start: '2026-08-01', end: '2026-08-01' },
    })).success).toBe(false)

    const ok = ClaimedSeriesSchema.safeParse(baseSeries({
      availability: { state: 'unavailable', blockerCodes: ['meta_delivery_unavailable'] },
      points: [], coverage: { totalDays: 0, measuredDays: 0, noDeliveryDays: 0, notSyncedDays: 0 },
    }))
    expect(ok.success).toBe(true)
  })

  it('rejects unknown keys so the envelope cannot drift by accretion', () => {
    const bad = ClaimedSeriesSchema.safeParse({ ...baseSeries(), sneaky: true })
    expect(bad.success).toBe(false)
  })
})
