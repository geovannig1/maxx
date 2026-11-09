import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// supabase/config.toml configures only the LOCAL stack. Its [auth.email] enable_signup is the
// email-provider switch (false made magic-link sign-in answer 422 email_provider_disabled), while
// global sign-ups stay off and confirmations stay on, matching what a hosted project must have.

const toml = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8')

function section(name: string): Record<string, string> {
  const lines = toml.split('\n')
  const start = lines.findIndex((line) => line.trim() === `[${name}]`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  const values: Record<string, string> = {}
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('[')) break
    const match = /^(\w+)\s*=\s*(.+)$/.exec(line.trim())
    if (match) values[match[1]] = match[2]
  }
  return values
}

describe('local Supabase auth configuration', () => {
  it('keeps global sign-ups off but the email provider on, with confirmations required', () => {
    expect(section('auth').enable_signup).toBe('false')
    expect(section('auth.email').enable_signup).toBe('true')
    expect(section('auth.email').enable_confirmations).toBe('true')
    expect(section('auth').enable_anonymous_sign_ins).toBe('false')
  })

  // The login page sends `${window.location.origin}/auth/callback?next=…` as the magic-link redirect.
  // Supabase Auth matches it against site_url and additional_redirect_urls; a URL that matches neither
  // falls back to site_url, so the owner lands on /login unsigned. An exact entry never matches because
  // of the query string, and http://127.0.0.1 is a different origin from http://localhost.
  it('allows the local magic-link redirect for both loopback origins, with a wildcard path', () => {
    const auth = section('auth')
    expect(auth.site_url).toBe('"http://localhost:3000"')
    const allowed = JSON.parse(auth.additional_redirect_urls) as string[]
    expect(allowed).toEqual(expect.arrayContaining(['http://localhost:3000/**', 'http://127.0.0.1:3000/**']))
  })

  it('says the auth settings are local-only and names the hosted requirements', () => {
    expect(toml).toMatch(/LOCAL DEVELOPMENT ONLY/)
    expect(toml).toMatch(/Confirm email" ON/)
  })
})
