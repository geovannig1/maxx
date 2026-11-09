import { createHash } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MIN_SWITCHBACK_BLOCKS, causalDb, fixtureUnitIds, insertClientAppointment, insertSwitchbackHistory,
  outcomeUuid, switchbackDates,
} from './causal-fixture'

const A = '00000000-0000-4000-8000-000000000121'
const X = '00000000-0000-4000-8000-000000000122'
const D = '00000000-0000-4000-8000-000000000123'
const DA = '00000000-0000-4000-8000-000000000124'
const U1 = '00000000-0000-4000-8000-000000000125'
const U2 = '00000000-0000-4000-8000-000000000126'
const U3 = '00000000-0000-4000-8000-000000000127'
const P = '00000000-0000-4000-8000-000000000128'
const PA = '00000000-0000-4000-8000-000000000129'
const SB = '00000000-0000-4000-8000-000000000130'
const CB = '00000000-0000-4000-8000-000000000131'
const H = `sha256:${'a'.repeat(64)}`
const O8701 = outcomeUuid(8701)
const O8702 = outcomeUuid(8702)
let db: PGlite

type Row = Record<string, unknown>
const fp = (c: string) => `sha256:${c.repeat(64)}`

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

// A closed time-block experiment as the shipped schema admits one: twelve one-day
// switchback blocks from 2026-01-01 local midnight, alternating treatment/comparator. U1-U3 are the
// first three blocks, as in the original three-block fixture.
const WINDOW_START = '2026-01-01T05:00:00Z'
const WINDOW_END = '2026-01-13T05:00:00Z'
const OBSERVED_THROUGH = '2026-01-14T00:00:00Z'
const UNITS = [U1, U2, U3, ...fixtureUnitIds(0x9087, MIN_SWITCHBACK_BLOCKS - 3)]

async function setupDesign() {
  await insertSwitchbackHistory(db, { account: A, experiment: X, design: D, approval: DA, unitIds: UNITS })
  await db.query(`SELECT public.commit_causal_assignment_coverage_manifest(
    $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,true,ARRAY[]::text[],$8,
    $9::uuid[],$10,1,NULL,'outcome-assignment-coverage')`,
  [A, X, D, DA, WINDOW_START, WINDOW_END, OBSERVED_THROUGH, UNITS.length, UNITS, fp('f')])
}

async function setupAppointments() {
  for (const [id, created] of [[8701, '2026-01-01T17:00:00Z'], [8702, '2026-01-02T17:00:00Z']] as const) {
    await insertClientAppointment(db, { id, account: A, createdAt: created })
    await db.query(`SELECT public.link_causal_time_block_outcome(
      $1,$2,$3,$4,$5,1,$6)`, [A, X, D, DA, outcomeUuid(id), `outcome-link-${id}`])
  }
  await db.query(`SELECT public.commit_causal_outcome_coverage_manifest(
    $1,$2,$3,$4,$6::timestamptz,$7::timestamptz,
    $8::timestamptz,true,ARRAY[]::text[],2,$9::uuid[],
    $5,1,NULL,'outcome-appointment-coverage')`,
  [A, X, D, DA, fp('1'), WINDOW_START, WINDOW_END, OBSERVED_THROUGH, [O8701, O8702]])
}

async function setupEconomics() {
  await db.query(`INSERT INTO public.economics_policy_versions(
    id,ad_account_id,revision,schema_version,objective,currency,processor,
    processor_account_ref,realization_horizon_days,variable_cost_basis,
    required_cost_sources,allowed_variable_cost_categories,variable_cost_category_sources,
    fixed_overhead_treatment,content_hash,source_kind,source_ref,captured_at,dedupe_key,created_at
  ) VALUES ($1,$2,1,1,'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    'USD','stripe','acct_cc',30,'outcome_actual_entries',ARRAY['supplies'],
    ARRAY['materials'],'{"materials":"supplies"}','excluded_from_contribution',$3,
    'owner_entry','fixture','2025-11-01T00:00:00Z','outcome-policy','2025-11-01T00:00:00Z')`,
  [P, A, H])
  await db.query(`INSERT INTO public.economics_policy_approvals(
    id,ad_account_id,artifact_id,artifact_hash,decision,revision,effective_from,
    reviewed_by,reason,review_due_at,dedupe_key,created_at
  ) VALUES ($1,$2,$3,$4,'approved',1,'2025-12-01T00:00:00Z','owner','approved',
    '2099-01-01T00:00:00Z','outcome-policy-approval','2025-12-01T00:00:00Z')`, [PA, A, P, H])
}

async function setupMoney() {
  await db.query(`INSERT INTO public.processor_settlement_batches(
    id,ad_account_id,processor,processor_account_ref,window_start,window_end,source_head,
    complete,blocker_codes,event_count,contract_version,publication_fingerprint,imported_at
  ) VALUES ($1,$2,'stripe','acct_cc','2026-01-01T05:00:00Z','2026-02-12T05:00:00Z',
    'settlement-head',true,ARRAY[]::text[],3,1,$3,'2026-08-01T00:00:00Z')`, [SB, A, fp('2')])
  await db.query(`INSERT INTO public.processor_settlement_events(
    id,import_sequence,ad_account_id,batch_id,processor,processor_account_ref,
    processor_event_id,processor_transaction_id,event_kind,occurred_at,available_at,currency,
    outcome_id,collected_ex_tax_minor,refunds_ex_tax_minor,chargebacks_ex_tax_minor,
    recovered_chargebacks_ex_tax_minor,payment_fees_minor,tax_amount_minor,
    source_fingerprint,contract_version,recorded_at
  ) VALUES
    ('00000000-0000-4000-8000-000000000132',(SELECT import_sequence FROM public.processor_settlement_batches WHERE id=$1),$2,$1,'stripe','acct_cc','pay-t','tx-t','payment_settled','2026-01-01T17:01:00Z','2026-01-02T00:00:00Z','USD','${O8701}',30000,0,0,0,1000,0,$3,1,'2026-08-01T00:00:00Z'),
    ('00000000-0000-4000-8000-000000000133',(SELECT import_sequence FROM public.processor_settlement_batches WHERE id=$1),$2,$1,'stripe','acct_cc','refund-t','tx-t','refund_settled','2026-01-05T00:00:00Z','2026-01-06T00:00:00Z','USD','${O8701}',0,5000,0,0,0,0,$4,1,'2026-08-01T00:00:00Z'),
    ('00000000-0000-4000-8000-000000000134',(SELECT import_sequence FROM public.processor_settlement_batches WHERE id=$1),$2,$1,'stripe','acct_cc','pay-c','tx-c','payment_settled','2026-01-02T17:01:00Z','2026-01-03T00:00:00Z','USD','${O8702}',20000,0,0,0,700,0,$5,1,'2026-08-01T00:00:00Z')`,
  [SB, A, fp('3'), fp('4'), fp('5')])
  await db.query(`INSERT INTO public.variable_cost_batches(
    id,ad_account_id,economics_policy_id,economics_policy_approval_id,cost_source,
    window_start,window_end,source_head,complete,blocker_codes,event_count,contract_version,
    publication_fingerprint,imported_at
  ) VALUES ($1,$2,$3,$4,'supplies','2026-01-01T05:00:00Z','2026-02-12T05:00:00Z',
    'cost-head',true,ARRAY[]::text[],2,1,$5,'2026-08-01T00:00:00Z')`, [CB, A, P, PA, fp('6')])
  await db.query(`INSERT INTO public.variable_cost_events(
    id,import_sequence,ad_account_id,batch_id,economics_policy_id,cost_source,
    source_event_id,event_kind,occurred_at,available_at,currency,outcome_id,category,
    amount_minor,source_fingerprint,contract_version,recorded_at
  ) VALUES
    ('00000000-0000-4000-8000-000000000135',(SELECT import_sequence FROM public.variable_cost_batches WHERE id=$1),$2,$1,$3,'supplies','cost-t','cost_incurred','2026-01-10T00:00:00Z','2026-01-11T00:00:00Z','USD','${O8701}','materials',5000,$4,1,'2026-08-01T00:00:00Z'),
    ('00000000-0000-4000-8000-000000000136',(SELECT import_sequence FROM public.variable_cost_batches WHERE id=$1),$2,$1,$3,'supplies','cost-c','cost_incurred','2026-01-10T00:00:00Z','2026-01-11T00:00:00Z','USD','${O8702}','materials',4000,$5,1,'2026-08-01T00:00:00Z')`,
  [CB, A, P, fp('7'), fp('8')])
}

async function setupSpend() {
  await db.query(`SELECT public.commit_causal_meta_spend_batch(
    $1,$2,$3,$4,$7::timestamptz,$8::timestamptz,$9::timestamptz,
    true,ARRAY[]::text[],$5::jsonb,$6,1,NULL,'outcome-spend')`, [A, X, D, DA,
    JSON.stringify(switchbackDates().map((date, i) => ({
      spend_date: date, spend_minor: i % 2 === 0 ? 8000 : 5000,
      source_fingerprint: `sha256:${createHash('sha256').update(`spend:${date}`).digest('hex')}`,
    }))), fp('c'), WINDOW_START, WINDOW_END, OBSERVED_THROUGH])
}

async function materialize(dedupe = 'outcome-generation-v1') {
  return one<Row>(`SELECT (public.materialize_causal_contribution_outcomes(
    $1,$2,$3,$4,$5,1,$6
  )).*`, [A, X, D, DA, PA, dedupe])
}

beforeEach(async () => {
  db = await causalDb(A)
  await setupEconomics()
  await setupDesign()
  await setupAppointments()
  await setupMoney()
  await setupSpend()
})

describe('matured causal contribution outcomes', () => {
  // 087 built materialization for booking time blocks; 091 then quarantined every time-block generation
  // until treatment-path outcome materialization with finite carryover exists. On the shipped schema the
  // guarantee is therefore the refusal itself: no contribution is ever computed from booking time blocks.
  it('refuses to materialize booking-time-block contribution and writes nothing', async () => {
    await expect(materialize()).rejects.toThrow(/booking-time-block outcomes are quarantined/i)
    expect(await one<{ generations: number; outcomes: number; cuts: number }>(`
      SELECT
        (SELECT count(*)::int FROM public.causal_contribution_generations) generations,
        (SELECT count(*)::int FROM public.causal_contribution_unit_outcomes) outcomes,
        (SELECT count(*)::int FROM public.causal_contribution_cost_cuts) cuts
    `)).toEqual({ generations: 0, outcomes: 0, cuts: 0 })
  })

  it('fails closed on a newer incomplete settlement cut instead of using stale complete data', async () => {
    await db.query(`INSERT INTO public.processor_settlement_batches(
      id,ad_account_id,processor,processor_account_ref,window_start,window_end,source_head,
      complete,blocker_codes,event_count,contract_version,publication_fingerprint,imported_at
    ) VALUES ('00000000-0000-4000-8000-000000000137',$1,'stripe','acct_cc',
      '2026-01-01T05:00:00Z','2026-02-12T05:00:00Z','blocked-head',false,
      ARRAY['source_unavailable'],0,1,$2,'2026-08-02T00:00:00Z')`, [A, fp('d')])
    await expect(materialize()).rejects.toThrow(/complete settlement/i)
  })

  it('blocks unlinked processor money instead of silently excluding it', async () => {
    await db.query(`INSERT INTO public.processor_settlement_events(
      id,import_sequence,ad_account_id,batch_id,processor,processor_account_ref,
      processor_event_id,processor_transaction_id,event_kind,occurred_at,available_at,currency,
      outcome_id,collected_ex_tax_minor,refunds_ex_tax_minor,chargebacks_ex_tax_minor,
      recovered_chargebacks_ex_tax_minor,payment_fees_minor,tax_amount_minor,
      source_fingerprint,contract_version,recorded_at
    ) VALUES ('00000000-0000-4000-8000-000000000138',
      (SELECT import_sequence FROM public.processor_settlement_batches WHERE id=$1),$2,$1,
      'stripe','acct_cc','unlinked','tx-u','payment_settled','2026-01-03T00:00:00Z',
      '2026-01-04T00:00:00Z','USD',NULL,1000,0,0,0,0,0,$3,1,'2026-08-01T00:00:00Z')`,
    [SB, A, fp('e')])
    await expect(materialize()).rejects.toThrow(/unlinked processor/i)
  })

  it('fails closed when the latest spend snapshot is incomplete', async () => {
    const spend = await one<Row>(`SELECT * FROM public.causal_meta_spend_batches ORDER BY revision DESC LIMIT 1`)
    await db.query(`SELECT public.commit_causal_meta_spend_batch(
      $1,$2,$3,$4,$7::timestamptz,$8::timestamptz,$9::timestamptz,
      false,ARRAY['meta_unavailable'],'[]'::jsonb,$5,1,$6,'outcome-spend-blocked')`,
    [A, X, D, DA, fp('f'), spend.id, WINDOW_START, WINDOW_END, OBSERVED_THROUGH])
    await expect(materialize()).rejects.toThrow(/complete Meta spend/i)
  })

  it('creates no estimate, recommendation, or action authority when materialization is refused', async () => {
    await expect(materialize()).rejects.toThrow(/quarantined/i)
    expect(await one<{ estimates: number; recommendations: number; decisions: number }>(`
      SELECT
        (SELECT count(*)::int FROM public.causal_contribution_estimates) estimates,
        (SELECT count(*)::int FROM public.recommendations) recommendations,
        (SELECT count(*)::int FROM public.action_decisions) decisions
    `)).toEqual({ estimates: 0, recommendations: 0, decisions: 0 })
  })

  it('keeps generations, cuts, and outcomes append-only and private', async () => {
    // No generation row can exist (quarantine above), so the append-only guarantee is checked on the
    // catalog: every row change and TRUNCATE on all three tables goes through the append-only guard.
    expect(await one<{ guarded: number }>(`
      SELECT count(*)::int AS guarded FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND t.tgrelid IN ('public.causal_contribution_generations'::regclass,
           'public.causal_contribution_cost_cuts'::regclass, 'public.causal_contribution_unit_outcomes'::regclass)
         AND t.tgfoid = 'public.causal_assignment_append_only_guard()'::regprocedure`)).toEqual({ guarded: 6 })
    expect(await one<{ dml: number; browser_reads: number; service_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          CROSS JOIN (VALUES ('causal_contribution_generations'),('causal_contribution_cost_cuts'),
            ('causal_contribution_unit_outcomes')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('causal_contribution_generations'),('causal_contribution_cost_cuts'),
            ('causal_contribution_unit_outcomes')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) browser_reads,
        (SELECT count(*)::int FROM (VALUES ('causal_contribution_generations'),
            ('causal_contribution_cost_cuts'),('causal_contribution_unit_outcomes')) t(table_name)
          WHERE has_table_privilege('service_role','public.' || table_name,'SELECT')) service_reads
    `)).toEqual({ dml: 0, browser_reads: 0, service_reads: 3 })
  })
})
