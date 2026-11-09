import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'

// Owner-only management of webhook sources: the secret is returned once at creation and once per
// rotation, never stored anywhere a browser role can read, and never returned by a read.

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null, email: 'owner@example.test' as string | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.email ? { email: state.email, email_confirmed_at: '2026-01-01T00:00:00Z' } : null } }) },
  }),
}))

import { POST as create } from '@/app/api/outcomes/webhook-sources/route'
import { POST as rotate } from '@/app/api/outcomes/webhook-sources/[sourceId]/rotate/route'

const ACCOUNT = fixtureUuid(9601)
let db: PGlite

const createReq = (body: unknown) => create(new Request('http://localhost/api/outcomes/webhook-sources', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}))
const rotateReq = (id: string) => rotate(new Request(`http://localhost/api/outcomes/webhook-sources/${id}/rotate`, { method: 'POST' }),
  { params: Promise.resolve({ sourceId: id }) })

beforeEach(async () => {
  process.env.OWNER_EMAIL = 'owner@example.test'
  state.email = 'owner@example.test'
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  state.client = pgliteSupabase(db)
})
afterEach(() => { delete process.env.OWNER_EMAIL })

describe('webhook source management', () => {
  it('creates a disabled source by default and returns a 32-byte hex secret once, uncached', async () => {
    const res = await createReq({ label: 'Shop' })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await res.json()
    expect(body).toMatchObject({ enabled: false, signature_header: 'x-maxx-signature', path: `/api/outcomes/webhook/${body.source_id}` })
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/)
    const { rows } = await db.query<{ kind: string; enabled: boolean; secret: string }>(
      `select s.kind, s.enabled, k.secret from public.outcome_sources s join public.outcome_source_secrets k on k.source_id = s.id`)
    expect(rows).toEqual([{ kind: 'webhook', enabled: false, secret: body.secret }])
    // The secret is not in the source's config (which other screens may read).
    expect(JSON.stringify((await db.query('select config from public.outcome_sources')).rows)).not.toContain(body.secret)
  })

  it('gives every source its own random secret', async () => {
    const a = await (await createReq({ label: 'A', enabled: true })).json()
    const b = await (await createReq({ label: 'B', enabled: true })).json()
    expect(a.secret).not.toBe(b.secret)
  })

  it('rotates a secret: a new value is returned once and the stored secret changes', async () => {
    const created = await (await createReq({ label: 'Shop', enabled: true })).json()
    const res = await rotateReq(created.source_id)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const rotated = await res.json()
    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(rotated.secret).not.toBe(created.secret)
    expect((await db.query<{ secret: string }>('select secret from public.outcome_source_secrets')).rows).toEqual([{ secret: rotated.secret }])
  })

  it('refuses to rotate an unknown id, a non-webhook source and another account\'s source', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.outcome_sources (ad_account_id, kind, label) values ($1, 'acuity', 'Acuity') returning id`, [ACCOUNT])
    const other = fixtureUuid(9602)
    await insertAdAccount(db, other)
    await db.query('update public.ad_accounts set is_active = false where id = $1', [other])
    const { rows: foreign } = await db.query<{ id: string }>(
      `select public.create_outcome_webhook_source($1, 'Other', true, $2) as id`, [other, 'f'.repeat(64)])
    for (const id of [fixtureUuid(9699), rows[0].id, foreign[0].id, 'not-a-uuid']) {
      expect((await rotateReq(id)).status).toBe(404)
    }
    expect((await db.query<{ secret: string }>('select secret from public.outcome_source_secrets')).rows).toEqual([{ secret: 'f'.repeat(64) }])
  })

  it.each([[{}], [{ label: '' }], [{ label: 'x', secret: 'short' }], [{ label: 'x', enabled: 'yes' }]])(
    'rejects body %j without creating anything', async (body) => {
      expect((await createReq(body)).status).toBe(400)
      expect((await db.query<{ n: number }>('select count(*)::int n from public.outcome_sources')).rows[0].n).toBe(0)
    })

  it.each([[null, 401], ['someone@example.test', 403]])('refuses a %s session with %i', async (email, status) => {
    state.email = email
    expect((await createReq({ label: 'Shop' })).status).toBe(status)
    expect((await rotateReq(fixtureUuid(9699))).status).toBe(status)
  })
})
