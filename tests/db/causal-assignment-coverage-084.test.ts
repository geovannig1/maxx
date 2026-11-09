import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { causalDb } from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000091'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000092'
const EXPERIMENT = '00000000-0000-4000-8000-000000000093'
const DESIGN = '00000000-0000-4000-8000-000000000094'
const APPROVAL = '00000000-0000-4000-8000-000000000095'
const UNIT_A = '00000000-0000-4000-8000-000000000096'
const UNIT_B = '00000000-0000-4000-8000-000000000097'
const HASH = `sha256:${'a'.repeat(64)}`
const SEED_HASH = `sha256:${'b'.repeat(64)}`
const SOURCE_HEAD = `sha256:${'c'.repeat(64)}`
let db: PGlite

type Row = Record<string, unknown>

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

// A past scheduled design whose units were assigned one by one. The baseline schema admits time-block
// units only through an atomic switchback schedule, so the individually scheduled unit is a geo cell;
// coverage manifests are defined over any scheduled unit kind.
async function createHistoricalDesign() {
  await db.query(`
    INSERT INTO public.experiments(
      id,ad_account_id,hypothesis,changed_variable,control_ref,challenger_ref,
      primary_metric,min_sample,min_spend,success_contract,status,entity_level,entity_ref
    ) VALUES ($1,$2,'Historical causal run','daily_budget','current','challenger',
      'causal_incremental_contribution',30,500,'Use the governed interval',
      'proposed','adset','as_history')
  `, [EXPERIMENT, ACCOUNT])
  await db.query(`
    INSERT INTO public.causal_measurement_design_versions(
      id,ad_account_id,experiment_id,revision,schema_version,objective,primary_metric,currency,
      hypothesis,design_kind,estimand,assignment_unit,assignment_method,treatment_arm_ref,
      comparator_arm_ref,eligible_population,measurement_start,measurement_end,
      realization_horizon_days,confidence_level,minimum_detectable_effect_minor,
      randomization_seed_hash,treatment_allocation_bps,analysis_method,analysis_plan,
      content_hash,source_kind,source_ref,captured_at,dedupe_key,created_at
    ) VALUES (
      $1,$2,$3,1,1,'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      'causal_incremental_contribution','USD','Historical time-block test',
      'randomized_controlled','marginal_contribution_vs_current_state','geo_cell',
      'deterministic_hash_randomization','challenger_v1','current_paid_state',
      '{"eligibility_rule":"all_blocks","exclusion_rule":"blackouts","unit_source":"first_party_eligibility_log","timezone":"America/New_York"}',
      '2026-01-01T00:00:00Z','2026-01-07T00:00:00Z',30,0.95,2500,$4,5000,
      'regression_adjusted_intent_to_treat',
      '{"interval_method":"bootstrap","interference_assumption":"none","maturity_rule":"horizon","missing_outcome_rule":"zero_after_horizon","multiple_testing_policy":"single_primary_estimand","stop_rule":"owner_only"}',
      $5,'owner_entry','historical fixture','2025-12-01T00:00:00Z','coverage-design',
      '2025-12-01T00:00:00Z')
  `, [DESIGN, ACCOUNT, EXPERIMENT, SEED_HASH, HASH])
  await db.query(`
    INSERT INTO public.causal_measurement_design_approvals(
      id,ad_account_id,experiment_id,artifact_id,artifact_hash,decision,revision,
      reviewed_by,reason,dedupe_key,created_at
    ) VALUES ($1,$2,$3,$4,$5,'approved',1,'owner','Historical approval',
      'coverage-approval','2025-12-02T00:00:00Z')
  `, [APPROVAL, ACCOUNT, EXPERIMENT, DESIGN, HASH])
  await db.query(`
    INSERT INTO public.causal_assignment_units(
      id,ad_account_id,experiment_id,design_version_id,design_approval_id,
      design_approval_decision,unit_key_hash,assignment_unit_kind,arm,arm_ref,assigned_at,
      effective_from,effective_through,assignment_source_kind,assignment_source_ref,
      assignment_proof,policy_version,dedupe_key,created_at
    ) VALUES
      ($1,$3,$4,$5,$6,'approved',$7,'geo_cell','treatment','challenger_v1',
       '2025-12-03T00:00:00Z','2026-01-01T00:00:00Z','2026-01-03T00:00:00Z',
       'deterministic_randomizer','randomizer',$9,1,'coverage-unit-a','2025-12-03T00:00:00Z'),
      ($2,$3,$4,$5,$6,'approved',$8,'geo_cell','comparator','current_paid_state',
       '2025-12-03T00:00:00Z','2026-01-03T00:00:00Z','2026-01-05T00:00:00Z',
       'deterministic_randomizer','randomizer',$10,1,'coverage-unit-b','2025-12-03T00:00:00Z')
  `, [
    UNIT_A, UNIT_B, ACCOUNT, EXPERIMENT, DESIGN, APPROVAL,
    `sha256:${'d'.repeat(64)}`, `sha256:${'e'.repeat(64)}`,
    `md5:${'f'.repeat(32)}`, `md5:${'1'.repeat(32)}`,
  ])
}

async function commitCoverage(over: Record<string, unknown> = {}) {
  const args = {
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-05T00:00:00Z',
    observedThrough: '2026-01-06T00:00:00Z',
    complete: true,
    blockers: [],
    expected: 2,
    units: [UNIT_A, UNIT_B],
    sourceHead: SOURCE_HEAD,
    previous: null,
    dedupe: 'coverage-window-v1',
    ...over,
  }
  return one<Row>(`SELECT (public.commit_causal_assignment_coverage_manifest(
    $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8,$9::text[],
    $10,$11::uuid[],$12,1,$13::uuid,$14
  )).*`, [
    ACCOUNT, EXPERIMENT, DESIGN, APPROVAL, args.start, args.end, args.observedThrough,
    args.complete, args.blockers, args.expected, args.units, args.sourceHead, args.previous,
    args.dedupe,
  ])
}

beforeEach(async () => {
  db = await causalDb(ACCOUNT, OTHER_ACCOUNT)
  await createHistoricalDesign()
})

describe('causal assignment coverage manifests', () => {
  it('commits an exact complete membership set and retries idempotently', async () => {
    const first = await commitCoverage()
    const retry = await commitCoverage()
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      complete: true,
      revision: 1,
      expected_unit_count: 2,
      actual_unit_count: 2,
      membership_fingerprint: expect.stringMatching(/^md5:[0-9a-f]{32}$/),
    })
    expect(await one<{ members: number }>(`
      SELECT count(*)::int members FROM public.causal_assignment_coverage_members
       WHERE manifest_id=$1
    `, [first.id])).toEqual({ members: 2 })
  })

  it('rejects omitted, duplicate, extra, or count-mismatched membership', async () => {
    await expect(commitCoverage({ units: [UNIT_A] })).rejects.toThrow(/exact membership/i)
    await expect(commitCoverage({ units: [UNIT_A, UNIT_A], dedupe: 'duplicate-members' }))
      .rejects.toThrow(/duplicate/i)
    await expect(commitCoverage({ expected: 1, dedupe: 'wrong-count' }))
      .rejects.toThrow(/expected unit count/i)
  })

  it('records a complete zero-unit source window without inventing assignments', async () => {
    const manifest = await commitCoverage({
      start: '2026-01-05T00:00:00Z', end: '2026-01-07T00:00:00Z',
      observedThrough: '2026-01-08T00:00:00Z', expected: 0, units: [],
      dedupe: 'complete-zero-window',
    })
    expect(manifest).toMatchObject({ complete: true, expected_unit_count: 0, actual_unit_count: 0 })
  })

  it('records blockers without membership and permits an exact-window recovery revision', async () => {
    const blocked = await commitCoverage({
      start: '2026-01-05T00:00:00Z', end: '2026-01-07T00:00:00Z',
      observedThrough: '2026-01-08T00:00:00Z', complete: false,
      blockers: ['source_unavailable'], expected: null, units: [], dedupe: 'blocked-window-v1',
    })
    expect(blocked).toMatchObject({ complete: false, revision: 1, expected_unit_count: null })
    const recovered = await commitCoverage({
      start: '2026-01-05T00:00:00Z', end: '2026-01-07T00:00:00Z',
      observedThrough: '2026-01-08T00:00:00Z', expected: 0, units: [],
      sourceHead: `sha256:${'2'.repeat(64)}`,
      previous: blocked.id, dedupe: 'blocked-window-v2',
    })
    expect(recovered).toMatchObject({ complete: true, revision: 2, previous_manifest_id: blocked.id })
  })

  it('rejects false complete/blocker shapes and premature source windows', async () => {
    await expect(commitCoverage({ blockers: ['source_unavailable'] }))
      .rejects.toThrow(/complete.*blocker/i)
    await expect(commitCoverage({
      complete: false, blockers: ['source_unavailable'], expected: null,
      units: [UNIT_A], dedupe: 'blocked-with-members',
    })).rejects.toThrow(/incomplete.*membership/i)
    await expect(commitCoverage({
      start: '2026-01-05T00:00:00Z', end: '2099-01-01T00:00:00Z',
      observedThrough: '2099-01-01T00:00:00Z', expected: 0, units: [],
      dedupe: 'premature-window',
    })).rejects.toThrow(/measurement window|closed/i)
  })

  it('rejects differently bounded overlapping source windows', async () => {
    await commitCoverage()
    await expect(commitCoverage({
      start: '2026-01-04T00:00:00Z', end: '2026-01-07T00:00:00Z',
      observedThrough: '2026-01-08T00:00:00Z', expected: 0, units: [],
      dedupe: 'overlap-window',
    })).rejects.toThrow(/overlap/i)
  })

  it('requires the still-current approved design', async () => {
    await db.query(`INSERT INTO public.causal_measurement_design_approvals(
      ad_account_id,experiment_id,artifact_id,artifact_hash,decision,revision,
      previous_approval_id,reviewed_by,reason,dedupe_key,created_at
    ) VALUES ($1,$2,$3,$4,'withdrawn',2,$5,'owner','withdrawn','coverage-withdrawal',now())`,
    [ACCOUNT, EXPERIMENT, DESIGN, HASH, APPROVAL])
    await expect(commitCoverage()).rejects.toThrow(/current approved causal design/i)
  })

  it('keeps both ledgers append-only and isolated from browser/direct app writes', async () => {
    const manifest = await commitCoverage()
    await expect(db.query(
      `DELETE FROM public.causal_assignment_coverage_manifests WHERE id=$1`, [manifest.id],
    )).rejects.toThrow(/immutable|append-only/i)
    expect(await one<{ dml: number; browser_reads: number; service_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          CROSS JOIN (VALUES ('causal_assignment_coverage_manifests'),
            ('causal_assignment_coverage_members')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('causal_assignment_coverage_manifests'),
            ('causal_assignment_coverage_members')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) browser_reads,
        (SELECT count(*)::int FROM (VALUES ('causal_assignment_coverage_manifests'),
            ('causal_assignment_coverage_members')) t(table_name)
          WHERE has_table_privilege('service_role','public.' || table_name,'SELECT')) service_reads
    `)).toEqual({ dml: 0, browser_reads: 0, service_reads: 2 })
  })
})
