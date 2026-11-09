import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanUiText } from './_support/ui-text-scan'

// Screen wording: screens never hard-code one business's vocabulary. Owner-visible text names
// outcomes through `outcomeNoun`/`outcomeWords` (src/config/outcome-nouns.ts, NEXT_PUBLIC_OUTCOME_NOUN),
// and dates/windows carry the configured timezone's short name, never a literal "ET".
//
// Scope: src/components and the src/app screens (not src/app/api). Text = JSX text and string/template
// literals; comments and identifiers (`realBookings`, `total_bookings`) are code (tests/_support/ui-text-scan.ts).

const ROOT = process.cwd()
const ROOTS = ['src/components', 'src/app']
const EXCLUDE = ['src/app/api/']
const OUTCOME_WORD = /\b(booking|appointment)s?\b/i
const ET_LABEL = /\bET\b/

// Meta's own names, kept verbatim. Each entry must still match (a stale entry fails the test).
const META_LABEL_ALLOWLIST = [
  // The Meta custom event name "AppointmentConfirmed", split with <wbr /> for the table header.
  { file: 'src/components/reporting/OverviewCreative.tsx', text: 'Appointment' },
]

const key = (hit: { file: string; text: string }) => `${hit.file}: ${hit.text}`

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-ui-wording-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('screen wording uses the configured outcome noun', () => {
  it('reads owner-visible text in the real tree (known-present control)', () => {
    const hits = scanUiText(ROOT, ROOTS, /\bspend\b/i, EXCLUDE)
    expect(hits.some((h) => h.file === 'src/components/dashboard/KpiGrid.tsx')).toBe(true)
  })

  it('reports planted text and ignores comments, identifiers and code literals (planted controls)', () => {
    const files: Record<string, string> = {
      'src/components/Card.tsx': [
        "// a comment about bookings",
        "const realBookings = row.total_bookings",
        "const key = 'bookings'",
        "if (label === 'Bookings') {}",
        "export const a = <p>Paid bookings this week</p>",
        "export const b = 'One appointment left'",
        "export const c = `${n} bookings`",
        "export const d = <span title=\"Window 09:00 ET\">x</span>",
      ].join('\n'),
      'src/app/api/route.ts': "export const e = 'Bookings'\n",
    }
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    expect(scanUiText(planted, ROOTS, OUTCOME_WORD, EXCLUDE).map(key)).toEqual([
      'src/components/Card.tsx: Paid bookings this week',
      'src/components/Card.tsx: One appointment left',
      'src/components/Card.tsx: ${…} bookings',
    ])
    expect(scanUiText(planted, ROOTS, ET_LABEL, EXCLUDE).map(key)).toEqual(['src/components/Card.tsx: Window 09:00 ET'])
  })

  it('has no literal booking/appointment text outside the Meta-label allowlist', () => {
    const hits = scanUiText(ROOT, ROOTS, OUTCOME_WORD, EXCLUDE).map(key).sort()
    expect(hits).toEqual(META_LABEL_ALLOWLIST.map(key).sort())
  })

  it('has no hard-coded "ET" time label', () => {
    expect(scanUiText(ROOT, ROOTS, ET_LABEL, EXCLUDE).map(key)).toEqual([])
  })
})
