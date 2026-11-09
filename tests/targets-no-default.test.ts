import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  METRIC_RANGES, MONEY_METRICS, applyTargetOverrides, cpaTarget, getMetricStatus, getTargetLanguage,
  getTargetRange, mergeRanges, validateRangeOrdering, type MetricKey,
} from '@/lib/targets/target-ranges'
import { parseStoredTargetOverrides } from '@/lib/targets/store'
import { REC_THRESHOLDS, learningExitDailyBudget } from '@/lib/recommendations/thresholds'
import { evaluateFlag, type FlagInput } from '@/lib/flags/rules'
import { calculateTrajectory } from '@/lib/analytics/predictor'
import { evaluateModelledDirection, type ModelledDirectionalEvidence } from '@/lib/authority/directional-policy'
import { RangeBadge } from '@/components/ui/range-badge'
import { DaypartHeatmap } from '@/components/charts/DaypartHeatmap'
import { EXAMPLE_OWNER_TARGETS } from './helpers/example-targets'

// Cost metrics once shipped with a built-in target and maximum taken from one business.
// A neutral install has NO money target until the owner sets one; every surface says so instead of
// judging against another business's numbers. Each case has a control with the owner's target set.

afterEach(() => applyTargetOverrides(null))

const ok = { spend: 300, bookings: 5, windowDays: 7, attributionCoverage: 0.7 }

describe('money metrics have no built-in target', () => {
  it('cost bands are null by default; ratio and rate bands keep their references (control)', () => {
    for (const metric of MONEY_METRICS) {
      const { excellent, healthy, watch } = METRIC_RANGES[metric]
      expect([excellent, healthy, watch], metric).toEqual([null, null, null])
    }
    for (const metric of ['roas', 'mer', 'ctr', 'frequency', 'conversion_rate'] as MetricKey[]) {
      expect(typeof METRIC_RANGES[metric].healthy, metric).toBe('number')
    }
  })

  it('a cost metric is `no_target` and asks for a target; with the owner target set it is banded', () => {
    const none = getMetricStatus('cpa', 55, ok)
    expect(none.status).toBe('no_target')
    expect(none.band).toBeNull()
    expect(getTargetLanguage('cpa', none)).toMatch(/Set one in Settings → Performance Targets/)
    expect(cpaTarget()).toBeNull()
    expect(REC_THRESHOLDS.TARGET_CPA).toBeNull()
    expect(REC_THRESHOLDS.MAX_CPA).toBeNull()
    expect(learningExitDailyBudget()).toBeNull()

    applyTargetOverrides(EXAMPLE_OWNER_TARGETS)
    expect(getMetricStatus('cpa', 55, ok).status).toBe('healthy')
    expect(cpaTarget()).toEqual({ target: 64, max: 98 })
    expect(learningExitDailyBudget()).toBe(320)
  })

  it('a ratio metric is still judged with no owner targets (control)', () => {
    expect(getMetricStatus('frequency', 4, { windowDays: 7 }).status).toBe('critical')
  })

  it('a cost target needs the target (healthy) and maximum (watch); excellent is optional', () => {
    expect(validateRangeOrdering(mergeRanges({ cpa: { healthy: 64 } })).ok).toBe(false)
    expect(parseStoredTargetOverrides({ cpa: { excellent: 44 } }).ok).toBe(false)
    expect(validateRangeOrdering(mergeRanges({})).ok).toBe(true)
    // A stored row with only healthy and watch (written when excellent had a default) stays valid.
    expect(parseStoredTargetOverrides({ cpa: { healthy: 100, watch: 200 } }).ok).toBe(true)
    expect(parseStoredTargetOverrides({ cpa: { excellent: 44, healthy: 64, watch: 98 } }).ok).toBe(true)
    // Controls: an inverted target is still refused, with or without excellent.
    expect(parseStoredTargetOverrides({ cpa: { excellent: 98, healthy: 64, watch: 44 } }).ok).toBe(false)
    expect(parseStoredTargetOverrides({ cpa: { healthy: 98, watch: 64 } }).ok).toBe(false)
  })

  it('without an excellent edge, a value under the target is healthy', () => {
    applyTargetOverrides({ cpa: { healthy: 100, watch: 200 } })
    expect(getMetricStatus('cpa', 40, ok).status).toBe('healthy')
    expect(getMetricStatus('cpa', 150, ok).status).toBe('watch')
    expect(getMetricStatus('cpa', 250, ok).status).toBe('critical')
  })
})

describe('surfaces without a target', () => {
  it('the range badge says "Set a target"', () => {
    const html = renderToStaticMarkup(createElement(RangeBadge, { metric: 'cpa', value: 55, context: ok }))
    expect(html).toContain('Set a target')
    applyTargetOverrides(EXAMPLE_OWNER_TARGETS)
    expect(renderToStaticMarkup(createElement(RangeBadge, { metric: 'cpa', value: 55, context: ok }))).toContain('Healthy')
  })

  it('the daypart heatmap legend asks for a target instead of studio amounts', () => {
    const data = [{ hour: 9, day: 1, cpa: 50, spend: 100, bookings: 2 }]
    const none = renderToStaticMarkup(createElement(DaypartHeatmap, { data }))
    expect(none).toContain('no CPA target set')
    expect(none).not.toMatch(/≤\$64|\$98\+/)
    applyTargetOverrides(EXAMPLE_OWNER_TARGETS)
    const set = renderToStaticMarkup(createElement(DaypartHeatmap, { data }))
    expect(set).toContain('≤$64')
    expect(set).toContain('$98+')
  })

  const zeroBookings = (over: Partial<FlagInput> = {}): FlagInput => ({
    spend: 1_000, cpa: null, cpl: null, ctr: 1.2, frequency: 1.2, impressions: 20_000, bookings: 0, leads: 0,
    roas: null, window_days: 7, audience_type: 'consumer', peak_ctr: 1.3, ...over,
  })

  it('flags never compare against a CPA that nobody set', () => {
    expect(evaluateFlag(zeroBookings())).toBeNull()
    expect(evaluateFlag(zeroBookings({ bookings: 2, cpa: 500 }))).toBeNull()
    applyTargetOverrides(EXAMPLE_OWNER_TARGETS)
    expect(evaluateFlag(zeroBookings())?.flag_type).toBe('loser')
    expect(evaluateFlag(zeroBookings({ bookings: 2, cpa: 500 }))?.flag_type).toBe('loser')
  })

  it('the CPA trajectory has no breach line without a target', () => {
    const days = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-08-0${i + 1}`, spend: 80 + i * 16, bookings: 2,
    }))
    expect(calculateTrajectory(days).days_until_breach).toBeNull()
    applyTargetOverrides(EXAMPLE_OWNER_TARGETS)
    expect(calculateTrajectory(days).days_until_breach).not.toBeNull()
  })

  it('a Meta-modelled money direction is unsupported without a target', () => {
    const window = (start: string, end: string) => ({
      windowStart: start, windowEnd: end, spend: 400, modelledBookings: 10, modelledCpa: 40,
      peakDailyFrequency: 1.8, windowFrequency: 2.2, source: 'daily_insights' as const, observedDays: 14, expectedDays: 14,
      earliestSyncedAt: '2026-08-18T10:30:00.000Z', latestSyncedAt: '2026-08-18T10:30:00.000Z',
    })
    const ev = (targetCpa: number | null, watchCpa: number | null): ModelledDirectionalEvidence => ({
      recent: window('2026-08-04', '2026-08-17'), prior: window('2026-07-21', '2026-08-03'),
      sourceGeneration: { id: 'g', status: 'success', dateRangeStart: '2026-07-21', dateRangeEnd: '2026-08-17',
        startedAt: '2026-08-18T10:00:00.000Z', completedAt: '2026-08-18T10:30:00.000Z' },
      targetCpa, watchCpa, linkageCoverage: 0.31, blendedRoas: null,
    })
    for (const kind of ['budget_scale', 'budget_cut'] as const) {
      const verdict = evaluateModelledDirection(kind, ev(null, null))
      expect(verdict.ceiling, kind).toBe('unsupported')
      expect(verdict.reason, kind).toMatch(/none is set/)
    }
    expect(evaluateModelledDirection('budget_scale', ev(64, 98)).ceiling).toBe('owner_review')
  })

  it('getTargetRange exposes the null cost bands to callers', () => {
    expect(getTargetRange('cpa').healthy).toBeNull()
    expect(getTargetRange('ctr').watch).toBe(0.5)
  })
})
