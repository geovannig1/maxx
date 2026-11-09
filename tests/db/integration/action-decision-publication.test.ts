import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCOUNT = '00000000-0000-4000-8000-0000000000d7'
const FLAG_GEN = '00000000-0000-4000-8000-0000000000f7'
const REC_GEN_1 = '00000000-0000-4000-8000-000000000071'
const REC_GEN_2 = '00000000-0000-4000-8000-000000000072'
const REC_1 = '00000000-0000-4000-8000-0000000000a7'
const REC_2 = '00000000-0000-4000-8000-0000000000a8'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-0000000000d8'
let client: pg.Client

const rec = (id: string) => ({
  id, recommendation_type: 'investigate', target_entity_type: 'adset', target_entity_id: 'as-1',
  target_entity_name: 'Ad set 1', observed_fact: 'Meta modelled CPA is above the configured range.',
  metric_values: [], date_range_start: '2026-07-01', date_range_end: '2026-07-14', data_sources: ['meta_api'],
  evidence_summary: 'modelled signal', reason_for_action: 'Diagnostic-only governed copy.',
  confidence_score: 0.4, confidence_label: 'low', risk_level: 'high', gate_decision: 'hold', gate_passed: false,
  what_could_make_this_wrong: ['No interaction cohort.'], approval_required: false, action_allowed_now: false,
  low_data_warning: null, estimate_warning: 'Modelled.', attribution_warning: 'Not causal.',
  no_oscillation_allowed: null, no_oscillation_reason: null, recommended_next_check_date: '2026-07-21',
  grounding_json: {}, target_metric: 'cpa', target_status: 'critical', target_confidence: 'low',
  target_language: 'Modelled only.', attribution_confidence: null, external_knowledge_used: null,
  prior_learning_used: null, expected_upside: null, possible_downside: null, minimum_data_needed: null,
  learning_eligibility: false, outcome_status: null, source_flag_id: null, metric_claim_ids: [],
})

const decision = (sourceId: string, dedupe = `recommendation:${sourceId}:v3`, spend = 100) => ({
  action_kind: 'pause', target_level: 'adset', target_id: 'as-1', evidence_plane: 'meta_modelled',
  evidence_basis: 'calendar_period_signal', authority_tier: 'diagnostic_only',
  authority_reason: 'No interaction-cohort evidence.', owner_copy: 'Diagnostic-only governed copy.',
  direction_ceiling: 'unsupported', direction_reason: 'No trusted directional evidence.', policy_version: 3,
  dedupe_key: dedupe, source_id: sourceId, window_start: '2026-07-01', window_end: '2026-07-14',
  objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
  matured: null, continuity: null, windows_conflict: null, metrics: { spend },
  proposed_mutation: null,
  paid_cohort_recent_generation_id: null,
  paid_cohort_matured_generation_id: null,
})

async function publish(generation: string, expected: string | null, rows: object[], decisions: object[]) {
  return client.query(
    `SELECT replace_recommendation_generation_with_decisions($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) AS result`,
    [ACCOUNT, generation, expected, FLAG_GEN, '2026-07-14', JSON.stringify(rows), JSON.stringify(decisions)],
  )
}

beforeAll(async () => {
  if (!LOOPBACK.has(hostOf(DB))) throw new Error('refusing non-loopback')
  client = new pg.Client({ connectionString: DB }); await client.connect()
  await client.query(`DELETE FROM action_decisions WHERE ad_account_id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM recommendations WHERE ad_account_id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM decision_generations WHERE ad_account_id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM ad_accounts WHERE id=$1`, [OTHER_ACCOUNT])
  await client.query(`INSERT INTO ad_accounts(id,account_id) VALUES ($1,'act_d7')`, [ACCOUNT])
  await client.query(`INSERT INTO ad_accounts(id,account_id) VALUES ($1,'act_d8')`, [OTHER_ACCOUNT])
  await client.query(`INSERT INTO decision_generations(id,ad_account_id,kind,reference_date,is_current,row_count)
    VALUES ($1,$2,'flag','2026-07-14',true,0)`, [FLAG_GEN, ACCOUNT])
}, 60_000)

afterAll(async () => {
  if (!client) return
  await client.query(`DELETE FROM action_decisions WHERE ad_account_id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM recommendations WHERE ad_account_id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM decision_generations WHERE ad_account_id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCOUNT])
  await client.query(`DELETE FROM ad_accounts WHERE id=$1`, [OTHER_ACCOUNT])
  await client.end()
})

describe('atomic recommendation + authority publication', () => {
  it('rejects a missing/extra decision before publishing anything', async () => {
    await expect(publish(REC_GEN_1, null, [rec(REC_1)], [])).rejects.toThrow(/decision_count_mismatch/)
    const check = await client.query(`SELECT count(*)::int n FROM decision_generations WHERE id=$1`, [REC_GEN_1])
    expect(check.rows[0].n).toBe(0)
  })

  it('rejects duplicate or mismatched source identities before publication', async () => {
    await expect(publish(REC_GEN_1, null, [rec(REC_1), rec(REC_1)], [decision(REC_1), decision(REC_2)]))
      .rejects.toThrow(/decision_source_mismatch/)
    await expect(publish(REC_GEN_1, null, [rec(REC_1)], [decision(REC_2)]))
      .rejects.toThrow(/decision_source_mismatch/)
    const check = await client.query(`SELECT count(*)::int n FROM decision_generations WHERE id=$1`, [REC_GEN_1])
    expect(check.rows[0].n).toBe(0)
  })

  it('commits exactly one durable decision with its recommendation and is retry-idempotent', async () => {
    const first = await publish(REC_GEN_1, null, [rec(REC_1)], [decision(REC_1)])
    expect(first.rows[0].result.row_count).toBe(1)
    const retry = await publish(REC_GEN_1, null, [rec(REC_1)], [decision(REC_1)])
    expect(retry.rows[0].result).toEqual(first.rows[0].result)
    const joined = await client.query(`
      SELECT r.status, d.owner_copy, d.authority_tier
      FROM recommendations r JOIN action_decisions d
        ON d.ad_account_id=r.ad_account_id AND d.source_kind='recommendation' AND d.source_id=r.id::text
      WHERE r.id=$1`, [REC_1])
    expect(joined.rows).toEqual([{ status: 'open', owner_copy: 'Diagnostic-only governed copy.', authority_tier: 'diagnostic_only' }])
  })

  it('rejects an audit task linked to another account decision', async () => {
    const { rows } = await client.query(`SELECT id FROM action_decisions WHERE ad_account_id=$1 AND source_id=$2`, [ACCOUNT, REC_1])
    await expect(client.query(
      `INSERT INTO audit_tasks(ad_account_id, action_decision_id, title) VALUES ($1,$2,'bad link')`,
      [OTHER_ACCOUNT, rows[0].id],
    )).rejects.toThrow(/audit_task_action_decision_account_mismatch/)
  })

  it('rolls recommendation publication back when its decision collides', async () => {
    await expect(publish(REC_GEN_2, REC_GEN_1, [rec(REC_2)], [decision(REC_2, `recommendation:${REC_1}:v3`, 999)]))
      .rejects.toThrow(/dedupe collision/)
    const gen = await client.query(`SELECT count(*)::int n FROM decision_generations WHERE id=$1`, [REC_GEN_2])
    const prior = await client.query(`SELECT status FROM recommendations WHERE id=$1`, [REC_1])
    const failed = await client.query(`SELECT count(*)::int n FROM recommendations WHERE id=$1`, [REC_2])
    expect(gen.rows[0].n).toBe(0)
    expect(prior.rows[0].status).toBe('open')
    expect(failed.rows[0].n).toBe(0)
  })
})
