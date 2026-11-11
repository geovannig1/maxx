import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { signOutcomeWebhook } from '@/lib/outcomes/adapters/webhook/signature'

// Release plan §7.3 (conversions) on the SHIPPED schema: the signed webhook route, the conversions
// sender, the sweep and the delivery RPC run for real; only Meta's HTTP endpoint is stubbed.

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))

import { POST } from '@/app/api/outcomes/webhook/[sourceId]/route'
import { sweepUnsentOutcomeConversions } from '@/lib/conversions/outcome-sweep'
import { sendOutcomeConversion } from '@/lib/conversions/outcome-conversions'

const ACCOUNT = fixtureUuid(9701)
const SIGNING = '9'.repeat(64)
const HOUR = 3_600_000
let db: PGlite
let source: string
let meta: ReturnType<typeof vi.fn>

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const payload = (over: Record<string, unknown> = {}) => JSON.stringify({
  external_id: 'order-1', outcome_type: 'sale', status: 'confirmed', currency: 'EUR', gross_value: '80.00',
  occurred_at: iso(HOUR), origin: 'website',
  attribution: { landing_page: 'https://shop.example.test/checkout', fbc: `fb.1.${Date.now() - 2 * HOUR}.IwAR-fixture` },
  customer: { email: 'Buyer@Example.test' },
  ...over,
})

let tick = 0
async function deliver(body: string, id = source) {
  // Each call is a distinct signed delivery (a sender retry or a new state), never a byte replay.
  const t = Math.floor(Date.now() / 1000) - (tick += 1)
  const res = await POST(new Request(`http://localhost/api/outcomes/webhook/${id}`, {
    method: 'POST', body, headers: { 'x-maxx-signature': signOutcomeWebhook(SIGNING, t, body) },
  }), { params: Promise.resolve({ sourceId: id }) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function newSource(label: string, config: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'select public.create_outcome_webhook_source($1, $2, true, $3) as id', [ACCOUNT, label, SIGNING])
  await db.query('update public.outcome_sources set config = $1 where id = $2', [JSON.stringify(config), rows[0].id])
  return rows[0].id
}

const deliveries = async () => (await db.query<{ event_id: string; attempt_count: number; live: boolean }>(
  'select event_id, attempt_count, live_accepted_at is not null as live from public.conversion_deliveries order by id')).rows
const outcome = async (externalId: string) => (await db.query<Record<string, unknown>>(
  `select id, conversion_sent_at is not null as sent, conversion_send_error from public.outcomes where external_id = $1`, [externalId])).rows[0]
const sentEvents = () => meta.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).data[0])

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query(`update public.ad_accounts set currency = 'EUR' where id = $1`, [ACCOUNT])
  state.client = pgliteSupabase(db)
  source = await newSource('Shop')
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

describe('outcome conversions', () => {
  it('a duplicate webhook plus a sweep gives exactly one delivery', async () => {
    expect((await deliver(payload())).body).toMatchObject({ conversion: 'sent' })
    expect((await deliver(payload())).body).toMatchObject({ conversion: 'not-applicable' })
    await sweepUnsentOutcomeConversions(state.client!)
    const { id } = await outcome('order-1')
    expect(meta).toHaveBeenCalledTimes(1)
    expect(await deliveries()).toEqual([{ event_id: `maxx-${id}`, attempt_count: 1, live: true }])
    expect(sentEvents()[0]).toMatchObject({
      event_name: 'Purchase', event_id: `maxx-${id}`, action_source: 'website',
      event_source_url: 'https://shop.example.test/checkout', custom_data: { value: 80, currency: 'EUR' },
    })
  })

  it('retries a failed first send from the sweep, still as one delivery row, then stops', async () => {
    meta.mockResolvedValueOnce(Response.json({ error: { message: 'temporary' } }, { status: 500 }))
    expect((await deliver(payload())).body).toMatchObject({ conversion: 'error' })
    expect(await sweepUnsentOutcomeConversions(state.client!)).toMatchObject({ ran: true, sent: 1 })
    await sweepUnsentOutcomeConversions(state.client!)
    expect(meta).toHaveBeenCalledTimes(2)
    expect(await deliveries()).toEqual([expect.objectContaining({ attempt_count: 2, live: true })])
  })

  it('terminal-labelled rows cannot starve an eligible retry or a stale close-out', async () => {
    // 250 recent rows already closed out (terminal label), inserted first, and 600 stale unlabelled rows.
    const bulk = (n: number, prefix: string, hoursAgo: number, label: string | null) => db.query(
      `insert into public.outcomes (ad_account_id, source_id, external_id, outcome_type, currency, status, origin,
         origin_observed_at, origin_observed_source, occurred_at, landing_page, email, conversion_send_error)
       select $1, $2, $3 || g, 'sale', 'EUR', 'confirmed', 'website', now(), 'webhook',
              now() - make_interval(hours => $4), 'https://x.test/', 'a@b.test', $5
         from generate_series(1, $6) g`, [ACCOUNT, source, prefix, hoursAgo, label, n])
    await bulk(250, 'closed-', 2, 'no_user_data')
    await bulk(600, 'stale-', 60, null)
    meta.mockResolvedValueOnce(Response.json({ error: { message: 'temporary' } }, { status: 500 }))
    expect((await deliver(payload())).body).toMatchObject({ conversion: 'error' })

    expect(await sweepUnsentOutcomeConversions(state.client!)).toMatchObject({ ran: true, sent: 1, markedMissed: 600 })
    expect(await outcome('order-1')).toMatchObject({ sent: true })
    expect(await outcome('closed-1')).toMatchObject({ sent: false, conversion_send_error: 'no_user_data' })
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int n from public.outcomes where external_id like 'stale-%' and conversion_send_error = 'missed-48h-window'`)
    expect(rows[0].n).toBe(600)
  })

  it('never sends a cancellation, from the route or the sweep', async () => {
    await deliver(payload({ status: 'cancelled' }))
    await sweepUnsentOutcomeConversions(state.client!)
    expect(meta).not.toHaveBeenCalled()
    expect(await deliveries()).toEqual([])
  })

  it('never sends an outcome that was cancelled after a failed first send', async () => {
    meta.mockResolvedValueOnce(Response.json({}, { status: 500 }))
    await deliver(payload())
    await deliver(payload({ status: 'cancelled' }))
    await sweepUnsentOutcomeConversions(state.client!)
    expect(meta).toHaveBeenCalledTimes(1)
    expect((await outcome('order-1')).sent).toBe(false)
  })

  it('never sends on a reschedule or any other change to an already-confirmed outcome', async () => {
    await deliver(payload())
    meta.mockClear()
    const changed = await deliver(payload({ fulfilment_at: iso(-48 * HOUR), gross_value: '95.00' }))
    expect(changed.body).toMatchObject({ conversion: 'not-applicable' })
    expect(meta).not.toHaveBeenCalled()
  })

  it('never sends anything past the resend cutoff; the sweep closes it out instead', async () => {
    vi.stubEnv('OUTCOME_CONVERSIONS_SEND', 'off')
    await deliver(payload({ occurred_at: iso(47 * HOUR) }))
    vi.stubEnv('OUTCOME_CONVERSIONS_SEND', 'true')
    expect(await sweepUnsentOutcomeConversions(state.client!)).toMatchObject({ sent: 0, markedMissed: 1 })
    expect(meta).not.toHaveBeenCalled()
    expect(await outcome('order-1')).toMatchObject({ sent: false, conversion_send_error: 'missed-48h-window' })
    // Control: an outcome inside the cutoff in the same sweep is sent.
    vi.stubEnv('OUTCOME_CONVERSIONS_SEND', 'off')
    await deliver(payload({ external_id: 'order-2', occurred_at: iso(45 * HOUR) }))
    vi.stubEnv('OUTCOME_CONVERSIONS_SEND', 'true')
    expect(await sweepUnsentOutcomeConversions(state.client!)).toMatchObject({ sent: 1 })
  })

  it.each(['staff_or_manual', 'unknown'])('never sends origin %s, from the route or the sweep', async (origin) => {
    const res = await deliver(payload({ origin }))
    expect(res.body).toMatchObject({ conversion: 'skipped-origin_not_website' })
    await sweepUnsentOutcomeConversions(state.client!)
    expect(meta).not.toHaveBeenCalled()
    expect(await outcome('order-1')).toMatchObject({ conversion_send_error: 'origin_not_website' })
  })

  it('never sends a CSV-sourced outcome, even one claiming a website origin', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.outcome_sources (ad_account_id, kind, label, enabled) values ($1, 'csv', 'Import', true) returning id`, [ACCOUNT])
    const { rows: o } = await db.query<{ id: string }>(
      `insert into public.outcomes (ad_account_id, source_id, external_id, outcome_type, currency, status, origin,
         origin_observed_at, origin_observed_source, occurred_at, landing_page, email)
       values ($1, $2, 'row-1', 'sale', 'EUR', 'confirmed', 'website', now(), 'webhook', now(), 'https://x.test/', 'a@b.test') returning id`,
      [ACCOUNT, rows[0].id])
    await sweepUnsentOutcomeConversions(state.client!)
    expect(await sendOutcomeConversion(state.client!, o[0].id)).toMatchObject({ status: 'skipped', skip: 'source_not_sendable' })
    expect(meta).not.toHaveBeenCalled()
    // The database refuses to record one too: csv has no event id format.
    await expect(db.query(`select public.record_conversion_delivery($1, $2, now(), 1, 'EUR', 'live', 1, null, null, 'v1')`,
      [o[0].id, `maxx-${o[0].id}`])).rejects.toMatchObject({ code: '23000' })
  })

  it('refuses at the database to record a webhook delivery for a non-website outcome', async () => {
    vi.stubEnv('OUTCOME_CONVERSIONS_SEND', 'off')
    await deliver(payload({ origin: 'unknown' }))
    const { id } = await outcome('order-1')
    await expect(db.query(`select public.record_conversion_delivery($1, $2, now(), 1, 'EUR', 'live', 1, null, null, 'v1')`,
      [id, `maxx-${id}`])).rejects.toMatchObject({ code: '23000' })
  })

  it('sends each mapped type under its event name and never an unmapped one', async () => {
    const types = { lead: 'Lead', sale: 'Purchase', booking: 'Schedule', signup: 'CompleteRegistration', quote: null, subscription: null, custom: null }
    for (const [type, event] of Object.entries(types)) {
      const res = await deliver(payload({ external_id: `t-${type}`, outcome_type: type }))
      expect(res.body.conversion).toBe(event ? 'sent' : 'skipped-unmapped_type')
    }
    expect(sentEvents().map((e) => e.event_name)).toEqual(['Lead', 'Purchase', 'Schedule', 'CompleteRegistration'])
  })

  it('never mirrors an event the source declares as platform-native', async () => {
    const native = await newSource('Shop with pixel purchases', { platformNativeEvents: ['Purchase'] })
    expect((await deliver(payload(), native)).body).toMatchObject({ conversion: 'skipped-platform_native' })
    expect((await deliver(payload({ external_id: 'lead-1', outcome_type: 'lead' }), native)).body).toMatchObject({ conversion: 'sent' })
    await sweepUnsentOutcomeConversions(state.client!)
    expect(sentEvents().map((e) => e.event_name)).toEqual(['Lead'])
  })

  it('sends a pending lead on its first confirmation, once', async () => {
    expect((await deliver(payload({ outcome_type: 'lead', status: 'pending' }))).body).toMatchObject({ conversion: 'not-applicable' })
    expect((await deliver(payload({ outcome_type: 'lead' }))).body).toMatchObject({ conversion: 'sent' })
    expect((await deliver(payload({ outcome_type: 'lead' }))).body).toMatchObject({ conversion: 'not-applicable' })
    expect(meta).toHaveBeenCalledTimes(1)
  })

  it('sends nothing and labels nothing while sending is off', async () => {
    vi.stubEnv('OUTCOME_CONVERSIONS_SEND', '')
    expect((await deliver(payload())).body).toMatchObject({ conversion: 'off' })
    expect(await sweepUnsentOutcomeConversions(state.client!)).toMatchObject({ ran: false })
    expect(meta).not.toHaveBeenCalled()
    expect(await outcome('order-1')).toMatchObject({ conversion_send_error: null })
  })

  it('hashes the customer, attaches a browser fbc only when it predates the outcome', async () => {
    await deliver(payload())
    await deliver(payload({ external_id: 'order-2', attribution: { landing_page: 'https://shop.example.test/', fbc: `fb.1.${Date.now()}.later` } }))
    const [first, second] = sentEvents()
    expect(first.user_data.em[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(first)).not.toContain('Buyer@Example.test')
    expect(first.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR-fixture$/)
    expect(second.user_data.fbc).toBeUndefined()
  })

  it('hashes a national phone number with the account country calling code, else the configured one', async () => {
    const { createHash } = await import('node:crypto')
    const sha = (v: string) => createHash('sha256').update(v).digest('hex')
    vi.stubEnv('CONVERSIONS_PHONE_COUNTRY_CODE', '49')
    await db.query(`update public.ad_accounts set country = 'GB' where id = $1`, [ACCOUNT])
    await deliver(payload({ external_id: 'phone-gb', customer: { phone: '07700 900123' } }))
    await db.query(`update public.ad_accounts set country = null where id = $1`, [ACCOUNT])
    await deliver(payload({ external_id: 'phone-config', customer: { phone: '07700 900123' } }))
    const [gb, configured] = sentEvents()
    expect(gb.user_data.ph).toEqual([sha('447700900123')])
    expect(configured.user_data.ph).toEqual([sha('497700900123')])
  })
})
