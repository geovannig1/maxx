import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dollarFormatting, outcomeWordCounts } from './_support/currency-text-scan'
import { OUTCOME_WORDING_DEBT } from './_support/outcome-wording-debt'

// text Maxx builds for people and models (src/lib, src/mcp) prints money through formatMoney in the
// account currency and names outcomes with the configured noun. Two rules, each with a planted control:
//  1. no "$" placed before a formatted number (a `$${...}` interpolation or a '$' + ... concatenation);
//  2. no literal booking/appointment word in string literals, except Meta event names. Rule 2 is
//     shrink-only: OUTCOME_WORDING_DEBT lists the files still carrying such words and their counts, a
//     count may only fall, and any other file must have none.

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

  it('adds no literal outcome word outside the shrinking debt list, and no file exceeds its debt', () => {
    const counts = outcomeWordCounts(ROOT)
    const over = Object.entries(counts).filter(([file, n]) => n > (OUTCOME_WORDING_DEBT[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} > ${OUTCOME_WORDING_DEBT[file] ?? 0}`)
    expect(over).toEqual([])
  })

  it('names the converted files as clean (they are not in the debt list)', () => {
    for (const file of ['src/lib/cockpit/audience-performance.ts']) {
      expect(OUTCOME_WORDING_DEBT[file]).toBeUndefined()
      expect(outcomeWordCounts(ROOT)[file]).toBeUndefined()
    }
  })
})
