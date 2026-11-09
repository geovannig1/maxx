import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { MAX_CSV_BYTES } from '@/lib/outcomes/adapters/csv/contract'

// Owner-only CSV import routes on the shipped schema: auth, same-origin, size limit, rate limit,
// preview before commit (the commit must name the previewed file's hash) and redacted errors.

const OWNER_ID = fixtureUuid(9902)
const state = vi.hoisted(() => ({
  client: null as SupabaseClient | null,
  email: 'owner@example.test' as string | null,
}))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.email ? { id: '00000000-0000-4000-8000-000000009902', email: state.email, email_confirmed_at: '2026-01-01T00:00:00Z' } : null } }) },
  }),
}))

import { POST as preview } from '@/app/api/outcomes/csv-imports/preview/route'
import { POST as commit } from '@/app/api/outcomes/csv-imports/commit/route'

const ACCOUNT = fixtureUuid(9901)
const FILE = 'external_id,outcome_type,status,occurred_at,gross_value\r\nA1,sale,confirmed,2026-07-01,10.00\r\nA2,lead,pending,2026-07-02,\r\n'
let db: PGlite

const call = (handler: typeof preview, query: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost/api/outcomes/csv-imports/x?${query}`, {
    method: 'POST', body, headers: { 'content-type': 'text/csv', ...headers },
  }))
const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> })

beforeEach(async () => {
  process.env.OWNER_EMAIL = 'owner@example.test'
  state.email = 'owner@example.test'
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  state.client = pgliteSupabase(db)
})
afterEach(() => { delete process.env.OWNER_EMAIL })

describe('CSV import routes', () => {
  it('previews without writing, then commits the previewed file into a new source', async () => {
    const p = await json(await call(preview, 'label=Orders', FILE))
    expect(p.status).toBe(200)
    expect(p.body).toMatchObject({
      counts: { total: 2, new: 2, changed: 0, unchanged: 0, invalid: 0 }, errors: [], errors_truncated: false,
      file: { bytes: Buffer.byteLength(FILE) }, timezone: 'America/New_York',
    })
    expect((p.body.rows as unknown[]).length).toBe(2)
    expect((await db.query('select * from public.outcomes')).rows).toHaveLength(0)
    expect((await db.query('select * from public.outcome_sources')).rows).toHaveLength(0)

    const sha = (p.body.file as { sha256: string }).sha256
    const c = await json(await call(commit, `label=Orders&enabled=true&sha256=${sha}`, FILE))
    expect(c.status).toBe(200)
    expect(c.body).toMatchObject({ counts: { total: 2, new: 2, changed: 0, unchanged: 0, invalid: 0 } })
    const { rows } = await db.query<{ actor_user_id: string; file_sha256: string }>('select actor_user_id, file_sha256 from public.outcome_csv_imports')
    expect(rows).toEqual([{ actor_user_id: OWNER_ID, file_sha256: sha }])

    // The same file again into the same source: identical counts, nothing new.
    const again = await json(await call(commit, `source=${c.body.source_id}&sha256=${sha}`, FILE))
    expect(again.body).toMatchObject({ counts: { total: 2, new: 0, changed: 0, unchanged: 2, invalid: 0 } })
    expect((await db.query('select * from public.outcomes')).rows).toHaveLength(2)
  })

  it('refuses a commit whose file differs from the previewed hash', async () => {
    const res = await json(await call(commit, `label=Orders&enabled=true&sha256=${'0'.repeat(64)}`, FILE))
    expect(res).toMatchObject({ status: 409, body: { code: 'FILE_CHANGED' } })
    expect((await db.query('select * from public.outcome_sources')).rows).toHaveLength(0)
  })

  it('returns row errors with row numbers and refuses to commit a file that has any', async () => {
    const bad = FILE + 'A3,sale,maybe,2026-07-03,"1,000"\r\n'
    const p = await json(await call(preview, '', bad))
    expect(p.body).toMatchObject({ counts: { total: 3, new: 2, invalid: 1 } })
    expect(p.body.errors).toEqual([
      expect.objectContaining({ row: 4, field: 'status', code: 'invalid_choice' }),
      expect.objectContaining({ row: 4, field: 'gross_value', code: 'decimal_separator' }),
    ])
    const sha = (p.body.file as { sha256: string }).sha256
    expect(await json(await call(commit, `label=Orders&enabled=true&sha256=${sha}`, bad)))
      .toMatchObject({ status: 422, body: { code: 'ROWS_INVALID' } })
    expect((await db.query('select * from public.outcomes')).rows).toHaveLength(0)
  })

  it('reports a file-level problem as 422 with its code', async () => {
    expect(await json(await call(preview, '', 'id,type\r\n1,2\r\n')))
      .toMatchObject({ status: 422, body: { code: 'CSV_FILE_INVALID', file_error: { code: 'unknown_columns' } } })
  })

  it('refuses a body over the size limit before parsing it', async () => {
    const big = 'x'.repeat(MAX_CSV_BYTES + 1)
    expect((await call(preview, '', big)).status).toBe(413)
    expect((await call(preview, '', 'abc', { 'content-length': String(MAX_CSV_BYTES + 1) })).status).toBe(413)
  })

  it('refuses a non-CSV content type and malformed query parameters', async () => {
    expect((await call(preview, '', FILE, { 'content-type': 'application/json' })).status).toBe(415)
    expect((await call(preview, 'source=not-a-uuid', FILE)).status).toBe(400)
    expect((await call(commit, 'label=Orders&enabled=true', FILE)).status).toBe(400)
    expect((await call(commit, `label=&enabled=true&sha256=${'a'.repeat(64)}`, FILE)).status).toBe(400)
    expect((await call(commit, `source=${fixtureUuid(1)}&label=x&sha256=${'a'.repeat(64)}`, FILE)).status).toBe(400)
  })

  it('answers 404 for an unknown or non-csv source and 409 for a taken label', async () => {
    expect((await call(preview, `source=${fixtureUuid(9999)}`, FILE)).status).toBe(404)
    await db.query(`insert into public.outcome_sources (ad_account_id, kind, label) values ($1, 'csv', 'Orders')`, [ACCOUNT])
    expect(await json(await call(preview, 'label=Orders', FILE))).toMatchObject({ status: 409, body: { code: 'SOURCE_LABEL_TAKEN' } })
  })

  it.each([[null, 401], ['someone@example.test', 403]])('refuses a %s session with %i and writes nothing', async (email, status) => {
    state.email = email
    expect((await call(preview, '', FILE)).status).toBe(status)
    expect((await call(commit, `label=Orders&enabled=true&sha256=${'a'.repeat(64)}`, FILE)).status).toBe(status)
    expect((await db.query('select * from public.outcome_sources')).rows).toHaveLength(0)
  })

  it('refuses a cross-site request', async () => {
    expect((await call(preview, '', FILE, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await call(commit, '', FILE, { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('rate limits previews per owner', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 61; i++) statuses.push((await call(preview, '', FILE)).status)
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
  })

  it('never returns database error text to the browser', async () => {
    const real = state.client!
    state.client = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc') {
          return async (name: string, args: unknown) => name === 'commit_outcome_csv_import'
            ? { data: null, error: { message: 'relation "internal_table_x" violates constraint secret_detail', code: 'XX000' } }
            : target.rpc(name as never, args as never)
        }
        return Reflect.get(target, prop)
      },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = await json(await call(preview, '', FILE))
    const res = await call(commit, `label=Orders&enabled=true&sha256=${(p.body.file as { sha256: string }).sha256}`, FILE)
    const text = await res.text()
    expect(res.status).toBe(500)
    expect(text).not.toContain('internal_table_x')
    expect(JSON.parse(text)).toMatchObject({ code: 'CSV_IMPORT_FAILED' })
    // The server log names the failure but never a cell value from the file.
    expect(spy.mock.calls.flat().join(' ')).not.toContain('A1')
    spy.mockRestore()
  })
})
