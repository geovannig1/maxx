import { createHash } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

/**
 * Shared seed rows for the causal-measurement tests, built against the SHIPPED schema.
 *
 * "Historical" rows are inserted directly as the table owner, which the append-only guards allow,
 * with past timestamps, so a test can exercise an RPC over a measurement window that has already
 * closed. Every such row still satisfies the shipped constraints and insert-time triggers.
 */

export const OBJECTIVE = 'maximize_incremental_contribution_from_ad_attributed_collected_revenue'
export const PRIMARY_METRIC = 'causal_incremental_contribution'
export const DESIGN_HASH = `sha256:${'a'.repeat(64)}`
export const SEED_HASH = `sha256:${'b'.repeat(64)}`
export const HISTORY_CAPTURED_AT = '2025-12-01T00:00:00Z'
export const HISTORY_APPROVED_AT = '2025-12-02T00:00:00Z'
export const HISTORY_ASSIGNED_AT = '2025-12-03T00:00:00Z'

const DAY_MS = 86_400_000
const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const md5 = (value: string) => `md5:${createHash('md5').update(value).digest('hex')}`
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

/**
 * The shipped schema with the accounts the causal and economics RPCs expect: `account` is the sole
 * active ad account, and `inactiveAccount` (when given) exists but is inactive, so the RPCs' "sole
 * active ad account" rule is exercised against a real second row.
 */
export async function causalDb(account: string, inactiveAccount?: string): Promise<PGlite> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, account)
  if (inactiveAccount) {
    await insertAdAccount(db, inactiveAccount)
    await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [inactiveAccount])
  }
  return db
}

/** INSERT one row; jsonb values must already be JSON strings. */
export async function insertRow(db: PGlite, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row)
  await db.query(
    `INSERT INTO public.${table}(${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  )
}

export async function insertExperiment(db: PGlite, row: {
  id: string; account: string; minSample?: number; entityRef?: string; status?: string
}): Promise<void> {
  await insertRow(db, 'experiments', {
    id: row.id, ad_account_id: row.account, hypothesis: 'Historical causal run',
    changed_variable: 'daily_budget', control_ref: 'current', challenger_ref: 'challenger',
    primary_metric: PRIMARY_METRIC, min_sample: row.minSample ?? 30, min_spend: 500,
    success_contract: 'Use the governed interval', status: row.status ?? 'proposed',
    entity_level: 'adset', entity_ref: row.entityRef ?? 'as_history',
  })
}

/** A complete design-version row; `over` replaces any column. */
export async function insertDesign(db: PGlite, row: {
  id: string; account: string; experiment: string; assignmentUnit: string
  start: string; end: string; over?: Record<string, unknown>
}): Promise<void> {
  await insertRow(db, 'causal_measurement_design_versions', {
    id: row.id, ad_account_id: row.account, experiment_id: row.experiment, revision: 1,
    schema_version: 1, objective: OBJECTIVE, primary_metric: PRIMARY_METRIC, currency: 'USD',
    hypothesis: 'Historical causal test', design_kind: 'randomized_controlled',
    estimand: 'marginal_contribution_vs_current_state', assignment_unit: row.assignmentUnit,
    assignment_method: 'deterministic_hash_randomization', treatment_arm_ref: 'challenger_v1',
    comparator_arm_ref: 'current_paid_state',
    eligible_population: JSON.stringify({
      eligibility_rule: 'all_units', exclusion_rule: 'documented_blackouts',
      unit_source: 'first_party_eligibility_log', timezone: 'America/New_York',
    }),
    measurement_start: row.start, measurement_end: row.end, realization_horizon_days: 30,
    confidence_level: 0.95, minimum_detectable_effect_minor: 2500,
    randomization_seed_hash: SEED_HASH, treatment_allocation_bps: 5000,
    analysis_method: 'regression_adjusted_intent_to_treat',
    analysis_plan: JSON.stringify({
      interval_method: 'bootstrap', interference_assumption: 'no_cross_unit_interference',
      maturity_rule: 'horizon', missing_outcome_rule: 'zero_after_horizon',
      multiple_testing_policy: 'single_primary_estimand', stop_rule: 'owner_only',
    }),
    content_hash: DESIGN_HASH, source_kind: 'owner_entry', source_ref: 'historical fixture',
    captured_at: HISTORY_CAPTURED_AT, dedupe_key: `design-${row.id}`, created_at: HISTORY_CAPTURED_AT,
    ...row.over,
  })
}

export async function insertApproval(db: PGlite, row: {
  id: string; account: string; experiment: string; design: string
}): Promise<void> {
  await insertRow(db, 'causal_measurement_design_approvals', {
    id: row.id, ad_account_id: row.account, experiment_id: row.experiment, artifact_id: row.design,
    artifact_hash: DESIGN_HASH, decision: 'approved', revision: 1, reviewed_by: 'owner',
    reason: 'Historical pre-treatment approval', dedupe_key: `approval-${row.id}`,
    created_at: HISTORY_APPROVED_AT,
  })
}

/**
 * The paired-switchback analysis contract the baseline schema requires of every time-block design, with
 * one-day blocks so the smallest feasible window is MIN_SWITCHBACK_BLOCKS local days.
 */
export const SWITCHBACK_PLAN = {
  interval_method: 'switchback_randomization_inference',
  interference_assumption: 'finite_carryover_bounded_by_washout',
  carryover_window_seconds: 3600,
  washout_window_seconds: 7200,
  block_duration_seconds: 86_400,
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

/** 6 pairs of one-day blocks: the smallest schedule the baseline schema accepts. */
export const MIN_SWITCHBACK_BLOCKS = 12
/** Local (America/New_York) midnight that opens every historical switchback window. */
export const SWITCHBACK_START = '2026-01-01T05:00:00Z'

export type ScheduledBlock = { id: string; from: string; through: string; arm: 'treatment' | 'comparator' }

/** The local calendar dates (YYYY-MM-DD) of the historical switchback window, in order. */
export function switchbackDates(blocks = MIN_SWITCHBACK_BLOCKS): string[] {
  const start = Date.parse(SWITCHBACK_START)
  return Array.from({ length: blocks }, (_, i) => iso(start + i * DAY_MS).slice(0, 10))
}

/**
 * A closed, approved time-block experiment as the shipped schema admits one: a balanced paired
 * switchback design, its atomic schedule manifest, and one unit per one-day block,
 * alternating treatment/comparator. `unitIds` fixes the unit ids in block order.
 */
export async function insertSwitchbackHistory(db: PGlite, ids: {
  account: string; experiment: string; design: string; approval: string; unitIds: string[]
}): Promise<{ blocks: ScheduledBlock[]; start: string; end: string; manifest: string }> {
  const count = ids.unitIds.length
  const startMs = Date.parse(SWITCHBACK_START)
  const start = iso(startMs)
  const end = iso(startMs + count * DAY_MS)
  await insertExperiment(db, { id: ids.experiment, account: ids.account, minSample: count })
  await insertDesign(db, {
    id: ids.design, account: ids.account, experiment: ids.experiment, assignmentUnit: 'time_block',
    start, end, over: { analysis_plan: JSON.stringify(SWITCHBACK_PLAN) },
  })
  await insertApproval(db, { id: ids.approval, account: ids.account, experiment: ids.experiment, design: ids.design })
  const blocks: ScheduledBlock[] = ids.unitIds.map((id, i) => ({
    id, from: iso(startMs + i * DAY_MS), through: iso(startMs + (i + 1) * DAY_MS),
    arm: i % 2 === 0 ? 'treatment' : 'comparator',
  }))
  const scheduleBlocks = blocks.map((block, i) => ({
    unit_key_hash: sha256(`${ids.experiment}:block:${i}`),
    effective_from: block.from, effective_through: block.through,
  }))
  const manifest = await db.query<{ id: string }>(`
    INSERT INTO public.causal_time_block_schedule_manifests(
      ad_account_id,experiment_id,design_version_id,design_approval_id,measurement_start,
      measurement_end,timezone,block_duration_days,block_count,pair_count,treatment_block_count,
      comparator_block_count,schedule_policy,schedule_blocks,schedule_fingerprint,policy_version,
      dedupe_key,committed_at,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'America/New_York',1,$7,$8,$8,$8,
      'atomic_precommitted_paired_switchback',$9::jsonb,$10,1,$11,$12,$12)
    RETURNING id`, [
    ids.account, ids.experiment, ids.design, ids.approval, start, end, count, count / 2,
    JSON.stringify(scheduleBlocks), md5(JSON.stringify(scheduleBlocks)),
    `schedule-${ids.experiment}`, HISTORY_ASSIGNED_AT,
  ])
  const manifestId = manifest.rows[0].id
  for (const [i, block] of blocks.entries()) {
    await insertRow(db, 'causal_assignment_units', {
      id: block.id, ad_account_id: ids.account, experiment_id: ids.experiment,
      design_version_id: ids.design, design_approval_id: ids.approval,
      design_approval_decision: 'approved', unit_key_hash: scheduleBlocks[i].unit_key_hash,
      assignment_unit_kind: 'time_block', arm: block.arm,
      arm_ref: block.arm === 'treatment' ? 'challenger_v1' : 'current_paid_state',
      assigned_at: HISTORY_ASSIGNED_AT, effective_from: block.from, effective_through: block.through,
      assignment_source_kind: 'deterministic_randomizer', assignment_source_ref: 'switchback schedule',
      assignment_proof: md5(`${ids.experiment}:pair:${Math.floor(i / 2)}`), policy_version: 1,
      dedupe_key: `unit-${block.id}`, created_at: HISTORY_ASSIGNED_AT, schedule_manifest_id: manifestId,
    })
  }
  return { blocks, start, end, manifest: manifestId }
}

/** Deterministic outcome uuid for a fixture's numeric (Acuity-style) id: outcomeUuid(501) → 00000000-0000-4000-a000-000000000501. */
export const outcomeUuid = (id: number): string => `00000000-0000-4000-a000-${String(id).padStart(12, '0')}`

/** Deterministic id of an account's Acuity outcome source (the parent every fixture outcome needs). */
export const outcomeSourceUuid = (account: string): string => `00000000-0000-4000-b000-${account.slice(-12)}`

/** Ensure the account's Acuity outcome source exists and return its id. */
export async function ensureAcuitySource(db: PGlite, account: string): Promise<string> {
  const id = outcomeSourceUuid(account)
  await db.query(
    `INSERT INTO public.outcome_sources (id, ad_account_id, kind, label, enabled)
     VALUES ($1, $2, 'acuity', 'Acuity Scheduling', true) ON CONFLICT DO NOTHING`,
    [id, account],
  )
  return id
}

/** A minimal outcome (an Acuity booking with Acuity id `id`) owned by `account`; returns outcomeUuid(id). */
export async function insertOutcome(db: PGlite, account: string, id: number): Promise<string> {
  const sourceId = await ensureAcuitySource(db, account)
  await insertRow(db, 'outcomes', {
    id: outcomeUuid(id), ad_account_id: account, source_id: sourceId, external_id: String(id),
    outcome_type: 'booking', currency: 'USD',
  })
  return outcomeUuid(id)
}

/**
 * An outcome (an Acuity booking) whose client-booked origin the webhook observed one second after
 * booking. `id` is the Acuity id (stored as external_id); the outcome's uuid is outcomeUuid(id), which
 * is returned. A non-empty scheduledBy is a staff booking (origin staff_or_manual); otherwise an
 * observed origin is a website booking and an unobserved one stays unknown.
 */
export async function insertClientAppointment(db: PGlite, row: {
  id: number; account: string; createdAt: string; observedAt?: string | null
  scheduledBy?: string | null; error?: string | null
}): Promise<string> {
  const observedAt = row.observedAt === undefined
    ? iso(Date.parse(row.createdAt) + 1000)
    : row.observedAt
  const sourceId = await ensureAcuitySource(db, row.account)
  const id = outcomeUuid(row.id)
  const origin = row.scheduledBy ? 'staff_or_manual' : observedAt === null ? 'unknown' : 'website'
  await insertRow(db, 'outcomes', {
    id, ad_account_id: row.account, source_id: sourceId, external_id: String(row.id),
    outcome_type: 'booking', currency: 'USD', occurred_at: row.createdAt,
    origin, origin_observed_at: observedAt,
    origin_observed_source: observedAt === null ? null : 'webhook', conversion_send_error: row.error ?? null,
  })
  return id
}

/** Fixed unit ids for a fixture: fixtureUnitIds(0x9000, 3) → 3 deterministic uuids. */
export function fixtureUnitIds(series: number, count: number): string[] {
  const prefix = series.toString(16).padStart(4, '0')
  return Array.from({ length: count }, (_, i) => `00000000-0000-4000-${prefix}-${String(i + 1).padStart(12, '0')}`)
}

export type ContributionGeneration = {
  id: string; declaredUnits: number; outcomes: { unit: string; arm: 'treatment' | 'comparator'; contribution: number }[]
}

/**
 * A materialized outcome generation for a closed geo-cell experiment, with every lineage row its
 * foreign keys require. The shipped RPCs never produce one: materialization supports only time-block
 * designs and the baseline schema quarantines time-block generations. The estimator and the action-
 * decision lineage it feeds are defined over any generation, so the tests that exercise them insert
 * the generation directly.
 */
export async function insertContributionGenerations(db: PGlite, ids: {
  account: string; experiment: string; design: string; approval: string; entityRef: string
  units: { id: string; arm: 'treatment' | 'comparator' }[]; generations: ContributionGeneration[]
  designOver?: Record<string, unknown>
}): Promise<void> {
  const start = SWITCHBACK_START
  const end = iso(Date.parse(start) + 30 * DAY_MS)
  const observed = iso(Date.parse(end) + DAY_MS)
  const outcomeThrough = iso(Date.parse(end) + 31 * DAY_MS)
  await insertExperiment(db, { id: ids.experiment, account: ids.account, entityRef: ids.entityRef })
  await insertDesign(db, {
    id: ids.design, account: ids.account, experiment: ids.experiment, assignmentUnit: 'geo_cell',
    start, end, over: ids.designOver,
  })
  await insertApproval(db, { id: ids.approval, account: ids.account, experiment: ids.experiment, design: ids.design })
  for (const [i, { id, arm }] of ids.units.entries()) {
    await insertRow(db, 'causal_assignment_units', {
      id, ad_account_id: ids.account, experiment_id: ids.experiment, design_version_id: ids.design,
      design_approval_id: ids.approval, design_approval_decision: 'approved',
      unit_key_hash: sha256(`${ids.experiment}:geo:${i}`), assignment_unit_kind: 'geo_cell', arm,
      arm_ref: arm === 'treatment' ? 'challenger_v1' : 'current_paid_state', assigned_at: HISTORY_ASSIGNED_AT,
      effective_from: start, effective_through: end, assignment_source_kind: 'deterministic_randomizer',
      assignment_source_ref: 'historical randomizer', assignment_proof: md5(`${ids.experiment}:geo:${i}`),
      policy_version: 1, dedupe_key: `geo-unit-${id}`, created_at: HISTORY_ASSIGNED_AT,
    })
  }
  const assignmentCoverage = await db.query<{ id: string }>(`SELECT (public.commit_causal_assignment_coverage_manifest(
    $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,true,ARRAY[]::text[],$8,$9::uuid[],
    $10,1,NULL,'estimate-assignment-coverage')).id`, [
    ids.account, ids.experiment, ids.design, ids.approval, start, end, observed,
    ids.units.length, ids.units.map((unit) => unit.id), sha256('assignment-head'),
  ])
  const appointmentCoverage = await db.query<{ id: string }>(`
    INSERT INTO public.causal_outcome_coverage_manifests(
      ad_account_id,experiment_id,design_version_id,design_approval_id,
      assignment_coverage_manifest_id,revision,window_start,window_end,observed_through,complete,
      expected_outcome_count,actual_link_count,membership_fingerprint,source_head,
      policy_version,dedupe_key,committed_at,created_at
    ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,true,0,0,$9,$10,1,'estimate-appointment-coverage',$8,$8)
    RETURNING id`, [
    ids.account, ids.experiment, ids.design, ids.approval, assignmentCoverage.rows[0].id,
    start, end, observed, md5('no-appointments'), sha256('appointment-head'),
  ])
  const spend = await db.query<{ id: string }>(`
    INSERT INTO public.causal_meta_spend_batches(
      ad_account_id,experiment_id,design_version_id,design_approval_id,revision,timezone,
      window_start,window_end,data_through,complete,day_count,total_spend_minor,source_head,
      publication_fingerprint,policy_version,dedupe_key,imported_at,created_at
    ) VALUES ($1,$2,$3,$4,1,'America/New_York',$5,$6,$7,true,30,0,$8,$9,1,
      'estimate-spend',$7,$7)
    RETURNING id`, [
    ids.account, ids.experiment, ids.design, ids.approval, start, end, observed,
    sha256('spend-head'), md5('spend'),
  ])
  const policy = await db.query<{ id: string }>(`SELECT (public.commit_economics_policy_version(
    $1,1,$2,'USD','unknown_processor','merchant_1',30,'outcome_actual_entries',
    ARRAY['owner_actual_cost_export'],ARRAY['consumables'],
    '{"consumables":"owner_actual_cost_export"}'::jsonb,'excluded_from_contribution',$3,
    'owner_entry','owner worksheet','2025-11-01T00:00:00Z','estimate-policy')).id`,
  [ids.account, OBJECTIVE, DESIGN_HASH])
  const policyApproval = await db.query<{ id: string }>(`SELECT (public.approve_economics_policy_version(
    $1,$2,$3,NULL,'2025-11-01T00:00:00Z','owner','verified actual cost sources',$4,
    'estimate-policy-approval')).id`, [
    ids.account, policy.rows[0].id, DESIGN_HASH, iso(Date.now() + 365 * DAY_MS),
  ])
  const settlementId = '00000000-0000-4000-8fff-000000000001'
  await db.query(`SELECT public.commit_processor_settlement_batch(
    $1,$2,'unknown_processor','merchant_1',$3::timestamptz,$4::timestamptz,
    'settlement-head',true,ARRAY[]::text[],'[]'::jsonb,1,$5)`,
  [ids.account, settlementId, start, outcomeThrough, sha256('settlement')])
  const settlement = await db.query<{ id: string; import_sequence: string }>(`
    SELECT id,import_sequence::text FROM public.processor_settlement_batches WHERE id=$1`, [settlementId])
  for (const generation of ids.generations) {
    const treatment = generation.outcomes.filter((o) => o.arm === 'treatment').length
    await insertRow(db, 'causal_contribution_generations', {
      id: generation.id, ad_account_id: ids.account, experiment_id: ids.experiment,
      design_version_id: ids.design, design_approval_id: ids.approval,
      economics_policy_id: policy.rows[0].id, economics_policy_approval_id: policyApproval.rows[0].id,
      assignment_coverage_manifest_id: assignmentCoverage.rows[0].id,
      outcome_coverage_manifest_id: appointmentCoverage.rows[0].id,
      meta_spend_batch_id: spend.rows[0].id, settlement_batch_id: settlement.rows[0].id,
      settlement_import_sequence: settlement.rows[0].import_sequence,
      measurement_start: start, measurement_end: end, outcome_through: outcomeThrough,
      unit_count: generation.declaredUnits, treatment_unit_count: treatment,
      comparator_unit_count: generation.declaredUnits - treatment, cost_source_count: 1,
      source_fingerprint: md5(`generation:${generation.id}`), policy_version: 1,
      dedupe_key: `generation-${generation.id}`, materialized_at: outcomeThrough, created_at: outcomeThrough,
    })
    for (const outcome of generation.outcomes) {
      await insertRow(db, 'causal_contribution_unit_outcomes', {
        generation_id: generation.id, ad_account_id: ids.account, experiment_id: ids.experiment,
        design_version_id: ids.design, design_approval_id: ids.approval,
        assignment_unit_id: outcome.unit, arm: outcome.arm, outcome_count: 0,
        collected_ex_tax_minor: outcome.contribution, refunds_ex_tax_minor: 0,
        chargebacks_ex_tax_minor: 0, recovered_chargebacks_ex_tax_minor: 0, payment_fees_minor: 0,
        variable_cost_minor: 0, ad_spend_minor: 0, contribution_minor: outcome.contribution,
      })
    }
  }
}
