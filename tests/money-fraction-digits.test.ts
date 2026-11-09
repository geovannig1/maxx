import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { listSourceFiles } from './_support/source-scan'
import { dollarFormatting } from './_support/currency-text-scan'
import { formatMoney, formatMoneyTrim, formatCurrency } from '@/lib/utils/format-currency'
import { RECOMMENDATION_EVIDENCE_VALUE_FORMATTER } from '@/lib/cockpit/contracts'
import { formatKpiValue } from '@/lib/report/daily-digest'
import { formatMetric, METRIC_BY_KEY } from '@/lib/metrics/catalog'

// money shown on screens and in reports uses the account currency's minor-unit digits (JPY 0,
// USD 2, KWD 3). A fixed two decimals printed "¥1,234.00" and dropped KWD's third digit. Population:
// every source file under src. Rules, each with a planted control:
//  1. no `style: 'currency'` options object outside src/lib/utils/format-currency.ts, and no
//     formatMoney-family call, with a literal non-zero fraction-digit count (use formatMoney /
//     formatMoneyTrim / currencyFractionDigits, which know the currency's digits). Unconditional compact
//     notation, whose digits count an abbreviated magnitude rather than minor units, is exempt;
//  2. no "$" glued to a formatted number in src/components or src/app (src/lib and src/mcp are covered by
//     tests/currency-text-boundary.test.ts).

const FORMATTER_HOME = 'src/lib/utils/format-currency.ts'
const CURRENCY_OBJECT = /\{[^{}]*style:\s*['"]currency['"][^{}]*\}/g
const MONEY_CALL = /\bformat(?:Money|MoneyTrim|MoneyAmount|Currency)\((?:[^()]|\([^()]*\))*?\{[^{}]*\}/g
const LITERAL_DIGITS = /FractionDigits:\s*(?:[^,}\n]*?(?:\?\?|\?|:)\s*)?[1-9]\b/
const COMPACT = /compact:\s*true|notation:\s*['"]compact['"]/
const fixedDigits = (options: string) => LITERAL_DIGITS.test(options) && !COMPACT.test(options)

function sources(base: string): string[] {
  return listSourceFiles(path.join(base, 'src')).map((f) => path.relative(base, f).split(path.sep).join('/'))
}
const code = (text: string) => text.split('\n').map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line)).join('\n')
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

export function fixedDigitMoney(base: string): string[] {
  return sources(base).filter((file) => file !== FORMATTER_HOME).flatMap((file) => {
    const text = code(readFileSync(path.join(base, file), 'utf8'))
    const hits: string[] = []
    for (const match of text.matchAll(CURRENCY_OBJECT)) {
      if (fixedDigits(match[0])) hits.push(`${file}:${lineOf(text, match.index)} currency style`)
    }
    for (const match of text.matchAll(MONEY_CALL)) {
      if (fixedDigits(match[0])) hits.push(`${file}:${lineOf(text, match.index)} fixed digits`)
    }
    return hits
  })
}

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-money-digits-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))
afterEach(() => vi.unstubAllEnvs())

describe('money uses the currency\'s minor-unit digits', () => {
  it('reports planted fixed-digit money and accepts currency-aware and compact formatting (planted control)', () => {
    const plant: Record<string, string> = {
      'src/components/a.tsx': "const m = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })\n"
        + "const p = new Intl.NumberFormat(locale, {\n  style: 'currency',\n  minimumFractionDigits: 2,\n})\n"
        + "const q = (v: number) => v.toLocaleString(l, { style: 'currency', notation: v >= 1000 ? 'compact' : 'standard', maximumFractionDigits: v >= 1000 ? 1 : 2 })\n"
        + "const r = (v: number) => v.toLocaleString(l, { style: 'currency', notation: 'compact', maximumFractionDigits: 1 })\n",
      'src/lib/b.ts': 'const b = (n: number) => formatMoney(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })\n',
      'src/lib/c.ts': 'const c = (n: number) => formatMoney(Math.abs(n), { maximumFractionDigits: n % 1 ? 2 : 0 })\n',
      'src/lib/d.ts': 'const d = (n: number) => formatMoney(n, { maximumFractionDigits: 0 }) + formatMoney(n, { compact: true, maximumFractionDigits: 1 })\n'
        + '// formatMoney(n, { maximumFractionDigits: 2 }) in a comment\nconst e = (n: number) => formatMoney(n, { maximumFractionDigits: n % 1 ? digits : 0 })\n',
      'src/lib/utils/format-currency.ts': "new Intl.NumberFormat(locale, { style: 'currency', currency })\n",
      'src/app/f.tsx': "const f = (n: number) => '$' + n.toLocaleString()\n",
    }
    for (const [file, text] of Object.entries(plant)) {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    expect(fixedDigitMoney(planted).sort()).toEqual([
      'src/components/a.tsx:2 currency style',
      'src/components/a.tsx:6 currency style',
      'src/lib/b.ts:1 fixed digits',
      'src/lib/c.ts:1 fixed digits',
    ])
    expect(dollarFormatting(planted, ['src/components', 'src/app'])).toEqual(['src/app/f.tsx:1'])
  })

  it('formats no money with fixed decimals anywhere in src', () => {
    expect(fixedDigitMoney(process.cwd())).toEqual([])
  })

  it('glues no "$" to a formatted number in components or pages', () => {
    expect(dollarFormatting(process.cwd(), ['src/components', 'src/app'])).toEqual([])
  })

  it('shows JPY without decimals and KWD with three across the shared money formatters', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'JPY')
    const jpy = [formatMoney(1234), formatMoneyTrim(1234.5), formatCurrency(1234), RECOMMENDATION_EVIDENCE_VALUE_FORMATTER.money(1234),
      formatKpiValue({ key: 'spend', label: 'Amount Spent', unit: 'money', value: 1234 } as never), formatMetric(METRIC_BY_KEY.spend, 1234)]
    for (const text of jpy) expect(text).toMatch(/^¥1,23[45]$/)
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'KWD')
    const kwd = [formatMoney(3.333), formatMoneyTrim(3.333), formatCurrency(3.333), RECOMMENDATION_EVIDENCE_VALUE_FORMATTER.money(3.333),
      formatKpiValue({ key: 'spend', label: 'Amount Spent', unit: 'money', value: 3.333 } as never), formatMetric(METRIC_BY_KEY.spend, 3.333)]
    for (const text of kwd) expect(text).toContain('3.333')
  })

  it('keeps USD output byte-identical (control)', () => {
    expect([formatMoney(1000), formatMoneyTrim(1000), formatMoneyTrim(1000.5), formatCurrency(12.345), RECOMMENDATION_EVIDENCE_VALUE_FORMATTER.money(12),
      formatMetric(METRIC_BY_KEY.cpc, 1.5)])
      .toEqual(['$1,000.00', '$1,000', '$1,000.5', '$12.35', '$12.00', '$1.50'])
  })
})
