import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// both public webhooks refuse an unauthenticated flood from one address BEFORE any database
// lookup or signature work. The limiter is in-process and per address (/64 for IPv6).

const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => db }))

const SOURCE = '00000000-0000-4000-8000-0000000000aa'
const t = () => Math.floor(Date.now() / 1000)

beforeEach(async () => {
  vi.resetModules()
  db.rpc.mockReset().mockResolvedValue({ data: [], error: null })
  db.from.mockReset()
  vi.stubEnv('ACUITY_USER_ID', '1')
  vi.stubEnv('ACUITY_API_KEY', ['fake', 'acuity', 'key'].join('-'))
})

function outcomePost(address: string) {
  return new Request(`https://maxx.example.test/api/outcomes/webhook/${SOURCE}`, {
    method: 'POST', body: '{}',
    headers: { 'x-forwarded-for': address, 'x-maxx-signature': `t=${t()},v1=${'a'.repeat(64)}` },
  })
}

describe('pre-auth webhook limiter', () => {
  it('the outcome webhook stops looking sources up for one address after 600 requests a minute', async () => {
    const { POST } = await import('@/app/api/outcomes/webhook/[sourceId]/route')
    const call = (address: string) => POST(outcomePost(address), { params: Promise.resolve({ sourceId: SOURCE }) })
    for (let i = 0; i < 600; i++) expect((await call('198.51.100.7')).status).toBe(404)
    const lookups = db.rpc.mock.calls.length
    expect(lookups).toBe(600)
    const limited = await call('198.51.100.7')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' })
    expect(db.rpc.mock.calls.length).toBe(lookups)
    // Control: another address is unaffected.
    expect((await call('198.51.100.8')).status).toBe(404)
  })

  it('the Acuity webhook refuses a flood before reading the body or checking the signature', async () => {
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const call = () => POST(new NextRequest('https://maxx.example.test/api/webhooks/acuity', {
      method: 'POST', body: 'action=scheduled&id=1', headers: { 'x-forwarded-for': '2001:db8:9:9::1', 'x-acuity-signature': 'bad' },
    }))
    for (let i = 0; i < 300; i++) expect((await call()).status).toBe(401)
    const limited = await call()
    expect(limited.status).toBe(429)
    // Same /64, different interface id: still limited.
    const sibling = await POST(new NextRequest('https://maxx.example.test/api/webhooks/acuity', {
      method: 'POST', body: 'x', headers: { 'x-forwarded-for': '2001:db8:9:9:abcd::2' },
    }))
    expect(sibling.status).toBe(429)
  })
})
