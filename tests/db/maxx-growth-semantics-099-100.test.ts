import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb } from './schema-db'

let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
})

describe('custom-audience diagnostic evidence', () => {
  it('adds the live health, size, source-spec, and freshness fields', async () => {
    const result = await db.query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'custom_audiences'
    `)
    expect(Object.fromEntries(result.rows.map((row) => [row.column_name, row.data_type]))).toMatchObject({
      approximate_count_lower_bound: 'bigint',
      approximate_count_upper_bound: 'bigint',
      retention_days: 'integer',
      lookalike_spec: 'jsonb',
      operation_status: 'jsonb',
      delivery_status: 'jsonb',
      meta_updated_at: 'timestamp with time zone',
    })
  })
})

describe('checkout-revenue semantics', () => {
  // A pre-squash migration first wrote these comments; the money_basis_version rule replaced them with
  // the versioned rule below. The intent is unchanged: say which rows hold checkout revenue and which hold booked value.
  it('marks both legacy-named report columns with the versioned money-basis rule', async () => {
    const result = await db.query<{ table_name: string; comment: string }>(`
      SELECT c.relname AS table_name,
             col_description(c.oid, a.attnum) AS comment
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname IN ('daily_reports', 'weekly_reports')
        AND a.attname = 'business_revenue'
      ORDER BY c.relname
    `)
    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.comment).toMatch(/versioned checkout revenue/i)
      expect(row.comment).toMatch(/money_basis_version\s*=\s*1/i)
      expect(row.comment).toMatch(/legacy v0 rows may contain scheduled booked value/i)
    }
  })
})

describe('app_settings service-role contract', () => {
  it('grants service_role the operational access needed for acuity_ledger_health', async () => {
    const result = await db.query<{ can_select: boolean; can_insert: boolean; can_update: boolean; comment: string }>(`
      SELECT has_table_privilege('service_role', 'public.app_settings', 'SELECT') AS can_select,
             has_table_privilege('service_role', 'public.app_settings', 'INSERT') AS can_insert,
             has_table_privilege('service_role', 'public.app_settings', 'UPDATE') AS can_update,
             obj_description('public.app_settings'::regclass, 'pg_class') AS comment
    `)
    expect(result.rows[0]).toMatchObject({ can_select: true, can_insert: true, can_update: true })
    expect(result.rows[0].comment).toMatch(/acuity_ledger_health/i)
  })
})
