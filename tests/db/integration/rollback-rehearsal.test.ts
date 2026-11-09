import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import pg from 'pg'
const execFileAsync = promisify(execFile)

// The rollback-to-snapshot script rehearsed through the ACTUAL psql invocation (`psql -v ... -f`),
// exactly as the runbook documents it. An earlier rehearsal did test-side string replacement and therefore
// missed that psql does NOT substitute :variables inside dollar-quoted DO bodies (a real P0). This suite
// reproduces the real production transition: durable-generation schema applied -> LEGACY pre-state (rows the OLD
// direct-write code shape: null generation_id, null audit fields, open recs) -> locked rollback-schema
// snapshots -> the FIRST new-code generation (mutating a same-day row, structurally closing a wrong-unit
// flag, superseding the legacy recs) -> psql rollback -> full-state assertions, incl. every mutable flag
// column, reopened recommendations, date-scoped reader exclusion, account isolation, and guards.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const ACCT = '00000000-0000-4000-8000-0000000000d9'
const OTHER = '00000000-0000-4000-8000-0000000000d8' // isolation account
const CAMP = '00000000-0000-4000-8000-0000000000da'
const ADSET = '00000000-0000-4000-8000-0000000000db'
const AD = '00000000-0000-4000-8000-0000000000dc'
const DATE = '2026-04-10' // distinct date+accounts from every other suite

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }
const conn = async () => { const c = new pg.Client({ connectionString: DB }); await c.connect(); return c }
const SCRIPT = path.resolve(process.cwd(), 'scripts/rollback-flag-generation.sql')

/** The REAL documented invocation - no test-side substitution. Throws (non-zero exit) on script abort,
 *  with psql's stderr (NOTICEs + the abort reason) folded into the error message for assertions. */
const runRollback = (confirm = 'ROLLBACK-ALL-SINCE-SNAPSHOT'): string => {
  try {
    return execFileSync('psql', [DB, '-v', `account='${ACCT}'`, '-v', `confirm='${confirm}'`, '-f', SCRIPT], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    const err = e as { message: string; stderr?: Buffer | string }
    throw new Error(`${err.message}\n${typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? ''}`)
  }
}

const SNAPSHOT_SCRIPT = path.resolve(process.cwd(), 'scripts/create-rollback-snapshot.sql')
/** The REAL atomic snapshot invocation: one txn, advisory lock, precondition, ID-set capture. */
const runSnapshot = (): string => {
  try {
    return execFileSync('psql', [DB, '-v', `account='${ACCT}'`, '-f', SNAPSHOT_SCRIPT], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    const err = e as { message: string; stderr?: Buffer | string }
    throw new Error(`${err.message}\n${typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? ''}`)
  }
}
/** Production-complete rec payload: jsonb_populate_record NULLS absent columns (table defaults never
 *  apply through the RPC), so every NOT NULL column must be present. */
const recPayload = (id: string, over: Record<string, unknown> = {}) => ({
  id, recommendation_type: 'pause', target_entity_type: 'ad', target_entity_id: AD,
  observed_fact: 'fact', metric_values: [], data_sources: ['meta_api'],
  what_could_make_this_wrong: ['sample'], confidence_score: 0.5, confidence_label: 'low',
  risk_level: 'low', gate_decision: 'hold', gate_passed: false,
  approval_required: true, action_allowed_now: false, metric_claim_ids: [], ...over,
})

/** The baseline revokes replace_recommendation_generation_with_decisions from service_role, because a
 *  recommendation must now publish with MetricClaim lineage. These rollback rehearsals are about
 *  generation mechanics (CAS, supersede, head rotation), not claim lineage, so they drive the retired
 *  inner RPC directly on the superuser connection instead of pretending it is still a supported path. */
const publishRecGeneration = async (
  c: pg.Client, generationId: string, expectedPrev: string | null, sourceFlagGeneration: string,
  newRows: object[], decisions: object[],
) => {
  await c.query(
    `SELECT replace_recommendation_generation_with_decisions($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [ACCT, generationId, expectedPrev, sourceFlagGeneration, DATE, JSON.stringify(newRows), JSON.stringify(decisions)],
  )
}

/** Rollback tests exercise generation mechanics, not recommendation economics. The baseline makes
 * the production invariant explicit: every published recommendation has one governed authority row. */
const diagnosticDecision = (sourceId: string, key: string) => ({
  action_kind: 'observe' as const,
  target_level: 'account' as const,
  target_id: null,
  evidence_plane: 'structural' as const,
  evidence_basis: 'calendar_period_signal' as const,
  authority_tier: 'diagnostic_only' as const,
  authority_reason: 'Rollback rehearsal fixture: generation mechanics only.',
  owner_copy: 'Diagnostic rollback rehearsal fixture. No action is authorised.',
  direction_ceiling: 'unsupported' as const,
  direction_reason: 'No directional evidence is part of this fixture.',
  policy_version: 3,
  dedupe_key: key,
  source_id: sourceId,
  window_start: null,
  window_end: null,
  objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue' as const,
  matured: null,
  continuity: null,
  windows_conflict: null,
  metrics: {},
  proposed_mutation: null,
  paid_cohort_recent_generation_id: null,
  paid_cohort_matured_generation_id: null,
  pragmatic_media_buyer: false,
})


describe('rollback-to-snapshot - REAL psql rehearsal of the production transition', () => {
  beforeAll(async () => {
    for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
      if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing non-loopback host: ${u}`)
    }
    execFileSync('psql', ['--version'], { stdio: 'pipe' }) // hard-require the real client
    const c = await conn()
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
    for (const acct of [ACCT, OTHER]) {
      for (const t of ['recommendations', 'flags', 'decision_generations', 'daily_reports', 'audit_tasks', 'daily_insights', 'ads', 'adsets', 'campaigns'])
        await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [acct])
      await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [acct])
    }
    await c.query(`
      INSERT INTO ad_accounts (id, account_id, is_active)
      VALUES ($1,'act_rb_test',true), ($2,'act_rb_other',false)
    `, [ACCT, OTHER])
    // This shared integration database is intentionally serial, but earlier suites leave their account
    // fixtures behind. The owner-facing MCP resolver must see the production invariant (exactly one
    // active account); isolate this suite instead of weakening that fail-closed boundary.
    await c.query(`UPDATE ad_accounts SET is_active = (id=$1)`, [ACCT])
    // Entity tree (adset linked -> CBO judgment path is real) for ACCT; a minimal tree for OTHER.
    await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id, last_synced_at) VALUES ($1,$2,'m-rb-c', now())`, [CAMP, ACCT])
    await c.query(`INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id) VALUES ($1,$2,$3,'m-rb-as')`, [ADSET, ACCT, CAMP])
    await c.query(`INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id) VALUES ($1,$2,$3,$4,'m-rb-ad')`, [AD, ACCT, CAMP, ADSET])
    await c.end()
  })

  it('legacy transition: first new-code generation is fully undone by the documented psql command', async () => {
    const c = await conn()
    // LEGACY pre-state (old direct-write shape: no generation, no audit): a valid ADSET loser under the
    // (currently ABO) campaign, an AD-level loser whose fields the first generation will MUTATE via a
    // same-day re-prove, and an OPEN legacy recommendation.
    const legacyAdset = '00000000-0000-4000-8000-00000000ab01'
    const legacyAd = '00000000-0000-4000-8000-00000000ab02'
    const legacyRec = '00000000-0000-4000-8000-00000000ab03'
    await c.query(`INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, flag_type, confidence, reason, evidence, recommended_action, spend_in_window, is_active)
      VALUES ($1,$2,$3,7,'adset',$4,$5,'loser','high','legacy adset reason','{"spend":10}','legacy action',10,true)`, [legacyAdset, ACCT, DATE, CAMP, ADSET])
    await c.query(`INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, ad_id, flag_type, confidence, reason, evidence, recommended_action, spend_in_window, is_active)
      VALUES ($1,$2,$3,7,'ad',$4,$5,$6,'loser','low','LEGACY AD REASON','{"spend":42}','LEGACY ACTION',42,true)`, [legacyAd, ACCT, DATE, CAMP, ADSET, AD])
    await c.query(`INSERT INTO recommendations (id, ad_account_id, recommendation_type, target_entity_type, target_entity_id, observed_fact, status) VALUES ($1,$2,'pause','ad',$3,'legacy fact','open')`, [legacyRec, ACCT, AD])
    // An INACTIVE pre-snapshot row on a natural key the first generation will re-prove — the
    // RPC's ON CONFLICT will REACTIVATE and mutate it; the (full-account) snapshot must restore it to
    // its ORIGINAL INACTIVE state field-for-field, including superseded_at.
    const legacyInactive = '00000000-0000-4000-8000-00000000ab05'
    await c.query(`INSERT INTO flags (id, ad_account_id, flag_date, window_days, entity_level, campaign_id, adset_id, ad_id, flag_type, confidence, reason, evidence, recommended_action, spend_in_window, is_active, superseded_at)
      VALUES ($1,$2,$3,30,'ad',$4,$5,$6,'watchlist','medium','OLD INACTIVE REASON','{"spend":7}','OLD INACTIVE ACTION',7,false,'2026-04-01T00:00:00Z')`, [legacyInactive, ACCT, DATE, CAMP, ADSET, AD])
    // Isolation fixture: OTHER account keeps an active flag + its own generation untouched throughout.
    await c.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id) VALUES ('00000000-0000-4000-8000-00000000ab98',$1,'m-rb-other') ON CONFLICT (id) DO NOTHING`, [OTHER])
    await c.query(`INSERT INTO flags (id, ad_account_id, flag_date, entity_level, campaign_id, flag_type, reason, is_active)
      VALUES ('00000000-0000-4000-8000-00000000ab99',$1,$2,'campaign','00000000-0000-4000-8000-00000000ab98','scale_candidate','other acct','true')`, [OTHER, DATE])
    await c.query(`INSERT INTO decision_generations (id, ad_account_id, kind, reference_date) VALUES ('00000000-0000-4000-8000-00000000ab97',$1,'flag',$2)`, [OTHER, DATE])

    // RUNBOOK: snapshots AFTER migrations (durable-generation schema already applied here), BEFORE new code runs.
    runSnapshot() // the REAL atomic snapshot script, via psql

    // FIRST new-code generation: campaign flips CBO+fresh, so the legacy ADSET loser closes structurally;
    // the RPC also re-proves the AD loser same-day with MUTATED fields, writes a brand-new row, and a rec
    // generation supersedes the legacy open rec.
    await c.query(`UPDATE campaigns SET daily_budget=100, last_synced_at=now() WHERE id=$1`, [CAMP])
    const { getAdminClient } = await import('@/lib/supabase/admin')
    const { replaceFlagGeneration, latestRecGenerationForDate } = await import('@/lib/flags/generations')
    const db = getAdminClient()
    const { randomUUID } = await import('node:crypto')
    const G1 = randomUUID(), R1 = randomUUID()
    const newRow = '00000000-0000-4000-8000-00000000ab04'
    await replaceFlagGeneration(db, {
      adAccountId: ACCT, generationId: G1, expectedPrev: null, referenceDate: DATE,
      newRows: [
        // same-day re-prove of the ACTIVE legacy AD row's natural key with DIFFERENT mutable fields
        { id: randomUUID(), flag_date: DATE, window_days: 7, entity_level: 'ad', campaign_id: CAMP, adset_id: ADSET, ad_id: AD, flag_type: 'loser', confidence: 'high', reason: 'MUTATED REASON', evidence: { spend: 999 }, recommended_action: 'MUTATED ACTION', spend_in_window: 999 },
        // same natural key as the INACTIVE legacyInactive row -> ON CONFLICT REACTIVATES + mutates it
        { id: randomUUID(), flag_date: DATE, window_days: 30, entity_level: 'ad', campaign_id: CAMP, adset_id: ADSET, ad_id: AD, flag_type: 'watchlist', confidence: 'high', reason: 'REACTIVATED REASON', evidence: { spend: 555 }, recommended_action: 'REACTIVATED ACTION', spend_in_window: 555 },
        // a brand-new row with no predecessor (retired-outright path)
        { id: newRow, flag_date: DATE, window_days: 1, entity_level: 'ad', campaign_id: CAMP, adset_id: ADSET, ad_id: AD, flag_type: 'winner', confidence: 'low', reason: 'new row' },
      ],
      evaluatedScopes: [], provenKeys: [],
      frozen: { global: false, campaign_ids: [], campaign_metadata_not_before: '2000-01-01T00:00:00Z' },
    })
    const r1row = randomUUID()
    await publishRecGeneration(c, R1, null, G1, [recPayload(r1row, { recommendation_type: 'investigate' })], [diagnosticDecision(r1row, `rollback-r1:${r1row}`)])

    // Damage assertions (what rollback must undo): structural closure, same-day mutation, superseded rec.
    const damaged = (await c.query(`SELECT is_active, superseded_reason FROM flags WHERE id=$1`, [legacyAdset])).rows[0]
    expect(damaged).toMatchObject({ is_active: false, superseded_reason: 'structural_unit_change' })
    const mutated = (await c.query(`SELECT reason, confidence, recommended_action, generation_id FROM flags WHERE id=$1`, [legacyAd])).rows[0]
    expect(mutated.reason).toBe('MUTATED REASON')
    expect(mutated.generation_id).toBe(G1)
    // Damage: the INACTIVE row was REACTIVATED + mutated by ON CONFLICT (audit cleared, gen stamped).
    const reactivated = (await c.query(`SELECT is_active, reason, superseded_at, generation_id FROM flags WHERE id=$1`, [legacyInactive])).rows[0]
    expect(reactivated).toMatchObject({ is_active: true, reason: 'REACTIVATED REASON', superseded_at: null, generation_id: G1 })
    expect((await c.query(`SELECT status FROM recommendations WHERE id=$1`, [legacyRec])).rows[0].status).toBe('superseded')

    // ROLLBACK via the DOCUMENTED psql command (no substitution tricks). Effects asserted below;
    // a non-zero exit (any guard/SQL failure) would throw here.
    runRollback()

    // (3) EVERY mutable flag field restored on the same-day-mutated row.
    const restored = (await c.query(`SELECT is_active, generation_id, superseded_reason, superseded_by_generation_id, confidence, reason, evidence, recommended_action, spend_in_window FROM flags WHERE id=$1`, [legacyAd])).rows[0]
    expect(restored).toMatchObject({
      is_active: true, generation_id: null, superseded_reason: null, superseded_by_generation_id: null,
      confidence: 'low', reason: 'LEGACY AD REASON', recommended_action: 'LEGACY ACTION',
    })
    expect(restored.evidence).toEqual({ spend: 42 })
    expect(Number(restored.spend_in_window)).toBe(42)
    // Structurally-closed legacy adset loser restored; the new-code rows retired.
    expect((await c.query(`SELECT is_active FROM flags WHERE id=$1`, [legacyAdset])).rows[0].is_active).toBe(true)
    expect((await c.query(`SELECT is_active FROM flags WHERE id=$1`, [newRow])).rows[0].is_active).toBe(false)
    // The reactivated-and-mutated row is restored to its ORIGINAL INACTIVE state field-for-field
    // (full-account snapshot — an active-only snapshot could not have done this).
    const inactiveRestored = (await c.query(`SELECT is_active, reason, confidence, recommended_action, evidence, spend_in_window, superseded_at, generation_id FROM flags WHERE id=$1`, [legacyInactive])).rows[0]
    expect(inactiveRestored).toMatchObject({
      is_active: false, reason: 'OLD INACTIVE REASON', confidence: 'medium',
      recommended_action: 'OLD INACTIVE ACTION', generation_id: null,
    })
    expect(inactiveRestored.evidence).toEqual({ spend: 7 })
    expect(Number(inactiveRestored.spend_in_window)).toBe(7)
    expect(new Date(inactiveRestored.superseded_at).toISOString()).toBe('2026-04-01T00:00:00.000Z')
    // (4) Prior open recommendation reopened; the new one superseded.
    expect((await c.query(`SELECT status FROM recommendations WHERE id=$1`, [legacyRec])).rows[0].status).toBe('open')
    expect((await c.query(`SELECT count(*)::int c FROM recommendations WHERE ad_account_id=$1 AND status='open'`, [ACCT])).rows[0].c).toBe(1)
    // (5) Generations stamped + no current heads (legacy pre-state had none) + date readers skip them.
    const gens = (await c.query(`SELECT rolled_back_at IS NOT NULL AS rb, is_current FROM decision_generations WHERE ad_account_id=$1`, [ACCT])).rows
    expect(gens.length).toBe(2)
    expect(gens.every((g) => g.rb === true && g.is_current === false)).toBe(true)
    expect(await latestRecGenerationForDate(db, ACCT, DATE)).toBeNull() // rolled-back excluded
    // (7) Account isolation + snapshot-schema permissions.
    expect((await c.query(`SELECT is_active FROM flags WHERE id='00000000-0000-4000-8000-00000000ab99'`)).rows[0].is_active).toBe(true)
    expect((await c.query(`SELECT rolled_back_at FROM decision_generations WHERE id='00000000-0000-4000-8000-00000000ab97'`)).rows[0].rolled_back_at).toBeNull()
    const priv = (await c.query(`SELECT has_schema_privilege('anon','rollback','USAGE') AS anon_usage, has_schema_privilege('authenticated','rollback','USAGE') AS auth_usage`)).rows[0]
    expect(priv).toMatchObject({ anon_usage: false, auth_usage: false })
    await c.end()
  })

  it('prior-generation case: heads and open recs restore to the pre-snapshot generation; guards hold', async () => {
    const c = await conn()
    const { getAdminClient } = await import('@/lib/supabase/admin')
    const { replaceFlagGeneration, commitDailyReportGeneration, getRecLineageStatus } = await import('@/lib/flags/generations')
    const db = getAdminClient()
    const { randomUUID } = await import('node:crypto')

    // GOOD baseline generation G0/R0 (this is the state the snapshot captures), with one open rec.
    const G0 = randomUUID(), R0 = randomUUID(), r0row = randomUUID()
    const prevFlagHead = (await c.query(`SELECT id FROM decision_generations WHERE ad_account_id=$1 AND kind='flag' AND is_current`, [ACCT])).rows[0]?.id ?? null
    const prevRecHead = (await c.query(`SELECT id FROM decision_generations WHERE ad_account_id=$1 AND kind='recommendation' AND is_current`, [ACCT])).rows[0]?.id ?? null
    await replaceFlagGeneration(db, { adAccountId: ACCT, generationId: G0, expectedPrev: prevFlagHead, referenceDate: DATE, newRows: [], evaluatedScopes: [], provenKeys: [], frozen: { global: false, campaign_ids: [] } })
    await publishRecGeneration(c, R0, prevRecHead, G0, [recPayload(r0row, { recommendation_type: 'hold' })], [diagnosticDecision(r0row, `rollback-r0:${r0row}`)])

    runSnapshot() // the REAL atomic snapshot script, via psql

    // BAD deployment: G1 supersedes nothing structural but R1 supersedes R0's open row — and a REPORT is
    // committed pinned to R1 (it is the date's latest rec gen at that moment), which the runbook will
    // leave standing after rollback.
    const G1 = randomUUID(), R1 = randomUUID()
    await replaceFlagGeneration(db, { adAccountId: ACCT, generationId: G1, expectedPrev: G0, referenceDate: DATE, newRows: [], evaluatedScopes: [], provenKeys: [], frozen: { global: false, campaign_ids: [] } })
    await publishRecGeneration(c, R1, R0, G1, [], [])
    expect((await c.query(`SELECT status FROM recommendations WHERE id=$1`, [r0row])).rows[0].status).toBe('superseded')
    const unavailableMoneyBasis = {
      money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: false,
        revenue_complete: null,
        observed_collected_value_lower_bound: null,
        covered_outcomes: null,
        total_outcomes: null,
      },
    }
    const pinned = await commitDailyReportGeneration(db, {
      adAccountId: ACCT,
      reportDate: DATE,
      recGeneration: R1,
      payload: { summary_text: 'bad-deploy report', report_json: unavailableMoneyBasis },
    })
    expect(pinned.committed).toBe(true)

    runRollback()

    // The STANDING report pinned to rolled-back R1 resolves to the honest 'rolled_back' lineage
    // state — never last_known_complete ("a newer run committed" would be the OPPOSITE of the truth) —
    // at the resolver AND at the MCP consumer boundary.
    const lineage = await getRecLineageStatus(db, ACCT, R1)
    expect(lineage.state).toBe('rolled_back')
    const { getDailyReport } = await import('@/mcp/tools/daily-report')
    const mcp = await getDailyReport({ date: DATE }) as { recommendation_lineage?: { state: string; notice: string | null } }
    expect(mcp.recommendation_lineage?.state).toBe('rolled_back')
    expect(mcp.recommendation_lineage?.notice).toMatch(/rolled back.*do not act/i)

    // Prior heads restored CURRENT; prior open rec reopened; stamped gens lose date authority so the
    // restored R0 commits as the date's report pin again (incl. the flag lineage-race guard vs G0).
    const heads = (await c.query(`SELECT id, kind FROM decision_generations WHERE ad_account_id=$1 AND is_current ORDER BY kind`, [ACCT])).rows
    expect(heads).toEqual([{ id: G0, kind: 'flag' }, { id: R0, kind: 'recommendation' }])
    expect((await c.query(`SELECT status FROM recommendations WHERE id=$1`, [r0row])).rows[0].status).toBe('open')
    const commit = await commitDailyReportGeneration(db, {
      adAccountId: ACCT,
      reportDate: DATE,
      recGeneration: R0,
      payload: { summary_text: 'post-rollback', report_json: unavailableMoneyBasis },
      expectedFlagGeneration: G0,
    })
    expect(commit.committed).toBe(true)

    // GUARDS through the real invocation: wrong confirm token aborts; and after NEW post-rollback work,
    // re-running against the obsolete snapshot aborts.
    expect(() => runRollback('nope')).toThrow(/confirm token/)
    const G2 = randomUUID()
    await replaceFlagGeneration(db, { adAccountId: ACCT, generationId: G2, expectedPrev: G0, referenceDate: DATE, newRows: [], evaluatedScopes: [], provenKeys: [], frozen: { global: false, campaign_ids: [] } })
    expect(() => runRollback()).toThrow(/obsolete/)
    await c.end()
  })

  it('snapshot atomicity: lock-serialized against decision RPCs, precondition-guarded, ID-set membership', async () => {
    const c = await conn()
    const { getAdminClient } = await import('@/lib/supabase/admin')
    const { replaceFlagGeneration, readCurrentGeneration } = await import('@/lib/flags/generations')
    const db = getAdminClient()
    const { randomUUID } = await import('node:crypto')

    // (a) PRECONDITION: a pending/running sync row aborts the snapshot (checked BEFORE 049 could ever
    // sweep such rows to failed).
    await c.query(`INSERT INTO api_sync_logs (ad_account_id, sync_type, triggered_by, status) VALUES ($1,'full','test','running')`, [ACCT])
    expect(() => runSnapshot()).toThrow(/pending\/running sync/)
    await c.query(`DELETE FROM api_sync_logs WHERE ad_account_id=$1 AND status='running'`, [ACCT])

    // (b) LOCK WINDOW: the snapshot script takes the SAME per-account advisory lock as the decision RPCs.
    // Advisory-lock mutual exclusion is symmetric, so we prove serialization by holding the lock in an
    // open transaction (exactly what a mid-commit RPC does) and showing the REAL psql snapshot BLOCKS
    // until release — a generation can never commit BETWEEN the snapshot's internal statements.
    const holder = await conn()
    await holder.query('BEGIN')
    await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':decision'))`, [ACCT])
    let snapshotDone = false
    const snapshotP = execFileAsync('psql', [DB, '-v', `account='${ACCT}'`, '-f', SNAPSHOT_SCRIPT]).then(() => { snapshotDone = true })
    await new Promise((r) => setTimeout(r, 600))
    expect(snapshotDone).toBe(false) // blocked behind the RPC-style lock holder
    await holder.query('COMMIT')
    await snapshotP
    expect(snapshotDone).toBe(true)
    await holder.end()

    // (c) ID-SET MEMBERSHIP: a generation committed AFTER the snapshot returned is ABSENT from
    // generations_snapshot and gets stamped by the rollback — no committed_at comparison involved.
    const head = await readCurrentGeneration(db, ACCT, 'flag')
    const G3 = randomUUID()
    await replaceFlagGeneration(db, { adAccountId: ACCT, generationId: G3, expectedPrev: head, referenceDate: DATE, newRows: [], evaluatedScopes: [], provenKeys: [], frozen: { global: false, campaign_ids: [] } })
    expect((await c.query(`SELECT count(*)::int c FROM rollback.generations_snapshot WHERE id=$1`, [G3])).rows[0].c).toBe(0)

    // (d) The ROLLBACK itself refuses an in-flight sync (paused triggers stop NEW jobs, not one
    // already executing) — literal psql exits nonzero and NOTHING changes.
    await c.query(`INSERT INTO api_sync_logs (ad_account_id, sync_type, triggered_by, status) VALUES ($1,'full','test','running')`, [ACCT])
    expect(() => runRollback()).toThrow(/pending\/running sync/)
    expect((await c.query(`SELECT rolled_back_at FROM decision_generations WHERE id=$1`, [G3])).rows[0].rolled_back_at).toBeNull() // untouched
    await c.query(`DELETE FROM api_sync_logs WHERE ad_account_id=$1 AND status='running'`, [ACCT])

    runRollback()
    expect((await c.query(`SELECT rolled_back_at FROM decision_generations WHERE id=$1`, [G3])).rows[0].rolled_back_at).not.toBeNull()
    await c.end()
  })
})
