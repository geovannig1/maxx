// Loopback-only authentication fixture. Never a real Supabase credential or production session.
export const fixtureUser = { id: '00000000-0000-4000-8000-000000000001', email: 'reporting-test@example.test',
  aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z',
  // The owner gate (src/lib/auth/owner.ts) admits only a confirmed email.
  email_confirmed_at: '2026-01-01T00:00:00Z' }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
export const fixtureToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: fixtureUser.id, aud: 'authenticated', role: 'authenticated', exp: 4102444800 })}.local-test-signature`
export const fixtureCookie = `base64-${encode({ access_token: fixtureToken, refresh_token: 'local-test-refresh', expires_at: 4102444800, expires_in: 86400, token_type: 'bearer', user: fixtureUser })}`
