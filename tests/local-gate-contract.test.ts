import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The local gate must stay equal to CI independently of server-side GitHub configuration.
 *
 * This repository is private and on GitHub Pro, which makes branch protection available but does
 * not configure it automatically. Without a required-check rule, a check that never reports does
 * not block a merge.
 *
 * So scripts/gate-local.sh is the enforcement that survives, and its value depends entirely on it
 * running what CI runs. Nothing stops someone adding a step to ci.yml and not to the gate; the gate
 * would still print GATE PASSED, which is the same shape of lie as a workflow too invalid to start.
 * This test makes that drift a failing test instead of a silent hole.
 *
 * It is textual on purpose. A YAML library would normalise the file into something other than what
 * GitHub reads, and the whole point is to compare the two things as they are actually written.
 */

const ROOT = process.cwd()
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const GATE = readFileSync(join(ROOT, 'scripts/gate-local.sh'), 'utf8')

/**
 * The exact command of every `step '<label>' <command>` line in the gate.
 *
 * This must be an exact-match set, not a substring search of the file. The first version of this test
 * asserted `GATE.toContain('npm run test:db')` and could not fail: `npm run test:db:integration` is
 * also in the file and contains that string, so deleting the PGlite step entirely still passed. The
 * test was verified by deliberately removing a step and watching it stay green — which is the only
 * reason the bug was found rather than shipped as a gate that proves nothing.
 */
function gateStepCommands(): string[] {
  return [...GATE.matchAll(/^\s*step\s+'[^']*'\s+(.+?)\s*$/gm)].map((m) => m[1])
}

/** Every `run:` command in one job of ci.yml, single-line form only. */
function jobRunCommands(job: string): string[] {
  const start = CI.indexOf(`\n  ${job}:\n`)
  if (start === -1) throw new Error(`job ${job} not found in ci.yml`)
  const rest = CI.slice(start + 1)
  // The next line indented exactly two spaces ends this job.
  const endMatch = /\n {2}[A-Za-z0-9_-]+:\n/.exec(rest.slice(1))
  const body = endMatch ? rest.slice(0, endMatch.index + 1) : rest
  return [...body.matchAll(/^ +run: (?!\|)(.+)$/gm)].map((m) => m[1].trim())
}

/**
 * Commands that legitimately differ between the runner and a developer's machine. Each needs a
 * reason: an unexplained entry here is how a real gap gets waved through.
 */
const EXEMPT = new Map<string, string>([
  ['npm ci', 'the runner starts from an empty checkout; a developer already has node_modules'],
  ['supabase start', 'the gate calls scripts/sb.sh start, which wraps the CLI to avoid .env.local'],
  ['supabase stop', 'the gate leaves the local stack up on purpose — it is the developer database'],
])

describe('the local gate runs what CI runs', () => {
  it('reads both files (guards this test against silently comparing nothing)', () => {
    expect(jobRunCommands('verify').length).toBeGreaterThan(4)
    expect(gateStepCommands().length).toBeGreaterThan(4)
  })

  it.each(jobRunCommands('verify'))(
    'verify step `%s` is covered by the gate static tier',
    (command) => {
      if (EXEMPT.has(command)) return
      expect(gateStepCommands()).toContain(command)
    },
  )

  it.each(jobRunCommands('database-integration'))(
    'database-integration step `%s` is covered by the gate full tier',
    (command) => {
      if (EXEMPT.has(command)) return
      expect(gateStepCommands()).toContain(command)
    },
  )

  it('keeps the exemption list honest: every entry is still a command CI actually runs', () => {
    const all = new Set([...jobRunCommands('verify'), ...jobRunCommands('database-integration')])
    for (const command of EXEMPT.keys()) expect(all.has(command)).toBe(true)
  })
})

describe('the gate is exposed through package.json', () => {
  it('is discoverable without reading this file', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
    expect(scripts.typecheck).toBe('tsc --noEmit')
    expect(scripts.gate).toContain('gate-local.sh')
    expect(scripts['gate:full']).toContain('full')
  })
})

describe('CI does not bill for runs nobody is waiting on', () => {
  it('cancels superseded pull-request runs', () => {
    // Exhausting the allowance is not a billing inconvenience; it is how the gate went dark.
    expect(CI).toMatch(/^concurrency:$/m)
    expect(CI).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
  })
})
