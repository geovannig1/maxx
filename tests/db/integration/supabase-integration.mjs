// REAL Supabase integration proofs (what PGlite's single connection cannot do).
//
// Prereq: a local Supabase must be running (`supabase start`), reachable at the URLs/keys below (the
// standard local demo keys are the defaults; override via env). This suite:
//   • replicates prod's ambient default-ACL grants on the EXISTING tables the RPCs touch (local
//     `supabase start` doesn't apply them) + seeds a test account/entities,
//   • proves CAS + the shared :decision lock under TRUE multi-connection concurrency (raw pg),
//   • proves the RPCs work through PostgREST and that anon is denied at the HTTP/permission layer.
// decision_generations grants come from the baseline schema itself (explicit) — NOT re-granted here.
//
// Publishers: the baseline retires replace_recommendation_generation and ..._with_decisions (revoked
// from service_role) in favour of ..._with_claims_and_decisions, which is what the application calls.
// These proofs exercise the granted publisher and assert the retired ones STAY retired.
//
// Run:  supabase start  &&  node tests/db/integration/supabase-integration.mjs
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const API = process.env.SB_API_URL || 'http://127.0.0.1:54321'

// SAFETY: this suite GRANTs/DELETEs — refuse to run against anything but a loopback host. BOTH the raw
// Postgres URL and the API URL are validated (a remote SB_DB_URL override must never receive our writes).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u) => { try { return new URL(u).hostname } catch { return '' } }
for (const u of [DB, API]) if (!LOOPBACK.has(hostOf(u))) { console.error(`refusing non-loopback host: ${u}`); process.exit(1) }
const ANON = process.env.SB_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const SR = process.env.SB_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const ACCT = '00000000-0000-4000-8000-000000000001'
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FROZEN = JSON.stringify({ global: false, campaign_ids: [] })
const conn = async () => { const c = new pg.Client({ connectionString: DB }); await c.connect(); return c }
const flagRpc = (c, gen, prev) => c.query(`SELECT replace_flag_generation($1,$2,$3,$4,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$5::jsonb)`, [ACCT, gen, prev, '2026-07-18', FROZEN])
let failures = 0
const check = (label, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++ }

async function setup() {
  const c = await conn()
  for (const t of ['flags', 'recommendations', 'daily_reports', 'campaigns', 'adsets', 'ads'])
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO service_role`)
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_test_1') ON CONFLICT (id) DO NOTHING`, [ACCT])
  await c.end()
}
// Clear the account's ON DELETE RESTRICT children before the tables above them. The list is DERIVED from
// the catalog rather than written out, because a hand-kept list is exactly what rotted: a pre-squash migration
// added a RESTRICT child and did not update the fixtures, and the claim tables did the same. session_replication
// _role = replica suspends FK triggers for the transaction, so delete order does not matter.
async function purgeRestrictChildren(c) {
  const { rows } = await c.query(`
    SELECT DISTINCT child.relname AS t
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    JOIN pg_attribute a ON a.attrelid = child.oid AND a.attname = 'ad_account_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE ns.nspname='public' AND fk.contype='f' AND fk.confdeltype='r'
      AND parent.relname IN ('ad_accounts','outcomes')
      AND child.relname NOT IN ('outcomes','outcome_sources')`)
  await c.query('BEGIN')
  try {
    await c.query('SET LOCAL session_replication_role = replica')
    for (const { t } of rows) await c.query(`DELETE FROM public.${t} WHERE ad_account_id=$1`, [ACCT])
    await c.query('COMMIT')
  } catch (error) { await c.query('ROLLBACK'); throw error }
}

async function clean(c) {
  await purgeRestrictChildren(c)
  for (const t of ['recommendations', 'flags', 'decision_generations', 'daily_reports'])
    await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [ACCT])
}

async function concurrency() {
  console.log('multi-connection concurrency (raw pg):')
  const clients = await Promise.all(Array.from({ length: 5 }, conn))
  await clean(clients[0])
  const res = await Promise.allSettled(clients.map((c, i) => flagRpc(c, U(1000 + i), null)))
  const ok = res.filter((r) => r.status === 'fulfilled').length
  const stale = res.filter((r) => r.status === 'rejected' && /stale_expected_generation/.test(r.reason.message)).length
  check(`CAS race: exactly one of 5 concurrent commits wins (${ok} ok / ${stale} stale)`, ok === 1 && stale === 4)
  for (const c of clients) await c.end()

  const a = await conn(), b = await conn()
  await clean(a)
  const F1 = U(2000), F2 = U(2001), R1 = U(2002)
  await flagRpc(a, F1, null)
  await a.query('BEGIN')
  await a.query(`SELECT replace_recommendation_generation_with_claims_and_decisions($1,$2,$3,$4,$5,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb)`, [ACCT, R1, null, F1, '2026-07-18'])
  let bDone = false
  const bPromise = flagRpc(b, F2, F1).then(() => { bDone = true })
  await new Promise((r) => setTimeout(r, 600))
  const blocked = !bDone
  await a.query('COMMIT')
  await bPromise
  await a.end(); await b.end()
  check('shared :decision lock: concurrent flag commit blocks while a rec RPC holds it', blocked)
}

async function postgrest() {
  console.log('PostgREST + permissions (supabase-js):')
  const svc = createClient(API, SR, { auth: { persistSession: false } })
  const anon = createClient(API, ANON, { auth: { persistSession: false } })
  const c = await conn(); await clean(c); await c.end()
  const args = (gen, prev) => ({ p_account: ACCT, p_generation_id: gen, p_expected_prev: prev, p_reference_date: '2026-07-18', p_new_rows: [], p_evaluated_scopes: [], p_proven_keys: [], p_frozen: { global: false, campaign_ids: [] } })

  const r1 = await svc.rpc('replace_flag_generation', args(U(3000), null))
  check('service_role flag RPC round-trips through PostgREST', !r1.error && r1.data?.generation_id === U(3000))
  const r2 = await svc.rpc('replace_recommendation_generation_with_claims_and_decisions', { p_account: ACCT, p_generation_id: U(3010), p_expected_prev: null, p_source_flag_generation: U(3000), p_reference_date: '2026-07-18', p_new_rows: [], p_decisions: [], p_metric_claims: [] })
  check('service_role rec RPC (cross-stage lineage) via PostgREST', !r2.error && r2.data?.generation_id === U(3010))
  const r3 = await svc.rpc('commit_daily_report_generation', {
    p_account: ACCT,
    p_report_date: '2026-07-18',
    p_rec_generation: U(3010),
    p_payload: {
      summary_text: 'ok',
      report_json: {
        money_basis: {
          version: 1,
          basis: 'outcome_collected_value',
          source_available: false,
        },
      },
    },
  })
  check('service_role report RPC commits via PostgREST', !r3.error && r3.data?.committed === true)
  const r4 = await anon.rpc('replace_flag_generation', args(U(3001), U(3000)))
  check('anon RPC is DENIED at the permission layer', !!r4.error)
  const r5 = await anon.from('decision_generations').insert({ id: U(3002), ad_account_id: ACCT, kind: 'flag', reference_date: '2026-07-18' })
  check('anon direct manifest insert is RLS-denied', !!r5.error)

  // The baseline retires the two lineage-free publishers. service_role must reach the MetricClaim
  // publisher and ONLY that one, or a caller can publish recommendations with no claim lineage.
  const denied = async (fn, args) => {
    const r = await svc.rpc(fn, args)
    return r.error?.code === '42501' || /permission denied/i.test(r.error?.message ?? '')
  }
  check('retired publisher replace_recommendation_generation is denied to service_role',
    await denied('replace_recommendation_generation', { p_account: ACCT, p_generation_id: U(3020), p_expected_prev: null, p_source_flag_generation: U(3000), p_reference_date: '2026-07-18', p_new_rows: [] }))
  check('retired publisher replace_recommendation_generation_with_decisions is denied to service_role',
    await denied('replace_recommendation_generation_with_decisions', { p_account: ACCT, p_generation_id: U(3021), p_expected_prev: null, p_source_flag_generation: U(3000), p_reference_date: '2026-07-18', p_new_rows: [], p_decisions: [] }))
}

async function nonEmpty() {
  console.log('non-empty production-shaped payloads (full schema, via PostgREST):')
  const svc = createClient(API, SR, { auth: { persistSession: false } })
  const c = await conn()
  await clean(c)
  // Owned entity hierarchy (campaign 40 → adset 50 → ad 60), filling the required NOT-NULL columns.
  await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id) VALUES ($1,$2,'meta-c-1') ON CONFLICT (id) DO NOTHING`, [U(40), ACCT])
  await c.query(`INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id) VALUES ($1,$2,$3,'meta-as-1') ON CONFLICT (id) DO NOTHING`, [U(50), ACCT, U(40)])
  await c.query(`INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id) VALUES ($1,$2,$3,$4,'meta-ad-1') ON CONFLICT (id) DO NOTHING`, [U(60), ACCT, U(40), U(50)])
  const F1 = U(4000), R1 = U(4010)

  // A production-shaped flag row — incl. a payload ad_account_id + is_active the RPC must FORCE away.
  const flag = { id: U(4100), flag_date: '2026-07-18', window_days: 7, entity_level: 'adset', campaign_id: U(40), adset_id: U(50), ad_id: null, meta_adset_id: 'meta-as-1', flag_type: 'loser', confidence: 'high', audience_type: 'consumer', reason: 'cpa above cap', evidence: { spend: 120, cpa: 85 }, recommended_action: 'pause', watch_next: 'cpa', spend_in_window: 120.5, cpa_in_window: 85.25, ctr_in_window: 1.2, frequency_in_window: 2.3, ad_account_id: '00000000-0000-4000-8000-000000000999', is_active: false }
  const rf = await svc.rpc('replace_flag_generation', { p_account: ACCT, p_generation_id: F1, p_expected_prev: null, p_reference_date: '2026-07-18', p_new_rows: [flag], p_evaluated_scopes: [], p_proven_keys: [], p_frozen: { global: false, campaign_ids: [] } })
  check('non-empty flag publishes (1 row, 1 in active snapshot)', !rf.error && rf.data?.row_count === 1 && rf.data?.active_flags?.length === 1)
  const pf = (await c.query(`SELECT ad_account_id, generation_id, is_active, flag_type, cpa_in_window, evidence FROM flags WHERE id=$1`, [U(4100)])).rows[0]
  check('flag persisted: account+is_active FORCED from params, generation stamped, enum/numeric/jsonb intact',
    !!pf && pf.ad_account_id === ACCT && pf.generation_id === F1 && pf.is_active === true && pf.flag_type === 'loser' && Number(pf.cpa_in_window) === 85.25 && pf.evidence?.spend === 120)

  // A production-shaped rec with the tricky types (jsonb / numeric / text[]) + forced + a bogus key.
  // Production-complete rec (all NOT-NULL columns present, as the app's builder emits) + the tricky
  // types (jsonb / numeric / text[]) + a payload account/status the RPC must FORCE + a bogus key it drops.
  // Two claims, deliberately: a MEASURED operand and the DERIVED metric computed from it. A pre-squash
  // migration pinned measurementKind to 'measured', which made every derived and modelled claim
  // unpublishable and silently broke recommendation publication in production; the baseline fixes that, and this is the
  // proof — through PostgREST, with the full 21-key snapshot the trigger and CHECK both demand.
  const CLAIM_SPEND = 'claim-spend-4110'
  const CLAIM_CPA = 'claim-cpa-4110'
  const OBSERVED_AT = '2026-07-18T12:00:00.000Z'
  const claimSnapshot = (claimId, metric, value, kind, inputClaimIds) => ({
    claimId, metricKey: `meta_delivery.${metric}`, label: metric, value, unit: 'money',
    formula: kind === 'derived' ? 'meta_delivery.spend / meta_delivery.bookings' : null,
    definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: `flag-generation:${F1}`, evidencePlane: 'meta_delivery' },
    entity: { level: 'adset', id: U(50) },
    attributionScope: 'none',
    window: { start: '2026-07-12', end: '2026-07-18', basis: 'closed_account_days', timezone: 'America/New_York' },
    comparison: { method: 'none', window: null },
    asOf: OBSERVED_AT,
    availability: { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 1, denominator: 1 },
    maturity: { state: 'not_applicable', matureThrough: null },
    freshness: { state: 'fresh', observedAt: OBSERVED_AT, maxAgeHours: 26 },
    setupFingerprint: null,
    authority: { state: 'diagnostic', policyVersion: 'recommendation_metric_claim_v1' },
    measurementKind: kind,
    inputClaimIds,
  })
  const rec = { id: U(4110), recommendation_type: 'pause', target_entity_type: 'adset', target_entity_id: U(50), observed_fact: 'cpa high', metric_values: [{ name: 'CPA', value: 85 }], data_sources: ['meta_api', 'ga4'], what_could_make_this_wrong: ['low sample'], confidence_score: 0.72, confidence_label: 'medium', risk_level: 'low', gate_decision: 'act', gate_passed: true, approval_required: true, action_allowed_now: false, grounding_json: { reasons: ['x'] }, learning_eligibility: true, source_flag_id: U(4100), metric_claim_ids: [CLAIM_SPEND, CLAIM_CPA], ad_account_id: '00000000-0000-4000-8000-000000000999', status: 'archived', not_a_real_column: 'DROP ME' }
  // The trigger cross-checks each claim's value against the SOURCE FLAG's evidence, so these must be the
  // flag's own numbers (evidence: { spend: 120, cpa: 85 }) — not a display recalculation.
  const claims = [
    { claim_id: CLAIM_SPEND, source_flag_id: U(4100), source_flag_generation_id: F1, source_metric_key: 'spend',
      snapshot: claimSnapshot(CLAIM_SPEND, 'spend', 120, 'measured', []) },
    { claim_id: CLAIM_CPA, source_flag_id: U(4100), source_flag_generation_id: F1, source_metric_key: 'cpa',
      snapshot: claimSnapshot(CLAIM_CPA, 'cpa', 85, 'derived', [CLAIM_SPEND]) },
  ]
  // Baseline invariant: every published recommendation carries exactly one governed authority row.
  const decision = {
    action_kind: 'pause', target_level: 'adset', target_id: 'meta-as-1', evidence_plane: 'meta_modelled',
    evidence_basis: 'calendar_period_signal', authority_tier: 'diagnostic_only',
    authority_reason: 'No interaction-cohort evidence.', owner_copy: 'Diagnostic-only governed copy.',
    direction_ceiling: 'unsupported', direction_reason: 'No trusted directional evidence.', policy_version: 3,
    dedupe_key: `recommendation:${U(4110)}:v3`, source_id: U(4110),
    window_start: '2026-07-12', window_end: '2026-07-18',
    objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    matured: null, continuity: null, windows_conflict: null, metrics: { spend: 120 },
    proposed_mutation: null, paid_cohort_recent_generation_id: null, paid_cohort_matured_generation_id: null,
  }
  const rr = await svc.rpc('replace_recommendation_generation_with_claims_and_decisions', { p_account: ACCT, p_generation_id: R1, p_expected_prev: null, p_source_flag_generation: F1, p_reference_date: '2026-07-18', p_new_rows: [rec], p_decisions: [decision], p_metric_claims: claims })
  check('non-empty rec publishes (1 row)', !rr.error && rr.data?.row_count === 1)
  const pr = (await c.query(`SELECT ad_account_id, generation_id, status, confidence_score, data_sources, metric_values, gate_passed FROM recommendations WHERE id=$1`, [U(4110)])).rows[0]
  check('rec persisted: account+status FORCED, generation stamped, jsonb+numeric+text[] round-trip',
    !!pr && pr.ad_account_id === ACCT && pr.generation_id === R1 && pr.status === 'open' && Number(pr.confidence_score) === 0.72 && Array.isArray(pr.data_sources) && pr.data_sources.includes('ga4') && pr.gate_passed === true)
  const bound = (await c.query(`SELECT b.claim_id, s.source_metric_key, s.snapshot FROM recommendation_metric_claim_bindings b JOIN recommendation_metric_claim_snapshots s USING (claim_id) WHERE b.recommendation_id=$1 ORDER BY b.claim_id`, [U(4110)])).rows
  const derived = bound.find((row) => row.claim_id === CLAIM_CPA)
  check('MetricClaim lineage persisted: both claims bound to the recommendation with immutable snapshots',
    bound.length === 2 && bound.some((row) => row.claim_id === CLAIM_SPEND && Number(row.snapshot?.value) === 120))
  check('a DERIVED MetricClaim publishes and keeps the operands it was computed from (123 rejected this)',
    derived?.source_metric_key === 'cpa' && derived?.snapshot?.measurementKind === 'derived'
      && Array.isArray(derived?.snapshot?.inputClaimIds) && derived.snapshot.inputClaimIds.includes(CLAIM_SPEND))
  await c.end()
}

async function structuralClosure() {
  console.log('Structural closure + result shape (via PostgREST):')
  const svc = createClient(API, SR, { auth: { persistSession: false } })
  const c = await conn()
  await clean(c)
  // CBO parent (daily budget) refreshed NOW -> any past boundary sees it as FRESH; an adset budget flag
  // under it is structurally impossible and must close IN THE SAME COMMIT that inserts it.
  await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id, daily_budget, last_synced_at) VALUES ($1,$2,'m-c-struct',100,now()) ON CONFLICT (id) DO UPDATE SET daily_budget=100, last_synced_at=now()`, [U(70), ACCT])
  await c.query(`INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id) VALUES ($1,$2,$3,'m-as-struct') ON CONFLICT (id) DO NOTHING`, [U(71), ACCT, U(70)])
  const flag = { id: U(72), flag_date: '2026-07-18', window_days: 7, entity_level: 'adset', campaign_id: U(70), adset_id: U(71), flag_type: 'loser', confidence: 'high', audience_type: 'unknown', reason: 'wrong unit' }
  const r = await svc.rpc('replace_flag_generation', {
    p_account: ACCT, p_generation_id: U(73), p_expected_prev: null, p_reference_date: '2026-07-18',
    p_new_rows: [flag], p_evaluated_scopes: [], p_proven_keys: [],
    p_frozen: { global: false, campaign_ids: [], campaign_metadata_not_before: '2000-01-01T00:00:00Z' },
  })
  check('structural closure fires through PostgREST (1 structural, snapshot empty)',
    !r.error && r.data?.structural_closures === 1 && r.data?.active_flags?.length === 0)
  check('result shape carries the structural-closure telemetry keys',
    !r.error && ['row_count', 'structural_closures', 'orphan_closures', 'unknown_metadata_flags', 'budget_decisions_frozen']
      .every((k) => k in (r.data ?? {})))
  const closed = (await c.query(`SELECT is_active, superseded_reason FROM flags WHERE id=$1`, [U(72)])).rows[0]
  check('closed row is audited (reason structural_unit_change)', closed?.is_active === false && closed?.superseded_reason === 'structural_unit_change')
  await c.end()
}

await setup()
await concurrency()
await postgrest()
await nonEmpty()
await structuralClosure()
console.log(failures === 0 ? '\nREAL-SUPABASE INTEGRATION PROOFS PASSED' : `\n${failures} INTEGRATION PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
