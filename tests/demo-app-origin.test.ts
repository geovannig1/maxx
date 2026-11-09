import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoAppEnv } from '../scripts/demo/start'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

// `npm run demo` serves the app through a gateway on another port. The browser's Origin is the
// gateway's, while the app (next dev) sees its own port, so the same-origin check refused every
// browser mutation in the demo: scoring copy, proposing and approving a change, drafting a plan.
// The launcher states the browser-facing origin as APP_URL, exactly as a self-hosted deployment does.

const GATEWAY = 'http://127.0.0.1:4800'
const BACKEND = 'http://127.0.0.1:4802'
const ENV = {} as NodeJS.ProcessEnv

function post(appUrl: string, headers: Record<string, string>): Request {
  return new Request(`${appUrl}/api/creative/copy/score`, { method: 'POST', headers })
}

describe('demo app origin', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('sets APP_URL to the gateway origin the browser uses', () => {
    expect(demoAppEnv(ENV, BACKEND, GATEWAY).APP_URL).toBe(GATEWAY)
  })

  it('never inherits an APP_URL from the shell', () => {
    expect(demoAppEnv({ APP_URL: 'https://maxx.example.com' } as unknown as NodeJS.ProcessEnv, BACKEND, GATEWAY).APP_URL).toBe(GATEWAY)
  })

  describe('with the demo app environment', () => {
    const useDemoEnv = () => {
      const env = demoAppEnv(ENV, BACKEND, GATEWAY)
      for (const name of ['APP_URL', 'NODE_ENV', 'VERCEL', 'VERCEL_ENV'] as const) vi.stubEnv(name, env[name] ?? '')
    }
    // next dev behind the gateway: request.url names the app's own port, never the gateway's.
    const APP = 'http://localhost:4801'

    it('accepts a same-origin browser mutation from a page on the gateway', () => {
      useDemoEnv()
      expect(rejectCrossOriginMutation(post(APP, { origin: GATEWAY, 'sec-fetch-site': 'same-origin' }))).toBeNull()
    })

    it.each([
      ['a cross-site page', { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }],
      ['a foreign Origin without Sec-Fetch-Site', { origin: 'https://attacker.example' }],
      ['a sibling on the same site', { origin: 'http://127.0.0.1:4899', 'sec-fetch-site': 'same-site' }],
      ['another loopback port', { origin: 'http://127.0.0.1:4899' }],
    ])('still refuses %s', (_label, headers) => {
      useDemoEnv()
      expect(rejectCrossOriginMutation(post(APP, headers))?.status).toBe(403)
    })
  })
})
