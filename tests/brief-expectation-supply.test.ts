import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRIEF_EXPECTATIONS, UNREACHABLE_GATES } from '@/lib/eval/brief-expectations'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-questions'

/**
 * Keeps the disabled gates honest by expiring their excuse automatically.
 *
 * Three of the six AnswerBrief gates are switched off because the claim supply is single-plane: one
 * tool emits claims and every one of them is meta_delivery. Switching a gate off for a real reason is
 * legitimate; leaving it off after the reason stops being true is how a rubric quietly rots into
 * decoration — the exact failure the eval rebuild exists to correct.
 *
 * So each UNREACHABLE_GATES entry names the plane whose absence disables it, and this asserts that
 * plane is STILL absent from the cockpit source. The day a second plane starts being emitted these
 * tests fail, and the only way to make them pass is to tighten the expectation or delete the excuse.
 *
 * Deliberately a source scan: the alternative is running the cockpit builder against a database, which
 * would make a structural invariant depend on data that happens to be present.
 */

const ROOT = process.cwd()
const COCKPIT = readFileSync(join(ROOT, 'src/lib/cockpit/builder.ts'), 'utf8')
const CHAT = readFileSync(join(ROOT, 'src/lib/maxx/chat.ts'), 'utf8')

/**
 * Every evidence plane the cockpit emits.
 *
 * MUST match both spellings. `commonClaim` writes `evidencePlane: args.plane` — a VARIABLE — and its
 * callers pass `plane: 'meta_delivery'`. An earlier version of this function matched only the literal
 * `evidencePlane:` form and therefore saw 2 of 14 claims; the twelve routed through `commonClaim` were
 * invisible, so adding an Acuity claim through the normal path would have left this file green and
 * UNREACHABLE_GATES silently rotting — the exact failure the docblock above claims to prevent.
 *
 * Worse, the original was "validated" by mutating one of the two visible literals, which proved
 * nothing about the twelve it could not see. Hence `planeLiteralsCoverEveryClaim` below: counting the
 * planes against the metric keys is what makes a plane routed through a variable fail the scan rather
 * than vanish from it.
 */
function emittedPlanes(): Set<string> {
  return new Set([
    ...[...COCKPIT.matchAll(/evidencePlane: '([a-z_]+)'/g)].map((m) => m[1]),
    ...[...COCKPIT.matchAll(/\bplane: '([a-z_]+)'/g)].map((m) => m[1]),
  ])
}

/** Claim-shaped things the cockpit builds, counted independently of how their plane is spelled. */
function emittedMetricKeyCount(): number {
  return [...COCKPIT.matchAll(/metricKey: '[a-z0-9_.]+'/g)].length
}

/**
 * `commonClaim(...)` CALL sites — the function definition is not one.
 *
 * The previous version counted every `commonClaim(` occurrence, which included
 * `function commonClaim(` itself. Paired with the plane counter below, which included the
 * `sourceHealth` literal that is not a commonClaim argument, the equality held at 13 === 13 by two
 * unrelated off-by-ones cancelling. It was tightened from `>=` to exact precisely to remove slack,
 * and still did not mean what it said — the drift it was meant to catch would have had to arrive in
 * pairs to be seen.
 */
function commonClaimCallCount(): number {
  return [...COCKPIT.matchAll(/commonClaim\(/g)].length
       - [...COCKPIT.matchAll(/function commonClaim\(/g)].length
}

/**
 * The `buildSourceHealth` body, whose plane literals describe SOURCE HEALTH, not claims.
 *
 * Ledger G moved the `sourceHealth: [{ plane: '...' }]` literal out of the returned object into this
 * helper, so the old inline exclusion regex stopped matching and its subtraction silently became
 * zero — the counter then over-reported by one. Excluding the whole function body anchors the
 * exclusion to the thing it means rather than to one formatting of it.
 */
function sourceHealthBody(): string {
  return COCKPIT.match(/function buildSourceHealth\([\s\S]*?\n\}/)?.[0] ?? ''
}

/** Plane literals passed as a commonClaim argument — `buildSourceHealth`'s own are not. */
function literalPlaneArgCount(): number {
  return [...COCKPIT.matchAll(/\bplane: '[a-z_]+'/g)].length
       - [...sourceHealthBody().matchAll(/\bplane: '[a-z_]+'/g)].length
}

describe('the claim supply is what the expectations assume', () => {
  it('finds the cockpit claim construction at all (guards against scanning nothing)', () => {
    expect(emittedPlanes().size).toBeGreaterThan(0)
    expect(emittedMetricKeyCount()).toBeGreaterThan(5)
  })

  it('sees a readable plane literal for every claim the builder constructs', () => {
    // EXACT, not >=. A first attempt compared plane literals against metric keys and passed with one
    // slot of slack (15 vs 14), so routing a single plane through a variable still slipped by — caught
    // only by deliberately trying it. Every commonClaim call must name its plane as a literal this
    // scanner can read, or the scan is quietly reporting a smaller world than exists.
    expect(literalPlaneArgCount()).toBe(commonClaimCallCount())
    expect(commonClaimCallCount()).toBeGreaterThan(5)
    // Both counters must exclude their impostor, or the equality can hold for the wrong reason.
    // These two assertions are what stop an exclusion from silently becoming a no-op: if
    // `buildSourceHealth` is renamed or its literal removed, the subtraction would quietly go to zero
    // and the equality above would break for a reason nobody could read. That is exactly how the
    // pre-Ledger-G version failed.
    expect(COCKPIT).toMatch(/function commonClaim\(/)
    expect(sourceHealthBody()).toMatch(/\bplane: '/)
  })

  it('still emits exactly one evidence plane', () => {
    // If this fails, Maxx gained a second plane — good news, and every UNREACHABLE_GATES entry below
    // must be re-examined rather than carried forward.
    expect([...emittedPlanes()]).toEqual(['meta_delivery'])
  })

  it('still routes claims through exactly one tool', () => {
    const declared = /const CLAIM_EMITTING_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(CHAT)
    expect(declared).not.toBeNull()
    expect(declared![1].split(',').filter((s) => s.trim()).length).toBe(1)
  })

  it.each(UNREACHABLE_GATES.map((g) => [`${g.question}/${g.gate}`, g] as const))(
    '%s is disabled for a reason that is still true',
    (_name, entry) => {
      if (entry.blockedByMissingPlane) {
        expect(emittedPlanes().has(entry.blockedByMissingPlane)).toBe(false)
      }
      if (entry.blockedByMissingLevel) {
        // commonClaim hardcodes entity.level — 'business' for the Acuity plane, 'account' for every
        // other. A question scored at adset or ad level therefore has no admissible brief: cite
        // anything and G4 fails, cite nothing and G1 fails. If the builder ever gains a level
        // parameter this assertion fails and the question must be re-scored at real granularity.
        expect(COCKPIT).toMatch(/level: args\.plane === 'outcome_business' \? 'business' : 'account'/)
        expect(COCKPIT).not.toMatch(new RegExp(`level: '${entry.blockedByMissingLevel}'`))
      }
      expect(Boolean(entry.blockedByMissingPlane) || Boolean(entry.blockedByMissingLevel)).toBe(true)
    },
  )

  it('every disabled gate names a real question and a real reason', () => {
    const ids = new Set(GOLDEN_QUESTIONS.map((q) => q.id))
    for (const entry of UNREACHABLE_GATES) {
      expect(ids.has(entry.question)).toBe(true)
      // A one-word excuse is not an excuse; the next reader has to be able to judge it.
      expect(entry.reason.length).toBeGreaterThan(80)
    }
  })
})

describe('every golden question has an expectation', () => {
  it.each(GOLDEN_QUESTIONS.map((q) => [q.id] as const))('%s', (id) => {
    // A question with no expectation is scored by nothing, which is how the keyword rubric came to be
    // the only thing gating a chat that had stopped producing prose.
    expect(BRIEF_EXPECTATIONS[id]).toBeDefined()
    expect(BRIEF_EXPECTATIONS[id].id).toBe(id)
  })

  it('carries no expectation for a question that no longer exists', () => {
    const ids = new Set(GOLDEN_QUESTIONS.map((q) => q.id))
    for (const key of Object.keys(BRIEF_EXPECTATIONS)) expect(ids.has(key)).toBe(true)
  })
})
