import { describe, it, expect } from 'vitest'
import { freshSchemaDb, insertAdAccount, fixtureUuid, migrationFiles, migrationSql } from './schema-db'

// The harness every database test relies on. It must build the shipped schema, isolate each test,
// and preserve the security posture the baseline promises.
describe('schema-db harness', () => {
  it('loads every shipped migration', () => {
    expect(migrationFiles().length).toBeGreaterThan(0)
    expect(migrationSql()).toContain('CREATE TABLE public.ad_accounts')
  })

  it('builds the full schema with row-level security on every table', async () => {
    const db = await freshSchemaDb()
    const { rows } = await db.query<{ tables: number; rls_off: number }>(
      `select count(*)::int as tables,
              count(*) filter (where not c.relrowsecurity)::int as rls_off
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`)
    expect(rows[0].tables).toBeGreaterThan(50)
    expect(rows[0].rls_off).toBe(0)
  })

  it('gives the browser roles no privilege on any table, sequence or function', async () => {
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
    // Control: the same instrument sees the application role's privileges.
    const control = await db.query<{ ok: boolean }>(`select has_table_privilege('service_role','public.ad_accounts','SELECT') as ok`)
    expect(control.rows[0].ok).toBe(true)
  })

  // A policy for a browser role is inert only while that role holds no table privilege. Keeping none
  // means a future grant cannot silently expose every row (`USING (true)`) to any signed-in user.
  it('defines no row-level policy for the browser roles or PUBLIC', async () => {
    const db = await freshSchemaDb()
    const { rows } = await db.query<{ policy: string }>(`
      select tablename || '.' || policyname as policy from pg_policies
       where schemaname = 'public' and roles && array['anon','authenticated','public']::name[]
       order by 1`)
    expect(rows).toEqual([])
    // Control: the same instrument sees the application role's policies.
    const control = await db.query<{ n: number }>(`
      select count(*)::int as n from pg_policies
       where schemaname = 'public' and roles && array['service_role']::name[]`)
    expect(control.rows[0].n).toBeGreaterThan(0)
  })

  it('isolates each database: rows written in one are absent from the next', async () => {
    const first = await freshSchemaDb()
    await insertAdAccount(first, fixtureUuid(1))
    expect((await first.query('select * from public.ad_accounts')).rows).toHaveLength(1)
    const second = await freshSchemaDb()
    expect((await second.query('select * from public.ad_accounts')).rows).toHaveLength(0)
  })
})

describe('schema-db roles mirror Supabase', () => {
  it('lets service_role bypass row-level security and gives the browser roles no bypass', async () => {
    const db = await freshSchemaDb()
    const { rows } = await db.query<{ rolname: string; rolbypassrls: boolean }>(
      `select rolname, rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role') order by rolname`)
    expect(rows).toEqual([
      { rolname: 'anon', rolbypassrls: false },
      { rolname: 'authenticated', rolbypassrls: false },
      { rolname: 'service_role', rolbypassrls: true },
    ])
  })
})
