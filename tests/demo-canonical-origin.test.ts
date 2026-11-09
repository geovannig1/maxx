import { describe, expect, it } from 'vitest'
import { canonicalOriginReply } from '../scripts/demo/canonical-origin'

// The demo app's same-origin check compares a mutation's Origin with APP_URL = http://127.0.0.1:<port>.
// A browser that opened http://localhost:<port> instead got a page whose every mutation the app refused
// (403 cross-origin). The gateway now sends any other host name to the one canonical origin, without
// loosening the app's same-origin rule.

const PORT = 4920

describe('demo gateway canonical origin', () => {
  it('lets the canonical host through untouched', () => {
    expect(canonicalOriginReply({ method: 'GET', url: '/dashboard', host: `127.0.0.1:${PORT}` }, PORT)).toBeNull()
    expect(canonicalOriginReply({ method: 'POST', url: '/api/changes', host: `127.0.0.1:${PORT}` }, PORT)).toBeNull()
  })

  it('redirects a page opened at localhost to the same path on 127.0.0.1', () => {
    const reply = canonicalOriginReply({ method: 'GET', url: '/campaigns/new?x=1', host: `localhost:${PORT}` }, PORT)
    expect(reply?.status).toBe(307)
    expect(reply?.headers.Location).toBe(`http://127.0.0.1:${PORT}/campaigns/new?x=1`)
    expect(canonicalOriginReply({ method: 'HEAD', url: '/', host: `LOCALHOST:${PORT}` }, PORT)?.status).toBe(307)
  })

  it('refuses a mutation sent to another host name instead of redirecting it', () => {
    const reply = canonicalOriginReply({ method: 'POST', url: '/api/changes', host: `localhost:${PORT}` }, PORT)
    expect(reply?.status).toBe(421)
    expect(reply?.body).toContain(`http://127.0.0.1:${PORT}`)
    expect(reply?.headers.Location).toBeUndefined()
  })

  it('treats a missing, foreign or wrong-port host as non-canonical (control: never a pass-through)', () => {
    for (const host of [undefined, 'attacker.example', `127.0.0.1:${PORT + 1}`, '127.0.0.1', `[::1]:${PORT}`]) {
      expect(canonicalOriginReply({ method: 'GET', url: '/', host }, PORT)?.status).toBe(307)
    }
  })

  it('never builds a redirect from a request target that is not a path', () => {
    const reply = canonicalOriginReply({ method: 'GET', url: '//attacker.example/x', host: `localhost:${PORT}` }, PORT)
    expect(reply?.headers.Location).toBe(`http://127.0.0.1:${PORT}/`)
  })
})
