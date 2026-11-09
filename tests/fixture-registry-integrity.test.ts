import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMISSIBLE_CASES, CORRECT_BRIEF, DEFECT_CASES, citation, fixtureClaims } from './fixtures/brief-defects'

/**
 * Every fixture citation must resolve to the claim the case meant to cite.
 *
 * `scoreBrief` reads plane, entity level, window, measurement lane and availability off the CLAIM, so
 * the whole rubric is only as sound as `claims.get(id)` returning the right one. The fixture builder
 * once keyed its claimId on three fields while a brief varied in ten, so distinct cases collapsed onto
 * one registry entry and `Map.set` kept the last writer: 6 of 16 ids resolved to a claim contradicting
 * the case on availability, window, measurement lane or entity.
 *
 * That defect used to be caught by re-deriving each predicate and comparing ten fields. Briefs no
 * longer carry predicates, so that check is gone — but the defect it caught is NOT, because it was
 * never about transcription. It was about a Map key that does not identify its value. `citation()` now
 * throws on a colliding registration, and the third test below fires that guard deliberately: a guard
 * nobody has watched fail is a guard nobody knows works.
 */

function everyFixtureCitation(): string[] {
  const briefs = [
    CORRECT_BRIEF,
    ...DEFECT_CASES.map((testCase) => testCase.brief),
    ...ADMISSIBLE_CASES.map((testCase) => testCase.brief),
  ]
  return briefs.flatMap((brief) => [
    ...brief.observations.flatMap((observation) => observation.claim_ids),
    ...brief.unavailable_claim_ids,
  ])
}

describe('the fixture claim registry agrees with its citations', () => {
  const cited = everyFixtureCitation()

  it('enumerates the whole fixture population (guards against checking nothing)', () => {
    expect(cited.length).toBeGreaterThan(50)
    expect(new Set(cited).size).toBeGreaterThan(10)
  })

  it('resolves every citation to a registered claim', () => {
    const claims = fixtureClaims()
    const missing = cited.filter((id) => !claims.has(id))
    expect([...new Set(missing)]).toEqual([])
  })

  // The id must be INJECTIVE over the override space. That is the whole invariant: the 6-of-16 defect
  // was an id keyed on three fields while the thing it identified varied in ten, so distinct cases
  // collapsed onto one entry and `Map.set` kept the last writer.
  //
  // The `citation()` collision throw cannot be fired through `citation()`'s own API — the id is
  // derived from every override, so two different registrations always produce two different ids.
  // That makes the throw a forward tripwire for a future edit, not something a test can trigger. So
  // this tests the property the throw protects instead, and it is strictly stronger: it fails if the
  // id is ever narrowed AND it fails if a new override dimension is added without extending the id.
  //
  // A previous version of this test built a local `new Map(claims)`, called `registry.set`, and
  // asserted the value changed. That asserts `Map.set` overwrites — a statement about ECMAScript, not
  // about this fixture. Mutation testing confirmed it: deleting the guard and re-narrowing the id
  // back to the original three fields left all four tests green.
  const ALTERNATIVE: Record<string, Record<string, unknown>> = {
    metric_key: { metric_key: 'meta_spend' },
    level: { level: 'adset' },
    // ONE dimension each. The first version varied plane, system and role together in all three
    // entries, so deleting `plane` from the id left every fixture distinct and all four tests green —
    // three of nine dimensions were unproven by a test whose whole claim was per-dimension injectivity.
    plane: { plane: 'ga4_telemetry' },
    system: { system: 'ga4' },
    role: { role: 'measurement_qa' },
    lane: { lane: 'measured' },
    start: { start: '2026-07-01' },
    end: { end: '2026-08-19' },
    availability: { availability: 'unavailable' },
  }

  it('enumerates every override dimension (a new one added without an entry here fails)', () => {
    // Totality read from the SOURCE, not from a list retyped here. A hand-maintained roster of what
    // to cover is the exact shape that let a supply scanner see 2 of 14 claims and report success:
    // the roster agreed with itself. `ClaimOverrides` is the contract, so parse it.
    const source = readFileSync(join(process.cwd(), 'tests/fixtures/brief-defects.ts'), 'utf8')
    const block = /type ClaimOverrides = \{([\s\S]*?)\n\}/.exec(source)
    expect(block).not.toBeNull()
    const accepted = [...block![1].matchAll(/^\s*([a-z_]+)\??:/gm)].map((m) => m[1]).sort()
    expect(accepted.length).toBeGreaterThan(5)
    expect(Object.keys(ALTERNATIVE).sort()).toEqual(accepted)
  })

  it.each(Object.keys(ALTERNATIVE))('changing %s changes the claim id', (dimension) => {
    const base = citation()
    const varied = citation(ALTERNATIVE[dimension] as Parameters<typeof citation>[0])
    expect(varied).not.toBe(base)
  })

  it('every distinct citation resolves to a claim whose own id matches the citation', () => {
    const claims = fixtureClaims()
    const mismatched = [...new Set(cited)]
      .map((id) => ({ id, claim: claims.get(id) }))
      .filter(({ id, claim }) => claim !== undefined && claim.claimId !== id)
      .map(({ id }) => id)
    expect(mismatched).toEqual([])
  })
})
