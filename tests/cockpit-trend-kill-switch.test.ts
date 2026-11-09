import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assemblePerformanceCockpitData, type CockpitEvidence, type MetaDeliveryEvidence,
} from '@/lib/cockpit/builder'
import { comparisonWindowKey, type CockpitRange } from '@/lib/cockpit/evidence'
import { comparableWindows, cockpitTrendsEnabled } from '@/lib/cockpit/comparison-window'

/**
 * Trends must be removable without a deploy, and OFF must mean the pre-trend surface.
 *
 * Before this switch the only way to disable trends was to omit comparison evidence — and that was
 * WORSE than either state: the twelve `*_change` claims were emitted regardless, so every metric cell
 * grew a permanent "No prior-period comparison" line and the extra window reads still fired. A
 * rollback that degrades the surface is not a rollback.
 */

const TZ = 'America/New_York' as const
const RANGE: CockpitRange = { start: '2026-08-01', end: '2026-08-20', basis: 'closed_account_days', timezone: TZ }

function delivery(factor: number, days: number): MetaDeliveryEvidence {
  return {
    available: true, spendAvailable: true, resultsAvailable: true, purchaseAvailable: true,
    leadAvailable: true, linkCtrAvailable: true, cpmAvailable: true, frequencyAvailable: true,
    spend: 1000 * factor, results: 40 * factor, purchaseValue: 3000 * factor,
    purchaseCount: 20 * factor, leads: 16 * factor, linkClicks: 100 * factor,
    impressions: 10_000 * factor, nativeFrequency: 1.5 * factor, dailyBudget: 70,
    spendCoveredDays: days, coveredDays: days, expectedDays: days,
    synchronizedAt: '2026-08-21T11:55:00.000Z', blockerCodes: [],
  }
}
const span = (w: CockpitRange) =>
  Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1

function cockpit() {
  const deliveryByWindow: Record<string, MetaDeliveryEvidence> = {}
  for (const maturity of [
    { state: 'settled' as const, matureThrough: RANGE.end },
    { state: 'settling' as const, matureThrough: '2026-08-13' },
  ]) {
    const pair = comparableWindows(RANGE, maturity)
    if (!pair) continue
    for (const [window, factor] of [[pair.current, 2], [pair.prior, 1]] as const) {
      const key = comparisonWindowKey(window)
      if (key !== comparisonWindowKey(RANGE)) deliveryByWindow[key] = delivery(factor, span(window))
    }
  }
  const evidence: CockpitEvidence = {
    account: { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'ES' },
    range: RANGE, asOf: '2026-08-21T12:00:00.000Z', delivery: delivery(2, 20),
    comparison: { deliveryByWindow, blockerCodes: [] },
    partialToday: { available: false, date: '2026-08-21', spend: null, dailyBudget: null, synchronizedAt: null, blockerCodes: ['x'] },
    synchronizedAt: '2026-08-21T11:55:00.000Z', decisionIds: [], primaryDecisionId: null, primaryDecision: null,
  }
  return assemblePerformanceCockpitData(evidence)
}

afterEach(() => { vi.unstubAllEnvs() })

describe('the trend kill switch', () => {
  it('is ON by default — a shipped feature must not depend on a flag being remembered', () => {
    expect(cockpitTrendsEnabled()).toBe(true)
    expect(cockpit().comparison.claimIds.length).toBeGreaterThan(0)
  })

  it('is OFF only for the exact value, so a typo does not silently disable it', () => {
    for (const value of ['false', '0', 'no', 'OFF', '']) {
      vi.stubEnv('MAXX_COCKPIT_TRENDS', value)
      expect(cockpitTrendsEnabled(), value).toBe(true)
    }
    vi.stubEnv('MAXX_COCKPIT_TRENDS', 'off')
    expect(cockpitTrendsEnabled()).toBe(false)
  })

  it('OFF emits NO trend claims at all — not twelve unavailable ones', () => {
    // The old "off" left a permanent "No prior-period comparison" line under every metric.
    vi.stubEnv('MAXX_COCKPIT_TRENDS', 'off')
    const data = cockpit()
    expect(data.comparison.claimIds).toEqual([])
    expect(Object.values(data.claims).filter((c) => c.metricKey.endsWith('_change'))).toEqual([])
  })

  it('OFF leaves exactly the non-trend claims — derived, not a hardcoded count', () => {
    // This asserted `off === 14` and broke the day two ordinary metrics were added, which is a test
    // pinned to a number rather than to the property. The property is: OFF removes every trend and
    // every claim that existed only to support one, and touches nothing else.
    const on = cockpit()
    vi.stubEnv('MAXX_COCKPIT_TRENDS', 'off')
    const off = cockpit()

    const onIds = new Set(Object.keys(on.claims))
    const offIds = new Set(Object.keys(off.claims))
    // Nothing appears that was not already there.
    for (const id of offIds) expect(onIds.has(id), `${id} appears only when trends are off`).toBe(true)
    // Everything removed is a trend or one of its supporting windows.
    const requestedWindow = `${RANGE.start}:${RANGE.end}`
    for (const id of onIds) {
      if (offIds.has(id)) continue
      const claim = on.claims[id]
      const isTrend = claim.metricKey.endsWith('_change')
      const isSupport = `${claim.window.start}:${claim.window.end}` !== requestedWindow
      expect(isTrend || isSupport, `${id} was removed but is neither a trend nor support`).toBe(true)
    }
    expect(offIds.size).toBeLessThan(onIds.size)
  })

  it('OFF reports not_requested, not "unavailable"', () => {
    // `unavailable` would say the comparison was attempted and failed. It was not attempted.
    vi.stubEnv('MAXX_COCKPIT_TRENDS', 'off')
    expect(cockpit().comparison.state).toBe('not_requested')
    expect(cockpit().comparison.window).toBeNull()
  })

  it('OFF leaves the headline metrics untouched', () => {
    vi.stubEnv('MAXX_COCKPIT_TRENDS', 'off')
    const data = cockpit()
    const spend = data.claims[data.paidPerformance.spendClaimId]
    expect(spend.availability.state).toBe('available')
    expect(spend.value).toBe(2000)
  })
})
