import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * `"LANDING_PAGE_VIEWS".replace('_', ' ')` yields `"LANDING PAGE_VIEWS"` — String.replace with a
 * STRING pattern replaces only the first occurrence. That shipped to production on
 * /performance/adsets, where Meta's optimization goal rendered with one underscore humanised
 * and the rest intact.
 *
 * Any token with two or more underscores hits this, and the codebase is full of them
 * (`needs_more_data`, `scale_candidate`, `campaign_plan_not_implemented`). The rule is
 * simply: use replaceAll.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('underscore humanisation', () => {
  it('never uses a non-global replace to humanise underscores', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8')
      text.split('\n').forEach((line, i) => {
        // .replace('_', …) / .replace("_", …) / .replace(/_/, …) — all single-shot.
        if (/\.replace\(\s*(['"]_['"]|\/_\/(?!g))\s*,/.test(line)) {
          offenders.push(`${file.replace(SRC, 'src')}:${i + 1}`)
        }
      })
    }
    expect(offenders, `use replaceAll('_', ' ') instead:\n${offenders.join('\n')}`).toEqual([])
  })

  it('demonstrates the bug this guards against', () => {
    expect('LANDING_PAGE_VIEWS'.replace('_', ' ')).toBe('LANDING PAGE_VIEWS')
    expect('LANDING_PAGE_VIEWS'.replaceAll('_', ' ')).toBe('LANDING PAGE VIEWS')
  })
})
