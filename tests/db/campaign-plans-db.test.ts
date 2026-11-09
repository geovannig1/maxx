import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { markerSeed, objectMarker } from '@/lib/platforms/meta/campaign-payloads'

// ADR-062: campaign plans on the SHIPPED schema, every trigger enabled. Versions are immutable; their
// status moves only along governed edges; a create_campaign_paused change request exists only for a
// submitted version, initiated by the owner, with params the database derives itself; the review RPC
// approves the plan and the request together; a rollback archives only an executed creation.

const ACCOUNT = '00000000-0000-4000-8000-000000000621'
const OTHER = '00000000-0000-4000-8000-000000000622'
const OWNER = '00000000-0000-4000-8000-0000000000aa'
const HASH = 'a'.repeat(64)
let db: PGlite
let seq = 0

const spec = { campaign: { name: 'Spring prospecting' } }

async function newVersion(planId: string | null, account = ACCOUNT, extra: Record<string, unknown> = {}) {
  const { rows } = await db.query<{ id: string; plan_id: string; version: number; status: string }>(
    'SELECT * FROM public.create_campaign_plan_version($1, $2, $3, $4, $5, $6)',
    [planId, account, OWNER, 'Spring prospecting', JSON.stringify({ goal: 'sales' }), JSON.stringify({
      spec, spec_hash: HASH, currency: 'USD', total_daily_budget_minor: 3000, validation: [], readiness: [],
      source: 'template', notes: [], ...extra,
    })])
  return rows[0]
}

async function submit(versionId: string, extra: Record<string, unknown> = {}, owner: string | null = OWNER) {
  seq += 1
  const { rows } = await db.query<{ id: string; status: string; params: Record<string, unknown>; initiated_by: string; campaign_plan_version_id: string; action_decision_id: string | null; meta_entity_id: string }>(
    'SELECT * FROM public.create_campaign_plan_change_request($1, $2, $3)',
    [versionId, owner, JSON.stringify({
      ad_account_id: ACCOUNT, action_type: 'create_campaign_paused', preview: 'Create 1 campaign PAUSED',
      risk_level: 'high', rollback_plan: 'Archive the created paused objects.', idempotency_key: `plan-621-${seq}`,
      requested_by: 'owner@example.com', ...extra,
    })])
  return rows[0]
}

const versionStatus = async (id: string) =>
  (await db.query<{ status: string }>('SELECT status FROM public.campaign_plan_versions WHERE id = $1', [id])).rows[0].status

const review = (id: string, approve: boolean) =>
  db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, $3)', [id, 'owner@example.com', approve])

beforeAll(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_621')
  await insertAdAccount(db, OTHER, 'act_622')
}, 120_000)
afterAll(async () => db.close())

describe('campaign plan versions (ADR-062)', () => {
  it('keeps row-level security on and gives the browser roles nothing', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('campaign_plans','campaign_plan_versions','campaign_plan_objects') ORDER BY relname`)
    expect(rows).toEqual([
      { relname: 'campaign_plan_objects', relrowsecurity: true },
      { relname: 'campaign_plan_versions', relrowsecurity: true },
      { relname: 'campaign_plans', relrowsecurity: true },
    ])
    const grants = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
        WHERE table_name IN ('campaign_plans','campaign_plan_versions','campaign_plan_objects') AND grantee IN ('anon','authenticated')`)
    expect(grants.rows[0].n).toBe(0)
    const exec = await db.query<{ ok: boolean }>(
      `SELECT has_function_privilege('anon', 'public.create_campaign_plan_change_request(uuid, uuid, jsonb)', 'EXECUTE') AS ok`)
    expect(exec.rows[0].ok).toBe(false)
  })

  it('numbers versions per plan and supersedes the previous draft', async () => {
    const v1 = await newVersion(null)
    expect(v1).toMatchObject({ version: 1, status: 'draft' })
    const v2 = await newVersion(v1.plan_id)
    expect(v2).toMatchObject({ plan_id: v1.plan_id, version: 2, status: 'draft' })
    expect(await versionStatus(v1.id)).toBe('superseded')
  })

  it('refuses a version for a plan of another account', async () => {
    const v1 = await newVersion(null)
    await expect(newVersion(v1.plan_id, OTHER)).rejects.toThrow(/campaign_plan_account_mismatch/)
  })

  it('freezes a version\'s content and refuses an illegal status edge', async () => {
    const v = await newVersion(null)
    await expect(db.query(`UPDATE public.campaign_plan_versions SET spec = '{"campaign":{}}' WHERE id = $1`, [v.id]))
      .rejects.toThrow(/campaign_plan_version_content_is_immutable/)
    await expect(db.query(`UPDATE public.campaign_plan_versions SET status = 'created_paused' WHERE id = $1`, [v.id]))
      .rejects.toThrow(/campaign_plan_version_illegal_transition/)
  })

  it('refuses a malformed hash or an unknown payload key', async () => {
    await expect(newVersion(null, ACCOUNT, { spec_hash: 'nope' })).rejects.toThrow()
    await expect(newVersion(null, ACCOUNT, { surprise: true })).rejects.toThrow(/campaign_plan_version_payload_invalid/)
  })
})

describe('create_campaign_paused change requests (ADR-062)', () => {
  it('creates an owner request with database-derived params and moves the version to pending_approval', async () => {
    const v = await newVersion(null)
    const cr = await submit(v.id)
    expect(cr).toMatchObject({
      status: 'pending', initiated_by: 'owner', campaign_plan_version_id: v.id, action_decision_id: null, meta_entity_id: 'act_621',
      params: { plan_version_id: v.id, spec_hash: HASH },
    })
    expect(await versionStatus(v.id)).toBe('pending_approval')
    // Double-click safe: the same version returns the same request.
    expect((await submit(v.id)).id).toBe(cr.id)
  })

  it('refuses a request without an owner identity, for a superseded version, or from another account', async () => {
    const v1 = await newVersion(null)
    await expect(submit(v1.id, {}, null)).rejects.toThrow(/owner_identity/)
    await newVersion(v1.plan_id)
    await expect(submit(v1.id)).rejects.toThrow(/campaign_plan_version_not_draft/)
    const v3 = await newVersion(null)
    await expect(submit(v3.id, { ad_account_id: OTHER })).rejects.toThrow(/campaign_plan_version_account_mismatch/)
  })

  it('refuses a plan request written around the RPC: agent initiator, tampered params, missing lineage', async () => {
    const v = await newVersion(null)
    const base = `INSERT INTO public.change_requests (ad_account_id, action_type, entity_level, meta_entity_id, params, preview, idempotency_key, initiated_by, requested_by_user_id, campaign_plan_version_id)
      VALUES ($1, 'create_campaign_paused', 'account', 'act_621', $2, 'p', $3, $4, $5, $6)`
    await expect(db.query(base, [ACCOUNT, JSON.stringify({ plan_version_id: v.id, spec_hash: HASH }), 'raw-1', 'agent', null, v.id]))
      .rejects.toThrow()
    // A draft that was never submitted cannot carry a request, even with exact params.
    await expect(db.query(base, [ACCOUNT, JSON.stringify({ plan_version_id: v.id, spec_hash: HASH }), 'raw-0', 'owner', OWNER, v.id]))
      .rejects.toThrow(/campaign_plan_version_not_submitted/)
    await db.query(`UPDATE public.campaign_plan_versions SET status = 'pending_approval' WHERE id = $1`, [v.id])
    await expect(db.query(base, [ACCOUNT, JSON.stringify({ plan_version_id: v.id, spec_hash: 'b'.repeat(64) }), 'raw-2', 'owner', OWNER, v.id]))
      .rejects.toThrow(/campaign_plan_change_request_params_mismatch/)
    await expect(db.query(base, [ACCOUNT, JSON.stringify({ plan_version_id: v.id, spec_hash: HASH }), 'raw-3', 'owner', OWNER, null]))
      .rejects.toThrow(/campaign_plan_version_required/)
  })

  it('keeps the legacy refusal for every other decision-less request (control)', async () => {
    await expect(db.query(`INSERT INTO public.change_requests (ad_account_id, action_type, entity_level, meta_entity_id, params, preview, idempotency_key)
      VALUES ($1, 'pause_ad', 'ad', '1', '{}', 'p', 'raw-legacy')`, [ACCOUNT])).rejects.toThrow(/change_request_action_decision_required/)
  })

  it('approves the plan and the request together, and rejects them together', async () => {
    const a = await newVersion(null)
    const approved = await submit(a.id)
    await review(approved.id, true)
    expect(await versionStatus(a.id)).toBe('approved')
    const b = await newVersion(null)
    const rejected = await submit(b.id)
    await review(rejected.id, false)
    expect(await versionStatus(b.id)).toBe('rejected')
  })

  it('refuses to approve an expired plan request', async () => {
    const v = await newVersion(null)
    const cr = await submit(v.id)
    await db.query(`UPDATE public.change_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [cr.id]).catch(() => undefined)
    // expires_at is frozen approval context; the guard refuses the edit, so force it with the trigger off.
    await db.query('ALTER TABLE public.change_requests DISABLE TRIGGER trg_change_request_approval_context')
    await db.query(`UPDATE public.change_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [cr.id])
    await db.query('ALTER TABLE public.change_requests ENABLE TRIGGER trg_change_request_approval_context')
    await expect(review(cr.id, true)).rejects.toThrow(/change_request_expired/)
  })

  it('freezes the plan lineage and payload of a request after insert', async () => {
    const v = await newVersion(null)
    const cr = await submit(v.id)
    const other = await newVersion(null)
    await expect(db.query('UPDATE public.change_requests SET campaign_plan_version_id = $2 WHERE id = $1', [cr.id, other.id]))
      .rejects.toThrow(/immutable/)
    await expect(db.query(`UPDATE public.change_requests SET params = '{}' WHERE id = $1`, [cr.id])).rejects.toThrow()
  })
})

describe('created objects and rollback (ADR-062)', () => {
  async function executedCreation() {
    const v = await newVersion(null)
    const cr = await submit(v.id)
    await review(cr.id, true)
    await db.query(`UPDATE public.campaign_plan_versions SET status = 'creating' WHERE id = $1`, [v.id])
    await db.query(`UPDATE public.campaign_plan_versions SET status = 'created_paused' WHERE id = $1`, [v.id])
    await db.query(`UPDATE public.change_requests SET status = 'executed', executed_at = now() WHERE id = $1`, [cr.id])
    return { v, cr }
  }

  it('records one object per local key and freezes a Meta id once set', async () => {
    const { v, cr } = await executedCreation()
    const bound = (key: string) => objectMarker(markerSeed(v.id, cr.id), key)
    const insert = (key: string, metaId: string | null, marker = bound(key)) => db.query(
      `INSERT INTO public.campaign_plan_objects (plan_version_id, ad_account_id, change_request_id, object_kind, local_key, marker, meta_id)
       VALUES ($1, $2, $3, 'campaign', $4, $6, $5) RETURNING id`, [v.id, ACCOUNT, cr.id, key, metaId, marker])
    // A marker not bound to this request (e.g. derived from the spec alone) is refused (security review H1).
    await expect(insert('campaign', null, 'mx-abc')).rejects.toThrow(/campaign_plan_object_marker_not_bound_to_request/)
    const { rows } = await insert('campaign', null)
    await expect(insert('campaign', null)).rejects.toThrow()
    await db.query(`UPDATE public.campaign_plan_objects SET meta_id = '1200001', state = 'created' WHERE id = $1`, [(rows[0] as { id: string }).id])
    await expect(db.query(`UPDATE public.campaign_plan_objects SET meta_id = '1200002' WHERE id = $1`, [(rows[0] as { id: string }).id]))
      .rejects.toThrow(/campaign_plan_object_identity_is_immutable/)
    await expect(db.query(`UPDATE public.campaign_plan_objects SET origin = 'found' WHERE id = $1`, [(rows[0] as { id: string }).id]))
      .rejects.toThrow(/campaign_plan_object_identity_is_immutable/)
    await expect(db.query(
      `INSERT INTO public.campaign_plan_objects (plan_version_id, ad_account_id, change_request_id, object_kind, local_key, marker)
       VALUES ($1, $2, $3, 'adset', 'adset:0', $4)`, [v.id, OTHER, cr.id, bound('adset:0')])).rejects.toThrow(/campaign_plan_object_account_mismatch/)
  })

  it('creates one live rollback per executed creation, and none for a pending one', async () => {
    const { v, cr } = await executedCreation()
    const rollback = await submit(v.id, { action_type: 'archive_campaign_plan_objects', rollback_of: cr.id, meta_ids: ['1200001'] })
    expect(rollback).toMatchObject({ status: 'pending', params: { plan_version_id: v.id, spec_hash: HASH, meta_ids: ['1200001'] } })
    expect((await submit(v.id, { action_type: 'archive_campaign_plan_objects', rollback_of: cr.id, meta_ids: ['1200001'] })).id).toBe(rollback.id)
    await review(rollback.id, true)

    const pendingVersion = await newVersion(null)
    const pending = await submit(pendingVersion.id)
    await expect(submit(pendingVersion.id, { action_type: 'archive_campaign_plan_objects', rollback_of: pending.id, meta_ids: ['1'] }))
      .rejects.toThrow(/campaign_plan_rollback_original_invalid/)
  })
})
