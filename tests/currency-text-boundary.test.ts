import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dollarFormatting, literalCurrencySigns, outcomeWordCounts } from './_support/currency-text-scan'
import { OUTCOME_WORDING_CEILING, OUTCOME_WORDING_DEBT } from './_support/outcome-wording-debt'

// text Maxx builds for people and models (src/lib, src/mcp) prints money through formatMoney in the
// account currency and names outcomes with the configured noun. Three rules, each with a planted control:
//  1. no "$" placed before a formatted number (a `$${...}` interpolation or a '$' + ... concatenation);
//  2. no literal booking/appointment word in string literals, except Meta event names. Rule 2 is a
//     ratchet: OUTCOME_WORDING_DEBT lists the files still carrying such words with their exact counts
//     and OUTCOME_WORDING_CEILING their total, so a conversion must lower both, the slack it leaves
//     cannot be refilled, and any other file must have none;
//  3. (all of src, not only src/lib and src/mcp) no literal "$" used as a currency sign: "$0 spend",
//     JSX `${x.toFixed(0)}`, a '$' display prefix, or the word "dollars". Text marked as a USD example or benchmark is the
//     explicit exception.

const ROOT = process.cwd()

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-currency-text-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('money and outcome wording in text builders', () => {
  it('reports planted dollar formatting and outcome words, and ignores event names and keys (planted control)', () => {
    const plantedFiles: Record<string, string> = {
      'src/lib/report/a.ts': 'export const a = (n: number) => `spent $${n.toFixed(2)}`\n',
      'src/mcp/tools/b.ts': "export const b = (n: number) => '$' + n\n",
      'src/lib/report/c.ts': "export const c = 'No bookings yet; AppointmentConfirmed fired'\nexport const k = 'bookings'\n",
      'src/lib/report/d.ts': "// $${not code}: bookings in a comment\nexport const d = `${'x'}`\n",
      'src/lib/maxx/chat.ts': 'export const e = (n: number) => `$${n}`\n',
      // Allowlist controls: a module specifier and database contracts are not wording; prose beside them is.
      'src/lib/report/f.ts': "import { x } from '@/lib/ga4/booking-reconciliation'\nconst m = () => import('./booking lag')\n"
        + "db.from('outcomes').select('spend, leads, bookings').eq('outcome_type', 'booking type')\nexport const p = 'No bookings here'\n",
    }
    for (const [file, text] of Object.entries(plantedFiles)) {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    expect(dollarFormatting(planted).sort()).toEqual(['src/lib/maxx/chat.ts:1', 'src/lib/report/a.ts:1', 'src/mcp/tools/b.ts:1'])
    expect(outcomeWordCounts(planted)).toEqual({ 'src/lib/report/c.ts': 1, 'src/lib/report/f.ts': 1 })
  })

  it('formats no money with a literal "$" in src/lib or src/mcp', () => {
    expect(dollarFormatting(ROOT)).toEqual([])
  })

  it('holds the outcome-wording debt at exactly its recorded counts and total', () => {
    const counts = outcomeWordCounts(ROOT)
    const drift = [...new Set([...Object.keys(counts), ...Object.keys(OUTCOME_WORDING_DEBT)])].sort()
      .filter((file) => (counts[file] ?? 0) !== (OUTCOME_WORDING_DEBT[file] ?? 0))
      .map((file) => `${file}: ${counts[file] ?? 0} (recorded ${OUTCOME_WORDING_DEBT[file] ?? 0})`)
    expect(drift).toEqual([])
    expect(Object.values(OUTCOME_WORDING_DEBT).reduce((sum, n) => sum + n, 0)).toBe(OUTCOME_WORDING_CEILING)
    expect(Object.values(OUTCOME_WORDING_DEBT).every((n) => n > 0)).toBe(true)
  })

  it('names the converted files as clean (they are not in the debt list)', () => {
    for (const file of ['src/lib/cockpit/audience-performance.ts', 'src/lib/tracking/health-monitor.ts']) {
      expect(OUTCOME_WORDING_DEBT[file]).toBeUndefined()
      expect(outcomeWordCounts(ROOT)[file]).toBeUndefined()
    }
  })

  it('reports each planted literal currency sign and ignores comments, keys, replacements and USD examples (planted control)', () => {
    const plantedFiles: Record<string, string> = {
      'src/app/p/page.tsx': 'export const P = ({ n }: { n: number }) => <p>${n.toFixed(0)}/day <span>$0</span></p>\n',
      'src/components/q.tsx': 'export const Q = ({ n }: { n: number }) => <p>spend ${n} · fine {n}</p>\n',
      'src/lib/r.ts': "export const r = 'no delivery ($0 spend)'\nexport const band = (n: number) => `<$100 (${n})`\n"
        + "const fmt = (n: number, prefix = '$') => prefix + n\nexport const s = (u: string, n: number) => (u === '$' ? '$' : '') + fmt(n, '$')\n"
        + "export const w = 'May create more contribution dollars; the next dollar is unproven.'\n",
      'src/lib/ok.ts': "// $5 in a comment\nexport const unit = { unit: '$', path: '$' }\nexport const t = (x: string) => x.replace(/a(b)/, '$1:$2')\n"
        + "export const ex = 'Official example (USD example): a $5 goal needs $25/day.'\nexport const re = '^\\\\d{1,14}$'\n"
        + "export const pairs = [[/(token)=\\S+/g, '$1=[redacted]']]\n"
        + "export const matcher = '\\\\b(?:budget|spend|dollars?)\\\\b'\n",
    }
    for (const [file, text] of Object.entries(plantedFiles)) {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    // Rule 3 also reports the `$${...}` plants of the first control (src/lib/maxx/chat.ts, src/lib/report/a.ts).
    expect(literalCurrencySigns(planted).sort()).toEqual([
      'src/app/p/page.tsx:1', 'src/app/p/page.tsx:1', 'src/components/q.tsx:1', 'src/lib/maxx/chat.ts:1',
      'src/lib/r.ts:1', 'src/lib/r.ts:2', 'src/lib/r.ts:3', 'src/lib/r.ts:4', 'src/lib/r.ts:4', 'src/lib/r.ts:5', 'src/lib/report/a.ts:1',
    ])
  })

  it('prints no literal "$" as a currency sign anywhere in src', () => {
    expect(literalCurrencySigns(ROOT)).toEqual([])
  })
})
