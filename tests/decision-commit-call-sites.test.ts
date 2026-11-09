import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * The SHIPPED wiring, not a call this test constructs.
 *
 * `matured`, `continuity` and `windows_conflict` were hardcoded `null` on every published decision.
 * The fix made `evidence` a required parameter on `recommendationDecisionCommit` and passed
 * `cohortAuthority.evidence` at the one production call site. Unit tests then proved each field is
 * persisted — by building their own argument object and calling the function directly.
 *
 * Mutation testing found the hole: change `src/lib/recommendations/generate.ts` to pass
 * `evidence: undefined` and THE WHOLE SUITE PASSED. TypeScript forces *a* value because the property is
 * required; it cannot force the *right* one. Production could revert to all-nulls with a green suite.
 *
 * That is this author's documented failure mode stated exactly: test the artifact you wrote, using
 * inputs you wrote, and never execute the shipped configuration. So this file reads the shipped
 * configuration. It is deliberately a source assertion rather than a mock-heavy integration test —
 * the thing that broke was a single argument at a single call site, and that is what it checks.
 */

const ROOT = process.cwd()

/** Every `recommendationDecisionCommit(` call site under src/, from git rather than a glob. */
function productionCallSites(): string[] {
  // The IDENTIFIER, not `name({`. The formatting-specific pattern made this test wrong in both
  // directions: a second call site written across lines was invisible while `toHaveLength(1)` still
  // passed, and a prettier-style reformat of the existing one made `git grep` exit 1, throwing at
  // module load and failing the whole file on a semantics-preserving change.
  const out = execFileSync('git', ['grep', '-nE', String.raw`recommendationDecisionCommit\s*\(`, '--', 'src'], {
    cwd: ROOT, encoding: 'utf8',
  })
  return out
    .split('\n')
    .filter(Boolean)
    // The declaration is not a call site.
    .filter((line) => !/\bexport function\b|\bfunction recommendationDecisionCommit\b/.test(line))
}

/** The argument object of the CALL — anchored on `name(`, since the import mentions the name first. */
function commitArgs(source: string): string {
  const call = /recommendationDecisionCommit\s*\(/.exec(source)
  if (!call) throw new Error('no recommendationDecisionCommit call found')
  const open = source.indexOf('{', call.index)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced argument object')
}

describe('the production decision-commit call site passes real evidence', () => {
  const source = readFileSync(`${ROOT}/src/lib/recommendations/generate.ts`, 'utf8')

  it('finds the call site at all (guards this test against checking nothing)', () => {
    expect(productionCallSites().length).toBeGreaterThan(0)
    expect(productionCallSites().join('\n')).toContain('src/lib/recommendations/generate.ts')
  })

  it('has exactly one production call site, so this file cannot silently cover a subset', () => {
    // Matches the identifier, not a formatting-specific `name({` — a second publisher written across
    // lines was invisible to the previous pattern while `toHaveLength(1)` still passed.
    const calls = [...source.matchAll(/recommendationDecisionCommit\s*\(/g)]
    expect(calls).toHaveLength(1)  // the import mentions the name without a paren, so it is excluded
    expect(productionCallSites()).toHaveLength(1)
  })

  it('passes the SAME evidence object the authority decision was taken on', () => {
    // Extract the FULL argument object by brace matching rather than by a lazy regex with a
    // hard-coded indentation depth. The old pattern required a trailing comma and an exact `\n      })`,
    // so it broke on a prettier reformat and could read a later `evidence:` from elsewhere in the file.
    const args = commitArgs(source)

    // EVERY `evidence:` inside the argument object, so a later spread or duplicate key — which wins at
    // runtime — cannot hide behind an earlier correct one. That mutation survived the first version.
    const assigned = [...args.matchAll(/evidence:\s*([\w.]+)/g)].map((m) => m[1])
    expect(assigned.length).toBeGreaterThan(0)
    expect(new Set(assigned).size).toBe(1)
    expect(args).not.toMatch(/\.\.\./)

    const decision = /decideRecommendationAuthority\(\{[\s\S]*?evidence:\s*([\w.]+)/.exec(source)
    expect(decision).not.toBeNull()
    expect(assigned[0]).toBe(decision![1])
  })

  it('never passes a literal undefined or null from production code', () => {
    const args = commitArgs(source)
    expect(args).toMatch(/evidence:/)
    expect(args).not.toMatch(/evidence:\s*(undefined|null)/)
  })
})

describe('the eval supplies G6 with the decision ids it must resolve against', () => {
  // `scoreBrief`'s fourth argument defaults to null, and null means "count only". A resolution the
  // shipped caller never supplies is a guard that exists solely in the unit tests — the same shape as
  // the production call site found passing `evidence: undefined` with a fully green suite.
  const source = readFileSync(`${ROOT}/scripts/eval-maxx.ts`, 'utf8')

  it('passes a decision-id set to scoreBrief, not the two-argument form', () => {
    const call = /scoreBrief\(([^)]*)\)/.exec(source)
    expect(call).not.toBeNull()
    const args = call![1].split(',').map((a) => a.trim())
    expect(args.length).toBeGreaterThanOrEqual(4)
    expect(args[3]).not.toBe('null')
    expect(args[3]).not.toBe('undefined')
  })

  it('derives that set from what the governed tools actually returned', () => {
    // Not an invented set: it must come from the chat result, or G6 would resolve against something
    // the model could not have been shown.
    expect(source).toMatch(/new Set\(res\.actionDecisions\.keys\(\)\)/)
  })
})
