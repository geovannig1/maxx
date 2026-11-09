import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `npm run lint` must cap warnings, or the gate emits signals and swallows them.
 *
 * `scoreBrief` shipped with a REQUIRED `claims` parameter that nothing read. eslint reported
 * `'claims' is defined but never used`, the lint step exited 0 because the script was bare `eslint`,
 * and the gate printed a green tick over a parameter that was pure ceremony. A warning nobody can
 * fail on is a comment.
 *
 * The cap is a RATCHET, not zero. Fifteen warnings pre-date this and are unrelated (deliberately
 * underscore-prefixed parameters, stale eslint-disable directives); fixing them is somebody else's
 * change. What the ratchet buys is that the count cannot GROW — a new warning fails the build on the
 * PR that introduces it. Lower the number whenever the debt is genuinely paid down.
 *
 * The number is 15 and not 11 because bare `eslint` lints a WIDER scope than `eslint src tests
 * scripts`. A cap set from the narrower count fails the build immediately — which is how this one was
 * corrected: by running `npm run lint`, not by counting.
 */

const PACKAGE = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('the lint step cannot swallow a new warning', () => {
  it('caps warnings', () => {
    expect(PACKAGE.scripts.lint).toMatch(/--max-warnings\s+\d+/)
  })

  it('caps them at a number that only ever ratchets down', () => {
    const cap = Number(/--max-warnings\s+(\d+)/.exec(PACKAGE.scripts.lint)![1])
    // If this fails because the cap was RAISED, the change under review added warnings — fix those
    // instead of raising the ceiling.
    expect(cap).toBeLessThanOrEqual(15)
  })
})
