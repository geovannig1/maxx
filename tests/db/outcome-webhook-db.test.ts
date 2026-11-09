import { describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'

// The generic webhook's server-side state — the per-source secret and the replay
// ledger — on the shipped schema.

const ACCOUNT = fixtureUuid(9401)
const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const SIGNING_A = '1'.repeat(64)
const SIGNING_B = '2'.repeat(64)

async function setup(): Promise<PGlite> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  return db
}

async function createSource(db: PGlite, enabled: boolean, label = 'Shop'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'select public.create_outcome_webhook_source($1, $2, $3, $4) as id', [ACCOUNT, label, enabled, SIGNING_A])
  return rows[0].id
}

const resolve = async (db: PGlite, id: string) =>
  (await db.query<Record<string, unknown>>('select * from public.get_outcome_webhook_source($1)', [id])).rows

const claim = async (db: PGlite, source: string, key: string) =>
  (await db.query<{ c: boolean }>('select public.claim_outcome_webhook_delivery($1, $2) as c', [source, key])).rows[0].c

describe('outcome webhook sources', () => {
  it('creates a webhook source and its secret atomically and resolves it only while enabled', async () => {
    const db = await setup()
    const enabled = await createSource(db, true)
    expect(await resolve(db, enabled)).toEqual([{
      source_id: enabled, ad_account_id: ACCOUNT, secret: SIGNING_A, timezone_name: 'America/New_York', config: {},
    }])
    const disabled = await createSource(db, false, 'Disabled shop')
    expect(await resolve(db, disabled)).toEqual([])
    expect(await resolve(db, fixtureUuid(9499))).toEqual([])
  })

  it('never resolves a non-webhook source or a webhook source without a secret', async () => {
    const db = await setup()
    const { rows } = await db.query<{ id: string }>(
      `insert into public.outcome_sources (ad_account_id, kind, label, enabled) values ($1, 'acuity', 'Acuity', true) returning id`, [ACCOUNT])
    await db.query('insert into public.outcome_source_secrets (source_id, secret) values ($1, $2)', [rows[0].id, SIGNING_A])
    expect(await resolve(db, rows[0].id)).toEqual([])
    const { rows: bare } = await db.query<{ id: string }>(
      `insert into public.outcome_sources (ad_account_id, kind, label, enabled) values ($1, 'webhook', 'Bare', true) returning id`, [ACCOUNT])
    expect(await resolve(db, bare[0].id)).toEqual([])
  })

  it('rotates a secret in place and refuses to rotate a non-webhook source', async () => {
    const db = await setup()
    const id = await createSource(db, true)
    expect((await db.query<{ r: boolean }>('select public.rotate_outcome_webhook_secret($1, $2) as r', [id, SIGNING_B])).rows[0].r).toBe(true)
    expect((await resolve(db, id))[0].secret).toBe(SIGNING_B)
    const { rows } = await db.query<{ rotated: boolean; n: number }>(
      'select rotated_at is not null as rotated, (select count(*)::int from public.outcome_source_secrets) as n from public.outcome_source_secrets')
    expect(rows).toEqual([{ rotated: true, n: 1 }])
    const { rows: acuity } = await db.query<{ id: string }>(
      `insert into public.outcome_sources (ad_account_id, kind, label) values ($1, 'acuity', 'Acuity') returning id`, [ACCOUNT])
    expect((await db.query<{ r: boolean }>('select public.rotate_outcome_webhook_secret($1, $2) as r', [acuity[0].id, SIGNING_B])).rows[0].r).toBe(false)
  })

  it('rejects a secret that is not 32 random bytes in hex, and creates nothing when it does', async () => {
    const db = await setup()
    await expect(db.query('select public.create_outcome_webhook_source($1, $2, true, $3)', [ACCOUNT, 'Shop', 'short']))
      .rejects.toMatchObject({ code: '23514' })
    expect((await db.query<{ n: number }>('select count(*)::int n from public.outcome_sources')).rows[0].n).toBe(0)
  })
})

describe('outcome webhook replay ledger', () => {
  it('claims a digest once per source', async () => {
    const db = await setup()
    const a = await createSource(db, true)
    const b = await createSource(db, true, 'Other shop')
    expect(await claim(db, a, KEY_A)).toBe(true)
    expect(await claim(db, a, KEY_A)).toBe(false)
    expect(await claim(db, a, KEY_B)).toBe(true) // control: another digest is new
    expect(await claim(db, b, KEY_A)).toBe(true) // control: the key is per source
  })

  it('releases a claim so a retry of a delivery that failed to record is processed', async () => {
    const db = await setup()
    const a = await createSource(db, true)
    expect(await claim(db, a, KEY_A)).toBe(true)
    await db.query('select public.release_outcome_webhook_delivery($1, $2)', [a, KEY_A])
    expect(await claim(db, a, KEY_A)).toBe(true)
  })

  it('prunes digests older than an hour and keeps younger ones (bounded retention)', async () => {
    const db = await setup()
    const a = await createSource(db, true)
    await claim(db, a, KEY_A)
    await claim(db, a, KEY_B)
    await db.query(`update public.outcome_webhook_deliveries set received_at = now() - interval '61 minutes' where delivery_key = $1`, [KEY_A])
    await db.query(`update public.outcome_webhook_deliveries set received_at = now() - interval '59 minutes' where delivery_key = $1`, [KEY_B])
    expect(await claim(db, a, 'c'.repeat(64))).toBe(true) // any claim prunes
    const keys = (await db.query<{ k: string }>('select delivery_key k from public.outcome_webhook_deliveries order by k')).rows.map((r) => r.k)
    expect(keys).toEqual([KEY_B, 'c'.repeat(64)])
    expect(await claim(db, a, KEY_B)).toBe(false) // still within retention: still a replay
  })

  it('rejects a digest that is not 64 hex characters', async () => {
    const db = await setup()
    const a = await createSource(db, true)
    await expect(claim(db, a, 'not-a-digest')).rejects.toMatchObject({ code: '23514' })
  })
})

describe('browser roles', () => {
  it.each(['anon', 'authenticated'])('%s can neither read secrets nor call the webhook functions', async (role) => {
    const db = await setup()
    const id = await createSource(db, true)
    await db.exec(`SET ROLE ${role}`)
    await expect(db.query('select secret from public.outcome_source_secrets')).rejects.toMatchObject({ code: '42501' })
    await expect(db.query('select * from public.get_outcome_webhook_source($1)', [id])).rejects.toMatchObject({ code: '42501' })
    await expect(db.query('select public.claim_outcome_webhook_delivery($1, $2)', [id, KEY_A])).rejects.toMatchObject({ code: '42501' })
    await db.exec('RESET ROLE')
    // Control: the service role can.
    await db.exec('SET ROLE service_role')
    expect((await db.query('select secret from public.outcome_source_secrets')).rows).toHaveLength(1)
    await db.exec('RESET ROLE')
  })
})
