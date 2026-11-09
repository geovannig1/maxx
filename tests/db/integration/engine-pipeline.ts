// Durable generations — END-TO-END engine→PostgREST→DB→report proof, running the REAL runFlagEngine →
// generateRecommendationsFromFlags → generateDailyReport code against a local Supabase (not the RPCs in
// isolation). Proves the whole pipeline over the wire: the engine publishes a flag generation atomically
// through PostgREST; recommendations build from the returned snapshot and commit with cross-stage lineage;
// the report pins to that rec generation; and a report pinned to a SUPERSEDED rec generation is rejected
// (stale) while the prior report row stands. Prereq: `supabase start` (same stack as the .mjs proofs).
//
// Run:  supabase start  &&  tsx --tsconfig tsconfig.scripts.json tests/db/integration/engine-pipeline.ts

// Point the app's admin client at the local stack BEFORE importing anything that builds it, and make the
// report deterministically metrics-only (no LLM provider keys → generateReport throws → metrics persist).
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SB_API_URL || 'http://127.0.0.1:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SB_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY

import pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { FlagRow } from '@/lib/recommendations/generate' // type-only: erased at runtime, no client built
import { purgeExecutiveEvidence, purgePaidMeasurement } from './paid-measurement-purge'
import { insertOutcomeOutcome } from './outcome-fixture'
import { EXAMPLE_OWNER_TARGETS } from '../../helpers/example-owner-targets'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// SAFETY: this suite GRANTs/DELETEs — refuse any non-loopback host, validating BOTH the raw Postgres URL
// and the API URL (a remote SB_DB_URL override must never receive our writes).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }
for (const u of [DB, process.env.NEXT_PUBLIC_SUPABASE_URL || '']) if (!LOOPBACK.has(hostOf(u))) { console.error(`refusing non-loopback host: ${u}`); process.exit(1) }

const ACCT = '00000000-0000-4000-8000-0000000000e2'
const CAMP = '00000000-0000-4000-8000-0000000000c2'
const ADSET = '00000000-0000-4000-8000-0000000000a2'
const AD = '00000000-0000-4000-8000-0000000000d2'
// A fixed HISTORICAL date, deliberately not yesterday(), so this test's ledger row can't collide with the
// account-agnostic acuity ledger of the runDailySync test (which seeds yesterday()).
const DATE = '2026-06-15'

let failures = 0
const check = (label: string, ok: boolean) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++ }
const conn = async () => { const c = new pg.Client({ connectionString: DB }); await c.connect(); return c }
const daysBefore = (dateStr: string, n: number) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }

async function seed(c: pg.Client) {
  // Ambient prod default-ACL grants the local `supabase start` doesn't apply (same as supabase-integration.mjs).
  // outcomes is INCLUDED so the report exercises the CANONICAL Acuity path, not the fallback.
  // `creatives` and the evidence-gate tables were MISSING: after a fresh reset the real pipeline
  // logged "permission denied for table creatives", silently degraded creative diversity to unknown,
  // and the suite still passed — so the advertised engine-to-evidence proof never exercised
  // diversity on a clean replay.
  for (const t of ['flags', 'recommendations', 'daily_reports', 'campaigns', 'adsets', 'ads', 'daily_insights', 'outcomes', 'creatives', 'custom_audiences', 'experiments', 'conversion_deliveries', 'app_settings'])
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO service_role`)
  await purgeExecutiveEvidence(c, [ACCT])
  // A previous run's outcome rows have RESTRICT children (collected-value observations); without this
  // purge a second run fails in setup on the outcomes delete below.
  await purgePaidMeasurement(c, [ACCT])
  for (const t of ['change_requests', 'audit_tasks', 'recommendations', 'flags', 'decision_generations', 'daily_reports', 'action_decisions', 'daily_insights', 'outcomes', 'outcome_sources', 'ads', 'adsets', 'campaigns'])
    await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [ACCT])
  await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
  // The acuity ledger is account-agnostic (single-account app) — isolate THIS date so getOutcomeMetrics
  // sees exactly the one row we seed below, regardless of other tests' accounts.
  await c.query(`DELETE FROM outcomes WHERE business_date=$1`, [DATE])

  // The app resolves the owner's settings through the sole active account, as in production.
  await c.query(`UPDATE ad_accounts SET is_active=false WHERE id<>$1`, [ACCT])
  await c.query(`INSERT INTO ad_accounts (id, account_id, is_active) VALUES ($1,'act_e2e',true)`, [ACCT])
  // Precondition: money metrics have no built-in target, so the zero-outcome loser tier needs an
  // owner-set CPA target. Store the example owner's targets where Settings -> Performance Targets does.
  await c.query(
    `INSERT INTO app_settings (ad_account_id, key, value, setting_type) VALUES ($1, 'performance_targets', $2, 'json')
     ON CONFLICT (ad_account_id, key) DO UPDATE SET value=excluded.value`,
    [ACCT, JSON.stringify(EXAMPLE_OWNER_TARGETS)],
  )
  const old = daysBefore(DATE, 10) // created >2 days ago so the too_early guard passes
  // last_synced_at = now() → FRESH vs the past boundary the engine runs pass (stale metadata
  // would disable budget evaluation and freeze the run).
  await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id, created_at, last_synced_at) VALUES ($1,$2,'m-c',$3, now())`, [CAMP, ACCT, old])
  await c.query(`INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id, created_at) VALUES ($1,$2,$3,'m-as',$4)`, [ADSET, ACCT, CAMP, old])
  await c.query(`INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id, created_at) VALUES ($1,$2,$3,$4,'m-ad',$5)`, [AD, ACCT, CAMP, ADSET, old])
  // 3 ad-level insight days: Σspend=$150 (≥ 2×$64 target), 0 bookings, ≥500 impressions → a `loser` flag.
  for (let i = 0; i < 3; i++) {
    const d = daysBefore(DATE, i)
    await c.query(
      `INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, campaign_id, adset_id, ad_id, impressions, spend, clicks, leads, bookings)
       VALUES ($1,$1,'ad',$2,$3,$4,$5, 1000, 50, 10, 0, 0)`, [d, ACCT, CAMP, ADSET, AD])
  }
  // Complete account-level trailing-30d window for report publication. DATE keeps the distinctive $42
  // spend so the persisted report row still proves it read the target day's warehouse metric.
  for (let i = 0; i < 30; i++) {
    const d = daysBefore(DATE, i)
    const spend = d === DATE ? 42 : 1
    await c.query(
      `INSERT INTO daily_insights (date_start, date_stop, entity_level, ad_account_id, impressions, spend, clicks, leads, bookings)
       VALUES ($1,$1,'account',$2, 3000, $3, 30, 5, 0)`, [d, ACCT, spend])
  }
  // Acuity ledger row for DATE — the CANONICAL business truth the report stores as business_outcomes/revenue.
  await insertOutcomeOutcome(c, ACCT, 990201, {
    business_date: DATE, gross_value: 250, collected_value: 250, status: 'confirmed',
  })
  await c.query(
    `INSERT INTO app_settings (ad_account_id, key, value, setting_type)
     VALUES ($1, 'acuity_ledger_health', $2, 'json')
     ON CONFLICT (ad_account_id, key) DO UPDATE SET value=excluded.value`,
    [ACCT, JSON.stringify({
      last_reconciled_at: new Date().toISOString(),
      window_basis: 'booking_date_et',
      window_start_date: daysBefore(DATE, 60),
      window_end_date: DATE,
      truncated: false,
    })],
  )
}

async function main() {
  const c = await conn()
  await seed(c)

  const { runFlagEngine } = await import('@/lib/flags/engine')
  const { generateRecommendationsFromFlags } = await import('@/lib/recommendations/generate')
  const { generateDailyReport } = await import('@/lib/report/generator')
  const { readCurrentGeneration } = await import('@/lib/flags/generations')
  const { getAdminClient } = await import('@/lib/supabase/admin')
  const { hydrateTargetOverrides } = await import('@/lib/targets/store')

  console.log('engine → recommendations → report (REAL code, real Postgres):')

  // 1) The flag engine evaluates the seeded insights and publishes a generation via the RPC.
  const BOUNDARY = '2000-01-01T00:00:00Z' // far past; seed stamped last_synced_at = now() → FRESH
  const META_OUTCOME_PLANE = {
    status: 'complete' as const,
    blockerCodes: [],
    sourceNotBefore: BOUNDARY,
    checkedLevels: ['campaign' as const, 'adset' as const, 'ad' as const],
  }
  // As the sync orchestrator does before the engine runs: load the owner's targets for this request.
  const targets = await hydrateTargetOverrides()
  check('the owner-set performance targets load (precondition)', targets.status === 'unversioned')
  const flagGen = await runFlagEngine(ACCT, DATE, { metadataNotBefore: BOUNDARY })
  const flagRows = (await c.query(`SELECT flag_type, generation_id, is_active FROM flags WHERE ad_account_id=$1 AND is_active=true`, [ACCT])).rows
  check('flag engine committed a generation (row_count>0)', !!flagGen.generation_id && flagGen.row_count > 0)
  check('a loser flag persisted, stamped with the generation id, active',
    flagRows.some((r) => r.flag_type === 'loser' && r.generation_id === flagGen.generation_id && r.is_active === true))
  check('the returned snapshot equals the persisted active flag set', flagGen.active_flags.length === flagRows.length)

  // 2) Recommendations build from the RETURNED snapshot (no re-query) and commit with cross-stage lineage.
  const recGen = await generateRecommendationsFromFlags(ACCT, DATE, flagGen.active_flags as unknown as FlagRow[], flagGen.generation_id)
  const recRows = (await c.query(`SELECT generation_id, source_flag_id, status FROM recommendations WHERE ad_account_id=$1`, [ACCT])).rows
  check('rec generation committed (row_count>0)', !!recGen.generation_id && recGen.row_count > 0)
  check('recs stamped with the rec generation, linked to a source flag, status open',
    recRows.length > 0 && recRows.every((r) => r.generation_id === recGen.generation_id && !!r.source_flag_id && r.status === 'open'))
  const recMan = (await c.query(`SELECT parent_generation_id, is_current FROM decision_generations WHERE ad_account_id=$1 AND kind='recommendation' AND is_current`, [ACCT])).rows[0]
  check('rec manifest parent = the flag generation (cross-stage lineage), and is current',
    recMan?.parent_generation_id === flagGen.generation_id && recMan?.is_current === true)

  // 3) The report pins to exactly this rec generation and carries the warehouse metrics.
  const res = await generateDailyReport(ACCT, DATE, recGen.generation_id, {
    sourceNotBefore: BOUNDARY,
    metaOutcomePlane: META_OUTCOME_PLANE,
  })
  const rep = (await c.query(`SELECT recommendation_generation_id, total_spend, business_outcomes, business_revenue FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, DATE])).rows[0]
  check('report committed', res.committed === true && res.reason === 'committed')
  check('report row pinned to the rec generation + carries the account metrics ($42 spend)',
    rep?.recommendation_generation_id === recGen.generation_id && Number(rep?.total_spend) === 42)
  check('report carries the CANONICAL Acuity ledger totals (1 booking / $250) — not the fallback',
    Number(rep?.business_outcomes) === 1 && Number(rep?.business_revenue) === 250)

  // 4) Rec advancement while the (old) report would persist: a NEWER rec generation commits for the date,
  //    so a report pinned to the now-superseded generation is REJECTED (stale) and the prior report stands.
  const db = getAdminClient()
  const flagHead = await readCurrentGeneration(db, ACCT, 'flag')
  // Advance the rec head with an empty generation. The baseline revokes this RPC from service_role in
  // favour of the MetricClaim publisher, so the rehearsal drives it directly on the superuser
  // connection rather than through an app helper that no production caller may use.
  await c.query(
    `SELECT replace_recommendation_generation_with_decisions($1,$2,$3,$4,$5,'[]'::jsonb,'[]'::jsonb)`,
    [ACCT, randomUUID(), recGen.generation_id, flagHead, DATE],
  )
  const stale = await generateDailyReport(ACCT, DATE, recGen.generation_id, {
    sourceNotBefore: BOUNDARY,
    metaOutcomePlane: META_OUTCOME_PLANE,
  }) // pinned to the superseded R1
  const repAfter = (await c.query(`SELECT recommendation_generation_id FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, DATE])).rows[0]
  check('report pinned to a superseded rec generation is rejected (stale_generation)', stale.committed === false && stale.reason === 'stale_generation')
  check('the prior report row still stands (pin unchanged, not overwritten)', repAfter?.recommendation_generation_id === recGen.generation_id)

  // 5) Exact-generation reads are ACCOUNT-SCOPED: the same generation id under a foreign account is empty
  //    (a report can never read another account's recommendations through a shared generation id).
  const { getRecommendationsByGeneration } = await import('@/lib/recommendations/store')
  const own = await getRecommendationsByGeneration(ACCT, recGen.generation_id, 8)
  const foreign = await getRecommendationsByGeneration('00000000-0000-4000-8000-000000000999', recGen.generation_id, 8)
  check('generation reads are account-scoped (own non-empty, foreign account = empty)', own.length > 0 && foreign.length === 0)

  // 6) DATE-SCOPED lineage (regression): committing a flag generation for the NEXT day must NOT mark
  //    this date's report stale — getRecLineageStatus filters by the rec gen's OWN reference_date, not the
  //    global flag head (which advances every new day). This is the exact false-positive the review caught.
  const { replaceFlagGeneration, getRecLineageStatus } = await import('@/lib/flags/generations')
  await replaceFlagGeneration(db, { adAccountId: ACCT, generationId: randomUUID(), expectedPrev: flagGen.generation_id, referenceDate: '2026-06-16', newRows: [], evaluatedScopes: [], provenKeys: [], frozen: { global: false, campaign_ids: [] } })
  const lineageNextDay = await getRecLineageStatus(db, ACCT, recGen.generation_id)
  check('next-day flag advance keeps THIS date current (date-scoped, not global head)', lineageNextDay.state === 'current')

  // 7) STRUCTURAL unit-transition proofs — REAL engine, real DB, ZERO new insight rows for the
  //    losing unit in either direction.
  // ABO->CBO (dormant ad set): seed an adset loser + creative_refresh via the RPC (no boundary → they
  // land active), flip CAMP to CBO with fresh metadata, run the REAL engine — the budget flag closes
  // structurally, the non-budget flag survives, and no pause/scale rec targets the dead unit.
  const flagHead2 = await readCurrentGeneration(db, ACCT, 'flag')
  const seedGen = randomUUID()
  await db.rpc('replace_flag_generation', {
    p_account: ACCT, p_generation_id: seedGen, p_expected_prev: flagHead2, p_reference_date: DATE,
    p_new_rows: [
      { id: randomUUID(), flag_date: DATE, window_days: 7, entity_level: 'adset', adset_id: ADSET, campaign_id: CAMP, flag_type: 'loser', confidence: 'high', audience_type: 'unknown', reason: 'seed' },
      { id: randomUUID(), flag_date: DATE, window_days: 7, entity_level: 'adset', adset_id: ADSET, campaign_id: CAMP, flag_type: 'creative_refresh', confidence: 'high', audience_type: 'unknown', reason: 'seed' },
    ], p_evaluated_scopes: [], p_proven_keys: [], p_frozen: { global: false, campaign_ids: [] },
  })
  await c.query(`UPDATE campaigns SET daily_budget=100, last_synced_at=now() WHERE id=$1`, [CAMP]) // ABO -> CBO, FRESH
  const dirGen = await runFlagEngine(ACCT, DATE, { metadataNotBefore: BOUNDARY })
  const adsetFlags = (await c.query(`SELECT flag_type, is_active, superseded_reason, superseded_by_generation_id FROM flags WHERE ad_account_id=$1 AND adset_id=$2 AND entity_level='adset'`, [ACCT, ADSET])).rows
  const closedLoser = adsetFlags.find((r) => r.flag_type === 'loser')
  const keptRefresh = adsetFlags.find((r) => r.flag_type === 'creative_refresh')
  check('ABO->CBO: dormant adset budget flag closed structurally by the REAL engine run',
    closedLoser?.is_active === false && closedLoser?.superseded_reason === 'structural_unit_change' && closedLoser?.superseded_by_generation_id === dirGen.generation_id)
  check('ABO->CBO: non-budget creative_refresh on the SAME dormant adset survives', keptRefresh?.is_active === true)
  check('snapshot contains no wrong-unit budget flag', !(dirGen.active_flags as { entity_level?: string; adset_id?: string; flag_type?: string }[])
    .some((f) => f.entity_level === 'adset' && f.adset_id === ADSET && (f.flag_type === 'loser' || f.flag_type === 'scale_candidate')))
  const dirRecGen = await generateRecommendationsFromFlags(ACCT, DATE, dirGen.active_flags as unknown as FlagRow[], dirGen.generation_id)
  const wrongUnitRecs = (await c.query(`SELECT id FROM recommendations WHERE ad_account_id=$1 AND generation_id=$2 AND target_entity_id=$3 AND recommendation_type IN ('pause','scale')`, [ACCT, dirRecGen.generation_id, ADSET])).rows
  check('no pause/scale recommendation targets the wrong-unit adset', wrongUnitRecs.length === 0)

  // CBO->ABO (no campaign insight row): a campaign-level scale flag closes once fresh metadata shows
  // both budgets NULL — the campaign has NO insight rows at any point.
  const CAMPB = '00000000-0000-4000-8000-0000000000c9'
  await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id, daily_budget, last_synced_at) VALUES ($1,$2,'m-cb',100, now())`, [CAMPB, ACCT])
  const flagHead3 = await readCurrentGeneration(db, ACCT, 'flag')
  const seedGenB = randomUUID(), campFlagId = randomUUID()
  await db.rpc('replace_flag_generation', {
    p_account: ACCT, p_generation_id: seedGenB, p_expected_prev: flagHead3, p_reference_date: DATE,
    p_new_rows: [{ id: campFlagId, flag_date: DATE, window_days: 7, entity_level: 'campaign', campaign_id: CAMPB, flag_type: 'scale_candidate', confidence: 'medium', audience_type: 'unknown', reason: 'seed' }],
    p_evaluated_scopes: [], p_proven_keys: [], p_frozen: { global: false, campaign_ids: [] },
  })
  await c.query(`UPDATE campaigns SET daily_budget=NULL, lifetime_budget=NULL, last_synced_at=now() WHERE id=$1`, [CAMPB]) // CBO -> ABO, FRESH
  const dirGen2 = await runFlagEngine(ACCT, DATE, { metadataNotBefore: BOUNDARY })
  const campFlag = (await c.query(`SELECT is_active, superseded_reason FROM flags WHERE id=$1`, [campFlagId])).rows[0]
  check('CBO->ABO: campaign budget flag closed structurally with NO campaign insight rows',
    campFlag?.is_active === false && campFlag?.superseded_reason === 'structural_unit_change')
  check('direction proofs report structural telemetry', (dirGen.structural_closures ?? 0) >= 1 && (dirGen2.structural_closures ?? 0) >= 1)

  // 8) An INVALID freshness boundary through the REAL engine->RPC path behaves exactly like no
  //    boundary — the commit SUCCEEDS (the unparseable string never reaches the ::timestamptz cast),
  //    budget evaluation is disabled (frozen), and no structural judgment happens.
  const invGen = await runFlagEngine(ACCT, DATE, { metadataNotBefore: 'not-a-timestamp' })
  check('invalid boundary: commit succeeds (no timestamptz cast failure), frozen, zero structural',
    !!invGen.generation_id && invGen.budget_decisions_frozen === true && invGen.structural_closures === 0)

  await purgeExecutiveEvidence(c, [ACCT])
  await c.end()
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nENGINE→POSTGREST PIPELINE PROOFS PASSED' : `\n${failures} PIPELINE PROOF(S) FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((e) => { console.error(e); process.exit(1) })
