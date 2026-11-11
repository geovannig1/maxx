import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { OutcomeSourceAdapter } from '@/lib/outcomes/adapter'

// The reference adapter's webhook route checks its configuration and the delivery signature through the
// outcome-source adapter registry (the adapter object's validateConfig and verifyPush), not through a
// private copy of the same checks. Its nightly reconcile and conversion sweep already run through the
// registry (reconcileOutcomeSources -> adapter.reconcile).

const registry = vi.hoisted(() => ({
  override: null as Partial<OutcomeSourceAdapter> | null,
  kinds: [] as string[],
  verifyCalls: [] as Array<{ rawBody: string; secret: string }>,
}))
vi.mock('@/lib/outcomes/registry', async (original) => {
  const real = await original<typeof import('@/lib/outcomes/registry')>()
  return {
    ...real,
    getOutcomeAdapter: (kind: string) => {
      registry.kinds.push(kind)
      const adapter = real.getOutcomeAdapter(kind)
      if (!adapter) return adapter
      const merged = { ...adapter, ...registry.override }
      const verify = merged.verifyPush
      return verify
        ? { ...merged, verifyPush: (input: { rawBody: string; secret: string; headers: Headers; url: URL }) => { registry.verifyCalls.push(input); return verify(input) } }
        : merged
    },
  }
})

const KEY = ['fake', 'acuity', 'key'].join('-')
const BODY = 'action=order.completed&id=12345'

async function signed(body: string) {
  const { computeAcuitySignature } = await import('@/lib/outcomes/adapters/acuity/webhook')
  return new NextRequest('https://maxx.example.test/api/webhooks/acuity', {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-acuity-signature': computeAcuitySignature(body, KEY), 'x-forwarded-for': '203.0.113.9' },
  })
}

beforeEach(() => {
  vi.resetModules()
  registry.override = null
  registry.kinds = []
  registry.verifyCalls = []
  vi.stubEnv('ACUITY_USER_ID', '1')
  vi.stubEnv('ACUITY_API_KEY', KEY)
  vi.stubEnv('ACUITY_WEBHOOK_SECRET', '')
})

describe('Acuity webhook route goes through the adapter registry', () => {
  it('verifies the signature with the registered adapter and accepts a valid delivery (control)', async () => {
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const res = await POST(await signed(BODY))
    expect(res.status).toBe(200)
    expect(registry.kinds).toContain('acuity')
    expect(registry.verifyCalls).toHaveLength(1)
    expect(registry.verifyCalls[0]).toMatchObject({ rawBody: BODY, secret: KEY })
    // A wrong signature is still refused by the real adapter (control).
    const forged = await signed(BODY)
    forged.headers.set('x-acuity-signature', 'forged')
    expect((await POST(forged)).status).toBe(401)
  })

  it('refuses a delivery the registered adapter refuses, even with a valid signature', async () => {
    registry.override = { verifyPush: () => ({ ok: false, reason: 'mismatch' }) }
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const res = await POST(await signed(BODY))
    expect(res.status).toBe(401)
  })

  it('takes "configured" from the registered adapter', async () => {
    registry.override = { validateConfig: () => ({ ok: false, reason: 'not configured' }) }
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    expect((await POST(await signed(BODY))).status).toBe(503)
  })
})
