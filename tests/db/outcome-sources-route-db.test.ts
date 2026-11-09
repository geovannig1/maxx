import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'

// Enable/disable toggle for an outcome source after creation, plus a sources screen.
// Owner-only, same-origin, rate-limited, scoped to the sole active account, and it never returns a
// source's secret or config. Runs the real routes against the shipped schema.

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null, email: 'owner@example.test' as string | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.email ? { id: 'u-1', email: state.email, email_confirmed_at: '2026-01-01T00:00:00Z' } : null } }) },
  }),
}))

import { GET as list } from '@/app/api/outcomes/sources/route'
import { PATCH as toggle } from '@/app/api/outcomes/sources/[sourceId]/route'

const ACCOUNT = fixtureUuid(9701)
const OTHER = fixtureUuid(9702)
let db: PGlite

async function source(account: string, kind: string, label: string, enabled: boolean): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.outcome_sources (ad_account_id, kind, label, enabled, config) VALUES ($1, $2, $3, $4, '{"secret_env":"ACUITY_API_KEY"}') RETURNING id`,
    [account, kind, label, enabled])
  return rows[0].id
}

const patch = (id: string, body: unknown, headers: Record<string, string> = {}) => toggle(
  new Request(`http://localhost/api/outcomes/sources/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }),
  { params: Promise.resolve({ sourceId: id }) })
const enabledOf = async (id: string) => (await db.query<{ enabled: boolean }>('select enabled from public.outcome_sources where id = $1', [id])).rows[0]?.enabled

beforeEach(async () => {
  process.env.OWNER_EMAIL = 'owner@example.test'
  state.email = 'owner@example.test'
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query(`INSERT INTO public.ad_accounts (id, account_id, account_name, timezone_name, is_active) VALUES ($1, 'act_2', 'Inactive', 'America/New_York', false)`, [OTHER])
  state.client = pgliteSupabase(db)
})
afterEach(() => { delete process.env.OWNER_EMAIL })

describe('outcome sources screen API', () => {
  it('lists the active account sources without config or secrets', async () => {
    const id = await source(ACCOUNT, 'webhook', 'Shop', true)
    await source(OTHER, 'csv', 'Other account', true)
    const res = await list()
    expect(res.status).toBe(200)
    const body = await res.json() as { sources: Array<Record<string, unknown>> }
    expect(body.sources).toEqual([expect.objectContaining({ id, kind: 'webhook', label: 'Shop', enabled: true })])
    expect(JSON.stringify(body)).not.toContain('secret_env')
  })

  it('enables and disables a source of the active account', async () => {
    const id = await source(ACCOUNT, 'csv', 'Export', false)
    const on = await patch(id, { enabled: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ source: { id, enabled: true } })
    expect(await enabledOf(id)).toBe(true)
    expect((await patch(id, { enabled: false })).status).toBe(200)
    expect(await enabledOf(id)).toBe(false)
  })

  it("refuses another account's source as not found and leaves it unchanged", async () => {
    const foreign = await source(OTHER, 'webhook', 'Foreign', false)
    expect((await patch(foreign, { enabled: true })).status).toBe(404)
    expect(await enabledOf(foreign)).toBe(false)
  })

  it('rejects a bad body, a non-uuid id, a non-owner and no session', async () => {
    const id = await source(ACCOUNT, 'webhook', 'Shop', true)
    expect((await patch(id, { enabled: 'yes' })).status).toBe(400)
    expect((await patch(id, { enabled: true, label: 'x' })).status).toBe(400)
    expect((await patch('not-a-uuid', { enabled: true })).status).toBe(400)
    state.email = 'intruder@example.test'
    expect((await patch(id, { enabled: false })).status).toBe(403)
    expect((await list()).status).toBe(403)
    state.email = null
    expect((await patch(id, { enabled: false })).status).toBe(401)
    expect(await enabledOf(id)).toBe(true)
  })

  it('refuses a cross-origin request before any change', async () => {
    const id = await source(ACCOUNT, 'webhook', 'Shop', true)
    expect((await patch(id, { enabled: false }, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await patch(id, { enabled: false }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect(await enabledOf(id)).toBe(true)
  })

  it('is rate limited per owner', async () => {
    const id = await source(ACCOUNT, 'webhook', 'Shop', true)
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push((await patch(id, { enabled: i % 2 === 0 })).status)
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})
