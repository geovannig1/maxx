import { describe, expect, it } from 'vitest'
import { freshSchemaDb } from './schema-db'

// every SECURITY DEFINER function pins search_path with pg_catalog first and pg_temp LAST.
// Without an explicit pg_temp, Postgres searches the caller's temporary schema FIRST for tables, so a
// caller could shadow a table an unqualified definer statement reads.

describe('SECURITY DEFINER search_path', () => {
  it('pins pg_catalog first and pg_temp last on every definer function', async () => {
    const db = await freshSchemaDb()
    const { rows } = await db.query<{ name: string; path: string | null }>(`
      SELECT p.proname AS name,
             (SELECT substring(c FROM 'search_path=(.*)') FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS path
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`)
    expect(rows.length).toBeGreaterThan(60)
    const unsafe = rows.filter((row) => {
      const parts = (row.path ?? '').split(',').map((part) => part.trim().replace(/^"|"$/g, ''))
      return parts[0] !== 'pg_catalog' || parts[parts.length - 1] !== 'pg_temp'
    })
    expect(unsafe.map((row) => `${row.name}: ${row.path}`)).toEqual([])
  })
})
