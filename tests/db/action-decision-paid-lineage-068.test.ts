import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000000a68'
const OTHER = '00000000-0000-4000-8000-000000000b68'
const ADSET = '00000000-0000-4000-8000-000000000c68'
const RECENT = '00000000-0000-4000-8000-000000000d68'
const MATURED = '00000000-0000-4000-8000-000000000e68'
const RUN = '00000000-0000-4000-8000-000000000f68'
let db: PGlite

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_068')
  await insertAdAccount(db, OTHER, 'act_other_068')
  await db.exec(`
    INSERT INTO public.campaigns(id,ad_account_id,campaign_id)
      VALUES ('00000000-0000-4000-8000-000000000168','${ACCOUNT}','1001');
    INSERT INTO public.adsets(id,ad_account_id,campaign_id,adset_id)
      VALUES ('${ADSET}','${ACCOUNT}','00000000-0000-4000-8000-000000000168','2001');
    INSERT INTO public.action_decisions(
      id,ad_account_id,action_kind,target_level,target_id,evidence_plane,evidence_basis,
      authority_tier,authority_reason,owner_copy,direction_ceiling,direction_reason,policy_version,
      source_kind,source_id,dedupe_key)
    VALUES (
      '00000000-0000-4000-8000-000000000368','${ACCOUNT}','budget_cut','adset','${ADSET}',
      'interaction_cohort','interaction_cohort_complete','execution_eligible','legacy reason',
      'legacy copy','execution','legacy direction',1,'evaluator','legacy-source','legacy-v1');
  `)
  // Generations are written as the table owner (as the governed publisher does). Policy 2 is the
  // oldest generation policy a fresh install still admits.
  await insertGeneration(RECENT, ACCOUNT, RUN, 'recent_scale')
  await insertGeneration(MATURED, ACCOUNT, RUN, 'matured_cut')
  await db.exec(`
    INSERT INTO public.paid_cohort_units(ad_account_id,generation_id,entity_level,entity_id,complete)
    VALUES
      ('${ACCOUNT}','${RECENT}','adset','2001',true),
      ('${ACCOUNT}','${MATURED}','adset','2001',true);
  `)
})

async function insertGeneration(id: string, account: string, run: string, kind: 'recent_scale' | 'matured_cut') {
  const [start, end] = kind === 'recent_scale' ? ['2026-07-16', '2026-07-29'] : ['2026-07-01', '2026-07-14']
  await db.query(`
    INSERT INTO public.paid_cohort_generations(
      id,ad_account_id,evaluation_run_id,cohort_kind,window_start,window_end,as_of_date,activation_id,
      contract_version,policy_version,complete,publication_fingerprint)
    VALUES ($1,$2,$3,$4,$5,$6,'2026-07-30',NULL,1,2,true,'00000000000000000000000000000000')`,
  [id, account, run, kind, start, end])
}

const RUN_2 = '00000000-0000-4000-8000-000000001068'
const RECENT_2 = '00000000-0000-4000-8000-000000002068'
const MATURED_2 = '00000000-0000-4000-8000-000000003068'

async function insertSecondPair({ maturedUnit }: { maturedUnit: 'incomplete' | 'none' }) {
  await insertGeneration(RECENT_2, ACCOUNT, RUN_2, 'recent_scale')
  await insertGeneration(MATURED_2, ACCOUNT, RUN_2, 'matured_cut')
  await db.exec(`INSERT INTO public.paid_cohort_units(ad_account_id,generation_id,entity_level,entity_id,complete)
    VALUES ('${ACCOUNT}','${RECENT_2}','adset','2001',true)`)
  if (maturedUnit === 'incomplete') {
    await db.exec(`INSERT INTO public.paid_cohort_units(
      ad_account_id,generation_id,entity_level,entity_id,complete,blocker_codes)
      VALUES ('${ACCOUNT}','${MATURED_2}','adset','2001',false,ARRAY['missing_account_insight_days'])`)
  }
}

async function commit(over: Record<string, unknown> = {}) {
  const args = {
    p_ad_account_id: ACCOUNT, p_action_kind: 'budget_cut', p_target_level: 'adset', p_target_id: ADSET,
    p_evidence_plane: 'interaction_cohort', p_evidence_basis: 'interaction_cohort_complete',
    p_authority_tier: 'execution_eligible', p_authority_reason: 'exact evidence',
    p_owner_copy: 'Owner-approved execution may proceed.', p_direction_ceiling: 'execution',
    p_direction_reason: 'exact evidence', p_policy_version: 2,
    p_dedupe_key: `decision-${crypto.randomUUID()}`, p_source_kind: 'evaluator',
    p_source_id: `source-${crypto.randomUUID()}`,
    p_paid_cohort_recent_generation_id: RECENT,
    p_paid_cohort_matured_generation_id: MATURED,
    ...over,
  }
  const keys = Object.keys(args)
  const values = Object.values(args)
  return one<Record<string, unknown>>(`SELECT (public.commit_action_decision(${keys.map(
    (key, index) => `${key} => $${index + 1}`,
  ).join(',')})).*`, values)
}

describe('durable paid-cohort ActionDecision lineage', () => {
  it('commits and retries one exact decision with both generation ids', async () => {
    const key = 'lineage-retry'
    const source = 'lineage-source'
    const first = await commit({ p_dedupe_key: key, p_source_id: source })
    const retry = await commit({ p_dedupe_key: key, p_source_id: source })
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      paid_cohort_recent_generation_id: RECENT,
      paid_cohort_matured_generation_id: MATURED,
    })
  })

  it('rejects missing lineage, wrong direction, mixed runs and cross-account ids', async () => {
    await expect(commit({ p_paid_cohort_recent_generation_id: null }))
      .rejects.toThrow(/lineage/i)
    await expect(commit({
      p_paid_cohort_recent_generation_id: MATURED,
      p_paid_cohort_matured_generation_id: RECENT,
    })).rejects.toThrow(/direction|cohort/i)

    const mixed = '00000000-0000-4000-8000-000000000968'
    const foreign = '00000000-0000-4000-8000-000000000868'
    await insertGeneration(mixed, ACCOUNT, '00000000-0000-4000-8000-000000000768', 'matured_cut')
    await insertGeneration(foreign, OTHER, '00000000-0000-4000-8000-000000000668', 'recent_scale')
    await expect(commit({ p_paid_cohort_matured_generation_id: mixed })).rejects.toThrow(/same evaluation run/i)
    await expect(commit({ p_paid_cohort_recent_generation_id: foreign })).rejects.toThrow(/account|cohort/i)
  })

  it('rejects an unknown target and incomplete required target unit', async () => {
    await expect(commit({ p_target_id: '00000000-0000-4000-8000-000000009999' }))
      .rejects.toThrow(/target/i)
    // Units are append-only, so the incomplete matured unit is published as its own pair.
    await insertSecondPair({ maturedUnit: 'incomplete' })
    await expect(commit({
      p_paid_cohort_recent_generation_id: RECENT_2,
      p_paid_cohort_matured_generation_id: MATURED_2,
    })).rejects.toThrow(/complete matured_cut unit/i)
  })

  it('allows scale from a complete recent unit even when the matured unit is unavailable', async () => {
    // Units are append-only, so the pair whose matured unit is unavailable is published separately.
    await insertSecondPair({ maturedUnit: 'none' })
    await expect(commit({
      p_action_kind: 'budget_scale',
      p_paid_cohort_recent_generation_id: RECENT_2,
      p_paid_cohort_matured_generation_id: MATURED_2,
    })).resolves.toMatchObject({
      action_kind: 'budget_scale', paid_cohort_recent_generation_id: RECENT_2,
      paid_cohort_matured_generation_id: MATURED_2,
    })
  })

  it('keeps non-interaction decisions lineage-free and rejects lineage laundering', async () => {
    const diagnostic = {
      p_action_kind: 'observe', p_target_level: 'account', p_target_id: null,
      p_evidence_plane: 'structural', p_evidence_basis: 'calendar_period_signal',
      p_authority_tier: 'diagnostic_only', p_direction_ceiling: 'unsupported',
      p_paid_cohort_recent_generation_id: null, p_paid_cohort_matured_generation_id: null,
    }
    await expect(commit(diagnostic)).resolves.toMatchObject({
      evidence_basis: 'calendar_period_signal', paid_cohort_recent_generation_id: null,
    })
    await expect(commit({ ...diagnostic, p_paid_cohort_recent_generation_id: RECENT }))
      .rejects.toThrow(/only accompany interaction-cohort/i)
  })

  it('freezes lineage and prevents a below-floor row from entering approval', async () => {
    const current = await commit()
    await expect(db.query(`UPDATE public.action_decisions
      SET paid_cohort_recent_generation_id=$1 WHERE id=$2`, [MATURED, current.id]))
      .rejects.toThrow(/immutable/i)

    const legacy = await one<Record<string, unknown>>(`SELECT * FROM public.action_decisions
      WHERE dedupe_key='legacy-v1'`)
    expect(legacy).toMatchObject({
      policy_version: 1,
      paid_cohort_recent_generation_id: null,
      paid_cohort_matured_generation_id: null,
    })
    await expect(db.query(`UPDATE public.action_decisions SET approval_state='pending' WHERE id=$1`, [legacy.id]))
      .rejects.toThrow(/current policy floor/i)
  })

  it('publishes recommendation and decision atomically with persisted lineage', async () => {
    const recId = '00000000-0000-4000-8000-000000000468'
    const decision = {
      action_kind: 'budget_cut', target_level: 'adset', target_id: ADSET,
      evidence_plane: 'interaction_cohort', evidence_basis: 'interaction_cohort_complete',
      authority_tier: 'execution_eligible', authority_reason: 'exact evidence', owner_copy: 'owner copy',
      direction_ceiling: 'execution', direction_reason: 'exact evidence', policy_version: 2,
      dedupe_key: 'publication-lineage', source_id: recId, window_start: '2026-07-01',
      window_end: '2026-07-14', objective: 'bookings', matured: true, continuity: true,
      windows_conflict: false, metrics: {}, proposed_mutation: null,
      paid_cohort_recent_generation_id: RECENT,
      paid_cohort_matured_generation_id: MATURED,
    }
    // No flag generation exists in this fixture, so the recommendation generation names none.
    await one(`SELECT public.replace_recommendation_generation_with_decisions(
      $1,$2,NULL,NULL,'2026-07-30',$3::jsonb,$4::jsonb) result`, [
      ACCOUNT, '00000000-0000-4000-8000-000000000568',
      JSON.stringify([{
        id: recId, recommendation_type: 'budget_cut', target_entity_type: 'adset',
        observed_fact: 'fixture recommendation', metric_values: [], data_sources: [],
        confidence_score: 0, confidence_label: 'insufficient', risk_level: 'medium',
        gate_decision: 'hold', gate_passed: false, what_could_make_this_wrong: [],
        approval_required: true, action_allowed_now: false, metric_claim_ids: [],
      }]), JSON.stringify([decision]),
    ])
    const stored = await one<Record<string, unknown>>(`SELECT * FROM public.action_decisions
      WHERE source_kind='recommendation' AND source_id=$1`, [recId])
    expect(stored).toMatchObject({
      paid_cohort_recent_generation_id: RECENT,
      paid_cohort_matured_generation_id: MATURED,
    })
  })

  it('exposes the current floor and only grants the new governed commit RPC to service_role', async () => {
    const result = await one<{ floor: number; service: boolean; anon: boolean; authenticated: boolean }>(`
      SELECT public.action_decision_policy_floor() floor,
        has_function_privilege('service_role','public.commit_action_decision(uuid,text,text,text,text,text,text,text,text,text,text,integer,text,text,text,date,date,text,boolean,boolean,boolean,jsonb,jsonb,uuid,uuid,boolean)','EXECUTE') service,
        has_function_privilege('anon','public.commit_action_decision(uuid,text,text,text,text,text,text,text,text,text,text,integer,text,text,text,date,date,text,boolean,boolean,boolean,jsonb,jsonb,uuid,uuid,boolean)','EXECUTE') anon,
        has_function_privilege('authenticated','public.commit_action_decision(uuid,text,text,text,text,text,text,text,text,text,text,integer,text,text,text,date,date,text,boolean,boolean,boolean,jsonb,jsonb,uuid,uuid,boolean)','EXECUTE') authenticated`)
    const { floor, ...privileges } = result
    expect(privileges).toEqual({ service: true, anon: false, authenticated: false })
    // The paid-lineage policy introduced the floor at 2; later policies raised it. The database and the application must agree.
    expect(floor).toBe(ACTION_DECISION_POLICY_FLOOR)
  })
})
