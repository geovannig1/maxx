import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * The app↔database RPC name contract.
 *
 * A pre-squash migration declared a publisher named
 *   replace_recommendation_generation_with_metric_claims_and_decisions  (66 chars)
 * Postgres caps identifiers at NAMEDATALEN-1 = 63 bytes, so it was created truncated, with only a
 * NOTICE. Nothing caught it: every SQL-text check (`verify:replay`, the PGlite
 * RPC suite) passed, because the Postgres *parser* truncates an over-long identifier exactly the same
 * way it did at CREATE time — so those checks were comparing a truncated name against a truncated name.
 *
 * PostgREST does not truncate. `supabase.rpc('<66-char name>')` is a string lookup against the schema
 * cache, and it 404s (PGRST202). The result was a silent production outage: the flag stage committed
 * and the recommendation stage failed on every sync.
 *
 * These checks are deliberately static (no database, no network) so they run in the `verify` job and
 * fail on the PR that introduces the name, not days later in production.
 */

const ROOT = process.cwd()
const PG_MAX_IDENTIFIER_BYTES = 63

/** Every distinct name passed to `.rpc('…')` anywhere under src/. */
function calledRpcNames(): string[] {
  // `git grep` keeps this to tracked sources and out of build output; -h drops filenames, -o the match.
  const out = execFileSync('git', ['grep', '-hoE', String.raw`\.rpc\('[a-zA-Z0-9_]+'`, '--', 'src'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const names = out
    .split('\n')
    .map((line) => line.trim().replace(/^\.rpc\('/, '').replace(/'$/, ''))
    .filter(Boolean)
  return [...new Set(names)].sort()
}

/** Every function name DECLARED by a migration, as written in the file (before any truncation). */
function declaredFunctionNames(): Map<string, string> {
  const dir = join(ROOT, 'supabase/migrations')
  const declared = new Map<string, string>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, file), 'utf8')
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/gi)) {
      declared.set(m[1], file)
    }
    // A rename introduces a name no CREATE statement mentions.
    for (const m of sql.matchAll(/RENAME\s+TO\s+([a-zA-Z0-9_]+)/gi)) declared.set(m[1], file)
  }
  return declared
}

describe('app↔database RPC name contract', () => {
  const called = calledRpcNames()
  const declared = declaredFunctionNames()

  it('finds the RPC call sites at all (guards this test against silently matching nothing)', () => {
    expect(called.length).toBeGreaterThan(10)
    expect(called).toContain('replace_flag_generation')
  })

  it.each(called)('%s is short enough that Postgres will not truncate it', (name) => {
    // Byte length, not code units: NAMEDATALEN is a byte budget.
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(PG_MAX_IDENTIFIER_BYTES)
  })

  it.each(called)('%s is declared by a migration under the exact name the app calls', (name) => {
    expect(declared.has(name)).toBe(true)
  })

  // Two pre-squash migrations once declared the 66-char replace_recommendation_generation_with_metric_claims_and_decisions,
  // grandfathered here while those files were applied history. The squashed baseline no longer declares it,
  // so (as this guard always required) the exemption went with it: no over-long name is allowed at all.
  it('declares no function name that Postgres would truncate on creation', () => {
    const overlong = [...declared.entries()]
      .filter(([name]) => Buffer.byteLength(name, 'utf8') > PG_MAX_IDENTIFIER_BYTES)
      .map(([name, file]) => `${file}: ${name} (${Buffer.byteLength(name, 'utf8')} bytes)`)
    expect(overlong).toEqual([])
  })
})
