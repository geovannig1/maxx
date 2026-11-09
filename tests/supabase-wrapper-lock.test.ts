import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local Supabase wrapper serialization', () => {
  it('refuses a second invocation while a live process owns the workspace lock', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'maxx-sb-lock-'))
    tempRoots.push(root)
    const lock = path.join(root, 'lock')
    mkdirSync(lock)
    writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`, 'utf8')

    const result = spawnSync('scripts/sb.sh', ['status'], {
      cwd: process.cwd(),
      env: { ...process.env, MAXX_SUPABASE_LOCK_DIR: lock },
      encoding: 'utf8',
      timeout: 10_000,
    })

    expect(result.status).toBe(75)
    expect(result.stderr).toMatch(/already using the local Supabase workspace/i)
  })
})
