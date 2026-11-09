import { describe, it, expect } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'

// ADR-058 / the v1 release: the shipped schema is business-neutral. Business results are outcomes
// from a named source; Acuity is only a source kind.

// Names that may still say "appointment": Meta's own reported metrics, not our outcomes.
const ALLOWED = new Map<string, string>([
  ['column:daily_insights.appointment_value', 'Meta-reported action value (Meta metric name)'],
  ['column:daily_insights.appointment_value_view_through', 'Meta-reported 1d_view share of appointment_value'],
])

const NAMES_SQL = `
  select 'table:' || c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p')
  union all
  select 'view:' || c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v','m')
  union all
  select 'column:' || c.relname::text || '.' || a.attname::text from pg_attribute a
    join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p','v','m') and a.attnum > 0 and not a.attisdropped
  union all
  select 'function:' || p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'`

async function names(db: PGlite): Promise<string[]> {
  return (await db.query<{ name: string }>(NAMES_SQL)).rows.map((r) => r.name)
}

const ACCOUNT = fixtureUuid(9101)
const SOURCE = fixtureUuid(9102)

async function withSource(): Promise<PGlite> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query(
    `INSERT INTO public.outcome_sources (id, ad_account_id, kind, label, enabled)
     VALUES ($1, $2, 'acuity', 'Acuity Scheduling', true)`, [SOURCE, ACCOUNT])
  return db
}

function insertOutcome(db: PGlite, externalId: string, cols: { currency?: string; status?: string } = {}) {
  return db.query(
    `INSERT INTO public.outcomes (ad_account_id, source_id, external_id, outcome_type, currency, status)
     VALUES ($1, $2, $3, 'booking', $4, $5)`,
    [ACCOUNT, SOURCE, externalId, cols.currency ?? 'USD', cols.status ?? 'confirmed'])
}

describe('generic outcomes schema', () => {
  it('names no table, view, column or function after Acuity or appointments, outside the Meta-metric allowlist', async () => {
    const all = await names(await freshSchemaDb())
    // Control: the instrument sees the schema, including the generic objects and the allowlisted columns.
    expect(all).toEqual(expect.arrayContaining([
      'table:outcomes', 'table:outcome_sources', 'view:v_business_outcomes',
      'function:record_conversion_delivery', ...ALLOWED.keys(),
    ]))
    const offending = all.filter((n) => /acuity|appointment/i.test(n) && !ALLOWED.has(n))
    expect(offending).toEqual([])
  })

  it('the name check rejects a planted Acuity object (known-bad control)', async () => {
    const db = await freshSchemaDb()
    await db.exec('CREATE TABLE public.acuity_planted (appointment_id bigint)')
    const offending = (await names(db)).filter((n) => /acuity|appointment/i.test(n) && !ALLOWED.has(n))
    expect(offending).toEqual(['table:acuity_planted', 'column:acuity_planted.appointment_id'])
  })

  it('rejects the same (account, source, external_id) twice', async () => {
    const db = await withSource()
    await insertOutcome(db, '777000103')
    await expect(insertOutcome(db, '777000103')).rejects.toMatchObject({ code: '23505' })
    await insertOutcome(db, '777000109') // control: a different external id is accepted
    const { rows } = await db.query<{ n: number }>('select count(*)::int n from public.outcomes')
    expect(rows[0].n).toBe(2)
  })

  it('rejects a lower-case currency and a status outside the domain', async () => {
    const db = await withSource()
    await expect(insertOutcome(db, '1', { currency: 'usd' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertOutcome(db, '2', { status: 'canceled' })).rejects.toMatchObject({ code: '23514' })
    // control: valid values pass (the account's own currency: another one is refused by the
    // outcomes_account_currency trigger)
    await insertOutcome(db, '3', { currency: 'USD', status: 'cancelled' })
  })

  it('rejects an outcome whose source belongs to another account', async () => {
    const db = await withSource()
    const other = await insertAdAccount(db, fixtureUuid(9103))
    await expect(db.query(
      `INSERT INTO public.outcomes (ad_account_id, source_id, external_id, outcome_type, currency)
       VALUES ($1, $2, 'x', 'booking', 'USD')`, [other, SOURCE])).rejects.toMatchObject({ code: '23503' })
  })

  it('gives the browser roles nothing on the new objects; service_role keeps its grants', async () => {
    const db = await freshSchemaDb()
    const { rows } = await db.query<{ role: string; n: number }>(`
      select r as role,
        ((select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','v','m','p')
             and (has_table_privilege(r,c.oid,'SELECT') or has_table_privilege(r,c.oid,'INSERT')
               or has_table_privilege(r,c.oid,'UPDATE') or has_table_privilege(r,c.oid,'DELETE')))
       + (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='S' and has_sequence_privilege(r,c.oid,'USAGE'))
       + (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and has_function_privilege(r,p.oid,'EXECUTE')))::int as n
      from unnest(array['anon','authenticated']) r`)
    expect(rows).toEqual([{ role: 'anon', n: 0 }, { role: 'authenticated', n: 0 }])
    const control = await db.query<{ t: boolean; s: boolean; v: boolean; f: boolean; rls: number }>(`
      select has_table_privilege('service_role','public.outcomes','INSERT') t,
             has_table_privilege('service_role','public.outcome_sources','INSERT') s,
             has_table_privilege('service_role','public.v_business_outcomes','SELECT') v,
             has_function_privilege('service_role','public.record_conversion_delivery(uuid,text,timestamptz,numeric,text,text,integer,text,text,text)','EXECUTE') f,
             (select count(*)::int from pg_class where relname in ('outcomes','outcome_sources') and relrowsecurity) rls`)
    expect(control.rows[0]).toEqual({ t: true, s: true, v: true, f: true, rls: 2 })
  })
})
