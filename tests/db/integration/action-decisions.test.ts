import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import {
  purgePaidCohortLineageFixture,
  seedPaidCohortLineageFixture,
  type PaidCohortLineageFixture,
} from './paid-cohort-lineage-fixture'
import { purgePaidMeasurement } from './paid-measurement-purge'

/**
 * The decision record is only an audit record if its facts cannot be
 * rewritten, if approval can only move along governed edges, and if a retried pipeline cannot mint a
 * second decision for the same proposal.
 */

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000d1'
const LINEAGE: PaidCohortLineageFixture = {
  accountId: ACCT,
  campaignDbId: '00000000-0000-4000-8000-0000000001d1',
  adsetDbId: '00000000-0000-4000-8000-0000000002d1',
  activationId: '00000000-0000-4000-8000-0000000003d1',
  evaluationRunId: '00000000-0000-4000-8000-0000000004d1',
  recentGenerationId: '00000000-0000-4000-8000-0000000005d1',
  maturedGenerationId: '00000000-0000-4000-8000-0000000006d1',
  metaCampaignId: '641001',
  metaAdsetId: '641002',
}
let c: pg.Client

const insert = (over: Record<string, unknown> = {}) => {
  const row = {
    ad_account_id: ACCT, action_kind: 'budget_cut', target_level: 'adset', target_id: 'as-1',
    evidence_plane: 'interaction_cohort', evidence_basis: 'interaction_cohort_complete',
    // direction_supported is GENERATED — deliberately absent; supplying it is an error, which the
    // derived-column test asserts explicitly.
    authority_tier: 'execution_eligible', authority_reason: 'r',
    owner_copy: 'Owner-facing governed copy.',
    direction_ceiling: 'execution', direction_reason: 'd', policy_version: 1,
    source_kind: 'flag', source_id: 'f-1', dedupe_key: 'flag:f-1:adset:as-1:2026-07:v1',
    ...over,
  }
  const cols = Object.keys(row)
  const vals = cols.map((_, i) => `$${i + 1}`)
  return c.query(
    `INSERT INTO action_decisions (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING id`,
    Object.values(row))
}

const insertCurrent = (over: Record<string, unknown> = {}) => insert({
  target_id: LINEAGE.adsetDbId,
  action_kind: 'structural',
  evidence_plane: 'structural',
  evidence_basis: 'calendar_period_signal',
  authority_tier: 'owner_review',
  direction_ceiling: 'owner_review',
  policy_version: ACTION_DECISION_POLICY_FLOOR,
  objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
  ...over,
})

beforeAll(async () => {
  if (!LOOPBACK.has(hostOf(DB))) throw new Error('refusing non-loopback')
  c = new pg.Client({ connectionString: DB }); await c.connect()
  await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
  await purgePaidCohortLineageFixture(c, LINEAGE)
  await purgePaidMeasurement(c, [ACCT])
  await c.query(`DELETE FROM ad_accounts WHERE id = $1`, [ACCT])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_d1')`, [ACCT])
  await seedPaidCohortLineageFixture(c, LINEAGE)
}, 60000)

afterAll(async () => {
  if (c) {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    await purgePaidCohortLineageFixture(c, LINEAGE)
    await purgePaidMeasurement(c, [ACCT])
    await c.query(`DELETE FROM ad_accounts WHERE id = $1`, [ACCT])
    await c.end()
  }
})

/**
 * NOTE ON SCOPE — these run as the `postgres` SUPERUSER over a raw pg connection, so GRANTs do not
 * apply to them. They prove the CONSTRAINT and TRIGGER layer: rules that hold even for a caller that
 * cannot be locked out. Role permissions (service_role / authenticated / anon) are proved separately
 * in the PostgREST suite below, where grants are actually enforced.
 */
describe('action_decisions constraint + trigger layer (superuser; grants NOT in play)', () => {
  it('a raw duplicate INSERT is rejected by the unique index', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    await insert()
    await expect(insert()).rejects.toThrow(/duplicate key|uq_action_decisions_dedupe/i)
  })

  it('one source artifact cannot receive two policy decisions under different dedupe keys', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    await insert({ dedupe_key: 'source-one', source_id: 'same-source' })
    await expect(insert({ dedupe_key: 'source-two', source_id: 'same-source' }))
      .rejects.toThrow(/duplicate key|uq_action_decisions_source_policy/i)
  })

  it('a row is BORN unapproved — approved cannot be an insert value', async () => {
    await expect(insert({ approval_state: 'approved', dedupe_key: 'k-born', source_id: 'f-b' }))
      .rejects.toThrow(/must be created with approval_state = 'not_requested'/i)
  })

  it('approved_at cannot be supplied by the caller', async () => {
    await expect(insert({ approved_at: '1999-01-01', dedupe_key: 'k-at', source_id: 'f-c' }))
      .rejects.toThrow(/stamped internally/i)
  })

  it('id and created_at are frozen', async () => {
    const { rows } = await c.query(`SELECT id FROM action_decisions WHERE ad_account_id=$1 LIMIT 1`, [ACCT])
    await expect(c.query(`UPDATE action_decisions SET created_at='1999-01-01' WHERE id=$1`, [rows[0].id]))
      .rejects.toThrow(/id and created_at are immutable/i)
  })

  it('approved_at cannot be changed directly', async () => {
    const { rows } = await c.query(`SELECT id FROM action_decisions WHERE ad_account_id=$1 LIMIT 1`, [ACCT])
    await expect(c.query(`UPDATE action_decisions SET approved_at=now() WHERE id=$1`, [rows[0].id]))
      .rejects.toThrow(/cannot be set directly/i)
  })

  it('direction_supported is DERIVED from the ceiling — not a second, forgeable truth', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    await insert({ dedupe_key: 'k-derived', source_id: 'f-d' })
    const { rows } = await c.query(
      `SELECT direction_ceiling, direction_supported FROM action_decisions WHERE dedupe_key='k-derived'`)
    expect(rows[0].direction_supported).toBe(rows[0].direction_ceiling !== 'unsupported')
    // It cannot be written independently at all.
    await expect(insert({ direction_supported: false, dedupe_key: 'k-x', source_id: 'f-x' } as never))
      .rejects.toThrow(/generated|cannot insert/i)
  })

  it('COMMIT rpc is idempotent: an identical retry returns the SAME row', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    const args = [ACCT, 'budget_cut', 'adset', 'as-9', 'interaction_cohort',
      'interaction_cohort_complete', 'execution_eligible', 'r', 'Owner-facing governed copy.', 'execution', 'd', 1,
      'commit:as-9:2026-07:v1', 'flag', 'f-9']
    const call = `SELECT (commit_action_decision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)).id AS id`
    const a = await c.query(call, args)
    const b = await c.query(call, args)        // retry — must SUCCEED, not raise
    expect(b.rows[0].id).toBe(a.rows[0].id)
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM action_decisions WHERE ad_account_id=$1`, [ACCT])
    expect(rows[0].n).toBe(1)
  })

  it('COMMIT rpc RAISES on a real dedupe collision (same key, different decision)', async () => {
    const args = [ACCT, 'pause', 'adset', 'as-9', 'interaction_cohort',
      'interaction_cohort_complete', 'execution_eligible', 'r', 'Owner-facing governed copy.', 'execution', 'd', 1,
      'commit:as-9:2026-07:v1', 'flag', 'f-9']
    await expect(c.query(
      `SELECT commit_action_decision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, args))
      .rejects.toThrow(/dedupe collision/i)
  })

  it('REPEATED commits stay at one row across independent connections', async () => {
    const args = [ACCT, 'budget_cut', 'adset', 'as-9', 'interaction_cohort',
      'interaction_cohort_complete', 'execution_eligible', 'r', 'Owner-facing governed copy.', 'execution', 'd', 1,
      'commit:as-9:2026-07:v1', 'flag', 'f-9']
    const call = `SELECT (commit_action_decision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)).id AS id`
    const clients = await Promise.all(Array.from({ length: 6 }, async () => {
      const client = new pg.Client({ connectionString: DB }); await client.connect(); return client
    }))
    try {
      const ids = await Promise.all(clients.map((client) => client.query(call, args)))
      expect(new Set(ids.map((r) => r.rows[0].id)).size).toBe(1)
    } finally {
      await Promise.all(clients.map((client) => client.end()))
    }
  })

  it('a same-key retry with ANY changed immutable payload RAISES', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    const full: unknown[] = [ACCT, 'budget_cut', 'adset', 'as-9', 'interaction_cohort',
      'interaction_cohort_complete', 'execution_eligible', 'r', 'Owner-facing governed copy.', 'execution', 'd', 1,
      'full-payload-collision', 'flag', 'f-9', '2026-07-01', '2026-07-14', 'bookings', true, true, false,
      JSON.stringify({ spend: 100 }), JSON.stringify({ percent: -20 })]
    const call = `SELECT commit_action_decision(${full.map((_, i) => `$${i + 1}`).join(',')})`
    await c.query(call, full)
    for (const [index, replacement] of [
      [7, 'changed reason'], [8, 'Changed owner copy.'], [10, 'changed direction'], [13, 'alert'],
      [14, 'different-id'], [15, '2026-06-30'], [16, '2026-07-15'], [17, 'awareness'], [18, false],
      [19, false], [20, true], [21, JSON.stringify({ spend: 999 })], [22, JSON.stringify({ percent: -50 })],
    ] as Array<[number, unknown]>) {
      const changed: unknown[] = [...full]; changed[index] = replacement
      await expect(c.query(call, changed), `parameter ${index + 1} changed`).rejects.toThrow(/dedupe collision/i)
    }
  })

  it('concurrent different-payload commits cannot both claim one key', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    const base = [ACCT, 'budget_cut', 'adset', 'as-race', 'interaction_cohort',
      'interaction_cohort_complete', 'execution_eligible', 'r', 'Owner-facing governed copy.', 'execution', 'd', 1,
      'concurrent-collision', 'flag', 'f-race', null, null, 'bookings', true, true, false]
    const call = `SELECT commit_action_decision(${Array.from({ length: 23 }, (_, i) => `$${i + 1}`).join(',')})`
    const a = new pg.Client({ connectionString: DB }); const b = new pg.Client({ connectionString: DB })
    await Promise.all([a.connect(), b.connect()])
    try {
      const settled = await Promise.allSettled([
        a.query(call, [...base, JSON.stringify({ spend: 100 }), null]),
        b.query(call, [...base, JSON.stringify({ spend: 999 }), null]),
      ])
      expect(settled.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      const rejected = settled.find((x): x is PromiseRejectedResult => x.status === 'rejected')
      expect(String(rejected?.reason)).toMatch(/dedupe collision/i)
    } finally {
      await Promise.all([a.end(), b.end()])
    }
  })

  it('the DB policy floor matches the TypeScript constant', async () => {
    const { ACTION_DECISION_POLICY_FLOOR } = await import('@/lib/authority/legacy-cutover')
    const { rows } = await c.query(`SELECT action_decision_policy_floor() AS f`)
    expect(rows[0].f).toBe(ACTION_DECISION_POLICY_FLOOR)
  })

  it('core decision FACTS cannot be mutated after insertion', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    await insert({ dedupe_key: 'k-immutable', source_id: 'f-im' })
    const { rows } = await c.query(
      `SELECT id FROM action_decisions WHERE ad_account_id = $1 LIMIT 1`, [ACCT])
    const id = rows[0].id
    for (const [col, val] of [
      ['authority_tier', 'diagnostic_only'], ['direction_ceiling', 'owner_review'],
      ['action_kind', 'pause'], ['target_id', 'as-2'], ['policy_version', 2],
      ['metrics', '{"tampered":true}'], ['evidence_basis', 'calendar_period_signal'],
      ['owner_copy', 'Tampered copy'],
    ] as Array<[string, unknown]>) {
      await expect(
        c.query(`UPDATE action_decisions SET ${col} = $1 WHERE id = $2`, [val, id]),
      ).rejects.toThrow(/immutable/i)
    }
  })

  it('preserves historical execution rows but blocks every new approval edge below policy v4', async () => {
    await c.query(`DELETE FROM action_decisions WHERE ad_account_id = $1`, [ACCT])
    const historical = await insert({
      target_id: LINEAGE.adsetDbId, policy_version: 3,
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      paid_cohort_recent_generation_id: LINEAGE.recentGenerationId,
      paid_cohort_matured_generation_id: LINEAGE.maturedGenerationId,
      dedupe_key: 'k-approve', source_id: 'f-ap',
    })
    const id = historical.rows[0].id
    await expect(c.query(`UPDATE action_decisions SET approval_state='approved' WHERE id=$1`, [id]))
      .rejects.toThrow(/current policy floor/i)
    await expect(c.query(`UPDATE action_decisions SET approval_state='pending' WHERE id=$1`, [id]))
      .rejects.toThrow(/current policy floor/i)
    const after = await c.query(`SELECT approval_state, approved_at FROM action_decisions WHERE id=$1`, [id])
    expect(after.rows[0]).toEqual({ approval_state: 'not_requested', approved_at: null })
  })

  it('a policy-v1 decision is historical and cannot enter approval after the v2 cutover', async () => {
    const legacy = await insert({ dedupe_key: 'legacy-floor', source_id: 'legacy-floor' })
    await expect(c.query(`UPDATE action_decisions SET approval_state='pending' WHERE id=$1`, [legacy.rows[0].id]))
      .rejects.toThrow(/current policy floor/i)
  })

  it('a NON-execution decision can never be approved', async () => {
    const r = await insertCurrent({
      dedupe_key: 'flag:f-2:adset:as-1:2026-07:v4', source_id: 'f-2',
    })
    const id = r.rows[0].id
    await c.query(`UPDATE action_decisions SET approval_state='pending' WHERE id=$1`, [id])
    await expect(c.query(`UPDATE action_decisions SET approval_state='approved' WHERE id=$1`, [id]))
      .rejects.toThrow(/only execution_eligible may be approved/i)
  })

  it('the tier can never EXCEED the evidence ceiling', async () => {
    await expect(insert({ authority_tier: 'execution_eligible', direction_ceiling: 'owner_review',
      dedupe_key: 'k-ceiling', source_id: 'f-3' })).rejects.toThrow(/tier_within_ceiling/i)
    await expect(insert({ authority_tier: 'owner_review', direction_ceiling: 'unsupported',
      dedupe_key: 'k-unsup', source_id: 'f-4' })).rejects.toThrow(/tier_within_ceiling/i)
  })

  it('a non-account action MUST name its target', async () => {
    await expect(insert({ target_level: 'campaign', target_id: null, dedupe_key: 'k-t', source_id: 'f-5' }))
      .rejects.toThrow(/target_identity/i)
  })

  it('execution requires interaction-cohort evidence, enforced in the DATABASE', async () => {
    await expect(insert({ evidence_basis: 'calendar_period_signal', dedupe_key: 'k-e', source_id: 'f-6' }))
      .rejects.toThrow(/execution_requires_cohort/i)
  })
})
