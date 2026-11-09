import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// no checkout leaves the job token in .git/config (persist-credentials: false), every action is
// pinned to a full commit SHA, CodeQL is on v4, and CI runs the sample-data demo check in a browser.

const DIR = join(process.cwd(), '.github/workflows')
const files = readdirSync(DIR).filter((name) => name.endsWith('.yml'))
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')

/** The step block starting at a `- uses:` line, up to the next step or job. */
function stepBlocks(source: string, action: string): string[] {
  const lines = source.split('\n')
  return lines.flatMap((line, index) => {
    if (!line.trim().startsWith(`- uses: ${action}@`)) return []
    const indent = line.indexOf('-')
    const rest = lines.slice(index + 1)
    const end = rest.findIndex((next) => next.trim() !== '' && next.search(/\S/) <= indent)
    return [[line, ...(end === -1 ? rest : rest.slice(0, end))].join('\n')]
  })
}

describe('workflow hardening', () => {
  it('finds the workflows and their checkouts (guards against checking nothing)', () => {
    expect(files.sort()).toEqual(['ci.yml', 'codeql.yml', 'security.yml'])
    expect(files.flatMap((name) => stepBlocks(read(name), 'actions/checkout')).length).toBeGreaterThanOrEqual(6)
  })

  it.each(files)('%s: every checkout sets persist-credentials: false', (name) => {
    for (const block of stepBlocks(read(name), 'actions/checkout')) expect(block).toMatch(/^\s+persist-credentials: false$/m)
  })

  it.each(files)('%s: every action is pinned to a 40-character commit SHA', (name) => {
    const uses = [...read(name).matchAll(/uses: ([^\s@]+)@(\S+)/g)]
    for (const [, action, ref] of uses) expect(ref, action).toMatch(/^[0-9a-f]{40}$/)
  })

  it('CodeQL runs v4 and CI runs the demo check with a browser installed', () => {
    expect(read('codeql.yml')).toMatch(/codeql-action\/init@[0-9a-f]{40} # v4\./)
    const ci = read('ci.yml')
    expect(ci).toMatch(/run: npx playwright install --with-deps chromium/)
    expect(ci).toMatch(/run: npm run demo:check/)
  })

  it('the detector rejects a checkout without the setting (control)', () => {
    const bad = 'steps:\n      - uses: actions/checkout@abc\n        with:\n          fetch-depth: 0\n      - run: x\n'
    expect(stepBlocks(bad, 'actions/checkout')[0]).not.toMatch(/persist-credentials: false/)
  })
})
