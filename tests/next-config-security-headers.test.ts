import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The console approves live ad-account changes, so it must never be framed and the baseline hardening
 * headers must not regress. The CSP itself moved to the proxy in the v1 release (per-request nonce): its
 * assertions now run against src/lib/security/csp.ts in tests/content-security-policy.test.ts.
 */
type Header = { key: string; value: string }

async function loadHeaders(env: Record<string, string | undefined>): Promise<Header[]> {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const resolved = (await import('../next.config')).default
  const rules = await resolved.headers!()
  const all = rules.find((rule: { source: string }) => rule.source === '/(.*)')
  expect(all).toBeDefined()
  return all!.headers as Header[]
}

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co',
  NEXT_PUBLIC_SENTRY_DSN: 'https://publickey@o123.ingest.us.sentry.io/456',
}

afterEach(() => { vi.unstubAllEnvs() })

describe('next.config security headers', () => {
  it('sends no Content-Security-Policy: src/proxy.ts sets the only one, with a per-request nonce', async () => {
    // Two CSP headers would both be enforced (the stricter of each), so a static copy here would
    // silently keep blocking or allowing what the nonce policy decides. The policy itself is asserted
    // in tests/content-security-policy.test.ts and its delivery in tests/proxy-csp.test.ts.
    const headers = await loadHeaders(ENV)
    expect(headers.map(h => h.key.toLowerCase())).not.toContain('content-security-policy')
    expect(headers.map(h => h.key.toLowerCase())).not.toContain('content-security-policy-report-only')
  })

  it('stops next dev from writing agent rules into the repository (no untracked AGENTS.md)', async () => {
    vi.resetModules()
    const resolved = (await import('../next.config')).default
    expect(resolved.agentRules).toBe(false)
  })

  it('keeps the existing hardening headers', async () => {
    const headers = await loadHeaders(ENV)
    const byKey = new Map(headers.map(h => [h.key, h.value]))
    expect(byKey.get('X-Frame-Options')).toBe('DENY')
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff')
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(byKey.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(byKey.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()')
    expect(byKey.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains')
  })

  // Sentry decides browser source-map generation from the active bundler; Next 16 builds with Turbopack.
  async function resolvedConfig(authToken: string) {
    vi.resetModules()
    vi.stubEnv('TURBOPACK', '1')
    vi.stubEnv('SENTRY_AUTH_TOKEN', authToken)
    return (await import('../next.config')).default
  }

  it('disables the x-powered-by header and generates no browser source maps without a Sentry upload token', async () => {
    const resolved = await resolvedConfig('')
    expect(resolved.poweredByHeader).toBe(false)
    expect(resolved.productionBrowserSourceMaps).not.toBe(true)
  })

  it('control: with an upload token Sentry generates browser maps for upload (then deletes them)', async () => {
    const resolved = await resolvedConfig('test-token-not-a-secret')
    expect(resolved.productionBrowserSourceMaps).toBe(true)
  })

  it('allows no remote images, so /_next/image is not a public proxy', async () => {
    vi.resetModules()
    const config = (await import('../next.config')).default
    expect(config.images?.remotePatterns ?? []).toEqual([])
    expect(config.images?.domains ?? []).toEqual([])
  })
})
