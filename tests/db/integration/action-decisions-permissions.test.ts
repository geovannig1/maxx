import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
import {
  purgePaidCohortLineageFixture,
  seedPaidCohortLineageFixture,
  type PaidCohortLineageFixture,
} from './paid-cohort-lineage-fixture'
import { reassertShippedPrivileges } from './shipped-privileges'

/**
 * The constraint/trigger suite runs as the postgres SUPERUSER, where
 * GRANTs do not apply — so it proves the rules that hold even for an unlockable caller, but says
 * nothing about ROLES. These tests go through PostgREST, where grants are actually enforced, and
 * prove the governance boundary: writes are only reachable through the governed RPCs, the app role is
 * read-only, and anonymous is denied outright.
 */

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000d5'
const KEY = 'perm:as-1:2026-07:v3'
const LINEAGE: PaidCohortLineageFixture = {
  accountId: ACCT,
  campaignDbId: '00000000-0000-4000-8000-0000000001d5',
  adsetDbId: '00000000-0000-4000-8000-0000000002d5',
  activationId: '00000000-0000-4000-8000-0000000003d5',
  evaluationRunId: '00000000-0000-4000-8000-0000000004d5',
  recentGenerationId: '00000000-0000-4000-8000-0000000005d5',
  maturedGenerationId: '00000000-0000-4000-8000-0000000006d5',
  metaCampaignId: '645001',
  metaAdsetId: '645002',
}
let c: pg.Client

const svc = () => createClient(SB_URL, SERVICE, { auth: { persistSession: false } })
const anon = () => createClient(SB_URL, ANON, { auth: { persistSession: false } })

const COMMIT_ARGS = {
  p_ad_account_id: ACCT, p_action_kind: 'budget_cut', p_target_level: 'adset', p_target_id: LINEAGE.adsetDbId,
  p_evidence_plane: 'interaction_cohort', p_evidence_basis: 'interaction_cohort_complete',
  p_authority_tier: 'execution_eligible', p_authority_reason: 'r',
  p_owner_copy: 'Owner-facing governed copy.',
  p_direction_ceiling: 'execution', p_direction_reason: 'd', p_policy_version: 3,
  p_dedupe_key: KEY, p_source_kind: 'flag', p_source_id: 'f-1',
  p_objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
  p_proposed_mutation: { action_type: 'adjust_budget', new_daily_budget_usd: 60 },
  p_paid_cohort_recent_generation_id: LINEAGE.recentGenerationId,
  p_paid_cohort_matured_generation_id: LINEAGE.maturedGenerationId,
}

beforeAll(async () => {
  for (const u of [SB_URL, DB]) if (!LOOPBACK.has(hostOf(u))) throw new Error(`non-loopback: ${u}`)
  c = new pg.Client({ connectionString: DB }); await c.connect()
  await c.query(`DELETE FROM change_requests WHERE ad_account_id = $1`, [ACCT])
  await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
  await purgePaidCohortLineageFixture(c, LINEAGE)
  await c.query(`DELETE FROM ad_accounts WHERE id = $1`, [ACCT])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_d5')`, [ACCT])
  await seedPaidCohortLineageFixture(c, LINEAGE)
  // Several older integration suites blanket-GRANT every public table to service_role. Reassert the
  // shipped privilege contract (the baseline's grants) so this suite measures production, not
  // whichever suite ran first.
  await reassertShippedPrivileges(c)
}, 60000)

afterAll(async () => {
  if (c) {
    await c.query(`DELETE FROM change_requests WHERE ad_account_id = $1`, [ACCT])
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    await purgePaidCohortLineageFixture(c, LINEAGE)
    await c.query(`DELETE FROM ad_accounts WHERE id = $1`, [ACCT])
    await c.end()
  }
})

describe('action_decisions role permissions through PostgREST', () => {
  it('service_role CAN commit through the governed RPC', async () => {
    const { data, error } = await svc().rpc('commit_action_decision', COMMIT_ARGS)
    expect(error, error?.message).toBeNull()
    expect(data).toBeTruthy()
    expect((data as { dedupe_key: string }).dedupe_key).toBe(KEY)
  })

  it('service_role CANNOT write the table directly — the RPC is the only way in', async () => {
    const { error } = await svc().from('action_decisions').insert({
      ad_account_id: ACCT, action_kind: 'pause', target_level: 'adset', target_id: 'as-2',
      evidence_plane: 'interaction_cohort', evidence_basis: 'interaction_cohort_complete',
      authority_tier: 'execution_eligible', authority_reason: 'r',
      direction_ceiling: 'execution', direction_reason: 'd', policy_version: 1,
      dedupe_key: 'perm-direct', source_kind: 'flag',
    })
    expect(error, 'a raw direct insert must be denied').not.toBeNull()
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM action_decisions WHERE dedupe_key='perm-direct'`)
    expect(rows[0].n).toBe(0)
  })

  it('service_role CANNOT update or delete directly', async () => {
    const upd = await svc().from('action_decisions').update({ authority_tier: 'diagnostic_only' })
      .eq('ad_account_id', ACCT)
    expect(upd.error).not.toBeNull()
    const del = await svc().from('action_decisions').delete().eq('ad_account_id', ACCT)
    expect(del.error).not.toBeNull()
  })

  it('the trigger still rejects every direct app write if a future blanket GRANT reappears', async () => {
    await c.query(`GRANT INSERT, UPDATE, DELETE ON action_decisions TO service_role`)
    try {
      const direct = await svc().from('action_decisions').insert({
        ad_account_id: ACCT, action_kind: 'budget_cut', target_level: 'adset', target_id: 'as-bypass',
        evidence_plane: 'interaction_cohort', evidence_basis: 'interaction_cohort_complete',
        authority_tier: 'execution_eligible', authority_reason: 'forged', owner_copy: 'Forged copy.',
        direction_ceiling: 'execution', direction_reason: 'forged', policy_version: 1,
        dedupe_key: 'perm-trigger-bypass', source_kind: 'flag', source_id: 'f-bypass',
      })
      expect(direct.error?.message).toMatch(/must use the governed RPCs/i)

      const update = await svc().from('action_decisions').update({ authority_reason: 'tampered' })
        .eq('ad_account_id', ACCT).eq('dedupe_key', KEY)
      expect(update.error?.message).toMatch(/must use the governed RPCs/i)

      const del = await svc().from('action_decisions').delete()
        .eq('ad_account_id', ACCT).eq('dedupe_key', KEY)
      expect(del.error?.message).toMatch(/must use the governed RPCs/i)
    } finally {
      await c.query(`REVOKE INSERT, UPDATE, DELETE ON action_decisions FROM service_role`)
    }
  })

  it('the effective 064→068 chain exposes only the lineage-aware commit and paired approval path', async () => {
    const { rows } = await c.query(`
      SELECT
        (SELECT count(*)::int FROM (VALUES
          ('request_action_decision_approval(uuid)'::regprocedure),
          ('approve_action_decision(uuid,boolean)'::regprocedure)
        ) f(p) WHERE has_function_privilege('service_role',p,'EXECUTE')) primitive_count,
        (SELECT count(*)::int FROM pg_proc
          WHERE pronamespace='public'::regnamespace AND proname='commit_action_decision') commit_overloads,
        has_function_privilege(
          'service_role',
          'commit_action_decision(uuid,text,text,text,text,text,text,text,text,text,text,integer,text,text,text,date,date,text,boolean,boolean,boolean,jsonb,jsonb,uuid,uuid,boolean)'::regprocedure,
          'EXECUTE') service_can_commit`)
    expect(rows[0]).toEqual({ primitive_count: 0, commit_overloads: 1, service_can_commit: true })
  })

  it('service_role cannot use the paired transaction to revive historical money authority', async () => {
    const { rows } = await c.query(
      `SELECT id FROM action_decisions WHERE ad_account_id=$1 AND dedupe_key=$2`, [ACCT, KEY])
    const id = rows[0].id
    const primitive = await svc().rpc('request_action_decision_approval', { p_id: id })
    expect(primitive.error, 'primitive transition must not be callable by service_role').not.toBeNull()

    const pending = await svc().rpc('create_change_request_from_decision', {
      p_action_decision_id: id,
      p_request: {
        ad_account_id: ACCT, action_type: 'adjust_budget', entity_level: 'adset',
        meta_entity_id: LINEAGE.adsetDbId, params: { new_daily_budget_usd: 60 }, before_state: null,
        preview: 'Governed budget request.', reason: 'test', confidence: 5, risk_level: 'high',
        rollback_plan: 'restore', idempotency_key: 'governed-cr-1', requested_by: 'test',
        evidence: 'fixture', data_source: 'integration',
      },
    })
    expect(pending.error?.message).toMatch(/current policy floor/i)
    const state = await c.query(`SELECT approval_state, approved_at FROM action_decisions WHERE id=$1`, [id])
    expect(state.rows[0]).toEqual({ approval_state: 'not_requested', approved_at: null })
    const requests = await c.query(
      `SELECT count(*)::int n FROM change_requests WHERE action_decision_id=$1`, [id])
    expect(requests.rows[0].n).toBe(0)
  })

  it('authenticated has no direct table grants', async () => {
    const { rows } = await c.query(`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name='action_decisions' AND grantee='authenticated'`)
    const privs = rows.map((r) => r.privilege_type).sort()
    expect(privs).toEqual([])
  })

  it('anon has NO grants at all', async () => {
    // The GRANT table is the authoritative statement of what anon may do, and it is asserted
    // unconditionally. The live round-trip below only runs when an anon key is present in this
    // environment — it is corroboration, not the proof, so a missing key cannot mask a real grant.
    const { rows } = await c.query(`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE table_name='action_decisions' AND grantee='anon'`)
    expect(rows[0].n).toBe(0)

    // ...and no EXECUTE on the governed write paths either.
    const fns = await c.query(`
      SELECT count(*)::int AS n FROM information_schema.role_routine_grants
       WHERE grantee='anon' AND routine_name IN
             ('commit_action_decision','approve_action_decision','request_action_decision_approval',
              'create_change_request_from_decision','review_change_request_with_decision')`)
    expect(fns.rows[0].n).toBe(0)

    if (!ANON) return
    const { error } = await anon().from('action_decisions').select('id').limit(1)
    expect(error, 'anon must be denied').not.toBeNull()
  })

  it('anon cannot call the governed RPCs', async () => {
    if (!ANON) {
      // Grants already proved it above; skip the live call rather than fabricate a client.
      expect(ANON).toBe('')
      return
    }
    const { error } = await anon().rpc('commit_action_decision', COMMIT_ARGS)
    expect(error).not.toBeNull()
  })
})
