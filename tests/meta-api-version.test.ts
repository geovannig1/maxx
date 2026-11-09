import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { META_API_VERSION, META_GRAPH_BASE } from '@/lib/platforms/meta/api-version'

// Meta Graph API version guard (2026-07-17). v22.0 was hardcoded in ~a dozen paths and silently
// expired (2026-02-19) — calls kept working only via Meta's version rollover, which is unsupported
// and can shift payload shapes underneath passing unit tests. The version now lives in ONE module
// (src/lib/platforms/meta/api-version.ts); this test fails the suite if any source file hardcodes a
// graph.facebook.com version outside it, so the next bump is a one-line change and a drift back to
// scattered literals is impossible.

const ROOT = process.cwd()
const SCAN_DIRS = ['src', 'scripts']
const ALLOWED = join('src', 'lib', 'platforms', 'meta', 'api-version.ts')

function walk(dir: string, hits: Array<{ file: string; line: number; text: string }>) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) { walk(p, hits); continue }
    if (!/\.tsx?$/.test(entry)) continue
    const rel = p.slice(ROOT.length + 1)
    if (rel === ALLOWED) continue
    const lines = readFileSync(p, 'utf8').split('\n')
    lines.forEach((text, i) => {
      // A versioned Graph host literal (graph.facebook.com/vNN[.N]) — comments included on purpose:
      // even a commented-out hardcoded call is a copy-paste hazard back into scattered pins.
      if (/graph\.facebook\.com\/v\d+/.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim() })
    })
  }
}

describe('Meta Graph API version pin', () => {
  it('no file hardcodes a graph.facebook.com version outside api-version.ts', () => {
    const hits: Array<{ file: string; line: number; text: string }> = []
    for (const d of SCAN_DIRS) walk(join(ROOT, d), hits)
    expect(
      hits,
      `hardcoded Graph API version(s) — import META_GRAPH_BASE from '@/lib/platforms/meta/api-version' instead:\n${hits
        .map((h) => `${h.file}:${h.line} ${h.text}`)
        .join('\n')}`,
    ).toEqual([])
  })

  it('the pin is a supported version shape and the base derives from it', () => {
    expect(META_API_VERSION).toMatch(/^v\d+\.\d+$/)
    // Regression floor: never drift back below v25 (v22 expired 2026-02-19; v25 verified live 2026-07-17).
    expect(Number(META_API_VERSION.slice(1).split('.')[0])).toBeGreaterThanOrEqual(25)
    expect(META_GRAPH_BASE).toBe(`https://graph.facebook.com/${META_API_VERSION}`)
  })
})
