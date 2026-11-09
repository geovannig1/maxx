import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { markerSeed, objectMarker } from '@/lib/platforms/meta/campaign-payloads'

// Real Postgres (local Supabase) proofs for ADR-062 campaign plans, ADR-059 owner change requests and
// the security-review fixes: plan-version immutability, governed status moves, one live request per
// version, one plan object per Meta id, owner/agent initiation rules, the change-request status
// transition guard, and the stale-lock recovery (the real TS path over PostgREST, plus two connections
// racing the one-executing-row-per-account lock).

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return '' } }
const ACCOUNT = '00000000-0000-4000-8000-0000000007a1'
const OWNER = '00000000-0000-4000-8000-0000000000aa'
const AD = '120000000000007a1'
let db: pg.Client
let seq = 0

async function purge(): Promise<void> {
  await db.query('DELETE FROM action_log WHERE ad_account_id = $1', [ACCOUNT])
  await db.query('DELETE FROM campaign_plan_objects WHERE ad_account_id = $1', [ACCOUNT])
  // Requests reference versions (RESTRICT) and each other (rollback_of): delete rollbacks first.
  await db.query('DELETE FROM change_requests WHERE ad_account_id = $1 AND rollback_of IS NOT NULL', [ACCOUNT])
  await db.query('DELETE FROM change_requests WHERE ad_account_id = $1', [ACCOUNT])
  await db.query('DELETE FROM campaign_plan_versions WHERE ad_account_id = $1', [ACCOUNT])
  await db.query('DELETE FROM campaign_plans WHERE ad_account_id = $1', [ACCOUNT])
  await db.query('DELETE FROM action_decisions WHERE ad_account_id = $1', [ACCOUNT])
  await db.query('DELETE FROM ad_accounts WHERE id = $1', [ACCOUNT])
}

async function newVersion(): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM create_campaign_plan_version(NULL, $1, $2, $3, $4, $5)', [ACCOUNT, OWNER, 'Plan', '{}', JSON.stringify({
    spec: { campaign: { name: 'x' } }, spec_hash: 'c'.repeat(64), currency: 'USD', total_daily_budget_minor: 3000, validation: [], readiness: [], notes: [], source: 'template',
  })])
  return rows[0].id
}

async function submit(versionId: string): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>('SELECT id FROM create_campaign_plan_change_request($1, $2, $3)', [versionId, OWNER, JSON.stringify({
    ad_account_id: ACCOUNT, action_type: 'create_campaign_paused', preview: 'Create', risk_level: 'high', rollback_plan: 'Archive', idempotency_key: `int-7a1-${seq}-${randomUUID()}`, requested_by: 'owner',
  })])
  return rows[0].id
}

const review = (id: string, approve: boolean) => db.query('SELECT * FROM review_change_request_with_decision($1, $2, $3)', [id, 'owner@example.test', approve])

async function ownerReviewDecision(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO action_decisions (id, ad_account_id, action_kind, target_level, target_id, evidence_plane, evidence_basis,
      authority_tier, authority_reason, owner_copy, direction_ceiling, direction_reason, policy_version, objective, source_kind, dedupe_key, pragmatic_media_buyer)
    VALUES ($1, $2, 'pause', 'ad', $3, 'meta_modelled', 'meta_modelled_association', 'owner_review', 'Owner review.', 'Owner copy.', 'owner_review', 'Owner review.',
      5, 'maximize_incremental_contribution_from_ad_attributed_collected_revenue', 'recommendation', $4, true) RETURNING id`,
  [randomUUID(), ACCOUNT, AD, `int-7a1-${randomUUID()}`])
  return rows[0].id
}

function ownerPause(decision: string, owner: string | null = OWNER) {
  seq += 1
  return db.query<{ id: string; initiated_by: string }>('SELECT id, initiated_by FROM create_owner_change_request($1, $2, $3)', [decision, owner, JSON.stringify({
    ad_account_id: ACCOUNT, action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: AD, params: {}, before_state: { id: AD, status: 'ACTIVE' },
    preview: 'Pause', risk_level: 'medium', rollback_plan: 'activate', idempotency_key: `int-owner-7a1-${seq}-${randomUUID()}`, requested_by: 'owner',
  })])
}

beforeAll(async () => {
  if (!LOOPBACK.has(hostOf(DB))) throw new Error(`refusing non-loopback database ${DB}`)
  db = new pg.Client({ connectionString: DB })
  await db.connect()
  await purge()
  await db.query(`INSERT INTO ad_accounts (id, account_id, currency, is_active) VALUES ($1, 'act_7a1', 'USD', true)`, [ACCOUNT])
}, 60_000)

afterAll(async () => {
  if (!db) return
  await purge()
  await db.end()
})

describe('campaign plans on real Postgres (ADR-062)', () => {
  it('keeps a version\'s content immutable and its status on governed edges', async () => {
    const v = await newVersion()
    await expect(db.query(`UPDATE campaign_plan_versions SET spec = '{"campaign":{"name":"y"}}' WHERE id = $1`, [v])).rejects.toThrow(/campaign_plan_version_content_is_immutable/)
    await expect(db.query(`UPDATE campaign_plan_versions SET status = 'approved' WHERE id = $1`, [v])).rejects.toThrow(/campaign_plan_version_illegal_transition/)
    await expect(db.query(`UPDATE campaign_plan_versions SET status = 'creating' WHERE id = $1`, [v])).rejects.toThrow(/campaign_plan_version_illegal_transition/)
  })

  it('holds one live creation request per version', async () => {
    const v = await newVersion()
    const first = await submit(v)
    expect(await submit(v)).toBe(first)
    await expect(db.query(`INSERT INTO change_requests (ad_account_id, action_type, entity_level, meta_entity_id, params, preview, idempotency_key, initiated_by, requested_by_user_id, campaign_plan_version_id)
      SELECT ad_account_id, action_type, entity_level, meta_entity_id, params, preview, idempotency_key || ':dup', initiated_by, requested_by_user_id, campaign_plan_version_id FROM change_requests WHERE id = $1`, [first]))
      .rejects.toThrow(/uq_change_requests_campaign_plan_version|campaign_plan_version_not_submitted|duplicate key/)
  })

  it('binds each object to its request\'s marker and holds a Meta id in one row only', async () => {
    const [v1, v2] = [await newVersion(), await newVersion()]
    const [c1, c2] = [await submit(v1), await submit(v2)]
    const insert = (v: string, c: string, metaId: string, marker = objectMarker(markerSeed(v, c), 'campaign')) => db.query(
      `INSERT INTO campaign_plan_objects (plan_version_id, ad_account_id, change_request_id, object_kind, local_key, marker, meta_id) VALUES ($1, $2, $3, 'campaign', 'campaign', $4, $5)`,
      [v, ACCOUNT, c, marker, metaId])
    await expect(insert(v1, c1, '987650001', objectMarker(markerSeed(v2, c2), 'campaign'))).rejects.toThrow(/campaign_plan_object_marker_not_bound_to_request/)
    await insert(v1, c1, '987650001')
    await expect(insert(v2, c2, '987650001')).rejects.toThrow(/uq_campaign_plan_objects_meta_id/)
  })
})

describe('owner change requests and status transitions on real Postgres (ADR-059, security review L1)', () => {
  it('records an owner request as owner-initiated, refuses it on the agent path and without an owner id', async () => {
    const decision = await ownerReviewDecision()
    const { rows } = await ownerPause(decision)
    expect(rows[0].initiated_by).toBe('owner')
    await expect(ownerPause(await ownerReviewDecision(), null)).rejects.toThrow(/owner_change_request_requires_owner_identity/)
    await expect(db.query('SELECT create_change_request_from_decision($1, $2)', [await ownerReviewDecision(), JSON.stringify({
      ad_account_id: ACCOUNT, action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: AD, params: {}, before_state: { id: AD },
      preview: 'Pause', risk_level: 'medium', rollback_plan: 'activate', idempotency_key: `int-agent-${randomUUID()}`, requested_by: 'agent',
    })])).rejects.toThrow(/not_execution_eligible/)
    await expect(db.query(`UPDATE change_requests SET initiated_by = 'agent' WHERE id = $1`, [rows[0].id])).rejects.toThrow(/initiator_is_immutable|change_requests_owner_identity|lineage/)
  })

  it('makes executed terminal and keeps an ADR-059 failure from running again', async () => {
    const { rows } = await ownerPause(await ownerReviewDecision())
    await review(rows[0].id, true)
    await db.query(`UPDATE change_requests SET status = 'executed' WHERE id = $1`, [rows[0].id])
    await expect(db.query(`UPDATE change_requests SET status = 'failed' WHERE id = $1`, [rows[0].id])).rejects.toThrow(/change_request_illegal_status_transition/)
    const second = (await ownerPause(await ownerReviewDecision())).rows[0].id
    await review(second, true)
    await db.query(`UPDATE change_requests SET status = 'failed' WHERE id = $1`, [second])
    await expect(db.query(`UPDATE change_requests SET status = 'executed' WHERE id = $1`, [second])).rejects.toThrow(/change_request_illegal_status_transition/)
  })
})

describe('stale-lock recovery on real Postgres (security review M1)', () => {
  it('a second connection is blocked by a stuck run, and recovery through the app releases it', async () => {
    const v = await newVersion()
    const cr = await submit(v)
    await review(cr, true)
    await db.query(`UPDATE campaign_plan_versions SET status = 'creating' WHERE id = $1`, [v])
    await db.query(`INSERT INTO action_log (ad_account_id, action_type, entity_level, meta_entity_id, actor, idempotency_key, status, verified, change_request_id, created_at)
      VALUES ($1, 'create_campaign_paused', 'account', 'act_7a1', 'owner', $2, 'executing', false, $3, now() - interval '20 minutes')`, [ACCOUNT, `stuck-${cr}`, cr])

    const other = new pg.Client({ connectionString: DB })
    await other.connect()
    try {
      const claim = () => other.query(`INSERT INTO action_log (ad_account_id, action_type, entity_level, meta_entity_id, actor, idempotency_key, status, verified)
        VALUES ($1, 'pause_ad', 'ad', $2, 'owner', $3, 'executing', false)`, [ACCOUNT, AD, `other-${randomUUID()}`])
      await expect(claim()).rejects.toThrow(/idx_action_log_one_executing_per_account|duplicate key/)

      // Too young: refused, the lock stays.
      const { reviewChangeRequest } = await import('@/lib/writes/change-review')
      process.env.CHANGE_RECOVERY_STALE_MINUTES = '60'
      expect((await reviewChangeRequest({ id: cr, action: 'recover', actor: 'owner@example.test', accountId: ACCOUNT })).body.status).toBe('NOT_STALE')
      delete process.env.CHANGE_RECOVERY_STALE_MINUTES
      const recovered = await reviewChangeRequest({ id: cr, action: 'recover', actor: 'owner@example.test', accountId: ACCOUNT })
      expect(recovered.body).toMatchObject({ status: 'RECOVERED', outcome: 'unknown' })

      const state = await db.query<{ log: string; request: string; version: string }>(`SELECT
          (SELECT status FROM action_log WHERE change_request_id = $1) AS log,
          (SELECT status::text FROM change_requests WHERE id = $1) AS request,
          (SELECT status FROM campaign_plan_versions WHERE id = $2) AS version`, [cr, v])
      expect(state.rows[0]).toEqual({ log: 'unknown', request: 'failed', version: 'failed' })
      await expect(claim()).resolves.toBeDefined()
    } finally {
      await other.query(`DELETE FROM action_log WHERE ad_account_id = $1 AND change_request_id IS NULL`, [ACCOUNT])
      await other.end()
    }
  })
})
