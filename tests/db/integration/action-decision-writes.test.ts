import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import {
  purgePaidCohortLineageFixture,
  seedPaidCohortLineageFixture,
  type PaidCohortLineageFixture,
} from './paid-cohort-lineage-fixture'
import { purgePaidMeasurement } from './paid-measurement-purge'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return '' } }
const ACCOUNT = '00000000-0000-4000-8000-0000000000e1'
const OTHER = '00000000-0000-4000-8000-0000000000e2'
const LINEAGE: PaidCohortLineageFixture = {
  accountId: ACCOUNT,
  campaignDbId: '00000000-0000-4000-8000-0000000001e1',
  adsetDbId: '00000000-0000-4000-8000-0000000002e1',
  activationId: '00000000-0000-4000-8000-0000000003e1',
  evaluationRunId: '00000000-0000-4000-8000-0000000004e1',
  recentGenerationId: '00000000-0000-4000-8000-0000000005e1',
  maturedGenerationId: '00000000-0000-4000-8000-0000000006e1',
  metaCampaignId: '640001',
  metaAdsetId: '640002',
}
let db: pg.Client
let sequence = 0

async function commitDecision(over: Record<string, unknown> = {}) {
  sequence += 1
  const base = {
    p_ad_account_id: ACCOUNT,
    p_action_kind: 'budget_scale',
    p_target_level: 'adset',
    p_target_id: LINEAGE.adsetDbId,
    p_evidence_plane: 'interaction_cohort',
    p_evidence_basis: 'interaction_cohort_complete',
    p_authority_tier: 'execution_eligible',
    p_authority_reason: 'Complete interaction cohort supports the exact move.',
    p_owner_copy: 'Execution-eligible only after owner approval and write mode.',
    p_direction_ceiling: 'execution',
    p_direction_reason: 'Direction proven.',
    p_policy_version: 3,
    p_dedupe_key: `write-decision-${sequence}`,
    p_source_kind: 'evaluator',
    p_source_id: `write-source-${sequence}`,
    p_objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    p_proposed_mutation: { action_type: 'adjust_budget', new_daily_budget_usd: 60 },
    p_paid_cohort_recent_generation_id: LINEAGE.recentGenerationId,
    p_paid_cohort_matured_generation_id: LINEAGE.maturedGenerationId,
    ...over,
  }
  const keys = Object.keys(base)
  const values = Object.values(base).map((value) =>
    typeof value === 'object' && value !== null ? JSON.stringify(value) : value)
  const casts = keys.map((key, index) => {
    const value = `$${index + 1}`
    return key === 'p_proposed_mutation' ? `${value}::jsonb` : value
  })
  const result = await db.query(
    `SELECT (commit_action_decision(${keys.map((key, i) => `${key} => ${casts[i]}`).join(',')})).*`,
    values,
  )
  return result.rows[0] as Record<string, unknown>
}

function requestPayload(target: string, amount = 60, account = ACCOUNT) {
  return {
    ad_account_id: account,
    action_type: 'adjust_budget',
    entity_level: 'adset',
    meta_entity_id: target,
    params: { new_daily_budget_usd: amount },
    before_state: { daily_budget: '5000' },
    preview: `CHANGE ${target} to $${amount}.`,
    reason: 'integration proof',
    confidence: 5,
    risk_level: 'high',
    rollback_plan: 'restore prior budget',
    idempotency_key: `request:${target}:${amount}:${sequence}`,
    requested_by: 'integration',
    evidence: 'fixture',
    data_source: 'integration',
  }
}

async function createRequest(decisionId: string, payload: object) {
  return db.query(
    `SELECT (create_change_request_from_decision($1,$2::jsonb)).*`,
    [decisionId, JSON.stringify(payload)],
  )
}

beforeAll(async () => {
  if (!LOOPBACK.has(hostOf(DB))) throw new Error(`refusing non-loopback database ${DB}`)
  db = new pg.Client({ connectionString: DB }); await db.connect()
  await db.query(`DELETE FROM change_requests WHERE ad_account_id IN ($1,$2)`, [ACCOUNT, OTHER])
  await db.query(`DELETE FROM action_decisions WHERE ad_account_id IN ($1,$2)`, [ACCOUNT, OTHER])
  await purgePaidCohortLineageFixture(db, LINEAGE)
  await purgePaidMeasurement(db, [ACCOUNT, OTHER])
  await db.query(`DELETE FROM ad_accounts WHERE id IN ($1,$2)`, [ACCOUNT, OTHER])
  await db.query(`INSERT INTO ad_accounts(id,account_id) VALUES ($1,'act_write_e1'),($2,'act_write_e2')`, [ACCOUNT, OTHER])
  await seedPaidCohortLineageFixture(db, LINEAGE)
}, 60_000)

afterAll(async () => {
  if (!db) return
    await db.query(`DELETE FROM change_requests WHERE ad_account_id IN ($1,$2)`, [ACCOUNT, OTHER])
    await db.query(`DELETE FROM action_decisions WHERE ad_account_id IN ($1,$2)`, [ACCOUNT, OTHER])
    await purgePaidCohortLineageFixture(db, LINEAGE)
    await purgePaidMeasurement(db, [ACCOUNT, OTHER])
    await db.query(`DELETE FROM ad_accounts WHERE id IN ($1,$2)`, [ACCOUNT, OTHER])
  await db.end()
})

describe('ActionDecision -> change request -> owner review is one database state machine', () => {
  it('rejects a policy-v3 decision whose durable objective is a delivery proxy', async () => {
    await expect(commitDecision({ p_objective: 'bookings' }))
      .rejects.toThrow(/action_decisions_v3_commercial_objective/i)
  })

  it('rejects a new unlinked request at the table boundary', async () => {
    await expect(db.query(`
      INSERT INTO change_requests(
        ad_account_id,action_type,entity_level,meta_entity_id,params,preview,idempotency_key)
      VALUES ($1,'pause_ad','ad','ad-legacy','{}','bad','unlinked')`, [ACCOUNT]))
      .rejects.toThrow(/action_decision_required/)
  })

  it('keeps a historical policy-v3 execution decision auditable but cannot create a request', async () => {
    const decision = await commitDecision()
    await expect(createRequest(String(decision.id), requestPayload(String(decision.target_id))))
      .rejects.toThrow(/current policy floor/i)
    const state = await db.query(`SELECT approval_state FROM action_decisions WHERE id=$1`, [decision.id])
    const count = await db.query(`SELECT count(*)::int n FROM change_requests WHERE action_decision_id=$1`, [decision.id])
    expect(state.rows[0].approval_state).toBe('not_requested')
    expect(count.rows[0].n).toBe(0)
  })

  it('cannot mint current policy-v5 execution authority through attributed paid-cohort association', async () => {
    await expect(commitDecision({ p_policy_version: ACTION_DECISION_POLICY_FLOOR }))
      .rejects.toThrow(/v4_money_quarantine|causal-estimate lineage/i)
  })

  it('cannot turn owner-review evidence into a live request', async () => {
    const decision = await commitDecision({
      p_action_kind: 'structural',
      p_authority_tier: 'owner_review',
      p_direction_ceiling: 'owner_review',
      p_evidence_plane: 'structural',
      p_evidence_basis: 'calendar_period_signal',
      p_paid_cohort_recent_generation_id: null,
      p_paid_cohort_matured_generation_id: null,
      p_policy_version: ACTION_DECISION_POLICY_FLOOR,
      p_proposed_mutation: {
        action_type: 'duplicate_adset', new_name: 'Copy', new_daily_budget_usd: null,
      },
    })
    const payload = {
      ...requestPayload(String(decision.target_id)), action_type: 'duplicate_adset',
      params: { new_name: 'Copy', new_daily_budget_usd: null },
    }
    await expect(createRequest(String(decision.id), payload)).rejects.toThrow(/not_execution_eligible/)
    const state = await db.query(`SELECT approval_state FROM action_decisions WHERE id=$1`, [decision.id])
    expect(state.rows[0].approval_state).toBe('not_requested')
  })

})
