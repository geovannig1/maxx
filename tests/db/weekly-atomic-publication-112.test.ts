import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000001120'
const EVIDENCE = '00000000-0000-4000-8000-000000001121'
const FIRST = '00000000-0000-4000-8000-000000001122'
const SECOND = '00000000-0000-4000-8000-000000001123'
let db: PGlite
// The shipped weekly_reports table requires a money basis on every row; an unavailable Acuity read is
// the smallest valid one.
const MONEY_BASIS = { version: 1, basis: 'outcome_collected_value', source_available: false,
  revenue_complete: null, observed_collected_value_lower_bound: null, covered_outcomes: null, total_outcomes: null }

function payload(id: string, summary: string) {
  return {
    id,
    summary_text: summary,
    full_report_md: summary,
    report_json: {
      money_basis: MONEY_BASIS,
      weeklyDigest: {
        contract_version: 1,
        weekly_report_id: id,
        week_start: '2026-08-10',
        week_end: '2026-08-16',
      },
    },
    total_spend: 100,
    total_leads: 2,
    total_bookings: 1,
    business_outcomes: null,
    business_revenue: null,
    avg_cpl: 50,
    avg_cpb: 100,
    ga4_bookings: 0,
    ga4_revenue: 0,
    prev_total_spend: 90,
    prev_total_bookings: 1,
    model_used: 'deterministic-weekly-v1',
    generated_at: '2026-08-17T10:00:00.000Z',
    executive_evidence_generation_id: EVIDENCE,
  }
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await db.query(`INSERT INTO public.executive_evidence_generations(
      id,ad_account_id,report_date,contract_version,evidence_json,evidence_fingerprint,source_generated_at
    ) VALUES ($1,$2,'2026-08-16',1,$3::jsonb,$4,'2026-08-17T09:00:00.000Z')`, [EVIDENCE, ACCOUNT, JSON.stringify({
    contract: 'executive_evidence_snapshot', version: 1, generatedAt: '2026-08-17T09:00:00.000Z',
    account: { id: ACCOUNT, name: 'Studio', timezone: 'America/New_York' }, lastCompleteDate: '2026-08-16',
    authority: { tier: 'diagnostic_only', moneyActionsAuthorized: false },
  }), `sha256:${'a'.repeat(64)}`])
})

afterEach(async () => db.close())

async function commit(value: Record<string, unknown>) {
  return db.query<{ id: string }>(`
    SELECT public.commit_weekly_executive_report($1,$2,$3,$4::jsonb) id
  `, [ACCOUNT, '2026-08-10', '2026-08-16', JSON.stringify(value)])
}

describe('atomic weekly report publication', () => {
  it('commits the first immutable snapshot and returns it unchanged to a racing retry', async () => {
    expect((await commit(payload(FIRST, 'first'))).rows[0].id).toBe(FIRST)
    expect((await commit(payload(SECOND, 'second'))).rows[0].id).toBe(FIRST)

    const rows = await db.query<{ id: string; summary_text: string; count: number }>(`
      SELECT min(id::text) id, min(summary_text) summary_text, count(*)::int count
      FROM public.weekly_reports WHERE ad_account_id=$1 AND week_start='2026-08-10'
    `, [ACCOUNT])
    expect(rows.rows[0]).toEqual({ id: FIRST, summary_text: 'first', count: 1 })
  })

  it('rejects malformed identity/evidence and direct identity rewrites', async () => {
    await expect(commit({ ...payload(FIRST, 'bad'), executive_evidence_generation_id: SECOND }))
      .rejects.toThrow(/evidence/i)
    await commit(payload(FIRST, 'first'))
    await expect(db.query(`UPDATE public.weekly_reports SET id=$2 WHERE id=$1`, [FIRST, SECOND]))
      .rejects.toThrow(/identity.*immutable/i)
  })

  it('rejects a pre-existing legacy row instead of treating it as a successful retry', async () => {
    await db.query(`INSERT INTO public.weekly_reports(
      id,ad_account_id,week_start,week_end,report_json,model_used
    ) VALUES ($1,$2,'2026-08-10','2026-08-16',$3::jsonb,'legacy-weekly')`,
    [FIRST, ACCOUNT, JSON.stringify({ money_basis: MONEY_BASIS })])

    await expect(commit(payload(SECOND, 'current'))).rejects.toThrow(/existing weekly report.*not current/i)
  })

  it('exposes only the locked service-role RPC', async () => {
    const contract = (await db.query<Record<string, unknown>>(`SELECT
      p.prosecdef security_definer,
      pg_catalog.array_to_string(p.proconfig, ',') NOT LIKE '%public%' safe_path,
      pg_catalog.pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%' has_lock,
      has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_execute
      FROM pg_catalog.pg_proc p
      WHERE p.oid='public.commit_weekly_executive_report(uuid,date,date,jsonb)'::pg_catalog.regprocedure
    `)).rows[0]
    expect(contract).toEqual({
      security_definer: true,
      safe_path: true,
      has_lock: true,
      service_execute: true,
      authenticated_execute: false,
      anon_execute: false,
    })
    const privileges = (await db.query<Record<string, unknown>>(`SELECT
      has_table_privilege('service_role','public.weekly_reports','SELECT') service_select,
      has_table_privilege('service_role','public.weekly_reports','INSERT') service_insert,
      has_table_privilege('service_role','public.weekly_reports','UPDATE') service_update,
      has_table_privilege('service_role','public.weekly_reports','DELETE') service_delete
    `)).rows[0]
    expect(privileges).toMatchObject({
      service_insert: false, service_update: false, service_delete: false,
    })
  })
})
