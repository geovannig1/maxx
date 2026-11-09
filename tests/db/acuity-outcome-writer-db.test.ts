import { describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { toLedgerRow, upsertAppointments } from '@/lib/outcomes/adapters/acuity/ledger'
import type { AcuityAppointmentRaw } from '@/lib/outcomes/adapters/acuity/client'

// Carried item: the REAL TypeScript writer (toLedgerRow → toOutcomeRow → upsertAppointments,
// including ensureAcuitySource) runs against the SHIPPED schema through the real Supabase SDK. Unit
// tests of the mapper cannot catch a column, constraint, trigger or conflict-target mismatch.

const ACCOUNT = fixtureUuid(9301)

async function setup(currency = 'USD'): Promise<{ db: PGlite; log: string[] }> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query('UPDATE public.ad_accounts SET currency = $1 WHERE id = $2', [currency, ACCOUNT])
  return { db, log: [] }
}

const byId = (over: Partial<AcuityAppointmentRaw> = {}): AcuityAppointmentRaw => ({
  id: 777000103,
  firstName: 'Ada', lastName: 'Example', email: 'ada@example.test', phone: '5550100',
  type: 'Studio rental', appointmentTypeID: 7, calendarID: 3,
  datetime: '2026-11-20T15:00:00-0500', datetimeCreated: '2026-11-08T14:30:00-0500',
  price: '125.00', amountPaid: '0.00', paid: 'no', canceled: false, scheduledBy: null,
  forms: [{ values: [{ name: 'fbclid', value: 'IwAR-fixture' }] }],
  ...over,
} as AcuityAppointmentRaw)

async function outcomeRows(db: PGlite) {
  return (await db.query<Record<string, unknown>>(
    `SELECT external_id, outcome_type, status, currency, gross_value::text, collected_value::text, origin,
            origin_observed_source, observation_source, business_date::text, fbclid, outcome_label
       FROM public.outcomes ORDER BY external_id`)).rows
}

const count = async (db: PGlite, sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n

describe('Acuity outcome writer against the shipped schema', () => {
  it('writes one outcome under one Acuity source with the observed values', async () => {
    const { db, log } = await setup()
    const written = await upsertAppointments([toLedgerRow(byId(), ACCOUNT, 'webhook')], pgliteSupabase(db, log))
    expect(written).toBe(1)
    expect(await outcomeRows(db)).toEqual([{
      external_id: '777000103', outcome_type: 'booking', status: 'confirmed', currency: 'USD',
      gross_value: '125', collected_value: '0', origin: 'website', origin_observed_source: 'webhook',
      observation_source: 'webhook', business_date: '2026-11-08', fbclid: 'IwAR-fixture', outcome_label: 'Studio rental',
    }])
    expect(await count(db, `select count(*)::int n from public.outcome_sources where kind = 'acuity' and enabled`)).toBe(1)
    // The observation triggers fired on the real insert.
    expect(await count(db, `select count(*)::int n from public.outcome_observations where change_kind = 'first_observation'`)).toBe(1)
    expect(await count(db, `select count(*)::int n from public.outcome_collected_value_observations`)).toBe(1)
    // Control on the instrument: the writer really went through the SDK transport.
    expect(log).toContain('POST outcomes')
  })

  it('keeps an unobserved amount paid NULL, never 0', async () => {
    const { db } = await setup()
    await upsertAppointments([toLedgerRow(byId({ amountPaid: null } as never), ACCOUNT, 'webhook')], pgliteSupabase(db))
    expect((await outcomeRows(db))[0]).toMatchObject({ collected_value: null, gross_value: '125' })
  })

  it('is idempotent: a retry and a list-shaped sweep give one row, keep the origin and log no observation', async () => {
    const { db } = await setup()
    const client = pgliteSupabase(db)
    await upsertAppointments([toLedgerRow(byId(), ACCOUNT, 'webhook')], client)
    await upsertAppointments([toLedgerRow(byId(), ACCOUNT, 'webhook')], client)
    const listShaped: Partial<AcuityAppointmentRaw> = byId()
    delete listShaped.scheduledBy
    await upsertAppointments([toLedgerRow(listShaped as AcuityAppointmentRaw, ACCOUNT, 'sweep')], client)
    const rows = await outcomeRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ origin: 'website', origin_observed_source: 'webhook', observation_source: 'sweep' })
    expect(await count(db, 'select count(*)::int n from public.outcome_observations')).toBe(1)
    expect(await count(db, `select count(*)::int n from public.outcome_sources`)).toBe(1)
  })

  it('records a cancellation as a status change on the same row (control: the log does move)', async () => {
    const { db } = await setup()
    const client = pgliteSupabase(db)
    await upsertAppointments([toLedgerRow(byId(), ACCOUNT, 'webhook')], client)
    await upsertAppointments([toLedgerRow(byId({ canceled: true }), ACCOUNT, 'webhook')], client)
    expect((await outcomeRows(db))[0]).toMatchObject({ status: 'cancelled' })
    expect((await db.query<{ change_kind: string }>(
      'select change_kind from public.outcome_observations order by id')).rows.map((r) => r.change_kind))
      .toEqual(['first_observation', 'status_change'])
  })

  it('refuses an account without a valid ISO currency instead of writing a guessed one', async () => {
    const { db } = await setup('X1')
    await expect(upsertAppointments([toLedgerRow(byId(), ACCOUNT, 'webhook')], pgliteSupabase(db)))
      .rejects.toThrow(/no valid ISO currency/)
    expect(await count(db, 'select count(*)::int n from public.outcomes')).toBe(0)
  })

  it('refuses a row with no ad account', async () => {
    const { db } = await setup()
    await expect(upsertAppointments([toLedgerRow(byId(), null, 'webhook')], pgliteSupabase(db)))
      .rejects.toThrow(/no ad account/)
  })
})
