import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertUniqueClaimIds } from '@/lib/cockpit/builder'

/**
 * The duplicate-claim-id guard, watched failing.
 *
 * `claimId()` is `metricKey:start:end` — it carries no entity. Today every cockpit claim is
 * account-level with a distinct metric key, so nothing collides and the guard is a FORWARD tripwire:
 * it fires the day adset- or ad-level claims exist, which `brief-expectations.ts` records as the
 * reason two eval gates are permanently unreachable.
 *
 * That made it untestable through the builder's own API, and mutation testing confirmed the
 * consequence — deleting the throw entirely left the whole suite green. So the guard is exported and fired
 * here directly, and the last test keeps it wired into the assembly path, because a guard that is
 * proven correct but no longer called is worth nothing.
 *
 * What it prevents: `Object.fromEntries` keeps the LAST of a duplicate pair and drops the other with
 * no error, so a claim vanishes before `assertNoCrossPlaneLineage` ever sees it, and a brief citing
 * the dropped id fails to resolve — withholding a correct answer for a reason no reader can diagnose.
 */

const claim = (claimId: string) => ({ claimId })

describe('a claim id must identify exactly one claim', () => {
  it('accepts distinct ids', () => {
    expect(() => assertUniqueClaimIds([
      claim('meta.spend:2026-08-01:2026-08-22'),
      claim('meta.impressions:2026-08-01:2026-08-22'),
    ])).not.toThrow()
  })

  it('accepts an empty set rather than throwing on nothing', () => {
    expect(() => assertUniqueClaimIds([])).not.toThrow()
  })

  it('THROWS on the collision the current id format will produce at sub-account level', () => {
    // The exact future case: same metric, same window, two entity levels — one id.
    expect(() => assertUniqueClaimIds([
      claim('meta.spend:2026-08-01:2026-08-22'),
      claim('meta.spend:2026-08-01:2026-08-22'),
    ])).toThrow(/duplicate claim id/i)
  })

  it('names every colliding id, and each one once', () => {
    try {
      assertUniqueClaimIds([
        claim('a:1:2'), claim('a:1:2'), claim('a:1:2'),
        claim('b:1:2'), claim('b:1:2'),
        claim('c:1:2'),
      ])
      throw new Error('expected a throw')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('a:1:2')
      expect(message).toContain('b:1:2')
      expect(message).not.toContain('c:1:2')
      // Two distinct colliding ids, not three occurrences of them.
      expect(message).toContain('2 duplicate claim id(s)')
    }
  })

  it('tells the reader what to do, not just that something is wrong', () => {
    expect(() => assertUniqueClaimIds([claim('x:1:2'), claim('x:1:2')]))
      .toThrow(/widen claimId\(\) to include the entity/i)
  })

  it('is CALLED unconditionally by the cockpit assembly, before the map that would swallow a collision', () => {
    // Text order is not execution. The first version compared two `indexOf` positions, so wrapping the
    // call in `if (claims.length < 0)` kept the text in place, disabled the guard, and left the whole
    // suite green. This asserts the statement is unguarded AND that it precedes the map.
    const source = readFileSync(join(process.cwd(), 'src/lib/cockpit/builder.ts'), 'utf8')
    const callLine = source.split('\n').find((line) => line.includes('assertUniqueClaimIds(claims)'))
    expect(callLine).toBeDefined()
    // The call must be the WHOLE statement on its line — no `if`, no `&&`, no ternary in front of it.
    expect(callLine!.trim()).toBe('assertUniqueClaimIds(claims)')
    const guardAt = source.indexOf('assertUniqueClaimIds(claims)')
    const mapAt = source.indexOf('Object.fromEntries(claims.map(')
    expect(mapAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(mapAt)
    // And the line before it must not open a conditional block that could contain it.
    const preceding = source.slice(0, guardAt).trimEnd().split('\n').at(-1) ?? ''
    expect(preceding).not.toMatch(/\bif\s*\(/)
  })
})
