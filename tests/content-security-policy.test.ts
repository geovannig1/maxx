import { describe, expect, it } from 'vitest'
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header'
import {
  API_CONTENT_SECURITY_POLICY, createNonce, pageContentSecurityPolicy, type CspSourceEnv,
} from '@/lib/security/csp'

/**
 * the CSP moved from next.config.ts headers into one builder that src/proxy.ts calls per request
 * with a fresh nonce. The console approves live ad-account changes and renders untrusted model/feed
 * content, so this policy is a real control: scripts run only with this request's nonce (no
 * 'unsafe-inline' for scripts), images may load only from enumerated origins (no `*`, no blanket
 * `https:`), plugins are off and framing is refused. These are the assertions that used to run against
 * next.config.ts (tests/next-config-security-headers.test.ts), now against the builder, plus the nonce.
 */

function directives(csp: string): Map<string, string[]> {
  return new Map(csp.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const [name, ...sources] = part.split(/\s+/)
    return [name, sources] as [string, string[]]
  }))
}

const ENV: CspSourceEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co',
  NEXT_PUBLIC_SENTRY_DSN: 'https://publickey@o123.ingest.us.sentry.io/456',
}
const NONCE = 'bm9uY2UtZml4dHVyZS0wMDE='

const production = (env: CspSourceEnv = ENV) => directives(pageContentSecurityPolicy({ nonce: NONCE, isDev: false, env }))
const development = (env: CspSourceEnv = ENV) => directives(pageContentSecurityPolicy({ nonce: NONCE, isDev: true, env }))

describe('page Content-Security-Policy (moved from next.config.ts)', () => {
  it('sets an enumerated CSP with no wildcard image source', () => {
    const d = production()

    expect(d.get('default-src')).toEqual(["'self'"])
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'self'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('font-src')).toEqual(["'self'"])

    const img = d.get('img-src') ?? []
    expect(img).toContain("'self'")
    expect(img).toEqual(expect.arrayContaining(['blob:', 'data:', 'https://*.fbcdn.net', 'https://*.fbsbx.com', 'https://*.cdninstagram.com']))
    expect(img).not.toContain('*')
    expect(img).not.toContain('https:')
    expect(img).not.toContain('http:')

    expect(d.get('media-src')).toEqual(["'self'", 'blob:', 'https://*.fbcdn.net'])

    const connect = d.get('connect-src') ?? []
    expect(connect).toContain('https://abcdefgh.supabase.co')
    expect(connect).toContain('https://o123.ingest.us.sentry.io')
    expect(connect).not.toContain('*')
    expect(connect).not.toContain('https:')
  })

  it('omits unset origins instead of emitting an empty or wildcard source', () => {
    const connect = production({ NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co', NEXT_PUBLIC_SENTRY_DSN: '' }).get('connect-src') ?? []
    expect(connect).toEqual(["'self'", 'https://abcdefgh.supabase.co'])
    expect(production({ NEXT_PUBLIC_SUPABASE_URL: 'javascript:alert(1)' }).get('connect-src')).toEqual(["'self'"])
  })

  it('production: scripts need this request\'s nonce; no inline or eval scripts', () => {
    const d = production()
    expect(d.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"])
    expect(d.get('script-src')).not.toContain("'unsafe-inline'")
    expect(d.get('script-src')).not.toContain("'unsafe-eval'")
    expect(d.has('upgrade-insecure-requests')).toBe(true)
    expect(pageContentSecurityPolicy({ nonce: NONCE, isDev: false, env: ENV })).not.toMatch(/127\.0\.0\.1|localhost/)
  })

  it('styles keep \'unsafe-inline\' (React style attributes) and carry no nonce, which would disable it', () => {
    const style = production().get('style-src') ?? []
    expect(style).toEqual(["'self'", "'unsafe-inline'"])
    expect(style.join(' ')).not.toContain('nonce-')
  })

  it('development adds only \'unsafe-eval\' (React dev tooling) and the loopback media origins, never inline scripts', () => {
    const d = development()
    expect(d.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'", "'unsafe-eval'"])
    expect(d.get('img-src')).toEqual(expect.arrayContaining(['http://127.0.0.1:*', 'https://127.0.0.1:*', 'http://localhost:*']))
    expect(d.get('media-src')).toEqual(expect.arrayContaining(['http://127.0.0.1:*']))
    expect(d.has('upgrade-insecure-requests')).toBe(false)
    // Everything else is the production policy.
    const p = production()
    for (const name of ['default-src', 'style-src', 'font-src', 'connect-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
      expect(d.get(name), name).toEqual(p.get(name))
    }
  })

  it('Next.js reads the nonce back out of the header it is given (the mechanism that stamps its scripts)', () => {
    const csp = pageContentSecurityPolicy({ nonce: NONCE, isDev: false, env: ENV })
    expect(getScriptNonceFromHeader(csp)).toBe(NONCE)
    // control: a policy without a script nonce yields none
    expect(getScriptNonceFromHeader("default-src 'self'; script-src 'self'")).toBeUndefined()
  })

  it('refuses a nonce that could break out of the header', () => {
    expect(() => pageContentSecurityPolicy({ nonce: "x'; script-src *", isDev: false, env: ENV })).toThrow()
    expect(() => pageContentSecurityPolicy({ nonce: '', isDev: false, env: ENV })).toThrow()
  })
})

describe('nonces', () => {
  it('are fresh, at least 128 bits, and in the form Next.js accepts', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createNonce()))
    expect(seen.size).toBe(200)
    for (const nonce of seen) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      expect(Buffer.from(nonce, 'base64').length).toBeGreaterThanOrEqual(16)
      expect(getScriptNonceFromHeader(pageContentSecurityPolicy({ nonce, isDev: false, env: {} }))).toBe(nonce)
    }
  })
})

describe('API Content-Security-Policy', () => {
  it('allows nothing to load or frame a JSON response', () => {
    const d = directives(API_CONTENT_SECURITY_POLICY)
    expect(d.get('default-src')).toEqual(["'none'"])
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
    expect(API_CONTENT_SECURITY_POLICY).not.toContain('nonce-')
  })
})
