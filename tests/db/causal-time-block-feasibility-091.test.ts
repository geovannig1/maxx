import { createHash } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { causalDb } from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000911'
const EXPERIMENT = '00000000-0000-4000-8000-000000000912'
const DESIGN_HASH = `sha256:${'a'.repeat(64)}`
const SEED_HASH = `sha256:${'b'.repeat(64)}`
const CAPTURED_AT = new Date().toISOString()
let db: PGlite

type Row = Record<string, unknown>

const analysisPlan = {
  interval_method: 'switchback_randomization_inference',
  interference_assumption: 'finite_carryover_bounded_by_washout',
  carryover_window_seconds: 3600,
  washout_window_seconds: 7200,
  block_duration_seconds: 172_800,
  serial_dependence_policy: 'design_based_randomization_inference',
  schedule_policy: 'atomic_precommitted_paired_switchback',
  seasonality_adjustment_policy: 'adjacent_matched_block_pairs',
  schedule_commit_policy: 'atomic_full_window_before_measurement',
  spend_grain: 'local_calendar_day',
  block_boundary_policy: 'local_calendar_midnight',
  outcome_indexing_policy: 'assignment_treatment_path_with_finite_carryover',
  carryover_identification_policy: 'precommitted_upper_bound_sensitivity',
  minimum_pair_count: 6,
  maturity_rule: 'all_assigned_units_reach_realization_horizon',
  missing_outcome_rule: 'zero_after_realization_horizon',
  multiple_testing_policy: 'single_primary_estimand',
  stop_rule: 'owner_approved_loss_ceiling_only',
}

function designContract(plan: Record<string, unknown> = analysisPlan) {
  return {
    objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    primary_metric: 'causal_incremental_contribution',
    currency: 'USD',
    hypothesis: 'The challenger causes more collected contribution than the current paid state.',
    design_kind: 'randomized_controlled',
    estimand: 'marginal_contribution_vs_current_state',
    assignment_unit: 'time_block',
    assignment_method: 'deterministic_hash_randomization',
    treatment_arm_ref: 'challenger_v1',
    comparator_arm_ref: 'current_paid_state',
    eligible_population: {
      eligibility_rule: 'all_precommitted_local_day_blocks',
      exclusion_rule: 'documented_blackout_windows_only',
      unit_source: 'governed_switchback_schedule',
      timezone: 'America/New_York',
    },
    measurement_start: '2099-09-01T04:00:00Z',
    measurement_end: '2099-10-31T04:00:00Z',
    realization_horizon_days: 30,
    confidence_level: 0.95,
    minimum_detectable_effect_minor: 2500,
    randomization_seed_hash: SEED_HASH,
    treatment_allocation_bps: 5000,
    pre_period_start: null,
    pre_period_end: null,
    analysis_method: 'regression_adjusted_intent_to_treat',
    analysis_plan: plan,
  }
}

function scheduleBlocks(count = 30) {
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(Date.UTC(2099, 8, 1 + index * 2, 4))
    const end = new Date(Date.UTC(2099, 8, 3 + index * 2, 4))
    return {
      unit_key_hash: `sha256:${createHash('sha256').update(`block:${index}`).digest('hex')}`,
      effective_from: start.toISOString().replace('.000Z', 'Z'),
      effective_through: end.toISOString().replace('.000Z', 'Z'),
    }
  })
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

async function createApprovedDesign(plan: Record<string, unknown> = analysisPlan) {
  const design = await one<Row>(`SELECT (public.commit_causal_measurement_design(
    $1,$2,1,$3::jsonb,$4,'owner_entry','prospective switchback',$5::timestamptz,
    'design-v1')).*`, [ACCOUNT, EXPERIMENT, JSON.stringify(designContract(plan)),
    DESIGN_HASH, CAPTURED_AT])
  const approval = await one<Row>(`SELECT (public.approve_causal_measurement_design(
    $1,$2,$3,$4,NULL,'owner','Approved before assignment','approval-v1')).*`,
  [ACCOUNT, EXPERIMENT, design.id, DESIGN_HASH])
  return { design, approval }
}

async function commitSchedule(
  designId: string,
  approvalId: string,
  blocks: Record<string, unknown>[] = scheduleBlocks(),
  dedupe = 'schedule-v1',
) {
  return one<Row>(`SELECT (public.commit_causal_time_block_schedule(
    $1,$2,$3,$4,$5::jsonb,1,$6)).*`,
  [ACCOUNT, EXPERIMENT, designId, approvalId, JSON.stringify(blocks), dedupe])
}

beforeEach(async () => {
  db = await causalDb(ACCOUNT)
  await db.query(`INSERT INTO public.experiments(
    id,ad_account_id,hypothesis,changed_variable,control_ref,challenger_ref,
    primary_metric,min_sample,min_spend,success_contract,status,entity_level,entity_ref
  ) VALUES ($1,$2,'Contribution lift','daily_budget','current','challenger',
    'causal_incremental_contribution',30,500,'Governed interval','draft','adset','as_911')`,
  [EXPERIMENT, ACCOUNT])
})

describe('causal time-block feasibility', () => {
  it('rejects designs that do not align daily spend, treatment-path outcomes, and atomic scheduling', async () => {
    expect(await one<{ valid: boolean }>(`SELECT public.causal_time_block_analysis_plan_valid(
      'randomized_controlled',$1::jsonb) valid`, [JSON.stringify({
      ...analysisPlan,
      schedule_policy: 'precommitted_randomized_switchback',
      spend_grain: 'six_hour',
      outcome_indexing_policy: 'booking_time_block',
    })])).toEqual({ valid: false })
  })

  it('rejects an unbalanced or undersized switchback before owner approval', async () => {
    await expect(one(`SELECT public.commit_causal_measurement_design(
      $1,$2,1,$3::jsonb,$4,'owner_entry','unbalanced',$5::timestamptz,'unbalanced')`, [
      ACCOUNT, EXPERIMENT, JSON.stringify({ ...designContract(), treatment_allocation_bps: 6000 }),
      DESIGN_HASH, CAPTURED_AT,
    ])).rejects.toThrow(/balanced supported paired switchback/i)

    await expect(one(`SELECT public.commit_causal_measurement_design(
      $1,$2,1,$3::jsonb,$4,'owner_entry','undersized',$5::timestamptz,'undersized')`, [
      ACCOUNT, EXPERIMENT,
      JSON.stringify({ ...designContract(), measurement_end: '2099-09-25T04:00:00Z' }),
      DESIGN_HASH, CAPTURED_AT,
    ])).rejects.toThrow(/infeasible.*sample|sample.*pair counts/i)
  })

  it('commits the entire paired schedule atomically and assigns one arm per pair', async () => {
    const { design, approval } = await createApprovedDesign()
    const first = await commitSchedule(design.id as string, approval.id as string)
    const retry = await commitSchedule(design.id as string, approval.id as string)
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({ block_count: 30, treatment_block_count: 15,
      comparator_block_count: 15, pair_count: 15 })

    const units = (await db.query<{ arm: string; manifest: string }>(`
      SELECT arm,schedule_manifest_id::text manifest
      FROM public.causal_assignment_units ORDER BY effective_from`)).rows
    expect(new Set(units.map((unit) => unit.manifest))).toEqual(new Set([first.id as string]))
    for (let index = 0; index < units.length; index += 2) {
      expect(new Set(units.slice(index, index + 2).map((unit) => unit.arm)))
        .toEqual(new Set(['treatment', 'comparator']))
      const digest = createHash('md5').update(
        `${SEED_HASH}:${design.id}:${index / 2}`,
      ).digest('hex')
      const flip = Number.parseInt(digest.slice(0, 8), 16) % 2
      expect(units[index + flip].arm).toBe('treatment')
    }

    const changed = scheduleBlocks()
    changed[0] = { ...changed[0], unit_key_hash: `sha256:${'f'.repeat(64)}` }
    await expect(commitSchedule(design.id as string, approval.id as string, changed))
      .rejects.toThrow(/dedupe collision/i)

    await expect(one(`SELECT public.commit_causal_measurement_design(
      $1,$2,1,$3::jsonb,$4,'owner_entry','post-schedule revision',$5::timestamptz,
      'design-v2')`, [ACCOUNT, EXPERIMENT, JSON.stringify(designContract()),
      `sha256:${'c'.repeat(64)}`, CAPTURED_AT]))
      .rejects.toThrow(/cannot change after.*schedule/i)
  })

  it('rejects partial, sub-day, and caller-drip-fed time-block schedules', async () => {
    const { design, approval } = await createApprovedDesign()
    await expect(commitSchedule(design.id as string, approval.id as string, scheduleBlocks(28),
      'partial')).rejects.toThrow(/full measurement window|minimum pair count|block count/i)

    const subDay = scheduleBlocks()
    subDay[0] = { ...subDay[0], effective_through: '2099-09-01T10:00:00Z' }
    await expect(commitSchedule(design.id as string, approval.id as string, subDay,
      'sub-day')).rejects.toThrow(/contiguous|local calendar|block duration/i)

    await expect(db.query(`SELECT public.record_causal_assignment_unit(
      $1,$2,$3,$4,$5,NULL,'2099-09-01T04:00:00Z','2099-09-03T04:00:00Z',
      'deterministic_randomizer','drip feed',NULL,1,'drip-feed')`, [
      ACCOUNT, EXPERIMENT, design.id, approval.id, scheduleBlocks(1)[0].unit_key_hash,
    ])).rejects.toThrow(/atomic full-window schedule/i)
  })

  it('keeps booking-time-block outcomes quarantined until treatment-path materialization exists', async () => {
    const { design } = await createApprovedDesign()
    await expect(db.query(`INSERT INTO public.causal_contribution_generations(
      ad_account_id,experiment_id,design_version_id) VALUES ($1,$2,$3)`,
    [ACCOUNT, EXPERIMENT, design.id])).rejects.toThrow(/treatment-path.*carryover/i)
  })

  it('keeps schedules append-only, private, and non-authoritative', async () => {
    const { design, approval } = await createApprovedDesign()
    const schedule = await commitSchedule(design.id as string, approval.id as string)
    await expect(db.query(`DELETE FROM public.causal_time_block_schedule_manifests WHERE id=$1`,
      [schedule.id])).rejects.toThrow(/immutable|append-only/i)
    expect(await one<{ dml: number; browser_reads: number; service_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          WHERE has_table_privilege(role_name,'public.causal_time_block_schedule_manifests',
            privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          WHERE has_table_privilege(role_name,'public.causal_time_block_schedule_manifests',
            'SELECT')) browser_reads,
        has_table_privilege('service_role','public.causal_time_block_schedule_manifests',
          'SELECT')::int service_reads
    `)).toEqual({ dml: 0, browser_reads: 0, service_reads: 1 })
  })
})
