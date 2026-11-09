import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Workflow files must stay VALID, because an invalid one does not fail — it silently runs nothing.
 *
 * `.github/workflows/ci.yml` referenced `${{ runner.temp }}` from a job-level `env:` block. The `runner`
 * context is not available there, so GitHub rejected the whole workflow at validation time: every run in
 * this repository's history, on PRs and on main alike, ended after 0 seconds with "this run likely failed
 * because of a workflow file issue" and NO job executed. A red X would have been noticed; zero checks was
 * not. The cockpit ship and everything before it merged with no gate at all, and by the time CI first ran
 * for real it surfaced a production outage plus broken integration proofs that had accumulated behind it.
 *
 * A CI job cannot catch this class of error, because a workflow too invalid to parse never starts the job
 * that would check it. So this runs in the unit suite, locally and in `npm run gate`, before a push.
 *
 * The durable second half of the fix is branch protection requiring the `verify` and `database-integration`
 * checks by name: a workflow that fails to start produces MISSING checks, and required-but-missing blocks a
 * merge. That is a repository setting, not something this file can assert.
 */

const WORKFLOW_DIR = join(process.cwd(), '.github/workflows')

/** Contexts GitHub does not expose to `jobs.<id>.env` (or to any job-level key evaluated before a runner
 *  exists). Each has an environment-variable form usable inside a step — `runner.temp` is `$RUNNER_TEMP`. */
const CONTEXTS_UNAVAILABLE_AT_JOB_LEVEL = ['runner', 'steps', 'job', 'env', 'hashFiles']

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
}

/** The job-level `env:` block of each job: from a line indented 4 spaces reading `env:` up to the next
 *  key at the same indent. Deliberately textual — the point is to check the file as GitHub parses it,
 *  without a YAML library silently normalising away the thing being tested. */
function jobLevelEnvBlocks(source: string): { job: string; body: string }[] {
  const lines = source.split('\n')
  const blocks: { job: string; body: string }[] = []
  let job = '<unknown>'
  for (let i = 0; i < lines.length; i += 1) {
    const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i])
    if (jobHeader) job = jobHeader[1]
    if (!/^ {4}env:\s*$/.test(lines[i])) continue
    const body: string[] = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '') { body.push(line); continue }
      const indent = line.length - line.trimStart().length
      if (indent <= 4) break
      body.push(line)
    }
    blocks.push({ job, body: body.join('\n') })
  }
  return blocks
}

describe('GitHub workflow files are valid enough to actually run', () => {
  const files = workflowFiles()

  it('finds the workflow files (guards this test against silently checking nothing)', () => {
    expect(files).toContain('ci.yml')
  })

  it.each(files)('%s: no job-level env: reads a context GitHub does not provide there', (file) => {
    const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
    const offences: string[] = []
    for (const { job, body } of jobLevelEnvBlocks(source)) {
      for (const context of CONTEXTS_UNAVAILABLE_AT_JOB_LEVEL) {
        // ${{ runner.temp }} — with or without inner spacing.
        if (new RegExp(String.raw`\$\{\{[^}]*\b${context}\.`).test(body)) {
          offences.push(`${file} job "${job}": job-level env: references the ${context} context`)
        }
      }
    }
    expect(offences).toEqual([])
  })

  it.each(files)('%s: every job the gate depends on is actually defined', (file) => {
    const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
    const defined = new Set([...source.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]))
    const needed = [...source.matchAll(/^\s*needs:\s*\[([^\]]*)\]/gm)]
      .flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean))
    for (const job of needed) expect(defined.has(job)).toBe(true)
  })
})
