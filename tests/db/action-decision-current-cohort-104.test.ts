import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertActionDecision, insertAdset, insertCampaign } from './decision-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000104'
const CAMPAIGN = '00000000-0000-4000-8000-000000007104'
const ADSET = '00000000-0000-4000-8000-000000001104'
const LEGACY_RECENT = '00000000-0000-4000-8000-000000002104'
const LEGACY_MATURED = '00000000-0000-4000-8000-000000003104'
const CURRENT_RECENT = '00000000-0000-4000-8000-000000004104'
const CURRENT_MATURED = '00000000-0000-4000-8000-000000005104'
const V4_DECISION = '00000000-0000-4000-8000-000000006104'
const FINGERPRINT = 'f'.repeat(32)

let db: PGlite

const insertDecision = (overrides: Record<string, unknown> = {}) => insertActionDecision(db, ACCOUNT, {
  action_kind: 'budget_cut',
  target_level: 'adset',
  target_id: ADSET,
  evidence_plane: 'interaction_cohort',
  evidence_basis: 'interaction_cohort_complete',
  authority_tier: 'owner_review',
  authority_reason: 'paid cohort association',
  owner_copy: 'Owner review only.',
  direction_ceiling: 'owner_review',
  direction_reason: 'paid cohort association',
  policy_version: 5,
  source_kind: 'recommendation',
  source_id: crypto.randomUUID(),
  paid_cohort_recent_generation_id: CURRENT_RECENT,
  paid_cohort_matured_generation_id: CURRENT_MATURED,
  pragmatic_media_buyer: true,
  ...overrides,
})

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_104')
  await insertCampaign(db, CAMPAIGN, ACCOUNT, '100104')
  await insertAdset(db, ADSET, ACCOUNT, CAMPAIGN, '200104')

  // Policy-v1 generations exist in production from before the v2 cutover, but the shipped insert
  // guard (correctly) refuses to mint new ones. Seed them as the table owner with only that guard
  // suspended; every other trigger and constraint still applies.
  await db.exec(`ALTER TABLE public.paid_cohort_generations DISABLE TRIGGER paid_cohort_current_policy_guard`)
  await db.exec(`
    INSERT INTO public.paid_cohort_generations(
      id,ad_account_id,evaluation_run_id,cohort_kind,window_start,window_end,as_of_date,activation_id,
      contract_version,policy_version,complete,publication_fingerprint)
    VALUES
      ('${LEGACY_RECENT}','${ACCOUNT}','00000000-0000-4000-8000-000000008104',
        'recent_scale','2026-08-01','2026-08-14','2026-08-15',NULL,1,1,true,'${FINGERPRINT}'),
      ('${LEGACY_MATURED}','${ACCOUNT}','00000000-0000-4000-8000-000000008104',
        'matured_cut','2026-08-01','2026-08-14','2026-08-15',NULL,1,1,true,'${FINGERPRINT}');
  `)
  await db.exec(`ALTER TABLE public.paid_cohort_generations ENABLE TRIGGER paid_cohort_current_policy_guard`)
  await db.exec(`
    INSERT INTO public.paid_cohort_generations(
      id,ad_account_id,evaluation_run_id,cohort_kind,window_start,window_end,as_of_date,activation_id,
      contract_version,policy_version,complete,publication_fingerprint)
    VALUES
      ('${CURRENT_RECENT}','${ACCOUNT}','00000000-0000-4000-8000-000000009104',
        'recent_scale','2026-08-01','2026-08-14','2026-08-15',NULL,1,2,true,'${FINGERPRINT}'),
      ('${CURRENT_MATURED}','${ACCOUNT}','00000000-0000-4000-8000-000000009104',
        'matured_cut','2026-08-01','2026-08-14','2026-08-15',NULL,1,2,true,'${FINGERPRINT}');
    INSERT INTO public.paid_cohort_units(ad_account_id,generation_id,entity_level,entity_id,complete)
    VALUES
      ('${ACCOUNT}','${LEGACY_RECENT}','adset','200104',true),
      ('${ACCOUNT}','${LEGACY_MATURED}','adset','200104',true),
      ('${ACCOUNT}','${CURRENT_RECENT}','adset','200104',true),
      ('${ACCOUNT}','${CURRENT_MATURED}','adset','200104',true);
  `)

  await insertDecision({
    id: V4_DECISION,
    authority_reason: 'legacy v4',
    owner_copy: 'legacy v4 copy',
    direction_reason: 'legacy v4',
    policy_version: 4,
    source_id: '00000000-0000-4000-8000-000000010104',
    dedupe_key: 'legacy-v4',
  })
})

describe('persisted evidence cutover', () => {
  it('raises the ActionDecision floor to v5 while preserving v4 audit rows', async () => {
    const floor = await db.query<{ floor: number }>('SELECT public.action_decision_policy_floor() floor')
    expect(floor.rows[0].floor).toBe(5)

    const legacy = await db.query<{ policy_version: number; approval_state: string }>(
      'SELECT policy_version, approval_state FROM public.action_decisions WHERE id=$1',
      [V4_DECISION],
    )
    expect(legacy.rows[0]).toEqual({ policy_version: 4, approval_state: 'not_requested' })
  })

  it('requires v5 paid-cohort ActionDecisions to link both current paid-cohort generations', async () => {
    await expect(insertDecision({
      paid_cohort_recent_generation_id: LEGACY_RECENT,
      paid_cohort_matured_generation_id: LEGACY_MATURED,
    })).rejects.toThrow(/current paid-cohort policy/i)

    await expect(insertDecision({
      paid_cohort_recent_generation_id: CURRENT_RECENT,
      paid_cohort_matured_generation_id: LEGACY_MATURED,
    })).rejects.toThrow(/current paid-cohort policy/i)

    await expect(insertDecision()).resolves.toBeTruthy()
  })

  it('prevents v4 artifacts from entering approval or executable change requests', async () => {
    await expect(db.query(
      `UPDATE public.action_decisions SET approval_state='pending' WHERE id=$1`,
      [V4_DECISION],
    )).rejects.toThrow(/current policy floor/i)

    await expect(db.query(
      `INSERT INTO public.change_requests(
         ad_account_id,action_decision_id,status,action_type,entity_level,meta_entity_id,params,
         preview,idempotency_key)
       VALUES ($1,$2,'pending','adjust_budget','adset',$3,'{"new_daily_budget_usd":10}','Cut budget',
         'change-request-v4')`,
      [ACCOUNT, V4_DECISION, ADSET],
    )).rejects.toThrow(/current policy floor/i)
  })
})
