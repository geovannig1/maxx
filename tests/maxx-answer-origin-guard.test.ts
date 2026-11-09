import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { governMaxxAnswer, type MaxxToolEvidence } from '@/lib/maxx/chat'

/**
 * The prose guard must not police prose the server wrote.
 *
 * `violatesMeasurementBoundary` refuses a sentence stating a multi-day frequency or reach without
 * naming a native rollup. It was written when the answer WAS model prose. Once every return path
 * became server-composed, it started firing on the system's own output: a brief citing
 * `meta.native_frequency` had its ENTIRE answer replaced by "I withheld the generated answer because
 * it crossed a governed measurement boundary" — a governance refusal that reads like the system
 * working correctly.
 *
 * `meta.native_frequency` is only available when `source-readers` read a native all-days rollup, so
 * the claim IS the thing the rule demands. The guard could not tell, because it reads sentences.
 *
 * The fix is an ORIGIN with a fail-safe default, not a flag. These cases pin both directions.
 */

const EVIDENCE: MaxxToolEvidence[] = [{
  tool: 'get_performance_cockpit', sources: ['Meta'],
  dateWindow: 'requested 2026-04-06 to 2026-04-24; actual coverage must come from tool lineage',
  scope: 'account act_123', observedAt: '2026-04-25T12:00:00.000Z',
  freshness: 'tool response observed 2026-04-25T12:00:00.000Z', availability: 'returned',
  caveat: 'A returned response does not make every metric complete, current, or decision-grade.',
}]

const WITHHELD = 'crossed a governed measurement boundary'
/** Exactly what `claimLine` emits for the native frequency claim. */
const FREQUENCY_LINE = '- **Meta frequency — 3x**'

describe('server-composed text is not scanned as if the model wrote it', () => {
  it('a rendered frequency claim SURVIVES on the production path', () => {
    expect(governMaxxAnswer(FREQUENCY_LINE, EVIDENCE, 'server_composed')).not.toContain(WITHHELD)
    expect(governMaxxAnswer(FREQUENCY_LINE, EVIDENCE, 'server_composed')).toContain('Meta frequency')
  })

  it('the same text is still REFUSED when the model authored it', () => {
    // The guard is narrowed, not weakened. This is the case it was written for.
    expect(governMaxxAnswer(FREQUENCY_LINE, EVIDENCE, 'model_authored')).toContain(WITHHELD)
  })

  it('DEFAULTS to strict, so a caller that says nothing keeps the old behaviour', () => {
    // Fail-safe: a future call site added without thinking about origin gets the guard, not a hole.
    expect(governMaxxAnswer(FREQUENCY_LINE, EVIDENCE)).toContain(WITHHELD)
  })

  it('still refuses a model claim of paid CPA with a number', () => {
    // A different rule in the same guard, proving the narrowing is about ORIGIN and not about
    // switching the guard off for frequency.
    const text = 'Your paid CPA was $41.20 last month.'
    expect(governMaxxAnswer(text, EVIDENCE, 'model_authored')).toContain(WITHHELD)
  })

  it('still refuses GA4 revenue language from the model', () => {
    const text = 'GA4 shows revenue of $1,684 for the period.'
    expect(governMaxxAnswer(text, EVIDENCE, 'model_authored')).toContain(WITHHELD)
  })

  it('the numeric-without-evidence rule applies to BOTH origins', () => {
    // Narrowing the prose scan must not also narrow this. A figure with no tool behind it is
    // unsupported whoever composed it.
    const numeric = 'Spend was $963.40.'
    for (const origin of ['server_composed', 'model_authored'] as const) {
      expect(governMaxxAnswer(numeric, [], origin))
        .toContain('not enough governed account evidence')
    }
  })

  it('a server refusal string with no digits passes through untouched', () => {
    const message = 'Maxx chat is disabled. The account diagnostics remain read-only.'
    expect(governMaxxAnswer(message, [], 'server_composed')).toContain('Maxx chat is disabled')
  })
})

describe('the production call sites declare their origin', () => {
  it('both governMaxxAnswer calls in chat.ts pass server_composed', () => {
    // The shipped wiring, not a call this test constructs. If a third call site appears without an
    // origin it gets the strict default — but a KNOWN server path silently reverting to strict would
    // reintroduce the withheld-answer bug, so the two that exist are pinned.
    const source = readFileSync(join(process.cwd(), 'src/lib/maxx/chat.ts'), 'utf8')
    const calls = [...source.matchAll(/governMaxxAnswer\(([^)]*)\)/g)]
      .map((m) => m[1])
      .filter((args) => !args.includes('markdown'))   // exclude the declaration
    expect(calls).toHaveLength(2)
    for (const args of calls) expect(args).toContain("'server_composed'")
  })
})
