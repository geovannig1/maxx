import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { signOutcomeWebhook } from '@/lib/outcomes/adapters/webhook/signature'

// Rotating a webhook source's secret keeps the OLD secret verifying for a short, bounded window
// (0004_secret_rotation_grace.sql), so a sender can switch without refused deliveries. The window is
// chosen per rotation (0 = stop at once, for a suspected leak), capped at 24 hours, never returns the
// old secret anywhere, and ends on its own.

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } } }) },
  }),
}))

import { POST as rotate } from '@/app/api/outcomes/webhook-sources/[sourceId]/rotate/route'
import { POST as deliver } from '@/app/api/outcomes/webhook/[sourceId]/route'
import { readWebhookSecretGrace } from '@/lib/outcomes/adapters/webhook/sources'

const ACCOUNT = fixtureUuid(9801)
const OLD_SECRET = 'a'.repeat(64)
let db: PGlite
let source: string

const rotateReq = (body?: unknown) => rotate(new Request(`http://localhost/api/outcomes/webhook-sources/${source}/rotate`, {
  method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
}), { params: Promise.resolve({ sourceId: source }) })

let n = 0
async function post(secret: string) {
  n += 1
  const body = JSON.stringify({
    external_id: `ORDER-${n}`, outcome_type: 'sale', status: 'confirmed', currency: 'USD',
    occurred_at: '2026-07-20T18:00:00Z', origin: 'website',
  })
  const t = Math.floor(Date.now() / 1000) - 100 + n
  const res = await deliver(new Request(`http://localhost/api/outcomes/webhook/${source}`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-maxx-signature': signOutcomeWebhook(secret, t, body) },
  }), { params: Promise.resolve({ sourceId: source }) })
  return res.status
}

const expire = () => db.query(`UPDATE public.outcome_source_secrets SET previous_secret_expires_at = now() - interval '1 second'`)

beforeEach(async () => {
  process.env.OWNER_EMAIL = 'owner@example.test'
  vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'America/New_York')
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  state.client = pgliteSupabase(db)
  source = (await db.query<{ id: string }>('select public.create_outcome_webhook_source($1,$2,true,$3) as id',
    [ACCOUNT, 'Shop', OLD_SECRET])).rows[0].id
})
afterEach(() => { delete process.env.OWNER_EMAIL; vi.unstubAllEnvs() })

describe('webhook secret rotation grace period', () => {
  it('by default keeps the old secret verifying for 60 minutes beside the new one, then stops it', async () => {
    const before = Date.now()
    const res = await rotateReq()
    expect(res.status).toBe(200)
    const body = await res.json() as { secret: string; previous_secret_valid_until: string | null }
    expect(body).not.toHaveProperty('previous_secret')
    expect(JSON.stringify(body)).not.toContain(OLD_SECRET)
    const until = Date.parse(body.previous_secret_valid_until ?? '')
    expect(until - before).toBeGreaterThanOrEqual(60 * 60_000 - 5_000)
    expect(until - before).toBeLessThanOrEqual(60 * 60_000 + 5_000)

    expect(await post(body.secret)).toBe(200)
    expect(await post(OLD_SECRET)).toBe(200)
    expect(await post('b'.repeat(64))).toBe(404)

    await expire()
    expect(await post(OLD_SECRET)).toBe(404)
    expect(await post(body.secret)).toBe(200)
  })

  it('stops the old secret at once when the owner chooses no grace (suspected leak)', async () => {
    const res = await rotateReq({ grace_minutes: 0 })
    const body = await res.json() as { secret: string; previous_secret_valid_until: string | null }
    expect(body.previous_secret_valid_until).toBeNull()
    expect(await post(OLD_SECRET)).toBe(404)
    expect(await post(body.secret)).toBe(200)
  })

  it('refuses a window outside 0..1440 minutes and changes nothing', async () => {
    for (const grace_minutes of [-1, 1441, 1.5, '60', null]) {
      expect((await rotateReq({ grace_minutes })).status, String(grace_minutes)).toBe(400)
    }
    expect((await db.query<{ secret: string }>('select secret from public.outcome_source_secrets')).rows).toEqual([{ secret: OLD_SECRET }])
    // The database caps the window too, whoever calls it.
    await expect(db.query(`select public.rotate_outcome_webhook_secret($1, $2, 86401)`, [source, 'c'.repeat(64)])).rejects.toThrow()
  })

  it('a second rotation inside the window keeps only the secret it replaced', async () => {
    const first = await (await rotateReq({ grace_minutes: 15 })).json() as { secret: string }
    const second = await (await rotateReq({ grace_minutes: 15 })).json() as { secret: string }
    expect(await post(OLD_SECRET)).toBe(404)
    expect(await post(first.secret)).toBe(200)
    expect(await post(second.secret)).toBe(200)
  })

  it('returns the new secret and its window from the rotation itself, with no second read that could lose it', async () => {
    const client = state.client!
    // Any read of the secrets table after the rotation commits fails: the new secret must still reach the caller.
    state.client = new Proxy(client, { get: (target, key) => key === 'from'
      ? (table: string) => { if (table === 'outcome_source_secrets') throw new Error('secret table read unavailable'); return target.from(table) }
      : Reflect.get(target, key) })
    const res = await rotateReq({ grace_minutes: 15 })
    expect(res.status).toBe(200)
    const body = await res.json() as { secret: string; previous_secret_valid_until: string }
    expect(Date.parse(body.previous_secret_valid_until)).toBeGreaterThan(Date.now())
    expect(await post(body.secret)).toBe(200)
    expect(await post(OLD_SECRET)).toBe(200)
  })

  it('Settings reads when the old secret stops, never the secret itself', async () => {
    expect(await readWebhookSecretGrace(state.client!, [source])).toEqual({})
    const body = await (await rotateReq({ grace_minutes: 30 })).json() as { previous_secret_valid_until: string }
    const grace = await readWebhookSecretGrace(state.client!, [source])
    expect(Date.parse(grace[source])).toBe(Date.parse(body.previous_secret_valid_until))
    expect(JSON.stringify(grace)).not.toMatch(/[0-9a-f]{64}/)
    await expire()
    expect(await readWebhookSecretGrace(state.client!, [source])).toEqual({})
  })

  it('the stored old secret obeys the same shape and is removed with the source', async () => {
    await expect(db.query(`UPDATE public.outcome_source_secrets SET previous_secret = 'short', previous_secret_expires_at = now()`)).rejects.toThrow()
    await expect(db.query(`UPDATE public.outcome_source_secrets SET previous_secret = $1`, ['d'.repeat(64)])).rejects.toThrow()
    await db.query('DELETE FROM public.outcome_sources WHERE id = $1', [source])
    expect((await db.query('SELECT 1 FROM public.outcome_source_secrets')).rows).toEqual([])
  })
})
