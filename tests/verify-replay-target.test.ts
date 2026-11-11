import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// scripts/verify-replay.sh resets the stack that supabase/config.toml names, then verifies through
// SB_DB_URL. If the two name different databases, the reset and the checks look at different things.
// `--check-target` runs only the target guards, so these cases never touch a database.
const configPort = /\[db\][^[]*?\nport\s*=\s*(\d+)/.exec(readFileSync('supabase/config.toml', 'utf8'))![1]

function guard(url: string | undefined) {
  const env = { ...process.env }
  if (url === undefined) delete env.SB_DB_URL
  else env.SB_DB_URL = url
  return spawnSync('scripts/verify-replay.sh', ['--check-target'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 })
}

describe('verify-replay target guard', () => {
  it('accepts the default URL, which points at the configured local database port', () => {
    const result = guard(undefined)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`port ${configPort}`)
  })

  it('accepts an explicit loopback URL on the configured port', () => {
    expect(guard(`postgresql://postgres:postgres@localhost:${configPort}/postgres`).status).toBe(0)
  })

  it.each([
    ['a different local port', 'postgresql://postgres:postgres@127.0.0.1:5432/postgres'],
    ['no port (Postgres default 5432)', 'postgresql://postgres:postgres@127.0.0.1/postgres'],
    ['the shadow database port', 'postgresql://postgres:postgres@127.0.0.1:54320/postgres'],
  ])('refuses %s', (_label, url) => {
    const result = guard(url)
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(new RegExp(`REFUSING: .*port ${configPort}`))
  })

  it('still refuses a non-loopback host before comparing ports', () => {
    const result = guard(`postgresql://postgres:postgres@db.example.com:${configPort}/postgres`)
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/not loopback/)
  })
})
