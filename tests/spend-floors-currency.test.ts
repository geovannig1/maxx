import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { listSourceFiles } from './_support/source-scan'
import { minSpendToJudge } from '@/config/business-config'
import { SPEND_FLOORS } from '@/config/spend-floors'
import { envSpec, validateEnv } from '@/config/env'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { METRIC_RANGES, getConfidenceAdjustment } from '@/lib/targets/target-ranges'
import { evaluateFlag, type FlagInput } from '@/lib/flags/rules'
import { calculateTrajectory } from '@/lib/analytics/predictor'
import { judge } from '@/lib/learning/patterns'
import { getCellColor } from '@/components/charts/DaypartHeatmap'
import { checkZeroConversions } from '@/lib/alerts/thresholds'

// spend floors were fixed amounts (20, 60, 80, 2, 1/day, ...) that only make sense in USD-sized
// currencies: 20 yen is nothing, 20 KWD is a lot. One validated setting, NEXT_PUBLIC_MIN_SPEND_TO_JUDGE
// (default 20, in the account currency), sets the base; every other floor is a fixed multiple of it, so
// USD behaviour at the default is unchanged.

const ENV = 'NEXT_PUBLIC_MIN_SPEND_TO_JUDGE'
afterEach(() => vi.unstubAllEnvs())

const flagInput = (spend: number): FlagInput => ({
  spend, cpa: null, cpl: null, ctr: 1.2, frequency: 1.1, impressions: 4000, bookings: 0, leads: 0, roas: null,
  window_days: 7, entity_age_days: 10, audience_type: 'cold' as FlagInput['audience_type'],
})
/** Four days of CPA rising by `slope` per day from `start` (a perfect linear fit, R² = 1). */
const rising = (start: number, slope: number) => [0, 1, 2, 3].map((d) => ({ date: `2026-11-0${d + 1}`, spend: start + slope * d, bookings: 1 }))

describe('spend floors in the account currency', () => {
  it('keeps every USD floor at the default identical to the amount it replaced (control)', () => {
    expect(minSpendToJudge()).toBe(20)
    expect([REC_THRESHOLDS.MIN_SPEND_TO_JUDGE, REC_THRESHOLDS.DORMANT_SPEND_30D]).toEqual([20, 20])
    expect(Object.fromEntries(Object.entries(METRIC_RANGES).map(([k, r]) => [k, r.minSpend]))).toEqual({
      cpa: 60, cpl: 20, roas: 60, mer: 60, ctr: 0, cpc: 20, cpm: 20, frequency: 0, conversion_rate: 20,
    })
    expect({ ...SPEND_FLOORS }).toEqual({
      judge: 20, costPerOutcomeGate: 60, modelledZeroOutcome: 80, confidentSample: 200, heatmapSpendNoOutcome: 2,
      materialCpaSlopePerDay: 1, trackingCheck: 50, trackingCritical: 50, audienceCompare: 250, audienceLiveNoResults: 100,
      stoppedEntity: 5, minDailyBudget: 1,
    })
    expect(evaluateFlag(flagInput(19))?.flag_type).toBe('too_early')
    expect(evaluateFlag(flagInput(21))?.flag_type).not.toBe('too_early')
    expect(judge({ spend: 80, bookings: 0, impressions: 1000, clicks: 10 } as never).verdict).toBe('weak')
    expect(judge({ spend: 79, bookings: 0, impressions: 1000, clicks: 10 } as never).verdict).toBe('insufficient')
    expect(calculateTrajectory(rising(20, 1)).trend_direction).toBe('worsening')
    expect(calculateTrajectory(rising(20, 0.9)).trend_direction).toBe('flat')
  })

  it('judges a JPY account against its configured floor', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'JPY')
    // Defect control: at the USD-sized default, 2,500 yen (about USD 17) already counts as judgeable.
    expect(evaluateFlag(flagInput(2500))?.flag_type).not.toBe('too_early')

    vi.stubEnv(ENV, '3000')
    expect(REC_THRESHOLDS.MIN_SPEND_TO_JUDGE).toBe(3000)
    expect(REC_THRESHOLDS.DORMANT_SPEND_30D).toBe(3000)
    expect(SPEND_FLOORS.minDailyBudget).toBe(150)
    expect([METRIC_RANGES.cpa.minSpend, METRIC_RANGES.cpl.minSpend, METRIC_RANGES.ctr.minSpend]).toEqual([9000, 3000, 0])
    const early = evaluateFlag(flagInput(2500))
    expect(early?.flag_type).toBe('too_early')
    expect(early?.reason).toContain('¥3,000')
    expect(evaluateFlag(flagInput(3500))?.flag_type).not.toBe('too_early')
    expect(judge({ spend: 11_999, bookings: 0, impressions: 1000, clicks: 10 } as never).verdict).toBe('insufficient')
    expect(judge({ spend: 12_000, bookings: 0, impressions: 1000, clicks: 10 } as never).verdict).toBe('weak')
    // A 120 yen/day CPA rise on a ~5,000 yen CPA is below the 150 yen/day material slope (3000 / 20).
    expect(calculateTrajectory(rising(5000, 120)).trend_direction).toBe('flat')
    expect(calculateTrajectory(rising(5000, 160)).trend_direction).toBe('worsening')
    expect(getCellColor(null, 300, 0, null)).toBe(getCellColor(0, 0, 0, null))
    expect(getCellColor(null, 301, 0, null)).not.toBe(getCellColor(0, 0, 0, null))
    expect(checkZeroConversions({ todayConversions: 0, spend: 2999, baselineConversions: 3 })).toBeNull()
    expect(checkZeroConversions({ todayConversions: 0, spend: 3000, baselineConversions: 3 })).toBe('warning')
    expect(getConfidenceAdjustment({ spend: 29_999, bookings: 5, windowDays: 7, attributionCoverage: null })).toBe('medium')
    expect(getConfidenceAdjustment({ spend: 30_000, bookings: 5, windowDays: 7, attributionCoverage: null })).toBe('high')
  })

  it('refuses an invalid floor by name, never echoing the value', () => {
    for (const bad of ['abc', '0', '-5', '1e3', ' 20 x']) {
      vi.stubEnv(ENV, bad)
      expect(() => minSpendToJudge(), bad).toThrow(new RegExp(ENV))
      if (bad.trim().length > 1) expect(() => minSpendToJudge(), bad).not.toThrow(new RegExp(bad.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      expect(validateEnv({ [ENV]: bad }).map((i) => `${i.name}:${i.code}`), bad).toContain(`${ENV}:invalid`)
    }
    vi.stubEnv(ENV, '0.5')
    expect(minSpendToJudge()).toBe(0.5)
    expect(envSpec(ENV)?.default).toBe('20')
  })
})

// Population: every currency-denominated spend floor in src derives from SPEND_FLOORS. Reported: an
// upper-case constant or key naming SPEND, or a min-spend name, holding a literal amount; and a literal
// amount compared with a spend value. Amounts of 0 or 1 are zero / any-delivery checks, not floors, and
// `10 ** -digits` is a minor-unit epsilon. Data records (a benchmark's `spend: 6000`) are not floors.
const N = String.raw`(?:[2-9]|\d{2,})(?:\.\d+)?\b(?!\s*\*\*)`
const SPEND_NAMED_LITERAL = new RegExp(String.raw`\b(?:[A-Z][A-Z0-9_]*SPEND[A-Z0-9_]*|\w*(?:min|Min|MIN)_?[sS]pend\w*)\s*[:=]\s*${N}`)
const SPEND_COMPARISON = new RegExp(String.raw`[sS]pend\w*\)?(?:\s*\?\?\s*0\))?\s*[<>]=?\s*${N}|\b${N}\s*[<>]=?\s*\(?[\w.]*[sS]pend\b`)
const NOT_AN_AMOUNT = /MULTIPLE|TOLERANCE|SHARE|PCT|RATIO|DAYS|HOURS|_MS\b/
/** The one literal allowed: the setting's own documented default. */
const ALLOWED = [{ file: 'src/config/business-config.ts', line: /^export const DEFAULT_MIN_SPEND_TO_JUDGE = 20$/ }]

export function literalSpendFloors(base: string): string[] {
  return listSourceFiles(path.join(base, 'src')).flatMap((abs) => {
    const file = path.relative(base, abs).split(path.sep).join('/')
    return readFileSync(abs, 'utf8').split('\n').flatMap((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return []
      if (ALLOWED.some((a) => a.file === file && a.line.test(line))) return []
      const named = line.match(SPEND_NAMED_LITERAL)?.[0]
      const hit = (named !== undefined && !NOT_AN_AMOUNT.test(named)) || SPEND_COMPARISON.test(line)
      return hit ? [`${file}:${i + 1}`] : []
    })
  })
}

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-spend-floors-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('no literal spend floor in src (population)', () => {
  it('reports planted floors and accepts derived floors, zero checks and non-amount spend names (planted control)', () => {
    const plant: Record<string, string> = {
      'src/lib/a.ts': 'const MIN_SPEND_FOR_X = 20\nconst y = { zero_leads_min_spend: 20 }\nif (agg.spend >= 80) go()\n',
      'src/lib/b.ts': 'if ((ctx.spend ?? 0) >= 200) score++\nconst c = metaSpend >= 50 ? 1 : 0\nreturn spend > 2 ? A : B\n',
      'src/lib/c.ts': 'const MIN_SPEND_MULTIPLE = 3\nif (spend > 0 && windowSpend < 1) skip()\nconst floor = SPEND_FLOORS.judge\n// spend >= 80 in a comment\n'
        + 'const SPEND_RECONCILIATION_TOLERANCE = 0.02\nif (spend >= SPEND_FLOORS.costPerOutcomeGate) go()\n'
        + 'const benchmark = { spend: 6000 }\nif (Math.abs(campaignSpend - accountSpend) > 10 ** -digits) warn()\n',
      'src/lib/d.ts': '  DORMANT_SPEND_30D: 20,\n  minSpend: 60, minClicks: 0,\n',
      'src/config/business-config.ts': 'export const DEFAULT_MIN_SPEND_TO_JUDGE = 20\nexport const OTHER_MIN_SPEND = 20\n',
    }
    for (const [file, text] of Object.entries(plant)) {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    expect(literalSpendFloors(planted).sort()).toEqual(['src/config/business-config.ts:2', 'src/lib/a.ts:1', 'src/lib/a.ts:2', 'src/lib/a.ts:3',
      'src/lib/b.ts:1', 'src/lib/b.ts:2', 'src/lib/b.ts:3', 'src/lib/d.ts:1', 'src/lib/d.ts:2'])
  })

  it('finds no literal spend floor in src', () => {
    expect(literalSpendFloors(process.cwd())).toEqual([])
  })
})
