import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb } from './schema-db'

// Old vocabulary at the data layer, migration 20261110000300: the generic outcome ledgers, RPC
// parameters and value domains use outcome vocabulary. Meta's own metric columns (bookings,
// appointment_value) are Meta delivery vocabulary and out of scope here.

const OLD_COLUMN = '^(amount_paid|canceled|old_price|new_price|old_amount_paid|new_amount_paid|old_canceled|new_canceled)$'
const OLD_PARAM = '\\m(p_amount_paid|p_canceled)\\M'
const OLD_VALUE = "(outcome_appointments_api|outcome_booking_time_block|appointment_actual_entries|outcome_amount_paid_checkout|amount_paid_change|appointment_link_evaluation|amount_paid_observation|observed_amount_paid_lower_bound|amount_paid_lineage_incomplete|appointment_eligibility_inputs_incomplete)"

async function offenders(db: PGlite): Promise<string[]> {
  const columns = await db.query<{ o: string }>(
    `select table_name || '.' || column_name o from information_schema.columns where table_schema = 'public' and column_name ~ $1`, [OLD_COLUMN])
  const params = await db.query<{ o: string }>(
    `select proname || '(' || pg_get_function_identity_arguments(oid) || ')' o from pg_proc
      where pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) ~ $1`, [OLD_PARAM])
  const values = await db.query<{ o: string }>(
    `select conrelid::regclass::text || ' ' || conname o from pg_constraint
      where connamespace = 'public'::regnamespace and pg_get_constraintdef(oid) ~ $1
     union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~ $1
     union all select 'default ' || table_name || '.' || column_name from information_schema.columns
      where table_schema = 'public' and column_default ~ $1`, [OLD_VALUE])
  return [...columns.rows, ...params.rows, ...values.rows].map((r) => r.o).sort()
}

describe('outcome vocabulary in the shipped schema', () => {
  let db: PGlite
  beforeAll(async () => { db = await freshSchemaDb() })
  afterAll(async () => db.close())

  it('has no old appointment/Acuity column, RPC parameter, value domain, default or function literal', async () => {
    expect(await offenders(db)).toEqual([])
  })

  it('the renamed columns exist (control)', async () => {
    const { rows } = await db.query<{ c: string }>(
      `select table_name || '.' || column_name c from information_schema.columns where table_schema = 'public'
        and column_name in ('old_gross_value', 'new_cancelled', 'old_collected_value', 'collected_value', 'cancelled')
        and table_name in ('outcome_observations', 'outcome_collected_value_observations', 'paid_outcome_eligibility_inputs')
        order by 1`)
    expect(rows.map((r) => r.c)).toEqual([
      'outcome_collected_value_observations.new_cancelled', 'outcome_collected_value_observations.old_collected_value',
      'outcome_observations.new_cancelled', 'outcome_observations.old_gross_value',
      'paid_outcome_eligibility_inputs.cancelled', 'paid_outcome_eligibility_inputs.collected_value',
    ])
  })

  it('reports a planted old name (known-bad control)', async () => {
    await db.exec(`BEGIN; CREATE TABLE public.zz_planted (amount_paid numeric, kind text CHECK (kind = 'outcome_appointments_api'));
      CREATE FUNCTION public.zz_planted_fn(p_canceled boolean) RETURNS boolean LANGUAGE sql AS 'select p_canceled';`)
    try {
      expect(await offenders(db)).toEqual(expect.arrayContaining(['zz_planted.amount_paid', 'zz_planted_fn(p_canceled boolean)']))
      expect((await offenders(db)).some((o) => o.startsWith('zz_planted zz_planted_kind_check'))).toBe(true)
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})
