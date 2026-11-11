import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { signOutcomeWebhook } from '@/lib/outcomes/adapters/webhook/signature'

// The generic webhook route end to end on the SHIPPED schema: real signature check, real rate-limit
// RPC, real replay ledger, real outcome upsert and observation triggers. Only the Supabase transport
// is swapped (SDK → SQL on PGlite).

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
const spies = vi.hoisted(() => ({ verify: vi.fn(), rateLimit: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/webhook/signature', async (original) => {
  const actual = await original<typeof import('@/lib/outcomes/adapters/webhook/signature')>()
  spies.verify.mockImplementation(actual.verifyOutcomeWebhookSignature)
  return { ...actual, verifyOutcomeWebhookSignature: spies.verify }
})
vi.mock('@/lib/security/api-rate-limit', async (original) => {
  const actual = await original<typeof import('@/lib/security/api-rate-limit')>()
  spies.rateLimit.mockImplementation(actual.enforceApiRateLimit)
  return { ...actual, enforceApiRateLimit: spies.rateLimit }
})

import { POST } from '@/app/api/outcomes/webhook/[sourceId]/route'

const ACCOUNT = fixtureUuid(9501)
const SECRET_A = 'c'.repeat(64)
let db: PGlite
let source: string

const payload = (over: Record<string, unknown> = {}) => JSON.stringify({
  external_id: 'order-1001', outcome_type: 'sale', status: 'confirmed', currency: 'EUR',
  gross_value: '120.50', occurred_at: '2026-11-08T23:30:00Z', origin: 'website',
  customer: { email: 'buyer@example.test' }, ...over,
})

function post(id: string, body: string, opts: { secret?: string; t?: number; header?: string | null } = {}) {
  const t = opts.t ?? Math.floor(Date.now() / 1000)
  const header = opts.header === undefined ? signOutcomeWebhook(opts.secret ?? SECRET_A, t, body) : opts.header
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (header !== null) headers['x-maxx-signature'] = header
  return POST(new Request(`http://localhost/api/outcomes/webhook/${id}`, { method: 'POST', body, headers }),
    { params: Promise.resolve({ sourceId: id }) })
}

async function createSource(enabled: boolean, label: string, secret = SECRET_A): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'select public.create_outcome_webhook_source($1, $2, $3, $4) as id', [ACCOUNT, label, enabled, secret])
  return rows[0].id
}

const outcomes = async () => (await db.query<Record<string, unknown>>(
  `select external_id, status, gross_value::text, collected_value::text, business_date::text, origin, currency,
          origin_observed_source, observation_source from public.outcomes order by external_id`)).rows
const n = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query(`update public.ad_accounts set timezone_name = 'Europe/Berlin', currency = 'EUR' where id = $1`, [ACCOUNT])
  // configuration must agree with the account's timezone (src/config/business-config.ts).
  vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Europe/Berlin')
  state.client = pgliteSupabase(db)
  spies.verify.mockClear()
  spies.rateLimit.mockClear()
  source = await createSource(true, 'Shop')
})

afterEach(() => vi.unstubAllEnvs())

describe('generic outcome webhook route', () => {
  it('records a signed delivery once, in the account timezone, with NULL kept apart from 0', async () => {
    const res = await post(source, payload())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, external_id: 'order-1001' })
    expect(await outcomes()).toEqual([{
      external_id: 'order-1001', status: 'confirmed', gross_value: '120.50', collected_value: null,
      business_date: '2026-11-09', origin: 'website', currency: 'EUR',
      origin_observed_source: 'webhook', observation_source: 'webhook',
    }])
    expect(await n('select count(*)::int n from public.outcome_observations')).toBe(1)
    expect(spies.rateLimit).toHaveBeenCalledWith(expect.objectContaining({ actorKey: source, bucket: 'outcome-webhook' }))
  })

  it('refuses a replay of the same signed delivery and leaves the outcome as it was', async () => {
    const t = Math.floor(Date.now() / 1000)
    const body = payload()
    expect((await post(source, body, { t })).status).toBe(200)
    const replay = await post(source, body, { t })
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ code: 'REPLAY' })
    expect(await n('select count(*)::int n from public.outcomes')).toBe(1)
  })

  it('cannot roll a newer state back by replaying an older delivery', async () => {
    const t = Math.floor(Date.now() / 1000)
    const confirmed = payload()
    expect((await post(source, confirmed, { t: t - 10 })).status).toBe(200)
    expect((await post(source, payload({ status: 'cancelled' }), { t })).status).toBe(200)
    expect((await post(source, confirmed, { t: t - 10 })).status).toBe(409)
    expect((await outcomes())[0]).toMatchObject({ status: 'cancelled' })
  })

  it('treats a new delivery for the same external id as the newer state of the same row', async () => {
    expect((await post(source, payload(), { t: Math.floor(Date.now() / 1000) - 1 })).status).toBe(200)
    expect((await post(source, payload({ gross_value: '0', collected_value: '0' }))).status).toBe(200)
    expect(await outcomes()).toEqual([expect.objectContaining({ gross_value: '0', collected_value: '0' })])
    expect((await db.query<{ k: string }>('select change_kind k from public.outcome_observations order by id')).rows.map((r) => r.k))
      .toEqual(['first_observation', 'price_change'])
  })

  it('rejects a stale timestamp before looking anything up', async () => {
    const res = await post(source, payload(), { t: Math.floor(Date.now() / 1000) - 301 })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'SIGNATURE_STALE' })
    expect(spies.verify).not.toHaveBeenCalled()
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
  })

  it.each([
    ['no signature header', { header: null }],
    ['a malformed header', { header: 't=1,v1=zz' }],
  ])('rejects %s', async (_label, opts) => {
    const res = await post(source, payload(), opts)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'SIGNATURE_MALFORMED' })
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
  })

  it('answers a wrong signature, a disabled source and an unknown source identically, doing the same work', async () => {
    const disabled = await createSource(false, 'Disabled', SECRET_A)
    const responses = [
      await post(source, payload(), { secret: 'd'.repeat(64) }),
      await post(disabled, payload()),
      await post(fixtureUuid(9599), payload()),
    ]
    const shapes = await Promise.all(responses.map(async (r) => ({ status: r.status, body: await r.text(), type: r.headers.get('content-type') })))
    expect(shapes.map((s) => s.status)).toEqual([404, 404, 404])
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1)
    // The HMAC is computed for every one of them, twice: the live secret and the secret a rotation
    // replaced (a placeholder when there is none, or for the missing sources), so the work is the same.
    expect(spies.verify).toHaveBeenCalledTimes(6)
    expect(spies.rateLimit).not.toHaveBeenCalled()
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
    expect(await n('select count(*)::int n from public.outcome_webhook_deliveries')).toBe(0)
  })

  it('returns 404 for a source id that is not a uuid', async () => {
    expect((await post('not-a-uuid', payload())).status).toBe(404)
  })

  it('refuses a body over 32 KB before verifying it', async () => {
    const res = await post(source, payload({ outcome_label: 'x'.repeat(33 * 1024) }))
    expect(res.status).toBe(413)
    expect(spies.verify).not.toHaveBeenCalled()
  })

  it('rejects an invalid payload with the field names only, and writes nothing', async () => {
    const res = await post(source, payload({ currency: 'eur', gross_value: 120.5 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid payload', code: 'INVALID_PAYLOAD', fields: ['currency', 'gross_value'] })
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
  })

  it('releases the claim when the write fails, so the same signed delivery succeeds on retry', async () => {
    await db.query(`update public.ad_accounts set timezone_name = 'Not/AZone' where id = $1`, [ACCOUNT])
    const t = Math.floor(Date.now() / 1000)
    const body = payload()
    const failed = await post(source, body, { t })
    expect(failed.status).toBe(503)
    const failedBody = await failed.json()
    expect(failedBody).toMatchObject({ code: 'OUTCOME_WRITE_FAILED' })
    expect(JSON.stringify(failedBody)).not.toMatch(/Not\/AZone|RangeError|time zone/i)
    expect(await n('select count(*)::int n from public.outcome_webhook_deliveries')).toBe(0)
    await db.query(`update public.ad_accounts set timezone_name = 'Europe/Berlin', currency = 'EUR' where id = $1`, [ACCOUNT])
    expect((await post(source, body, { t })).status).toBe(200)
  })

  it('refuses to write when configuration disagrees with the account timezone, then accepts once it agrees', async () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'America/Chicago')
    const t = Math.floor(Date.now() / 1000)
    const body = payload()
    const refused = await post(source, body, { t })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ code: 'OUTCOME_WRITE_FAILED' })
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Europe/Berlin')
    expect((await post(source, body, { t })).status).toBe(200)
  })

  it('returns the rate limiter response and writes nothing when the source is over its limit', async () => {
    spies.rateLimit.mockResolvedValueOnce(Response.json({ code: 'RATE_LIMITED' }, { status: 429 }))
    const res = await post(source, payload())
    expect(res.status).toBe(429)
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
  })

  it('stops accepting the old secret once it is rotated', async () => {
    await db.query('select public.rotate_outcome_webhook_secret($1, $2)', [source, 'e'.repeat(64)])
    expect((await post(source, payload())).status).toBe(404)
    expect((await post(source, payload(), { secret: 'e'.repeat(64) })).status).toBe(200)
  })

  it('refuses an outcome in another currency with a stable 4xx before any claim or write', async () => {
    const res = await post(source, payload({ currency: 'USD' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'currency must be the ad account currency', code: 'CURRENCY_NOT_ACCOUNT', fields: ['currency'] })
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
    expect(await n('select count(*)::int n from public.outcome_webhook_deliveries')).toBe(0)
    // Control: the same delivery in the account currency is accepted.
    expect((await post(source, payload())).status).toBe(200)
  })

  it('refuses a value above the money ceiling (default and configured) with a 4xx', async () => {
    const huge = await post(source, payload({ gross_value: '1000000000.01' }))
    expect(huge.status).toBe(422)
    expect(await huge.json()).toMatchObject({ code: 'VALUE_ABOVE_CEILING', fields: ['gross_value'] })
    vi.stubEnv('OUTCOME_MONEY_CEILING', '500')
    const configured = await post(source, payload({ collected_value: '500.01' }))
    expect(await configured.json()).toMatchObject({ code: 'VALUE_ABOVE_CEILING', fields: ['collected_value'] })
    expect(await n('select count(*)::int n from public.outcomes')).toBe(0)
    expect((await post(source, payload({ collected_value: '500' }))).status).toBe(200)
  })
})
