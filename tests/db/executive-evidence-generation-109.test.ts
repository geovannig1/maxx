import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000001091'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000001092'
const DAILY = '00000000-0000-4000-8000-000000001093'
const WEEKLY = '00000000-0000-4000-8000-000000001094'
// The shipped report tables require a money basis on every row; an unavailable Acuity read is the
// smallest valid one, so every report_json below carries it alongside the digest under test.
const MONEY_BASIS = { version: 1, basis: 'outcome_collected_value', source_available: false,
  revenue_complete: null, observed_collected_value_lower_bound: null, covered_outcomes: null, total_outcomes: null }
const reportJson = (digest: Record<string, unknown> = {}) => JSON.stringify({ money_basis: MONEY_BASIS, ...digest })

let db: PGlite

function evidence(accountId = ACCOUNT, lastCompleteDate = '2026-08-15') {
  return {
    contract: 'executive_evidence_snapshot',
    version: 1,
    generatedAt: '2026-08-16T14:00:00.000Z',
    account: { id: accountId, name: 'Studio', timezone: 'America/New_York' },
    lastCompleteDate,
    authority: { tier: 'diagnostic_only', moneyActionsAuthorized: false },
  }
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER_ACCOUNT)
  await db.query(`INSERT INTO public.daily_reports(id,ad_account_id,report_date,report_json)
    VALUES ($1,$2,'2026-08-15',$3::jsonb)`, [DAILY, ACCOUNT, reportJson()])
})

// The baseline schema makes weekly identity and evidence immutable after insert, so the shipped schema binds a
// V1 weekly digest to its evidence when the row is committed rather than by a later UPDATE.
function insertWeekly(json: string, generationId: string) {
  return db.query(`INSERT INTO public.weekly_reports(
      id,ad_account_id,week_start,week_end,report_json,executive_evidence_generation_id
    ) VALUES ($1,$2,'2026-08-09','2026-08-15',$3::jsonb,$4)`, [WEEKLY, ACCOUNT, json, generationId])
}

afterEach(async () => db.close())

async function insertEvidence(payload = evidence(), reportDate = '2026-08-15') {
  return db.query<{ id: string }>(`
    INSERT INTO public.executive_evidence_generations(
      ad_account_id,report_date,contract_version,evidence_json,evidence_fingerprint,source_generated_at
    ) VALUES ($1,$2,1,$3::jsonb,$4,'2026-08-16T14:00:00.000Z')
    RETURNING id
  `, [ACCOUNT, reportDate, JSON.stringify(payload), `sha256:${'a'.repeat(64)}`])
}

describe('immutable executive evidence generations', () => {
  it('binds V3 daily and V1 weekly reports to the exact account/date generation', async () => {
    const generationId = (await insertEvidence()).rows[0].id

    await expect(db.query(`UPDATE public.daily_reports SET
      report_json=$2::jsonb, executive_evidence_generation_id=$3 WHERE id=$1`, [
      DAILY,
      reportJson({ dailyDigest: { contract_version: 3 } }),
      generationId,
    ])).resolves.toBeDefined()

    await expect(insertWeekly(
      reportJson({ weeklyDigest: { contract_version: 1, weekly_report_id: WEEKLY } }),
      generationId,
    )).resolves.toBeDefined()
  })

  it('extends the atomic daily report commit to persist the exact evidence generation', async () => {
    const definition = (await db.query<{ definition: string }>(`
      SELECT pg_catalog.pg_get_functiondef(
        'public.commit_daily_report_generation(uuid,date,uuid,jsonb,uuid)'::pg_catalog.regprocedure
      ) AS definition
    `)).rows[0].definition

    expect(definition).toContain('executive_evidence_generation_id')
    expect(definition).toContain("p_payload->>'executive_evidence_generation_id'")
    expect(definition).toContain("set_config('maxx.current_daily_report_commit', 'on', true)")
  })

  it('rejects V3 reports without evidence and cross-account or wrong-date evidence', async () => {
    await expect(db.query(`UPDATE public.daily_reports SET report_json=$2::jsonb WHERE id=$1`, [
      DAILY,
      reportJson({ dailyDigest: { contract_version: 3 } }),
    ])).rejects.toThrow(/executive evidence generation/i)

    const generationId = (await insertEvidence()).rows[0].id
    await expect(db.query(`UPDATE public.daily_reports SET
      ad_account_id=$2, report_json=$3::jsonb, executive_evidence_generation_id=$4 WHERE id=$1`, [
      DAILY,
      OTHER_ACCOUNT,
      reportJson({ dailyDigest: { contract_version: 3 } }),
      generationId,
    ])).rejects.toThrow(/account and report date/i)

    const wrongDateId = (await insertEvidence(evidence(ACCOUNT, '2026-08-14'), '2026-08-14')).rows[0].id
    await expect(db.query(`UPDATE public.daily_reports SET
      ad_account_id=$2, report_json=$3::jsonb, executive_evidence_generation_id=$4 WHERE id=$1`, [
      DAILY,
      ACCOUNT,
      reportJson({ dailyDigest: { contract_version: 3 } }),
      wrongDateId,
    ])).rejects.toThrow(/account and report date/i)
  })

  it('never allows an evidence-bound V3 daily row to be downgraded to a legacy digest', async () => {
    const generationId = (await insertEvidence()).rows[0].id
    await db.query(`UPDATE public.daily_reports SET
      report_json=$2::jsonb, executive_evidence_generation_id=$3 WHERE id=$1`, [
      DAILY,
      reportJson({ dailyDigest: { contract_version: 3 } }),
      generationId,
    ])

    await expect(db.query(`UPDATE public.daily_reports SET
      report_json=$2::jsonb, executive_evidence_generation_id=NULL WHERE id=$1`, [DAILY, reportJson()]))
      .rejects.toThrow(/immutable|cannot be downgraded/i)
  })

  it('blocks old direct rollup writers from mutating evidence-bound V3 headline columns', async () => {
    await expect(db.query(
      'UPDATE public.daily_reports SET total_spend=10 WHERE id=$1',
      [DAILY],
    )).resolves.toBeDefined()

    const generationId = (await insertEvidence()).rows[0].id
    await db.query(`UPDATE public.daily_reports SET
      report_json=$2::jsonb, executive_evidence_generation_id=$3 WHERE id=$1`, [
      DAILY,
      reportJson({ dailyDigest: { contract_version: 3 } }),
      generationId,
    ])

    await expect(db.query(
      'UPDATE public.daily_reports SET total_spend=999 WHERE id=$1',
      [DAILY],
    )).rejects.toThrow(/immutable outside the governed daily commit/i)
  })

  it('rejects a weekly digest whose embedded report identity differs from the row', async () => {
    const generationId = (await insertEvidence()).rows[0].id
    await expect(insertWeekly(
      reportJson({
        weeklyDigest: {
          contract_version: 1,
          weekly_report_id: OTHER_ACCOUNT,
        },
      }),
      generationId,
    )).rejects.toThrow(/weekly digest.*identity/i)
  })

  it('rejects malformed, action-authoritative, or cross-account evidence', async () => {
    await expect(insertEvidence(evidence(OTHER_ACCOUNT))).rejects.toThrow(/executive_evidence_contract/i)
    await expect(insertEvidence({
      ...evidence(),
      authority: { tier: 'owner_review', moneyActionsAuthorized: true },
    })).rejects.toThrow(/executive_evidence_contract/i)
  })

  it('is append-only and private to the service role', async () => {
    const generationId = (await insertEvidence()).rows[0].id
    await expect(db.query(`UPDATE public.executive_evidence_generations
      SET evidence_fingerprint=$2 WHERE id=$1`, [generationId, `sha256:${'b'.repeat(64)}`]))
      .rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec('DELETE FROM public.executive_evidence_generations'))
      .rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec('TRUNCATE public.executive_evidence_generations'))
      .rejects.toThrow(/append-only|truncate/i)

    const row = (await db.query<Record<string, unknown>>(`SELECT
      (SELECT relrowsecurity FROM pg_catalog.pg_class
        WHERE oid='public.executive_evidence_generations'::pg_catalog.regclass) rls,
      has_table_privilege('service_role','public.executive_evidence_generations','SELECT') service_select,
      has_table_privilege('service_role','public.executive_evidence_generations','INSERT') service_insert,
      has_table_privilege('service_role','public.executive_evidence_generations','UPDATE') service_update,
      has_table_privilege('authenticated','public.executive_evidence_generations','SELECT') authenticated_select,
      has_table_privilege('anon','public.executive_evidence_generations','SELECT') anon_select
    `)).rows[0]
    expect(row).toEqual({
      rls: true,
      service_select: true,
      service_insert: true,
      service_update: false,
      authenticated_select: false,
      anon_select: false,
    })
  })
})
