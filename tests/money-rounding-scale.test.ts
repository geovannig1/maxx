import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { listSources } from './helpers/env-reads'
import { roundMoney } from '@/lib/utils/format-currency'

// money is rounded at the account currency's minor unit (JPY 0 decimals, USD 2, KWD 3), never at a
// fixed two decimals. Population: every source file under src/mcp and src/lib. Each remaining two-decimal
// rounding is inventoried below with its non-money subject (ratios, rates, frequencies, scores).

const ROOT = path.resolve(__dirname, '..')

/** Every two-decimal rounding left in src/mcp and src/lib, by file, with what it rounds. None is money;
 *  money uses roundMoney / formatMoney. A new two-decimal rounding anywhere fails until it is either
 *  converted or listed here with its non-money subject. */
const NON_MONEY_TWO_DECIMAL: Record<string, { count: number; subject: string }> = {
  'src/mcp/tools/campaign-performance.ts': { count: 1, subject: 'frequency' },
  'src/lib/alerts/detector.ts': { count: 5, subject: 'CTR and frequency in alert text' },
  'src/lib/audience/resolver.ts': { count: 1, subject: 'confidence' },
  'src/lib/authority/directional-policy.ts': { count: 1, subject: 'blended ROAS' },
  'src/lib/cockpit/audience-performance.ts': { count: 1, subject: 'link CTR percent helper' },
  'src/lib/cockpit/contracts.ts': { count: 1, subject: 'ratio display' },
  'src/lib/creative/copy-prompt.ts': { count: 1, subject: 'link CTR percent in the prompt' },
  'src/lib/creative/copy-text.ts': { count: 1, subject: 'copy similarity ratio' },
  'src/lib/creative/correlator.ts': { count: 1, subject: 'average bookings' },
  'src/lib/creative/verdict.ts': { count: 2, subject: 'frequency' },
  'src/lib/diagnostics/anomaly.ts': { count: 3, subject: 'percent, ratio and unitless display (money uses formatMoney)' },
  'src/lib/diagnostics/delivery.ts': { count: 1, subject: 'events-per-week helper' },
  'src/lib/diagnostics/launch-performance.ts': { count: 1, subject: 'precision helper for ratios, shares, CTR and frequency' },
  'src/lib/diagnostics/drift-check.ts': { count: 1, subject: 'bookings-layer delta (money layers use roundMoney)' },
  'src/lib/diagnostics/opportunity.ts': { count: 1, subject: 'frequency' },
  'src/lib/diagnostics/rotation-bench.ts': { count: 1, subject: 'frequency' },
  'src/lib/diagnostics/structure.ts': { count: 1, subject: 'share and effective-entities helper' },
  'src/lib/eval/golden-questions.ts': { count: 1, subject: 'score' },
  'src/lib/flags/rules.ts': { count: 8, subject: 'frequency and CTR' },
  'src/lib/maxx/answer-values.ts': { count: 1, subject: 'percent change' },
  'src/lib/recommendations/builder.ts': { count: 1, subject: 'non-money metric values (money uses formatMoney)' },
  'src/lib/recommendations/grounding-gate.ts': { count: 1, subject: 'confidence score' },
  'src/lib/recommendations/learning-narrative.ts': { count: 1, subject: 'CTR' },
  'src/lib/recommendations/pragmatic-media-buyer.ts': { count: 1, subject: 'ROAS helper' },
  'src/lib/report/daily-digest.ts': { count: 1, subject: 'percent' },
  'src/lib/report/prompt-builder.ts': { count: 3, subject: 'percent, frequency and MER' },
  'src/lib/reporting/overview-business-summary.ts': { count: 3, subject: 'MER ratio' },
  'src/lib/reporting/overview-interpretation.ts': { count: 2, subject: 'MER ratio' },
  'src/lib/targets/target-ranges.ts': { count: 3, subject: 'percent, ratio and unitless bands (money uses formatMoney)' },
}

// Also a generic `Math.round(n * 10 ** p) / 10 ** p` helper, whose default precision is two decimals.
const TWO_DECIMAL = /Math\.round\([^\n]*?\*\s*100\s*\)\s*\/\s*100|Math\.round\([^\n]*?\*\s*10\s*\*\*\s*\w+\s*\)\s*\/\s*10\s*\*\*\s*\w+|\.toFixed\(2\)/g

/** Two-decimal roundings in one source text, comment lines excluded. */
export function twoDecimalRoundings(source: string): number {
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  return code.match(TWO_DECIMAL)?.length ?? 0
}

/** Files whose two-decimal roundings differ from the non-money inventory. */
export function unlisted(counts: Record<string, number>): string[] {
  const files = new Set([...Object.keys(counts), ...Object.keys(NON_MONEY_TWO_DECIMAL)])
  return [...files].filter((file) => (counts[file] ?? 0) !== (NON_MONEY_TWO_DECIMAL[file]?.count ?? 0))
    .map((file) => `${file}: ${counts[file] ?? 0} found, ${NON_MONEY_TWO_DECIMAL[file]?.count ?? 0} listed`).sort()
}

const saved = process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
  else process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = saved
})

describe('money rounding at the account currency scale', () => {
  it('planted controls: the detector counts two-decimal roundings and a new one is reported', () => {
    expect(twoDecimalRoundings('      spend: Math.round(totals.spend * 100) / 100,')).toBe(1)
    expect(twoDecimalRoundings('const r2 = (n: number) => Math.round(n * 100) / 100')).toBe(1)
    expect(twoDecimalRoundings('const extra = (cpl - baseline.avgCpl).toFixed(2)')).toBe(1)
    expect(twoDecimalRoundings('  spend: roundMoney(totals.spend),')).toBe(0)
    expect(twoDecimalRoundings('// Math.round(x * 100) / 100 in a comment')).toBe(0)
    expect(twoDecimalRoundings('const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p')).toBe(1)
    expect(unlisted({ 'src/mcp/tools/planted.ts': 1 })).toContain('src/mcp/tools/planted.ts: 1 found, 0 listed')
    expect(unlisted({ ...Object.fromEntries(Object.entries(NON_MONEY_TWO_DECIMAL).map(([f, v]) => [f, v.count])),
      'src/lib/flags/rules.ts': 9 })).toEqual(['src/lib/flags/rules.ts: 9 found, 8 listed'])
  })

  it('every two-decimal rounding in src/mcp and src/lib is a listed non-money value', () => {
    const files = ['src/mcp', 'src/lib'].flatMap((dir) => listSources(path.join(ROOT, dir)))
    expect(files.length).toBeGreaterThan(100)
    const counts = Object.fromEntries(files
      .map((file) => [path.relative(ROOT, file).split(path.sep).join('/'), twoDecimalRoundings(readFileSync(file, 'utf8'))] as const)
      .filter(([, count]) => count > 0))
    expect(unlisted(counts)).toEqual([])
  })

  it('roundMoney uses the currency minor unit', () => {
    expect(roundMoney(1234.56, 'JPY')).toBe(1235)
    expect(roundMoney(1.2346, 'KWD')).toBe(1.235)
    expect(roundMoney(1.2345, 'USD')).toBe(1.23)
    process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = 'KWD'
    expect(roundMoney(30.1236)).toBe(30.124)
  })
})
