import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import pg from 'pg'

// This file drives generateRecommendationsFromFlags DIRECTLY against the real local
// Supabase. It does NOT call runDailySync, and the old name ("...-pipeline") implied it did. The true
// end-to-end orchestration proof lives in run-daily-sync-evidence.test.ts; this one isolates the
// generator so a failure points at the gate rather than at ingestion.
//
// The finding: decideRecommendation, conversionActionability, resolveOptimizationEventEvidence,
// analyzeCreativeDiversity and the audience resolver had ZERO callers in src/. Their unit tests
// passed while the daily pipeline reached none of them. These tests drive the REAL
// generateRecommendationsFromFlags and assert on what it persisted — so if the wiring is removed,
// they fail.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000e1'
const META_ACCT = 'act_evidence_gate'
const CAMP = '00000000-0000-4000-8000-0000000000e2'
const ADSET = '00000000-0000-4000-8000-0000000000e3'
const AD = '00000000-0000-4000-8000-0000000000e4'
const FLAG = '00000000-0000-4000-8000-0000000000e5'
const DATE = '2026-05-14'

const conn = async () => { const c = new pg.Client({ connectionString: DB }); await c.connect(); return c }
let c: pg.Client

/** Targeting that resolves MIXED: retargeting custom audiences + a lookalike + Advantage expansion. */
const MIXED_TARGETING = {
  custom_audiences: [{ id: 'CA_SITE' }, { id: 'LAL_1' }],
  targeting_automation: { advantage_audience: 1 },
  geo_locations: { cities: [{ name: 'Metro', radius: 20 }] },
  age_min: 25, age_max: 55,
}

async function seed(opts: { targetingSyncedAt: string | null; withAudienceMeta: boolean; viewThrough: number | null }) {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
  for (const t of ['recommendations', 'flags', 'decision_generations', 'experiments', 'daily_insights', 'creatives', 'ads', 'adsets', 'campaigns', 'custom_audiences'])
    await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [ACCT]).catch(() => {})
  await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,$2)`, [ACCT, META_ACCT])

  // ABO: campaign carries NO budget, so the optimization unit is the ad set.
  await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id) VALUES ($1,$2,'m-c-eg')`, [CAMP, ACCT])
  await c.query(
    `INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id, adset_name, targeting, targeting_last_synced_at, daily_budget, learning_stage)
     VALUES ($1,$2,$3,'m-as-eg','Warm Engagers | Retargeting',$4::jsonb,$5,24,'LEARNING_LIMITED')`,
    [ADSET, ACCT, CAMP, JSON.stringify(MIXED_TARGETING), opts.targetingSyncedAt],
  )
  const CREATIVE = '00000000-0000-4000-8000-0000000000e6'
  await c.query(`INSERT INTO creatives (id, ad_account_id, creative_id, video_id, asset_type) VALUES ($1,$2,'m-cr-eg','vid_shared','video')`, [CREATIVE, ACCT])
  await c.query(`INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id, creative_id) VALUES ($1,$2,$3,$4,'m-ad-eg',$5)`, [AD, ACCT, CAMP, ADSET, CREATIVE])

  if (opts.withAudienceMeta) {
    await c.query(
      `INSERT INTO custom_audiences (ad_account_id, audience_id, name, subtype, meta_account_id)
       VALUES ($1,'CA_SITE','site visitors','WEBSITE',$2), ($1,'LAL_1','lookalike 1%','LOOKALIKE',$2)`,
      [ACCT, META_ACCT],
    )
  }

  // View-through-heavy modelled conversions in a thin window.
  await c.query(
    `INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, impressions, spend, clicks, leads, bookings, bookings_view_through)
     VALUES ($1,$1,'account',$2, 31400, 742, 388, 0, 8, $3)`,
    [DATE, ACCT, opts.viewThrough],
  )
  await c.query(
    `INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, campaign_id, adset_id, ad_id, impressions, spend, clicks, leads, bookings)
     VALUES ($1,$1,'ad',$2,$3,$4,$5, 2600, 118, 27, 0, 0)`,
    [DATE, ACCT, CAMP, ADSET, AD],
  )
  await c.query(
    `INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, campaign_id, adset_id, impressions, spend, clicks, leads, bookings, synced_at)
     VALUES ($1,$1,'adset',$2,$3,$4, 2600, 118, 27, 0, 0, now())`,
    [DATE, ACCT, CAMP, ADSET],
  )

  // A flag that WOULD produce a money-moving recommendation.
  await c.query(
    `INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, flag_type, confidence, audience_type, reason, evidence, spend_in_window, cpa_in_window)
     VALUES ($1,$2,$3,7,'adset',$4,$5,'scale_candidate','high','unknown','strong modelled CPA','{}'::jsonb, 176, 22)`,
    [FLAG, ACCT, DATE, CAMP, ADSET],
  )
}

async function runGeneration() {
  const { generateRecommendationsFromFlags } = await import('@/lib/recommendations/generate')
  const snapshot = (await c.query(
    `SELECT id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, ad_id,
            flag_type, confidence, audience_type, reason, evidence, spend_in_window, cpa_in_window,
            ctr_in_window, frequency_in_window, recommended_action, watch_next, is_active, created_at
     FROM flags WHERE ad_account_id=$1 AND is_active`, [ACCT],
  )).rows
  // Supersede any prior flag head first: decision_generations enforces one current per kind, so a
  // second run must advance the head rather than insert a competing current row.
  await c.query(
    `UPDATE decision_generations SET is_current = false
     WHERE ad_account_id=$1 AND kind='flag' AND is_current`, [ACCT],
  )
  const gen = (await c.query(
    `INSERT INTO decision_generations (id, ad_account_id, kind, reference_date, row_count, is_current, committed_at)
     VALUES (gen_random_uuid(),$1,'flag',$2,$3,true,now()) RETURNING id`,
    [ACCT, DATE, snapshot.length],
  )).rows[0].id
  return generateRecommendationsFromFlags(ACCT, DATE, snapshot as never, gen)
}

const recs = async () =>
  (await c.query(
    `SELECT recommendation_type, reason_for_action, grounding_json, what_could_make_this_wrong FROM recommendations WHERE ad_account_id=$1`,
    [ACCT],
  )).rows as Array<{ recommendation_type: string; reason_for_action: string | null; grounding_json: unknown; what_could_make_this_wrong: unknown }>

const briefs = async () =>
  (await c.query(
    `SELECT * FROM experiments WHERE ad_account_id=$1`, [ACCT],
  )).rows as Array<Record<string, unknown>>

beforeEach(async () => { if (!c) c = await conn() })
afterAll(async () => {
  if (c) {
    for (const t of ['recommendations', 'flags', 'decision_generations', 'experiments', 'daily_insights', 'creatives', 'ads', 'adsets', 'campaigns', 'custom_audiences'])
      await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [ACCT]).catch(() => {})
    await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
    await c.end()
  }
})

describe('generateRecommendationsFromFlags — the evidence gate is REACHED and blocks a money move', () => {
  it('a scale flag on a MIXED, view-through-heavy, learning ad set does NOT become a direct action', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    await runGeneration()

    const rows = await recs()
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows[0].grounding_json)).not.toContain('Data is stale')
    // No money-moving type survives.
    for (const r of rows) {
      expect(['scale', 'scale_proposal', 'reduce_budget', 'pause', 'activate']).not.toContain(r.recommendation_type)
    }
    // The gate's reasoning is on the record.
    const reasoning = rows.map((r) => JSON.stringify(r.grounding_json ?? {})).join(' ')
    expect(reasoning).toMatch(/DECISION GATE: verdict/)
    expect(reasoning).toMatch(/Business truth:/)
    expect(reasoning).toMatch(/Meta modelled:/)
    expect(reasoning).toMatch(/View\/click mix:/)
  }, 60000)

  it('does not invent or persist a test contract from a failed decision gate', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    await runGeneration()

    expect(await briefs()).toHaveLength(0)
  }, 60000)

  it('repeated generation remains free of auto-created test briefs', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    await runGeneration()
    await runGeneration()
    expect(await briefs()).toHaveLength(0)
  }, 90000)

  it('STALE targeting freezes the decision — verdict freeze, no test brief', async () => {
    const stale = new Date(Date.now() - 96 * 3600_000).toISOString()
    await seed({ targetingSyncedAt: stale, withAudienceMeta: true, viewThrough: 6 })
    await runGeneration()

    const reasoning = (await recs()).map((r) => JSON.stringify(r.grounding_json ?? {})).join(' ')
    expect(reasoning).toMatch(/verdict freeze/)
    expect(reasoning).toMatch(/stale|frozen/i)
    expect(await briefs()).toHaveLength(0) // freeze does not generate a test
  }, 60000)

  it('MISSING audience metadata also freezes material conclusions', async () => {
    // No custom_audiences rows: subtypes unresolved, so composition cannot be established.
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: false, viewThrough: 6 })
    await runGeneration()
    const rows = await recs()
    for (const r of rows) {
      expect(['scale', 'scale_proposal', 'reduce_budget', 'pause', 'activate']).not.toContain(r.recommendation_type)
    }
    expect(rows.map((r) => JSON.stringify(r.grounding_json ?? {})).join(' ')).toMatch(/DECISION GATE/)
  }, 60000)

  it('an UNKNOWN view/click mix still blocks — absence is not evidence of click-driven conversions', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: null })
    await runGeneration()
    const rows = await recs()
    for (const r of rows) {
      expect(['scale', 'scale_proposal', 'reduce_budget']).not.toContain(r.recommendation_type)
    }
  }, 60000)

  // The old conflict test only asserted a generic gate message existed — it never proved the
  // CONFLICT gate itself failed. These assert the named gate.
  it('a RUNNING experiment on THIS ad set blocks the move via the conflict gate', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    await c.query(
      // Identity is FIRST CLASS (`entity_level`/`entity_ref`). The free-text refs deliberately hold only budget
      // state — exactly what a Maxx-generated brief writes — so a match here proves entity_ref works.
      `INSERT INTO experiments (ad_account_id, hypothesis, entity_level, entity_ref, changed_variable, control_ref, challenger_ref, primary_metric, success_contract, status, min_sample, min_spend, started_at)
       VALUES ($1,'h','adset',$2,'daily_budget','current state ($24)','proposed state ($29)','m','s','running',30,500,now())`,
      [ACCT, ADSET],
    )
    await runGeneration()
    const reasoning = (await recs()).map((r) => JSON.stringify(r.grounding_json ?? {})).join(' ')
    // The grounding note lists the FAILED GATE NAMES, so asserting the name proves the conflict gate
    // itself failed — the previous test only checked that some generic gate message existed.
    expect(reasoning).toMatch(/no_experiment_conflict/)
  }, 60000)

  it('a RUNNING experiment on ANOTHER ad set does NOT raise a conflict here', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    await c.query(
      `INSERT INTO experiments (ad_account_id, hypothesis, entity_level, entity_ref, changed_variable, control_ref, challenger_ref, primary_metric, success_contract, status, min_sample, min_spend, started_at)
       VALUES ($1,'h','adset','00000000-0000-4000-8000-0000000000ff','daily_budget','c','ch','m','s','running',30,500,now())`,
      [ACCT],
    )
    await runGeneration()
    const reasoning = (await recs()).map((r) => JSON.stringify(r.grounding_json ?? {})).join(' ')
    expect(reasoning).not.toMatch(/no_experiment_conflict/)
  }, 60000)

  // A CAMPAIGN flag deliberately carries adset_id = null. Deriving budget structure, budget,
  // audience and diversity ONLY through adsetDbId made every campaign/CBO decision resolve to
  // optimizationUnit "unknown" + verdict "freeze", so the claimed roll-up was never operational.
  it('a CBO CAMPAIGN flag resolves its unit, then freezes when full member context is not proven', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    // Make the campaign CBO (it owns the budget) and add a campaign-level flag with adset_id NULL,
    // exactly as the flag engine emits it.
    await c.query(`UPDATE campaigns SET daily_budget = 90 WHERE id=$1`, [CAMP])
    const CFLAG = '00000000-0000-4000-8000-0000000000ec'
    await c.query(
      `INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, flag_type, confidence, audience_type, reason, evidence, spend_in_window, cpa_in_window)
       VALUES ($1,$2,$3,7,'campaign',$4,NULL,'scale_candidate','high','unknown','campaign-level scale','{}'::jsonb, 352, 22)`,
      [CFLAG, ACCT, DATE, CAMP],
    )
    await c.query(`DELETE FROM flags WHERE id=$1`, [FLAG]) // isolate the campaign decision
    await runGeneration()

    const g = (await recs()).map((r) => JSON.stringify(r.grounding_json ?? {})).join(' ')
    // The unit is resolved at CAMPAIGN, not "unknown".
    expect(g).toMatch(/at the campaign unit/)
    expect(g).not.toMatch(/at the unknown unit/)
    // Unit resolution is not action authority. The campaign can be identified while the decision still
    // freezes until member targeting/audience context is fully proven.
    expect(g).toMatch(/verdict freeze/)
    expect(g).toMatch(/campaign_member_context_resolved/)
  }, 90000)

  it('a CBO campaign whose MEMBER is frozen still freezes — the roll-up stays conservative', async () => {
    // No targeting timestamp on the member => frozen member => campaign context unresolved.
    await seed({ targetingSyncedAt: null, withAudienceMeta: true, viewThrough: 6 })
    await c.query(`UPDATE campaigns SET daily_budget = 90 WHERE id=$1`, [CAMP])
    const CFLAG2 = '00000000-0000-4000-8000-0000000000eb'
    await c.query(
      `INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, flag_type, confidence, audience_type, reason, evidence, spend_in_window, cpa_in_window)
       VALUES ($1,$2,$3,7,'campaign',$4,NULL,'scale_candidate','high','unknown','campaign-level scale','{}'::jsonb, 352, 22)`,
      [CFLAG2, ACCT, DATE, CAMP],
    )
    await c.query(`DELETE FROM flags WHERE id=$1`, [FLAG])
    await runGeneration()
    const g = (await recs()).map((r) => JSON.stringify(r.grounding_json ?? {})).join(' ')
    expect(g).toMatch(/verdict freeze/)
  }, 90000)

  it('does not auto-create a test brief even when exact entity identity is available', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    await runGeneration()
    expect(await briefs()).toHaveLength(0)
  }, 60000)

  it('does not invent briefs for two ad sets that share a budget', async () => {
    await seed({ targetingSyncedAt: new Date().toISOString(), withAudienceMeta: true, viewThrough: 6 })
    const ADSET2 = '00000000-0000-4000-8000-0000000000ee'
    const FLAG2 = '00000000-0000-4000-8000-0000000000ed'
    await c.query(
      `INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id, adset_name, targeting, targeting_last_synced_at, daily_budget, learning_stage)
       VALUES ($1,$2,$3,'m-as-eg2','Warm Two',$4::jsonb,now(),24,'LEARNING_LIMITED')`,
      [ADSET2, ACCT, CAMP, JSON.stringify(MIXED_TARGETING)])
    await c.query(
      `INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, flag_type, confidence, audience_type, reason, evidence, spend_in_window, cpa_in_window)
       VALUES ($1,$2,$3,7,'adset',$4,$5,'scale_candidate','high','unknown','strong modelled CPA','{}'::jsonb, 176, 22)`,
      [FLAG2, ACCT, DATE, CAMP, ADSET2])
    await runGeneration()
    expect(await briefs()).toHaveLength(0)
  }, 90000)
})
