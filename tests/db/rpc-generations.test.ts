import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, uuid, flagRow, activeFlagKeys, seedEntity, setCampaignBudget, touchCampaign, linkAdset } from './harness'
import { recommendationRow } from './decision-fixture'

// real-Postgres (PGlite) proofs of the durable-generation RPCs.

const ACCT = uuid(1)
const DATE = '2026-07-18'

async function callFlag(db: PGlite, o: {
  gen: string; prev: string | null; date?: string; rows: unknown[]; scopes?: unknown[]; proven?: unknown[]; frozen?: unknown
}) {
  const r = await db.query<{ r: { generation_id: string; row_count: number; active_flags: unknown[] } }>(
    `SELECT replace_flag_generation($1::uuid,$2::uuid,$3::uuid,$4::date,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) AS r`,
    [ACCT, o.gen, o.prev, o.date ?? DATE, JSON.stringify(o.rows), JSON.stringify(o.scopes ?? []), JSON.stringify(o.proven ?? []), JSON.stringify(o.frozen ?? { global: false, campaign_ids: [] })]
  )
  return r.rows[0].r
}
async function callRec(db: PGlite, o: { gen: string; prev: string | null; flagGen: string | null; date?: string; rows: Record<string, unknown>[] }) {
  const r = await db.query<{ r: { generation_id: string; row_count: number } }>(
    `SELECT replace_recommendation_generation($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::jsonb) AS r`,
    [ACCT, o.gen, o.prev, o.flagGen, o.date ?? DATE, JSON.stringify(o.rows.map((row) => recommendationRow(row)))]
  )
  return r.rows[0].r
}
async function callReport(db: PGlite, o: { recGen: string | null; date?: string; payload?: unknown; expectedFlag?: string | null }) {
  const r = await db.query<{ r: { committed: boolean; reason: string; current_generation_id: string | null } }>(
    `SELECT commit_daily_report_generation($1::uuid,$2::date,$3::uuid,$4::jsonb,$5::uuid) AS r`,
    [ACCT, o.date ?? DATE, o.recGen, JSON.stringify(o.payload ?? REPORT_PAYLOAD), o.expectedFlag ?? null]
  )
  return r.rows[0].r
}
// The shipped daily_reports contract requires a money basis on every new row; this is the minimal
// honest one (Acuity source unavailable, so no revenue is claimed).
const REPORT_PAYLOAD = {
  summary_text: 'hi',
  report_json: { money_basis: { version: 1, basis: 'outcome_collected_value', source_available: false } },
}
const scope = (level: string, id: string, w = 7) => ({ entity_level: level, entity_id: id, window_days: w })

let db: PGlite
beforeEach(async () => { db = await freshDb() })

describe('replace_flag_generation', () => {
  it('first commit (null→F1): inserts, creates a current manifest, returns the active snapshot', async () => {
    const F1 = uuid(10)
    const res = await callFlag(db, { gen: F1, prev: null, rows: [flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })] })
    expect(res.generation_id).toBe(F1)
    expect(res.row_count).toBe(1)
    expect(res.active_flags).toHaveLength(1)
    const heads = await db.query<{ c: number }>(`SELECT count(*)::int c FROM decision_generations WHERE ad_account_id=$1 AND kind='flag' AND is_current`, [ACCT])
    expect(heads.rows[0].c).toBe(1)
  })

  it('idempotent retry of the CURRENT generation returns the committed result (no error)', async () => {
    const F1 = uuid(10)
    await callFlag(db, { gen: F1, prev: null, rows: [flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'ad', ad_id: uuid(50), flag_type: 'loser', flag_date: DATE })] })
    const retry = await callFlag(db, { gen: F1, prev: null, rows: [] }) // same gen id → idempotent
    expect(retry.generation_id).toBe(F1)
    expect(retry.active_flags).toHaveLength(1)
  })

  it('stale CAS (wrong expected_prev) is rejected', async () => {
    const F1 = uuid(10)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    await expect(callFlag(db, { gen: uuid(11), prev: uuid(999), rows: [] })).rejects.toThrow(/stale_expected_generation/)
  })

  it('retry of F1 AFTER F2 committed → superseded_generation, never the F2 snapshot', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    await callFlag(db, { gen: F2, prev: F1, rows: [] })
    await expect(callFlag(db, { gen: F1, prev: null, rows: [] })).rejects.toThrow(/superseded_generation/)
  })

  it('manifest id with wrong account/date → invalid_generation', async () => {
    const F1 = uuid(10)
    await callFlag(db, { gen: F1, prev: null, date: DATE, rows: [] })
    await expect(callFlag(db, { gen: F1, prev: null, date: '2026-07-19', rows: [] })).rejects.toThrow(/invalid_generation/)
  })

  it('same-day re-prove leaves exactly one active row per key (adset + ad, fresh ids per run)', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    // Real runs mint a fresh id every time. An adset key (nullable ad_id) closes-old + inserts-new; an ad
    // key (non-null) upserts via ON CONFLICT. Both must end with exactly one ACTIVE row per key.
    const adset1 = flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })
    const ad1 = flagRow({ id: uuid(110), ad_account_id: ACCT, entity_level: 'ad', ad_id: uuid(60), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })
    await callFlag(db, { gen: F1, prev: null, rows: [adset1, ad1] })
    const adset2 = flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })
    const ad2 = flagRow({ id: uuid(111), ad_account_id: ACCT, entity_level: 'ad', ad_id: uuid(60), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })
    await callFlag(db, { gen: F2, prev: F1, rows: [adset2, ad2] })
    expect(await activeFlagKeys(db, ACCT)).toEqual(['ad:' + uuid(60) + ':7:loser', 'adset:' + uuid(50) + ':7:loser'])
  })

  it('cross-day re-prove closes the predecessor (replace-supersede), one active row survives', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await callFlag(db, { gen: F1, prev: null, date: '2026-07-17', rows: [flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: '2026-07-17' })] })
    await callFlag(db, { gen: F2, prev: F1, date: DATE, rows: [flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })] })
    expect(await activeFlagKeys(db, ACCT)).toEqual(['adset:' + uuid(50) + ':7:loser'])
    const total = await db.query<{ c: number }>(`SELECT count(*)::int c FROM flags WHERE ad_account_id=$1`, [ACCT])
    expect(total.rows[0].c).toBe(2) // both rows exist; only one active
  })

  it('stale closure: evaluated-not-proven closes; frozen adset budget flag preserved; ad-level scale closes under freeze', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    // The frozen carve-out resolves an adset's campaign through the REAL relationship, so the
    // fixture must link adset 50 to campaign 40 (prod guarantees adsets.campaign_id NOT NULL).
    await linkAdset(db, uuid(50), uuid(40))
    // Seed three flags via F1: an adset loser (camp X), a campaign scale (camp X), an ad-level scale.
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'campaign', campaign_id: uuid(40), flag_type: 'scale_candidate', flag_date: DATE }),
      flagRow({ id: uuid(102), ad_account_id: ACCT, entity_level: 'ad', ad_id: uuid(60), campaign_id: uuid(40), flag_type: 'scale_candidate', flag_date: DATE }),
    ] })
    // F2: all three entities EVALUATED, NONE proven (healthy), campaign 40 FROZEN.
    await callFlag(db, { gen: F2, prev: F1, rows: [], scopes: [scope('adset', uuid(50)), scope('campaign', uuid(40)), scope('ad', uuid(60))], proven: [], frozen: { global: false, campaign_ids: [uuid(40)] } })
    const keys = await activeFlagKeys(db, ACCT)
    // adset loser + campaign scale under frozen camp 40 are PRESERVED; ad-level scale CLOSES.
    expect(keys).toContain('adset:' + uuid(50) + ':7:loser')
    expect(keys).toContain('campaign:' + uuid(40) + ':7:scale_candidate')
    expect(keys).not.toContain('ad:' + uuid(60) + ':7:scale_candidate')
  })

  it('empty generation commits a manifest row and advances the head', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    const res = await callFlag(db, { gen: F2, prev: F1, rows: [] })
    expect(res.row_count).toBe(0)
    const head = await db.query<{ id: string }>(`SELECT id FROM decision_generations WHERE ad_account_id=$1 AND kind='flag' AND is_current`, [ACCT])
    expect(head.rows[0].id).toBe(F2)
    expect(head.rows).toHaveLength(1)
  })

  it('campaign-level re-prove (same-day AND cross-day) leaves exactly one active campaign flag per key', async () => {
    // Campaign rows have NULL adset_id/ad_id, so (like adset) the unique key never collides — the
    // replace-supersede (step 4) must retire the predecessor on both a same-day and a cross-day re-prove.
    const F1 = uuid(10), F2 = uuid(11), F3 = uuid(12)
    await callFlag(db, { gen: F1, prev: null, rows: [flagRow({ id: uuid(200), ad_account_id: ACCT, entity_level: 'campaign', campaign_id: uuid(40), flag_type: 'scale_candidate', flag_date: DATE })] })
    await callFlag(db, { gen: F2, prev: F1, rows: [flagRow({ id: uuid(201), ad_account_id: ACCT, entity_level: 'campaign', campaign_id: uuid(40), flag_type: 'scale_candidate', flag_date: DATE })] }) // same day
    expect(await activeFlagKeys(db, ACCT)).toEqual(['campaign:' + uuid(40) + ':7:scale_candidate'])
    await callFlag(db, { gen: F3, prev: F2, date: '2026-07-19', rows: [flagRow({ id: uuid(202), ad_account_id: ACCT, entity_level: 'campaign', campaign_id: uuid(40), flag_type: 'scale_candidate', flag_date: '2026-07-19' })] }) // cross day
    expect(await activeFlagKeys(db, ACCT)).toEqual(['campaign:' + uuid(40) + ':7:scale_candidate'])
    const active = await db.query<{ c: number }>(`SELECT count(*)::int c FROM flags WHERE ad_account_id=$1 AND is_active`, [ACCT])
    expect(active.rows[0].c).toBe(1) // exactly one active across all three re-proves
  })

  it('under freeze: an ad-level loser on a now-healthy ad CLOSES; an adset loser stays frozen', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await linkAdset(db, uuid(50), uuid(40)) // Freeze resolves via the real relationship
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'ad', ad_id: uuid(60), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE }),
    ] })
    // F2: both evaluated, neither re-proven (healthy), campaign 40 frozen. The frozen predicate only
    // protects adset/campaign budget flags — an ad-level loser is a creative pause, so it resolves.
    await callFlag(db, { gen: F2, prev: F1, rows: [], scopes: [scope('ad', uuid(60)), scope('adset', uuid(50))], proven: [], frozen: { global: false, campaign_ids: [uuid(40)] } })
    const keys = await activeFlagKeys(db, ACCT)
    expect(keys).not.toContain('ad:' + uuid(60) + ':7:loser')  // ad-level loser closes even under freeze
    expect(keys).toContain('adset:' + uuid(50) + ':7:loser')   // adset loser under frozen campaign preserved
  })
})

describe('replace_recommendation_generation — cross-stage lineage (C2/C3)', () => {
  it('commits when the source flag generation is current; rejects when the flag head has moved', async () => {
    const F1 = uuid(10), F2 = uuid(11), R1 = uuid(20)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    const rec = await callRec(db, { gen: R1, prev: null, flagGen: F1, rows: [{ id: uuid(200), recommendation_type: 'pause', target_entity_id: 'e1', generated_at: new Date(0).toISOString(), created_at: new Date(0).toISOString() }] })
    expect(rec.row_count).toBe(1)
    // A newer flag generation commits; a rec build still keyed to F1 must be rejected.
    await callFlag(db, { gen: F2, prev: F1, rows: [] })
    await expect(callRec(db, { gen: uuid(21), prev: R1, flagGen: F1, rows: [] })).rejects.toThrow(/stale_flag_generation/)
  })

  it('rec replacement supersedes the old open set and never leaves a mixed generation', async () => {
    const F1 = uuid(10), R1 = uuid(20), R2 = uuid(21)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    await callRec(db, { gen: R1, prev: null, flagGen: F1, rows: [{ id: uuid(200), recommendation_type: 'pause', target_entity_id: 'e1', generated_at: new Date(0).toISOString(), created_at: new Date(0).toISOString() }] })
    await callRec(db, { gen: R2, prev: R1, flagGen: F1, rows: [{ id: uuid(201), recommendation_type: 'scale', target_entity_id: 'e2', generated_at: new Date(0).toISOString(), created_at: new Date(0).toISOString() }] })
    const open = await db.query<{ generation_id: string }>(`SELECT DISTINCT generation_id FROM recommendations WHERE ad_account_id=$1 AND status='open'`, [ACCT])
    expect(open.rows).toEqual([{ generation_id: R2 }]) // exactly one generation open
  })
})

describe('commit_daily_report_generation — conditional persistence (C3)', () => {
  it('commits for the latest rec gen; returns stale_generation when a newer rec gen exists', async () => {
    const F1 = uuid(10), R1 = uuid(20), R2 = uuid(21)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    await callRec(db, { gen: R1, prev: null, flagGen: F1, rows: [] })
    expect((await callReport(db, { recGen: R1 })).committed).toBe(true)
    await callRec(db, { gen: R2, prev: R1, flagGen: F1, rows: [] }) // newer rec gen for the same date
    const stale = await callReport(db, { recGen: R1 })
    expect(stale.committed).toBe(false)
    expect(stale.reason).toBe('stale_generation')
    expect(stale.current_generation_id).toBe(R2)
  })

  it('null-generation path commits only while no rec manifest exists for the date', async () => {
    const F1 = uuid(10), R1 = uuid(20)
    // No rec manifest yet → the on-demand no-recs report commits.
    expect((await callReport(db, { recGen: null })).committed).toBe(true)
    // Once a rec generation commits for the date, the null path is stale.
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    await callRec(db, { gen: R1, prev: null, flagGen: F1, rows: [] })
    expect((await callReport(db, { recGen: null })).reason).toBe('stale_generation')
  })

  it('a missing / wrong-kind rec generation is invalid_generation, not stale (fix)', async () => {
    const F1 = uuid(10)
    await callFlag(db, { gen: F1, prev: null, rows: [] }) // F1 is a FLAG generation
    // A flag-kind id and a nonexistent id are both invalid — even though no REC generation exists for
    // the date (which the old code would have mislabeled stale_generation).
    expect((await callReport(db, { recGen: F1 })).reason).toBe('invalid_generation')
    expect((await callReport(db, { recGen: uuid(777) })).reason).toBe('invalid_generation')
  })
})

describe('security + rollback (corrective commit)', () => {
  it('rejects a flag referencing an entity owned by a DIFFERENT account (cross_account_entity)', async () => {
    await seedEntity(db, 'adsets', uuid(900), uuid(2)) // owned by account uuid(2), not ACCT=uuid(1)
    await expect(callFlag(db, {
      gen: uuid(10), prev: null,
      rows: [flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(900), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })],
    })).rejects.toThrow(/cross_account_entity/)
  })

  it('decision_generations has RLS enabled (repo convention)', async () => {
    const r = await db.query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'decision_generations'`)
    expect(r.rows[0].relrowsecurity).toBe(true)
  })

  it('a mid-transaction failure rolls the WHOLE RPC back — prior generation stays current, its flags active', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await callFlag(db, { gen: F1, prev: null, rows: [flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })] })
    // F2 passes CAS + ownership + runs step-4 supersede (which closes F1's adset flag), then FAILS in the
    // insert: the second row carries an invalid flag_type enum value → the cast raises mid-transaction.
    const supersedes = flagRow({ id: uuid(200), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })
    const bad = flagRow({ id: uuid(201), ad_account_id: ACCT, entity_level: 'ad', ad_id: uuid(60), adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'NOT_A_REAL_TYPE', flag_date: DATE })
    await expect(callFlag(db, { gen: F2, prev: F1, rows: [supersedes, bad] })).rejects.toThrow()
    // Rolled back: F1 still current, its adset flag still active (the step-4 supersede was undone), no F2.
    const head = await db.query<{ id: string }>(`SELECT id FROM decision_generations WHERE ad_account_id=$1 AND kind='flag' AND is_current`, [ACCT])
    expect(head.rows[0].id).toBe(F1)
    expect(await activeFlagKeys(db, ACCT)).toEqual(['adset:' + uuid(50) + ':7:loser'])
    const gens = await db.query<{ c: number }>(`SELECT count(*)::int c FROM decision_generations WHERE ad_account_id=$1 AND kind='flag'`, [ACCT])
    expect(gens.rows[0].c).toBe(1) // F2's manifest row was never committed
  })
})

// ═══ STRUCTURAL (6b) + ORPHAN (6c) closure, freshness-gated, audited ═══════════════════════════
// Every pre-existing test above passes NO freshness boundary, so 6b is disabled for them (byte-identical
// behavior). These opt in via p_frozen.campaign_metadata_not_before + fresh last_synced_at stamps + the
// REAL adset->campaign relationship (linkAdset).
describe('replace_flag_generation — structural unit closure', () => {
  const BOUNDARY = '2026-07-18T06:00:00Z'
  const FRESH = '2026-07-18T06:30:00Z'
  const STALE = '2026-07-18T05:00:00Z'
  const FZ = (over?: Record<string, unknown>) => ({ global: false, campaign_ids: [], campaign_metadata_not_before: BOUNDARY, ...over })
  const audit = async (id: string) => (await db.query<{ is_active: boolean; superseded_reason: string | null; superseded_by_generation_id: string | null }>(
    `SELECT is_active, superseded_reason, superseded_by_generation_id FROM flags WHERE id=$1`, [id])).rows[0]

  it('(1) SAME-COMMIT closure: new wrong-unit rows are inactive in the same transaction and absent from the snapshot', async () => {
    const F1 = uuid(10)
    await linkAdset(db, uuid(50), uuid(40))
    await setCampaignBudget(db, uuid(40), { daily: 100 }) // CBO parent -> adset budget flag impossible
    await touchCampaign(db, uuid(40), FRESH)
    await setCampaignBudget(db, uuid(41), {}) // ABO -> campaign budget flag impossible
    await touchCampaign(db, uuid(41), FRESH)
    const res = await callFlag(db, { gen: F1, prev: null, frozen: FZ(), rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'campaign', campaign_id: uuid(41), flag_type: 'scale_candidate', flag_date: DATE }),
    ] })
    expect(res.row_count).toBe(2) // rows WRITTEN (documented semantics) ...
    expect(res.active_flags).toHaveLength(0) // ... but neither survives commit-time truth
    expect((res as { structural_closures?: number }).structural_closures).toBe(2)
    expect((await audit(uuid(100)))).toMatchObject({ is_active: false, superseded_reason: 'structural_unit_change', superseded_by_generation_id: F1 })
    expect((await audit(uuid(101)))).toMatchObject({ is_active: false, superseded_reason: 'structural_unit_change', superseded_by_generation_id: F1 })
  })

  it('(2) both directions close across MULTIPLE windows with NO scopes/rows (dormant path)', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await linkAdset(db, uuid(50), uuid(40))
    // Seed WITHOUT a boundary so the rows land active (6b off), campaign state irrelevant yet.
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE, window_days: 7 }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'scale_candidate', flag_date: DATE, window_days: 30 }),
      flagRow({ id: uuid(102), ad_account_id: ACCT, entity_level: 'campaign', campaign_id: uuid(41), flag_type: 'scale_candidate', flag_date: DATE, window_days: 7 }),
    ] })
    // ABO->CBO for the adset's parent; CBO->ABO for campaign 41; both fresh.
    await setCampaignBudget(db, uuid(40), { lifetime: 500 }); await touchCampaign(db, uuid(40), FRESH)
    await setCampaignBudget(db, uuid(41), {}); await touchCampaign(db, uuid(41), FRESH)
    const res = await callFlag(db, { gen: F2, prev: F1, frozen: FZ(), rows: [] }) // no scopes, no rows
    expect((res as { structural_closures?: number }).structural_closures).toBe(3)
    expect(await activeFlagKeys(db, ACCT)).toEqual([])
  })

  it('(3) non-budget flags on the SAME entity survive (type scoping)', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await linkAdset(db, uuid(50), uuid(40))
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'creative_refresh', flag_date: DATE }),
    ] })
    await setCampaignBudget(db, uuid(40), { daily: 100 }); await touchCampaign(db, uuid(40), FRESH)
    await callFlag(db, { gen: F2, prev: F1, frozen: FZ(), rows: [] })
    expect(await activeFlagKeys(db, ACCT)).toEqual(['adset:' + uuid(50) + ':7:creative_refresh'])
  })

  it('(4) CBO variants: daily-only, lifetime-only, and ZERO-valued non-null budget all count as CBO', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    const cases: Array<[string, string, { daily?: number; lifetime?: number }]> = [
      [uuid(51), uuid(42), { daily: 100 }], [uuid(52), uuid(43), { lifetime: 500 }], [uuid(53), uuid(44), { daily: 0 }]]
    for (const [adset, camp, budget] of cases) { await linkAdset(db, adset, camp); await setCampaignBudget(db, camp, budget); await touchCampaign(db, camp, FRESH) }
    await callFlag(db, { gen: F1, prev: null, rows: cases.map(([adset, camp], i) =>
      flagRow({ id: uuid(110 + i), ad_account_id: ACCT, entity_level: 'adset', adset_id: adset, campaign_id: camp, flag_type: 'loser', flag_date: DATE })) })
    const res = await callFlag(db, { gen: F2, prev: F1, frozen: FZ(), rows: [] })
    expect((res as { structural_closures?: number }).structural_closures).toBe(3)
  })

  it('(5) freshness: STALE metadata preserves + is counted; a MISSING boundary disables 6b entirely', async () => {
    const F1 = uuid(10), F2 = uuid(11), F3 = uuid(12)
    await linkAdset(db, uuid(54), uuid(45))
    await setCampaignBudget(db, uuid(45), { daily: 100 }) // CBO — but STALE
    await touchCampaign(db, uuid(45), STALE)
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(54), campaign_id: uuid(45), flag_type: 'loser', flag_date: DATE })] })
    const withBoundary = await callFlag(db, { gen: F2, prev: F1, frozen: FZ(), rows: [] })
    expect((withBoundary as { structural_closures?: number }).structural_closures).toBe(0)
    expect((withBoundary as { unknown_metadata_flags?: number }).unknown_metadata_flags).toBe(1) // preserved, honestly counted
    const noBoundary = await callFlag(db, { gen: F3, prev: F2, rows: [] }) // boundary absent
    expect((noBoundary as { structural_closures?: number }).structural_closures).toBe(0)
    expect((noBoundary as { unknown_metadata_flags?: number }).unknown_metadata_flags).toBe(0) // nothing judged at all
    expect(await activeFlagKeys(db, ACCT)).toEqual(['adset:' + uuid(54) + ':7:loser'])
  })

  it('(6) frozen global=true does NOT preserve a fresh, known, structurally impossible unit', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await linkAdset(db, uuid(55), uuid(46))
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(55), campaign_id: uuid(46), flag_type: 'loser', flag_date: DATE })] })
    await setCampaignBudget(db, uuid(46), { daily: 100 }); await touchCampaign(db, uuid(46), FRESH)
    const res = await callFlag(db, { gen: F2, prev: F1, frozen: FZ({ global: true }), rows: [] })
    expect((res as { structural_closures?: number }).structural_closures).toBe(1) // freeze covers UNKNOWN; this is KNOWN+FRESH
    expect((res as { budget_decisions_frozen?: boolean }).budget_decisions_frozen).toBe(true)
    expect(await activeFlagKeys(db, ACCT)).toEqual([])
  })

  it('(7) the REAL relationship wins over mismatched denormalized flag data', async () => {
    const F1 = uuid(10), F2 = uuid(11)
    await setCampaignBudget(db, uuid(47), {});           await touchCampaign(db, uuid(47), FRESH) // ABO
    await setCampaignBudget(db, uuid(48), { daily: 50 }); await touchCampaign(db, uuid(48), FRESH) // CBO
    await linkAdset(db, uuid(56), uuid(48)) // REAL parent CBO, flag will LIE that it is 47 (ABO)
    await linkAdset(db, uuid(57), uuid(47)) // REAL parent ABO, flag will LIE that it is 48 (CBO)
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(56), campaign_id: uuid(47), flag_type: 'loser', flag_date: DATE }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(57), campaign_id: uuid(48), flag_type: 'loser', flag_date: DATE }),
    ] })
    await callFlag(db, { gen: F2, prev: F1, frozen: FZ(), rows: [] })
    const keys = await activeFlagKeys(db, ACCT)
    expect(keys).not.toContain('adset:' + uuid(56) + ':7:loser') // real parent CBO -> closed despite ABO lie
    expect(keys).toContain('adset:' + uuid(57) + ':7:loser')     // real parent ABO -> preserved despite CBO lie
  })

  it('(8) cross-account isolation: account A closure never touches account B', async () => {
    const B = uuid(2), F1 = uuid(10)
    await seedEntity(db, 'campaigns', uuid(300), B)
    await seedEntity(db, 'adsets', uuid(301), B)
    await linkAdset(db, uuid(301), uuid(300))
    await setCampaignBudget(db, uuid(300), { daily: 100 }); await touchCampaign(db, uuid(300), FRESH) // B: CBO fresh
    await db.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, adset_id, campaign_id, flag_type, reason)
      VALUES ($1, $2, $3, 'adset', $4, $5, 'loser', 'b-fixture')`, [uuid(310), B, DATE, uuid(301), uuid(300)])
    await callFlag(db, { gen: F1, prev: null, frozen: FZ(), rows: [] }) // account A commit
    const b = (await db.query<{ is_active: boolean }>(`SELECT is_active FROM flags WHERE id=$1`, [uuid(310)])).rows[0]
    expect(b.is_active).toBe(true) // B untouched by A's structural pass
  })

  it('(9) ORPHAN closure: null-FK flags close for ALL types, counted separately, excluded from snapshot', async () => {
    const F1 = uuid(10)
    // Simulate ON DELETE SET NULL aftermath: adset-level flag with NULL adset_id; ad-level creative_refresh with NULL ad_id.
    await db.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, adset_id, campaign_id, flag_type, reason)
      VALUES ($1, $2, $3, 'adset', NULL, $4, 'loser', 'orphan')`, [uuid(320), ACCT, DATE, uuid(40)])
    await db.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, ad_id, flag_type, reason)
      VALUES ($1, $2, $3, 'ad', NULL, 'creative_refresh', 'orphan')`, [uuid(321), ACCT, DATE])
    const res = await callFlag(db, { gen: F1, prev: null, rows: [] }) // no boundary needed — 6c is unconditional
    expect((res as { orphan_closures?: number }).orphan_closures).toBe(2)
    expect(res.active_flags).toHaveLength(0)
    expect((await audit(uuid(320)))).toMatchObject({ is_active: false, superseded_reason: 'orphaned_entity', superseded_by_generation_id: F1 })
    expect((await audit(uuid(321))).superseded_reason).toBe('orphaned_entity')
  })

  it('(10) CAS failure rolls back structural + orphan closures', async () => {
    const F1 = uuid(10)
    await linkAdset(db, uuid(50), uuid(40))
    await setCampaignBudget(db, uuid(40), { daily: 100 }); await touchCampaign(db, uuid(40), FRESH)
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })] })
    await db.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, adset_id, flag_type, reason)
      VALUES ($1, $2, $3, 'adset', NULL, 'loser', 'orphan')`, [uuid(322), ACCT, DATE])
    await expect(callFlag(db, { gen: uuid(11), prev: uuid(999), frozen: FZ(), rows: [] })).rejects.toThrow(/stale_expected_generation/)
    const keys = await activeFlagKeys(db, ACCT)
    expect(keys).toContain('adset:' + uuid(50) + ':7:loser') // structural closure rolled back
    expect((await audit(uuid(322))).is_active).toBe(true)    // orphan closure rolled back
  })

  it('(11) reactivation RESETS the audit triplet: an ACTIVE flag never carries a historical reason', async () => {
    // AD-level: the natural key is fully non-null, so a same-day re-prove hits ON CONFLICT and
    // REACTIVATES the original row (adset/campaign keys contain NULLs and go close-old+insert-new —
    // their old rows stay closed with their audit intact, which is correct history).
    const F1 = uuid(10), F2 = uuid(11), F3 = uuid(12)
    const key = { ad_account_id: ACCT, entity_level: 'ad' as const, ad_id: uuid(60), adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE }
    await callFlag(db, { gen: F1, prev: null, rows: [flagRow({ id: uuid(100), ...key })] })
    await callFlag(db, { gen: F2, prev: F1, rows: [], scopes: [scope('ad', uuid(60))], proven: [] }) // closes: not_reproven
    expect((await audit(uuid(100)))).toMatchObject({ is_active: false, superseded_reason: 'not_reproven', superseded_by_generation_id: F2 })
    await callFlag(db, { gen: F3, prev: F2, rows: [flagRow({ id: uuid(101), ...key })] }) // same natural key -> reactivates uuid(100)
    expect((await audit(uuid(100)))).toMatchObject({ is_active: true, superseded_reason: null, superseded_by_generation_id: null })
  })

  it('(12) idempotent retry returns the SAME persisted counts (a recompute would give 0)', async () => {
    const F1 = uuid(10)
    await linkAdset(db, uuid(50), uuid(40))
    await setCampaignBudget(db, uuid(40), { daily: 100 }); await touchCampaign(db, uuid(40), FRESH)
    const first = await callFlag(db, { gen: F1, prev: null, frozen: FZ(), rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE })] })
    expect((first as { structural_closures?: number }).structural_closures).toBe(1)
    const retry = await callFlag(db, { gen: F1, prev: null, rows: [] }) // same generation id
    expect((retry as { structural_closures?: number }).structural_closures).toBe(1) // persisted on the manifest
    expect((retry as { orphan_closures?: number }).orphan_closures).toBe(0)
    expect((retry as { budget_decisions_frozen?: boolean }).budget_decisions_frozen).toBe(false)
  })

  it('(13) dry-run parity: the deployment script lists EXACTLY the ids the RPC then closes', async () => {
    const F1 = uuid(10)
    // Fixture: structural adset (CBO fresh), structural campaign (ABO fresh), orphan, and a PRESERVED
    // stale case that must appear in NEITHER list.
    await linkAdset(db, uuid(50), uuid(40))
    await setCampaignBudget(db, uuid(40), { daily: 100 }); await touchCampaign(db, uuid(40), FRESH)
    await setCampaignBudget(db, uuid(41), {}); await touchCampaign(db, uuid(41), FRESH)
    await linkAdset(db, uuid(54), uuid(45))
    await setCampaignBudget(db, uuid(45), { daily: 100 }); await touchCampaign(db, uuid(45), STALE)
    for (const [id, level, adset, camp, type] of [
      [uuid(100), 'adset', uuid(50), uuid(40), 'loser'],
      [uuid(101), 'campaign', null, uuid(41), 'scale_candidate'],
      [uuid(102), 'adset', uuid(54), uuid(45), 'loser'], // stale -> preserved
    ] as const) {
      await db.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, adset_id, campaign_id, flag_type, reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'fixture')`, [id, ACCT, DATE, level, adset, camp, type])
    }
    await db.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, adset_id, flag_type, reason)
      VALUES ($1,$2,$3,'adset',NULL,'winner','orphan')`, [uuid(103), ACCT, DATE])

    const sql = fs.readFileSync(path.resolve(process.cwd(), 'scripts/dry-run-structural-closure.sql'), 'utf8')
      .replace(/:account/g, `'${ACCT}'`).replace(/:boundary/g, `'${BOUNDARY}'`)
    const dry = await db.query<{ id: string }>(sql)
    const dryIds = dry.rows.map((r) => r.id).sort()

    await callFlag(db, { gen: F1, prev: null, frozen: FZ(), rows: [] })
    const closed = await db.query<{ id: string }>(
      `SELECT id FROM flags WHERE ad_account_id=$1 AND superseded_by_generation_id=$2
       AND superseded_reason IN ('structural_unit_change','orphaned_entity') ORDER BY id`, [ACCT, F1])
    expect(closed.rows.map((r) => r.id).sort()).toEqual(dryIds)
    expect(dryIds).toEqual([uuid(100), uuid(101), uuid(103)].sort()) // stale uuid(102) in NEITHER list
  })

  it('(14) EVALUATED wrong-unit rows close as structural_unit_change, never not_reproven', async () => {
    // Blocker 1: with stale closure ordered first, an evaluated-not-proven wrong-unit flag was closed as
    // not_reproven with structural_closures=0. Precedence (structural before stale) must keep the truth.
    const F1 = uuid(10), F2 = uuid(11)
    await linkAdset(db, uuid(50), uuid(40))
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(50), campaign_id: uuid(40), flag_type: 'loser', flag_date: DATE }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'campaign', campaign_id: uuid(41), flag_type: 'scale_candidate', flag_date: DATE }),
    ] })
    await setCampaignBudget(db, uuid(40), { daily: 100 }); await touchCampaign(db, uuid(40), FRESH) // ABO->CBO
    await setCampaignBudget(db, uuid(41), {});             await touchCampaign(db, uuid(41), FRESH) // CBO->ABO
    // BOTH entities are EVALUATED and NOT proven this run — the exact preemption scenario.
    const res = await callFlag(db, { gen: F2, prev: F1, frozen: FZ(),
      rows: [], scopes: [scope('adset', uuid(50)), scope('campaign', uuid(41))], proven: [] })
    expect((res as { structural_closures?: number }).structural_closures).toBe(2)
    expect((await audit(uuid(100)))).toMatchObject({ is_active: false, superseded_reason: 'structural_unit_change', superseded_by_generation_id: F2 })
    expect((await audit(uuid(101)))).toMatchObject({ is_active: false, superseded_reason: 'structural_unit_change', superseded_by_generation_id: F2 })
  })

  it('(15) an orphaned budget flag counts orphan=1, unknown=0 (never double-counted as preserved)', async () => {
    const F1 = uuid(10)
    // Adset-level BUDGET flag with a NULL adset_id (deleted entity) — under a boundary this previously
    // counted as unknown_metadata BEFORE being orphan-closed (blocker 3).
    await db.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, adset_id, campaign_id, flag_type, reason)
      VALUES ($1, $2, $3, 'adset', NULL, $4, 'loser', 'orphan-budget')`, [uuid(330), ACCT, DATE, uuid(40)])
    const res = await callFlag(db, { gen: F1, prev: null, frozen: FZ(), rows: [] })
    expect((res as { orphan_closures?: number }).orphan_closures).toBe(1)
    expect((res as { unknown_metadata_flags?: number }).unknown_metadata_flags).toBe(0)
  })

  it('(16) the frozen carve-out resolves via the REAL parent: relationship-frozen preserved, denorm-frozen closes', async () => {
    // Blocker 2: a flag whose REAL parent is frozen must be preserved even when its denormalized
    // campaign_id lies about an unfrozen campaign — and denorm-frozen with an unfrozen real parent must
    // no longer be protected.
    const F1 = uuid(10), F2 = uuid(11)
    const FROZEN_CAMP = uuid(47), FREE_CAMP = uuid(48)
    await linkAdset(db, uuid(56), FROZEN_CAMP) // real parent frozen; flag will LIE denorm=FREE_CAMP
    await linkAdset(db, uuid(57), FREE_CAMP)   // real parent free;  flag will LIE denorm=FROZEN_CAMP
    await callFlag(db, { gen: F1, prev: null, rows: [
      flagRow({ id: uuid(100), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(56), campaign_id: FREE_CAMP, flag_type: 'loser', flag_date: DATE }),
      flagRow({ id: uuid(101), ad_account_id: ACCT, entity_level: 'adset', adset_id: uuid(57), campaign_id: FROZEN_CAMP, flag_type: 'loser', flag_date: DATE }),
    ] })
    // Both evaluated-not-proven; only FROZEN_CAMP is frozen. No boundary → structural off; pure freeze test.
    await callFlag(db, { gen: F2, prev: F1, rows: [],
      scopes: [scope('adset', uuid(56)), scope('adset', uuid(57))], proven: [],
      frozen: { global: false, campaign_ids: [FROZEN_CAMP] } })
    const keys = await activeFlagKeys(db, ACCT)
    expect(keys).toContain('adset:' + uuid(56) + ':7:loser')     // REAL parent frozen → preserved despite the lie
    expect(keys).not.toContain('adset:' + uuid(57) + ':7:loser') // real parent free → closes despite denorm lie
  })

  it('(17) report lineage-race guard: a newer flag generation for the date rejects the pinned commit', async () => {
    const F1 = uuid(10), R1 = uuid(20), F2 = uuid(11)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    await callRec(db, { gen: R1, prev: null, flagGen: F1, rows: [] })
    // Narrative computed against F1 while it is the latest flag gen for the date → commits.
    const ok = await callReport(db, { recGen: R1, expectedFlag: F1 })
    expect(ok.committed).toBe(true)
    // A NEWER flag generation for the SAME date arrives (the mid-generation race) → pinned commit rejects.
    await callFlag(db, { gen: F2, prev: F1, rows: [] })
    const stale = await callReport(db, { recGen: R1, expectedFlag: F1 })
    expect(stale.committed).toBe(false)
    expect(stale.reason).toBe('stale_generation')
    // A NULL guard (no-lineage / unknown paths) still commits — the narrative carries its own caveat.
    const unguarded = await callReport(db, { recGen: R1 })
    expect(unguarded.committed).toBe(true)
  })

  it('(18) ROLLED-BACK generations are excluded from every latest-for-date read in the commit RPC', async () => {
    // The durable exclusion: demoting is_current is NOT enough — latest-for-date readers order by
    // committed_at. A stamped generation must lose date authority to the restored one.
    const F1 = uuid(10), R1 = uuid(20), F2 = uuid(11), R2 = uuid(21)
    await callFlag(db, { gen: F1, prev: null, rows: [] })
    await callRec(db, { gen: R1, prev: null, flagGen: F1, rows: [] })
    await callFlag(db, { gen: F2, prev: F1, rows: [] })
    await callRec(db, { gen: R2, prev: R1, flagGen: F2, rows: [] })
    // Newest generations win the date while unstamped...
    const beforeStamp = await callReport(db, { recGen: R1 })
    expect(beforeStamp.committed).toBe(false) // R2 is newer for the date
    // ...but once F2/R2 are stamped rolled_back_at (what the rollback script does), the RESTORED R1/F1
    // regain date authority: R1 commits again, including under the flag lineage-race guard against F1.
    await db.query(`UPDATE decision_generations SET rolled_back_at = now(), is_current = false WHERE id IN ($1,$2)`, [F2, R2])
    await db.query(`UPDATE decision_generations SET is_current = true WHERE id IN ($1,$2)`, [F1, R1])
    const afterStamp = await callReport(db, { recGen: R1, expectedFlag: F1 })
    expect(afterStamp.committed).toBe(true)
    // And a stamped rec generation can never be committed as the date's report pin.
    const stampedPin = await callReport(db, { recGen: R2 })
    expect(stampedPin.committed).toBe(false)
  })
})
