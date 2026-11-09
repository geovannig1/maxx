import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { CsvImportError, commitCsvImport, planCsvImport } from '@/lib/outcomes/adapters/csv/import'

// The CSV import on the SHIPPED schema (the v1 release and 7.4 identity): one row per (account,
// source, external id); the same file twice gives identical counts and no new observations; a changed
// row updates in place and records one observation through the ledger's own triggers.

const ACCOUNT = fixtureUuid(9801)
const OWNER = fixtureUuid(9802)
const LOCALE = { timezone: 'America/New_York', currency: 'USD' }
const HEADER = 'external_id,outcome_type,status,occurred_at,gross_value,collected_value,origin,outcome_label'
const FILE = [
  HEADER,
  'ORD-1,sale,confirmed,2026-07-01T23:30:00-04:00,120.50,120.50,website,Gift card',
  'ORD-2,sale,confirmed,2026-07-02,999999999999999.999999,0,staff_or_manual,',
  'LEAD-3,lead,pending,2026-07-03,,,,Quote',
].join('\r\n')

let db: PGlite
let client: SupabaseClient

const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n
const counts = async () => ({
  outcomes: await count('select count(*)::int n from public.outcomes'),
  observations: await count('select count(*)::int n from public.outcome_observations'),
  collected: await count('select count(*)::int n from public.outcome_collected_value_observations'),
})

async function importFile(text: string, target: { sourceId: string } | { label: string; enabled: boolean }) {
  const sourceId = 'sourceId' in target ? target.sourceId : null
  const planned = await planCsvImport(client, { adAccountId: ACCOUNT, sourceId, text, locale: LOCALE })
  if (!planned.ok) throw new Error(`file error ${planned.fileError.code}`)
  const committed = await commitCsvImport(client, { adAccountId: ACCOUNT, target, actorUserId: OWNER, plan: planned.plan })
  return { plan: planned.plan, committed }
}

beforeEach(async () => {
  // ORD-2 exercises the stored 15+6 digit money bound, above the default outcome money ceiling.
  vi.stubEnv('OUTCOME_MONEY_CEILING', '1e16')
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  client = pgliteSupabase(db)
})

afterEach(() => vi.unstubAllEnvs())

describe('CSV import against the shipped schema', () => {
  it('creates the csv source, writes exact values and records the import', async () => {
    const { plan, committed } = await importFile(FILE, { label: 'Shop orders', enabled: true })
    expect(plan).toMatchObject({ totalRows: 3, newRows: 3, changedRows: 0, unchangedRows: 0, invalidRows: 0 })
    expect(committed).toMatchObject({ inserted: 3, updated: 0, unchanged: 0 })

    const { rows: sources } = await db.query('select id, kind, label, enabled, last_success_at is not null as touched from public.outcome_sources')
    expect(sources).toEqual([{ id: committed.sourceId, kind: 'csv', label: 'Shop orders', enabled: true, touched: true }])

    const { rows } = await db.query<Record<string, unknown>>(`
      select external_id, outcome_type, status, currency, gross_value::text g, collected_value::text c,
             business_date::text d, occurred_at = '2026-07-02T03:30:00Z'::timestamptz as exact_instant,
             origin, origin_observed_at, origin_observed_source, observation_source, outcome_label, email
        from public.outcomes order by external_id`)
    expect(rows).toEqual([
      { external_id: 'LEAD-3', outcome_type: 'lead', status: 'pending', currency: 'USD', g: null, c: null, d: '2026-07-03',
        exact_instant: false, origin: 'unknown', origin_observed_at: null, origin_observed_source: null,
        observation_source: 'csv_import', outcome_label: 'Quote', email: null },
      { external_id: 'ORD-1', outcome_type: 'sale', status: 'confirmed', currency: 'USD', g: '120.5', c: '120.5', d: '2026-07-01',
        exact_instant: true, origin: 'website', origin_observed_at: null, origin_observed_source: null,
        observation_source: 'csv_import', outcome_label: 'Gift card', email: null },
      { external_id: 'ORD-2', outcome_type: 'sale', status: 'confirmed', currency: 'USD', g: '999999999999999.999999', c: '0', d: '2026-07-02',
        exact_instant: false, origin: 'staff_or_manual', origin_observed_at: null, origin_observed_source: null,
        observation_source: 'csv_import', outcome_label: null, email: null },
    ])

    const { rows: audit } = await db.query('select ad_account_id, source_id, actor_user_id, file_sha256, file_bytes, row_count, new_count, changed_count, unchanged_count, invalid_count from public.outcome_csv_imports')
    expect(audit).toEqual([{
      ad_account_id: ACCOUNT, source_id: committed.sourceId, actor_user_id: OWNER, file_sha256: plan.fileSha256,
      file_bytes: Buffer.byteLength(FILE), row_count: 3, new_count: 3, changed_count: 0, unchanged_count: 0, invalid_count: 0,
    }])
    expect(plan.fileSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a stated website origin is recorded but never observed: the business view does not call it website', async () => {
    await importFile(FILE, { label: 'Shop', enabled: true })
    const { rows } = await db.query(`select external_id, web_origin_state from public.v_business_outcomes order by external_id`)
    expect(rows).toEqual([
      { external_id: 'LEAD-3', web_origin_state: 'origin_unknown' },
      { external_id: 'ORD-1', web_origin_state: 'origin_unknown' },
      { external_id: 'ORD-2', web_origin_state: 'staff_or_manual' },
    ])
  })

  it('importing the same file twice gives identical counts and no new observations', async () => {
    const first = await importFile(FILE, { label: 'Shop', enabled: true })
    const after1 = await counts()
    expect(after1.outcomes).toBe(3)
    expect(after1.observations).toBe(3) // one first observation per outcome
    const second = await importFile(FILE, { sourceId: first.committed.sourceId })
    expect(second.plan).toMatchObject({ totalRows: 3, newRows: 0, changedRows: 0, unchangedRows: 3 })
    expect(second.committed).toMatchObject({ inserted: 0, updated: 0, unchanged: 3 })
    expect(await counts()).toEqual(after1)
    expect(await count('select count(*)::int n from public.outcome_csv_imports')).toBe(2)
  })

  it('recognizes stored rows whose external ids contain commas, quotes, parentheses, spaces or backslashes', async () => {
    const odd = ['A,1', 'B"2', 'C(3)', 'D 4', 'E\\5', 'plain-6']
    const file = ['external_id,outcome_type,status,occurred_at',
      ...odd.map((id) => `"${id.replaceAll('"', '""')}",lead,confirmed,2026-07-01`)].join('\r\n')
    const first = await importFile(file, { label: 'Odd ids', enabled: true })
    expect(first.committed).toMatchObject({ inserted: 6 })
    const again = await importFile(file, { sourceId: first.committed.sourceId })
    expect(again.plan).toMatchObject({ newRows: 0, changedRows: 0, unchangedRows: 6 })
    expect(await count('select count(*)::int n from public.outcomes')).toBe(6)
  })

  it('treats 120.50 and 120.5 as the same value (no phantom change)', async () => {
    const first = await importFile(FILE, { label: 'Shop', enabled: true })
    const reformatted = FILE.replace('120.50,120.50', '120.5,120.500')
    const again = await importFile(reformatted, { sourceId: first.committed.sourceId })
    expect(again.plan).toMatchObject({ newRows: 0, changedRows: 0, unchangedRows: 3 })
  })

  it('a changed row updates in place and records exactly one observation of the change', async () => {
    const first = await importFile(FILE, { label: 'Shop', enabled: true })
    const before = await counts()
    const changed = FILE.replace('ORD-1,sale,confirmed,2026-07-01T23:30:00-04:00,120.50', 'ORD-1,sale,confirmed,2026-07-01T23:30:00-04:00,150.00')
    const result = await importFile(changed, { sourceId: first.committed.sourceId })
    expect(result.plan).toMatchObject({ newRows: 0, changedRows: 1, unchangedRows: 2 })
    expect(result.committed).toMatchObject({ inserted: 0, updated: 1, unchanged: 2 })
    expect(await counts()).toEqual({ ...before, observations: before.observations + 1 })
    const { rows } = await db.query(`
      select o.change_kind, o.old_gross_value::text old, o.new_gross_value::text new, o.observation_source
        from public.outcome_observations o join public.outcomes x on x.id = o.outcome_id
       where x.external_id = 'ORD-1' and o.change_kind <> 'first_observation'`)
    expect(rows).toEqual([{ change_kind: 'price_change', old: '120.5', new: '150', observation_source: 'csv_import' }])
    expect(await count(`select count(*)::int n from public.outcomes where external_id = 'ORD-1' and gross_value = 150`)).toBe(1)
  })

  it('a cancellation is a status change observation on the same row', async () => {
    const first = await importFile(FILE, { label: 'Shop', enabled: true })
    const cancelled = FILE.replace('ORD-2,sale,confirmed', 'ORD-2,sale,cancelled')
    const result = await importFile(cancelled, { sourceId: first.committed.sourceId })
    expect(result.committed).toMatchObject({ updated: 1 })
    expect(await count(`select count(*)::int n from public.outcome_observations where change_kind = 'status_change'`)).toBe(1)
    expect(await count('select count(*)::int n from public.outcomes')).toBe(3)
  })

  it('keeps one source per label and refuses another source kind or another account\'s source', async () => {
    await importFile(FILE, { label: 'Shop', enabled: false })
    const planned = await planCsvImport(client, { adAccountId: ACCOUNT, sourceId: null, text: FILE, locale: LOCALE })
    if (!planned.ok) throw new Error('plan failed')
    await expect(commitCsvImport(client, { adAccountId: ACCOUNT, target: { label: 'Shop', enabled: true }, actorUserId: OWNER, plan: planned.plan }))
      .rejects.toMatchObject({ code: 'SOURCE_LABEL_TAKEN' })

    const { rows: webhook } = await db.query<{ id: string }>(`select public.create_outcome_webhook_source($1, 'Hook', true, $2) as id`, [ACCOUNT, 'a'.repeat(64)])
    const other = fixtureUuid(9803)
    await insertAdAccount(db, other)
    const { rows: foreign } = await db.query<{ id: string }>(`insert into public.outcome_sources (ad_account_id, kind, label) values ($1, 'csv', 'Theirs') returning id`, [other])
    for (const sourceId of [webhook[0].id, foreign[0].id, fixtureUuid(9899)]) {
      await expect(planCsvImport(client, { adAccountId: ACCOUNT, sourceId, text: FILE, locale: LOCALE }))
        .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
      await expect(commitCsvImport(client, { adAccountId: ACCOUNT, target: { sourceId }, actorUserId: OWNER, plan: planned.plan }))
        .rejects.toBeInstanceOf(CsvImportError)
    }
    expect(await count('select count(*)::int n from public.outcomes')).toBe(3)
  })

  it('refuses to commit a plan with invalid rows and writes nothing', async () => {
    const bad = `${FILE}\r\nBAD-4,sale,maybe,2026-07-04,,,,`
    const planned = await planCsvImport(client, { adAccountId: ACCOUNT, sourceId: null, text: bad, locale: LOCALE })
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.plan).toMatchObject({ totalRows: 4, newRows: 3, invalidRows: 1 })
    await expect(commitCsvImport(client, { adAccountId: ACCOUNT, target: { label: 'Shop', enabled: true }, actorUserId: OWNER, plan: planned.plan }))
      .rejects.toMatchObject({ code: 'ROWS_INVALID' })
    expect(await counts()).toEqual({ outcomes: 0, observations: 0, collected: 0 })
    expect(await count('select count(*)::int n from public.outcome_sources')).toBe(0)
  })

  it('is atomic: a failing write leaves no source, outcome or audit row behind', async () => {
    const planned = await planCsvImport(client, { adAccountId: ACCOUNT, sourceId: null, text: FILE, locale: LOCALE })
    if (!planned.ok) throw new Error('plan failed')
    const broken = { ...planned.plan, fileSha256: 'not-a-hash' }
    await expect(commitCsvImport(client, { adAccountId: ACCOUNT, target: { label: 'Shop', enabled: true }, actorUserId: OWNER, plan: broken }))
      .rejects.toThrow()
    expect(await count('select count(*)::int n from public.outcome_sources')).toBe(0)
    expect(await count('select count(*)::int n from public.outcomes')).toBe(0)
    expect(await count('select count(*)::int n from public.outcome_csv_imports')).toBe(0)
  })

  it('gives the browser roles nothing on the import table or function', async () => {
    const { rows } = await db.query<{ r: string; t: boolean; f: boolean }>(`
      select r, has_table_privilege(r, 'public.outcome_csv_imports', 'SELECT') t,
             exists (select 1 from pg_proc p where p.proname = 'commit_outcome_csv_import' and has_function_privilege(r, p.oid, 'EXECUTE')) f
        from unnest(array['anon','authenticated','service_role']) r order by r`)
    expect(rows).toEqual([
      { r: 'anon', t: false, f: false }, { r: 'authenticated', t: false, f: false }, { r: 'service_role', t: true, f: true },
    ])
    expect((await db.query<{ rls: boolean }>(`select relrowsecurity rls from pg_class where oid = 'public.outcome_csv_imports'::regclass`)).rows[0].rls).toBe(true)
  })
})
