import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// `npm run mutate:check` (mutate.mjs --self-test) mutates two source files and restores them from
// git, which discards uncommitted work. It must refuse a dirty tree for those files. The fixture is a
// throwaway repository in the OS temp directory, never this checkout.

const SCRIPT = join(process.cwd(), 'scripts/mutate.mjs')
let fixture: string | null = null
afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = null
})

describe('mutate self-test on a dirty tree', () => {
  it('refuses before touching an uncommitted file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutate-self-test-'))
    fixture = dir
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init', '-q')
    mkdirSync(join(dir, 'src/lib/maxx'), { recursive: true })
    mkdirSync(join(dir, 'src/lib/cockpit'), { recursive: true })
    writeFileSync(join(dir, 'src/lib/maxx/chat.ts'), 'export const committed = 1\n')
    writeFileSync(join(dir, 'src/lib/cockpit/comparison-window.ts'), 'export const committed = 2\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'fixture')
    const unsaved = 'export const committed = 1\nexport const UNCOMMITTED_WORK = true\n'
    writeFileSync(join(dir, 'src/lib/maxx/chat.ts'), unsaved)

    const run = spawnSync(process.execPath, [SCRIPT, '--self-test'], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/Refusing to mutate files with uncommitted changes/)
    expect(readFileSync(join(dir, 'src/lib/maxx/chat.ts'), 'utf8')).toBe(unsaved)
  })
})
