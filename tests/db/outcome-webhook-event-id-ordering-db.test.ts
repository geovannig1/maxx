import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { signOutcomeWebhook } from '@/lib/outcomes/adapters/webhook/signature'

// On the SHIPPED schema: (1) an optional sender-supplied conversion `event_id`, strictly
// validated, so the business's browser pixel and Maxx's server event deduplicate (default stays
// `maxx-<outcome uuid>`); (2) an optional `updated_at` ordering field, so an older delivery can never
// overwrite a newer state. Only Meta's HTTP endpoint is stubbed.

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))

import { POST } from '@/app/api/outcomes/webhook/[sourceId]/route'

const ACCOUNT = fixtureUuid(9801)
const SIGNING = '8'.repeat(64)
const HOUR = 3_600_000
let db: PGlite
let source: string
let meta: ReturnType<typeof vi.fn>

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const payload = (over: Record<string, unknown> = {}) => JSON.stringify({
  external_id: 'order-1', outcome_type: 'sale', status: 'confirmed', currency: 'USD', gross_value: '80.00',
  occurred_at: iso(HOUR), origin: 'website',
  attribution: { landing_page: 'https://shop.example.test/checkout' },
  customer: { email: 'buyer@example.test' },
  ...over,
})

let tick = 0
async function deliver(body: string) {
  const t = Math.floor(Date.now() / 1000) - (tick += 1)
  const res = await POST(new Request(`http://localhost/api/outcomes/webhook/${source}`, {
    method: 'POST', body, headers: { 'x-maxx-signature': signOutcomeWebhook(SIGNING, t, body) },
  }), { params: Promise.resolve({ sourceId: source }) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const stored = async () => (await db.query<Record<string, unknown>>(
  `select id, status, gross_value::text, conversion_event_id, source_updated_at from public.outcomes where external_id = 'order-1'`)).rows[0]
const deliveryIds = async () => (await db.query<{ event_id: string }>('select event_id from public.conversion_deliveries order by id')).rows.map((r) => r.event_id)
const sentEventIds = () => meta.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).data[0].event_id)

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  state.client = pgliteSupabase(db)
  const { rows } = await db.query<{ id: string }>('select public.create_outcome_webhook_source($1, $2, true, $3) as id', [ACCOUNT, 'Shop', SIGNING])
  source = rows[0].id
  meta = vi.fn(async () => Response.json({ events_received: 1 }))
  vi.stubGlobal('fetch', meta)
  vi.stubEnv('OUTCOME_CONVERSIONS_SEND', 'true')
  vi.stubEnv('META_PIXEL_ID', '424242')
  vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'fixture')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('sender-supplied conversion event id', () => {
  it('sends and records the sender event id so the browser pixel copy deduplicates', async () => {
    expect((await deliver(payload({ event_id: 'shop-order-1001' }))).body).toMatchObject({ conversion: 'sent' })
    expect(sentEventIds()).toEqual(['shop-order-1001'])
    expect(await deliveryIds()).toEqual(['shop-order-1001'])
    expect((await stored()).conversion_event_id).toBe('shop-order-1001')
  })

  it('keeps the default maxx-<outcome uuid> when the sender supplies none (control)', async () => {
    await deliver(payload())
    const row = await stored()
    expect(row.conversion_event_id).toBeNull()
    expect(sentEventIds()).toEqual([`maxx-${row.id}`])
    expect(await deliveryIds()).toEqual([`maxx-${row.id}`])
  })

  it.each([
    ['empty', ''], ['spaces', 'order 1'], ['too long', 'x'.repeat(101)], ['non-ascii', 'ordér-1'],
    ['reserved maxx- prefix', 'maxx-abc'], ['reserved acuity- prefix', 'acuity-123'], ['number', 42],
  ])('rejects an invalid event id (%s) and writes nothing', async (_label, eventId) => {
    const res = await deliver(payload({ event_id: eventId }))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD', fields: ['event_id'] })
    expect(await stored()).toBeUndefined()
  })

  it('refuses a different event id for an outcome that already has one, and keeps it on omission', async () => {
    await deliver(payload({ event_id: 'shop-order-1001' }))
    const changed = await deliver(payload({ event_id: 'shop-order-9999', gross_value: '90.00' }))
    expect(changed.status).toBe(409)
    expect(changed.body).toMatchObject({ code: 'EVENT_ID_CHANGED' })
    expect(await stored()).toMatchObject({ conversion_event_id: 'shop-order-1001', gross_value: '80.00' })
    expect((await deliver(payload({ gross_value: '95.00' }))).status).toBe(200)
    expect(await stored()).toMatchObject({ conversion_event_id: 'shop-order-1001', gross_value: '95.00' })
  })
})

describe('updated_at ordering', () => {
  it('ignores a delivery older than the stored state and applies a newer one', async () => {
    await deliver(payload({ updated_at: '2026-11-08T12:00:00Z', gross_value: '100.00' }))
    const older = await deliver(payload({ updated_at: '2026-11-08T11:00:00Z', status: 'cancelled' }))
    expect(older.status).toBe(200)
    expect(older.body).toMatchObject({ ok: true, applied: false, reason: 'older_than_stored' })
    expect(await stored()).toMatchObject({ status: 'confirmed', gross_value: '100.00' })
    const newer = await deliver(payload({ updated_at: '2026-11-08T13:00:00Z', status: 'cancelled' }))
    expect(newer.body).toMatchObject({ ok: true, applied: true })
    expect(await stored()).toMatchObject({ status: 'cancelled' })
  })

  it('an older state never reaches the observation history', async () => {
    await deliver(payload({ updated_at: '2026-11-08T12:00:00Z' }))
    const before = (await db.query<{ n: number }>('select count(*)::int n from public.outcome_observations')).rows[0].n
    await deliver(payload({ updated_at: '2026-11-08T11:00:00Z', gross_value: '1.00' }))
    expect((await db.query<{ n: number }>('select count(*)::int n from public.outcome_observations')).rows[0].n).toBe(before)
  })

  it('keeps arrival order for a sender that does not send updated_at (unchanged behaviour)', async () => {
    await deliver(payload({ gross_value: '100.00' }))
    await deliver(payload({ gross_value: '70.00' }))
    expect(await stored()).toMatchObject({ gross_value: '70.00', source_updated_at: null })
  })

  it('rejects a malformed updated_at', async () => {
    const res = await deliver(payload({ updated_at: 'yesterday' }))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ fields: ['updated_at'] })
  })
})
