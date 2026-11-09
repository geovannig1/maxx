import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Contradictory language must not survive ANYWHERE the model reads — not just in the daily
// report prompt. MCP tool descriptions and notes are model-facing text with exactly the same
// authority, so the same prohibitions apply to them.

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    // .tsx too: a rendered component is a model/owner-visible surface with the same authority.
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const MODEL_FACING = [
  ...walk(resolve(process.cwd(), 'src/mcp')),
  ...walk(resolve(process.cwd(), 'src/lib/report')),
  ...walk(resolve(process.cwd(), 'src/lib/knowledge')),
  ...walk(resolve(process.cwd(), 'src/lib/playbooks')),
  ...walk(resolve(process.cwd(), 'src/lib/recommendations')),
  ...walk(resolve(process.cwd(), 'src/lib/outcomes/adapters/acuity')),
  ...walk(resolve(process.cwd(), 'src/lib/trust')),
  ...walk(resolve(process.cwd(), 'src/lib/tracking')),
  ...walk(resolve(process.cwd(), 'src/lib/diagnostics')),
  ...walk(resolve(process.cwd(), 'src/components')),
]

/** A comment explaining WHY a claim was removed is fine; the claim itself is not. */
function offendingLines(file: string, re: RegExp): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => re.test(l))
    // Lines that are purely explanatory comments about the prohibition are allowed.
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    // A line that PROHIBITS a claim is not the claim. "you must NOT claim the difference is
    // expected" is the rule that removes the defect, and flagging it would force the rule out.
    .filter((l) => !/\b(must NOT|never (say|claim|state|call)|do not (claim|say|state|call)|NOT claim|forbid)/i.test(l))
}

describe('model-facing text — banned fixed claims', () => {
  it('no fixed "under-counts" attribution claim survives', () => {
    const hits = MODEL_FACING.flatMap((f) =>
      offendingLines(f, /under-?counts?\b|under-?counted\b|undercounts?\b/i).map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('no "not a broken pixel" reassurance survives', () => {
    const hits = MODEL_FACING.flatMap((f) =>
      offendingLines(f, /not a broken (pixel|tag)/i).map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('no universal "cancellations are never lost revenue" rule survives', () => {
    const hits = MODEL_FACING.flatMap((f) =>
      offendingLines(f, /canceled-and-rebooked, never lost revenue/i).map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('no fixed "GA4 will be LOWER" direction claim survives', () => {
    const hits = MODEL_FACING.flatMap((f) =>
      offendingLines(f, /will be LOWER than Acuity/i).map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  // SEMANTIC VARIANTS, not one exact phrase. The first sweep pinned literal strings, so an equivalent
  // reassurance written slightly differently would have passed.
  it('no FIXED-DIRECTION comparison between the planes survives', () => {
    const variants = [
      /normally\s+(higher|lower)/i,
      /(will|should)\s+(always\s+)?be\s+(higher|lower)\s+than/i,
      /is\s+(always\s+)?(higher|lower)\s+than\s+(GA4|Acuity|Meta)/i,
      /(gap|difference|discrepancy)\s+is\s+(expected|normal|fine|nothing)/i,
      /expected,?\s+not\s+(broken|drift|a problem)/i,
    ]
    const hits = MODEL_FACING.flatMap((f) =>
      variants.flatMap((re) => offendingLines(f, re).map((l) => `${f}: ${l.trim()}`)),
    )
    expect(hits).toEqual([])
  })

  it('no unevidenced "not broken" reassurance survives', () => {
    // A DORMANT-account statement is allowed: it is evidence-bearing ("no delivery, so zero events
    // says nothing"). A blanket "the gap is not broken" is not.
    const hits = MODEL_FACING.flatMap((f) =>
      offendingLines(f, /\bnot\s+broken\b/i)
        .filter((l) => !/no ad delivery|\$0 spend|dormant|UNVERIFIED/i.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('no malformed attribution phrase survives', () => {
    const hits = MODEL_FACING.flatMap((f) =>
      offendingLines(f, /to (the|an) can under|calibrated to an can/i).map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('the guard actually scans a meaningful number of model-facing files', () => {
    // Guards against the scan silently covering nothing.
    expect(MODEL_FACING.length).toBeGreaterThan(40)
    expect(MODEL_FACING.some((f) => f.endsWith('.tsx'))).toBe(true)
  })
})
