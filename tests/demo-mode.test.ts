import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PGlite } from '@electric-sql/pglite'
import { ENV_VARS } from '@/config/env'
import { demoAppEnv } from '../scripts/demo/start'
import { startGateway } from '../scripts/demo/gateway'
import { handleRest } from '../scripts/demo/rest'
import { DEMO_ACCOUNT_ID, createSampleDb } from '../scripts/demo/sample-db'
import { DEMO_ACCESS, DEMO_USER, demoSessionCookie, startBackend } from '../scripts/demo/backend'
import { expandPacket } from '@/lib/reporting/packet-format'
import { demoCalendar } from '../scripts/demo/sample/demo-account'

// `npm run demo`. Loopback only; no service outside this process is contacted.

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)))
const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

describe('demo app environment', () => {
  it('blanks every schema variable from the parent environment, so a real .env.local is never used', () => {
    const real = Object.fromEntries(ENV_VARS.filter((s) => s.secret).map((s) => [s.name, `real-${s.name}-value`]))
    const env = demoAppEnv({ ...real, PATH: '/bin' } as unknown as NodeJS.ProcessEnv, 'http://127.0.0.1:3002', 'http://127.0.0.1:3000')
    for (const spec of ENV_VARS.filter((s) => s.secret)) expect(env[spec.name], spec.name).not.toBe(`real-${spec.name}-value`)
    expect(env).toMatchObject({ MAXX_DEMO: '1', AI_PROVIDER: 'none', META_ACCESS_TOKEN: '', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:3002', OWNER_EMAIL: DEMO_USER.email, NODE_ENV: 'development', VERCEL: '', VERCEL_ENV: '' })
    expect(env.PATH).toBe('/bin')
  })
})

describe('demo sample database and backend', () => {
  let db: PGlite
  let backend: Server
  let base: string
  beforeAll(async () => {
    db = await createSampleDb()
    backend = await startBackend(db, 0)
    base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`
  })
  afterAll(async () => { await close(backend); await db.close() })

  it('serves the seeded active account through the REST subset, filtered', async () => {
    const res = await handleRest(db, new Request(`${base}/rest/v1/ad_accounts?select=id,account_name&is_active=eq.true&limit=2`))
    expect(await res.json()).toEqual([{ id: DEMO_ACCOUNT_ID, account_name: 'Example Studio (sample)' }])
    const none = await handleRest(db, new Request(`${base}/rest/v1/ad_accounts?select=id&is_active=eq.false`))
    expect(await none.json()).toEqual([])
  })

  it('answers an unsupported query with an empty result, not an error', async () => {
    const res = await handleRest(db, new Request(`${base}/rest/v1/campaigns?select=id,ads(id)`))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-demo-unsupported')).toBeTruthy()
    expect(await res.json()).toEqual([])
  })

  it('accepts only the demo session token and reports locked-down auth settings', async () => {
    expect((await fetch(`${base}/auth/v1/user`, { headers: { Authorization: `Bearer ${DEMO_ACCESS}` } })).status).toBe(200)
    expect((await fetch(`${base}/auth/v1/user`, { headers: { Authorization: 'Bearer forged' } })).status).toBe(401)
    expect(await (await fetch(`${base}/auth/v1/settings`)).json()).toMatchObject({ disable_signup: true, mailer_autoconfirm: false })
  })
})

describe('demo gateway', () => {
  const calendar = demoCalendar(new Date('2026-11-08T15:00:00Z'))
  let app: Server
  let gateway: Server
  let base: string
  const seen: Array<{ url: string; cookie: string | undefined }> = []
  const cookie = demoSessionCookie('http://127.0.0.1:3002')
  beforeAll(async () => {
    app = createServer((req, res) => { seen.push({ url: req.url ?? '', cookie: req.headers.cookie }); res.end('APP') })
    const appPort = await listen(app)
    const probe = createServer()
    const port = await listen(probe)
    await close(probe)
    gateway = await startGateway({ port, appPort, sessionCookie: cookie, calendar })
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => { await close(gateway); await close(app) })

  it('opens the dashboard on the 28 days ending the day before the demo started, with the demo session', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard?from=2026-10-11&to=2026-11-07')
    expect(res.headers.get('set-cookie')).toContain('sb-127-auth-token=base64-')
  })

  it('serves sample reports for every section and refuses an unknown one', async () => {
    for (const section of ['meta', 'business', 'website', 'measurement']) {
      const body = await (await fetch(`${base}/api/reporting?section=${section}&from=2026-09-02&to=2026-09-04`)).json() as { section: string; notes: string[]; packetVersion?: number }
      expect(body.section).toBe(section)
      expect(body.notes[0]).toMatch(/^Sample data/)
      // The demo answers in the same packetVersion 2 form as the real API; it expands to the sample packet.
      expect(body.packetVersion).toBe(2)
      expect((expandPacket(body) as { section: string; notes: string[] }).notes).toEqual(body.notes)
    }
    expect((await fetch(`${base}/api/reporting?section=secrets`)).status).toBe(400)
  })

  it('is read-only except the demo-safe writes, and signs proxied requests in', async () => {
    expect((await fetch(`${base}/api/sync`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/creative/copy/generate`, { method: 'POST', body: '{}' })).status).toBe(405)
    expect((await fetch(`${base}/api/creative/copy/bank`, { method: 'POST', body: '{}' })).status).toBe(405)
    expect((await fetch(`${base}/api/creative/copy/score`, { method: 'POST', body: '{}' })).status).toBe(200)
    expect((await fetch(`${base}/api/outcomes/webhook-sources`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/setup/checks`, { method: 'POST', body: '{}' })).status).toBe(200)
    // ADR-059: proposing, reviewing and rolling back a change (applied by the simulated executor).
    const change = '00000000-0000-4000-8000-000000000c01'
    expect((await fetch(`${base}/api/changes`, { method: 'POST', body: '{}' })).status).toBe(200)
    expect((await fetch(`${base}/api/changes/${change}`, { method: 'PATCH', body: '{}' })).status).toBe(200)
    expect((await fetch(`${base}/api/changes/${change}/rollback`, { method: 'POST', body: '{}' })).status).toBe(200)
    // Controls: other methods and shapes on the same paths stay refused.
    expect((await fetch(`${base}/api/changes/${change}`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${base}/api/changes/not-a-uuid`, { method: 'PATCH', body: '{}' })).status).toBe(405)
    await fetch(`${base}/settings`)
    expect(seen.at(-1)?.cookie).toContain('sb-127-auth-token=base64-')
  })
})
