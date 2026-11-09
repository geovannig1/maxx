import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureUuid, freshSchemaDb, insertAdAccount } from './schema-db'

const REPORT = '00000000-0000-4000-8000-000000001081'
const ACCOUNT = fixtureUuid(1080)
// Minimal shipped-schema report: an unavailable Acuity read is the smallest valid money basis.
const UNAVAILABLE_MONEY_BASIS = { money_basis: { version: 1, basis: 'outcome_collected_value', source_available: false,
  revenue_complete: null, observed_collected_value_lower_bound: null, covered_outcomes: null, total_outcomes: null } }
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query(`INSERT INTO public.weekly_reports(id,ad_account_id,week_start,week_end,report_json)
    VALUES ($1,$2,'2026-08-10','2026-08-16',$3)`, [REPORT, ACCOUNT, UNAVAILABLE_MONEY_BASIS])
})

afterEach(async () => db.close())

async function claim(fingerprint = `sha256:${'a'.repeat(64)}`, provider = 'gmail_smtp') {
  return db.query<{ id: string }>(`
    INSERT INTO public.weekly_executive_delivery_attempts(
      report_id,provider,recipient,payload_fingerprint,message_id
    ) VALUES ($1,$2,'owner@example.com',$3,$4)
    RETURNING id
  `, [REPORT, provider, fingerprint, `<maxx-weekly-executive-${REPORT}@gmail.com>`])
}

describe('durable weekly executive delivery attempts', () => {
  it('installs exactly the row guard and truncate guard triggers', async () => {
    const triggers = await db.query<{ count: number }>(`SELECT count(*)::int count
      FROM pg_catalog.pg_trigger
      WHERE tgrelid='public.weekly_executive_delivery_attempts'::pg_catalog.regclass
        AND NOT tgisinternal`)
    expect(triggers.rows[0].count).toBe(2)
  })

  it('permits one lifetime attempt per committed report and recipient, regardless of payload/provider', async () => {
    await claim()
    await expect(claim(`sha256:${'b'.repeat(64)}`, 'resend')).rejects.toThrow(/unique|duplicate/i)
  })

  it('allows one claimed-to-terminal transition and rejects retries, deletes, and truncates', async () => {
    const id = (await claim()).rows[0].id
    await db.query(`UPDATE public.weekly_executive_delivery_attempts
      SET status='ambiguous', completed_at=pg_catalog.transaction_timestamp() WHERE id=$1`, [id])
    await expect(db.query(`UPDATE public.weekly_executive_delivery_attempts
      SET status='sent', completed_at=pg_catalog.transaction_timestamp() WHERE id=$1`, [id]))
      .rejects.toThrow(/terminal|immutable/i)
    await expect(db.exec('DELETE FROM public.weekly_executive_delivery_attempts'))
      .rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec('TRUNCATE public.weekly_executive_delivery_attempts'))
      .rejects.toThrow(/append-only|truncate|immutable/i)
  })

  it('allows only service-role reads, claims, and guarded completion updates', async () => {
    const row = (await db.query<Record<string, unknown>>(`SELECT
      (SELECT relrowsecurity FROM pg_catalog.pg_class
        WHERE oid='public.weekly_executive_delivery_attempts'::pg_catalog.regclass) rls,
      has_table_privilege('service_role','public.weekly_executive_delivery_attempts','SELECT') service_select,
      has_table_privilege('service_role','public.weekly_executive_delivery_attempts','INSERT') service_insert,
      has_table_privilege('service_role','public.weekly_executive_delivery_attempts','UPDATE') service_update,
      has_table_privilege('service_role','public.weekly_executive_delivery_attempts','DELETE') service_delete,
      has_table_privilege('authenticated','public.weekly_executive_delivery_attempts','SELECT') authenticated_select,
      has_table_privilege('anon','public.weekly_executive_delivery_attempts','SELECT') anon_select
    `)).rows[0]
    expect(row).toEqual({
      rls: true,
      service_select: true,
      service_insert: true,
      service_update: true,
      service_delete: false,
      authenticated_select: false,
      anon_select: false,
    })
  })
})
