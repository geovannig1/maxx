import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { postinstallMessage } from '../scripts/postinstall.mjs'

// `npm install` prints the next step only. Silent in CI and without a TTY; never prompts; never
// fails the install.

const ROOT = path.resolve(__dirname, '..')

describe('postinstall message', () => {
  it('names the next steps on an interactive terminal', () => {
    const message = postinstallMessage({}, true) as string
    expect(message).toContain('npm run setup')
    expect(message).toContain('npm run demo')
  })

  it('is silent in CI and without a TTY', () => {
    expect(postinstallMessage({ CI: '1' }, true)).toBeNull()
    expect(postinstallMessage({}, false)).toBeNull()
  })

  it('the script exits 0, prints nothing without a TTY, and reads no input', () => {
    const run = spawnSync(process.execPath, ['scripts/postinstall.mjs'], { cwd: ROOT, encoding: 'utf8', input: '', env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
  })

  it('package.json runs it as postinstall and it imports nothing (works without devDependencies)', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall.mjs')
    expect(readFileSync(path.join(ROOT, 'scripts/postinstall.mjs'), 'utf8')).not.toMatch(/^import /m)
  })
})
