import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureUuid, freshSchemaDb, insertAdAccount } from './schema-db'

const REPORT = '00000000-0000-4000-8000-000000000941'
const ACCOUNT = fixtureUuid(940)
// Minimal shipped-schema report: an unavailable Acuity read is the smallest valid money basis.
const UNAVAILABLE_MONEY_BASIS = { money_basis: { version: 1, basis: 'outcome_collected_value', source_available: false,
  revenue_complete: null, observed_collected_value_lower_bound: null, covered_outcomes: null, total_outcomes: null } }
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query(`INSERT INTO public.daily_reports(id,ad_account_id,report_date,report_json)
    VALUES ($1,$2,'2026-08-01',$3)`, [REPORT, ACCOUNT, UNAVAILABLE_MONEY_BASIS])
})

afterEach(async () => db.close())

async function claim() {
  return claimWithProvider('gmail_smtp')
}

async function claimWithProvider(provider: 'gmail_smtp' | 'resend') {
  return db.query<{ id: string }>(`
    INSERT INTO public.daily_digest_delivery_attempts(
      report_id,provider,recipient,payload_fingerprint,message_id
    ) VALUES ($1,$2,'owner@example.com',$3,$4)
    RETURNING id
  `, [REPORT, provider, `sha256:${'a'.repeat(64)}`, `<maxx-daily-digest-${REPORT}@gmail.com>`])
}

describe('durable daily digest delivery attempts', () => {
  it('permits only one attempt for an exact report, recipient, and payload', async () => {
    await claim()
    await expect(claim()).rejects.toThrow(/unique|duplicate/i)
  })

  it('prevents the same payload from being reclaimed through another provider', async () => {
    await claimWithProvider('gmail_smtp')
    await expect(claimWithProvider('resend')).rejects.toThrow(/unique|duplicate/i)
  })

  it('allows one claimed-to-terminal transition and then becomes immutable', async () => {
    const id = (await claim()).rows[0].id
    await db.query(`UPDATE public.daily_digest_delivery_attempts
      SET status='ambiguous', completed_at=pg_catalog.transaction_timestamp()
      WHERE id=$1`, [id])
    await expect(db.query(`UPDATE public.daily_digest_delivery_attempts
      SET status='sent', provider_message_id='later', completed_at=pg_catalog.transaction_timestamp()
      WHERE id=$1`, [id])).rejects.toThrow(/terminal|immutable/i)
    await expect(db.exec('DELETE FROM public.daily_digest_delivery_attempts'))
      .rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec('TRUNCATE public.daily_digest_delivery_attempts'))
      .rejects.toThrow(/append-only|truncate|immutable/i)
  })

  it('allows only service-role reads, claims, and guarded completion updates', async () => {
    const row = (await db.query<Record<string, unknown>>(`SELECT
      (SELECT relrowsecurity FROM pg_catalog.pg_class
        WHERE oid='public.daily_digest_delivery_attempts'::pg_catalog.regclass) rls,
      has_table_privilege('service_role','public.daily_digest_delivery_attempts','SELECT') service_select,
      has_table_privilege('service_role','public.daily_digest_delivery_attempts','INSERT') service_insert,
      has_table_privilege('service_role','public.daily_digest_delivery_attempts','UPDATE') service_update,
      has_table_privilege('service_role','public.daily_digest_delivery_attempts','DELETE') service_delete,
      has_table_privilege('authenticated','public.daily_digest_delivery_attempts','SELECT') authenticated_select,
      has_table_privilege('anon','public.daily_digest_delivery_attempts','SELECT') anon_select
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
