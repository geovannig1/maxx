import { createHash } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MIN_SWITCHBACK_BLOCKS, causalDb, fixtureUnitIds, insertClientAppointment, insertSwitchbackHistory, outcomeUuid,
} from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000082'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000083'
const EXPERIMENT = '00000000-0000-4000-8000-000000000084'
const HISTORICAL_EXPERIMENT = '00000000-0000-4000-8000-000000000085'
const HISTORICAL_DESIGN = '00000000-0000-4000-8000-000000000086'
const HISTORICAL_APPROVAL = '00000000-0000-4000-8000-000000000087'
const HISTORICAL_UNIT = '00000000-0000-4000-8000-000000000088'
const HASH = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const SEED_HASH = `sha256:${'c'.repeat(64)}`
const UNIT_HASH = `sha256:${'d'.repeat(64)}`
const CAPTURED_AT = new Date().toISOString()
let db: PGlite

type Row = Record<string, unknown>

// Scheduled (non-visitor) assignment through record_causal_assignment_unit. The baseline schema routes
// time-block units through one atomic switchback schedule instead, so the shipped schema's
// individually scheduled unit is the geo cell.
function designContract(over: Record<string, unknown> = {}) {
  return {
    objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    primary_metric: 'causal_incremental_contribution',
    currency: 'USD',
    hypothesis: 'The challenger causes more contribution than the governed comparison.',
    design_kind: 'randomized_controlled',
    estimand: 'marginal_contribution_vs_current_state',
    assignment_unit: 'geo_cell',
    assignment_method: 'deterministic_hash_randomization',
    treatment_arm_ref: 'challenger_v1',
    comparator_arm_ref: 'current_paid_state',
    eligible_population: {
      eligibility_rule: 'all_precommitted_time_blocks',
      exclusion_rule: 'documented_blackout_windows',
      unit_source: 'first_party_eligibility_log',
      timezone: 'America/New_York',
    },
    measurement_start: '2099-09-01T00:00:00Z',
    measurement_end: '2099-09-15T00:00:00Z',
    realization_horizon_days: 30,
    confidence_level: 0.95,
    minimum_detectable_effect_minor: 2500,
    randomization_seed_hash: SEED_HASH,
    treatment_allocation_bps: 5000,
    pre_period_start: null,
    pre_period_end: null,
    analysis_method: 'regression_adjusted_intent_to_treat',
    analysis_plan: {
      interval_method: 'bootstrap',
      interference_assumption: 'no_cross_unit_interference',
      maturity_rule: 'all_assigned_units_reach_realization_horizon',
      missing_outcome_rule: 'zero_after_realization_horizon',
      multiple_testing_policy: 'single_primary_estimand',
      stop_rule: 'owner_approved_loss_ceiling_only',
    },
    ...over,
  }
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

async function createApprovedDesign(contract = designContract()) {
  const design = await one<Row>(`
    SELECT (public.commit_causal_measurement_design(
      $1,$2,1,$3::jsonb,$4,'owner_entry','causal plan',$5::timestamptz,'design-v1'
    )).*`, [ACCOUNT, EXPERIMENT, JSON.stringify(contract), HASH, CAPTURED_AT])
  const approval = await one<Row>(`
    SELECT (public.approve_causal_measurement_design(
      $1,$2,$3,$4,NULL,'owner','Approved before any assignment','approve-design-v1'
    )).*`, [ACCOUNT, EXPERIMENT, design.id, HASH])
  return { design, approval }
}

async function assign(
  designId: string,
  approvalId: string,
  over: Record<string, unknown> = {},
) {
  const args = {
    unitHash: UNIT_HASH,
    requestedArm: null,
    effectiveFrom: '2099-09-02T00:00:00Z',
    effectiveThrough: '2099-09-03T00:00:00Z',
    sourceKind: 'deterministic_randomizer',
    sourceRef: 'server randomizer v1',
    proof: null,
    dedupe: 'assignment-unit-v1',
    ...over,
  }
  return one<Row>(`
    SELECT (public.record_causal_assignment_unit(
      $1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10,$11,1,$12
    )).*`, [
    ACCOUNT, EXPERIMENT, designId, approvalId, args.unitHash, args.requestedArm,
    args.effectiveFrom, args.effectiveThrough, args.sourceKind, args.sourceRef, args.proof,
    args.dedupe,
  ])
}

// A closed time-block experiment as the shipped schema admits one: twelve one-day
// switchback blocks from 2026-01-01 local midnight. HISTORICAL_UNIT is the 2026-01-02 block.
let history: Awaited<ReturnType<typeof insertSwitchbackHistory>>
async function createHistoricalTimeBlock() {
  const unitIds = fixtureUnitIds(0x9082, MIN_SWITCHBACK_BLOCKS)
  unitIds[1] = HISTORICAL_UNIT
  history = await insertSwitchbackHistory(db, {
    account: ACCOUNT, experiment: HISTORICAL_EXPERIMENT, design: HISTORICAL_DESIGN,
    approval: HISTORICAL_APPROVAL, unitIds,
  })
}

async function insertAppointment(id: number, createdAt: string, account = ACCOUNT) {
  await insertClientAppointment(db, { id, account, createdAt, observedAt: createdAt })
}

async function linkAppointment(id: number, over: Record<string, unknown> = {}) {
  const args = {
    experiment: HISTORICAL_EXPERIMENT,
    design: HISTORICAL_DESIGN,
    approval: HISTORICAL_APPROVAL,
    dedupe: `appointment-link-${id}`,
    ...over,
  }
  return one<Row>(`SELECT (public.link_causal_time_block_outcome(
    $1,$2,$3,$4,$5,1,$6
  )).*`, [ACCOUNT, args.experiment, args.design, args.approval, outcomeUuid(id), args.dedupe])
}

function expectedRandomizedArm(unitHash: string): 'treatment' | 'comparator' {
  const digest = createHash('md5').update(`${SEED_HASH}:${unitHash}`).digest('hex')
  return Number.parseInt(digest.slice(0, 8), 16) % 10_000 < 5000 ? 'treatment' : 'comparator'
}

beforeEach(async () => {
  db = await causalDb(ACCOUNT, OTHER_ACCOUNT)
  await db.query(`
    INSERT INTO public.experiments(
      id,ad_account_id,hypothesis,changed_variable,control_ref,challenger_ref,
      primary_metric,min_sample,min_spend,success_contract,status,entity_level,entity_ref
    ) VALUES ($1,$2,'Causal contribution increases','daily_budget','current','challenger',
      'causal_incremental_contribution',30,500,'Use the governed interval','draft','adset','as_82')
  `, [EXPERIMENT, ACCOUNT])
})

describe('causal assignment units', () => {
  it('computes a deterministic randomized arm and retries idempotently', async () => {
    const { design, approval } = await createApprovedDesign()
    const first = await assign(design.id as string, approval.id as string)
    const retry = await assign(design.id as string, approval.id as string)
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      arm: expectedRandomizedArm(UNIT_HASH),
      assignment_unit_kind: 'geo_cell',
      assignment_source_kind: 'deterministic_randomizer',
      assignment_proof: expect.stringMatching(/^md5:[0-9a-f]{32}$/),
    })
    const highBitHash = `sha256:${'0'.repeat(64)}`
    const highBit = await assign(design.id as string, approval.id as string, {
      unitHash: highBitHash, dedupe: 'assignment-high-bit-bucket',
    })
    expect(highBit.arm).toBe(expectedRandomizedArm(highBitHash))
  })

  it('rejects a caller-selected arm that differs from the committed randomization', async () => {
    const { design, approval } = await createApprovedDesign()
    const wrong = expectedRandomizedArm(UNIT_HASH) === 'treatment' ? 'comparator' : 'treatment'
    await expect(assign(design.id as string, approval.id as string, { requestedArm: wrong }))
      .rejects.toThrow(/randomized arm mismatch/i)
  })

  it('requires the current exact approval and stops after withdrawal', async () => {
    const { design, approval } = await createApprovedDesign()
    await one(`SELECT public.withdraw_causal_measurement_design_approval(
      $1,$2,$3,'owner','Implementation changed','withdraw-design-v1'
    )`, [ACCOUNT, EXPERIMENT, approval.id])
    await expect(assign(design.id as string, approval.id as string))
      .rejects.toThrow(/current approved causal design/i)
  })

  it('blocks assignment when a newer design version is awaiting owner review', async () => {
    const { design, approval } = await createApprovedDesign()
    await one(`SELECT public.commit_causal_measurement_design(
      $1,$2,1,$3::jsonb,$4,'owner_entry','revised causal plan',$5::timestamptz,'design-v2'
    )`, [
      ACCOUNT, EXPERIMENT, JSON.stringify(designContract({ confidence_level: 0.9 })),
      HASH_B, CAPTURED_AT,
    ])
    await expect(assign(design.id as string, approval.id as string))
      .rejects.toThrow(/newer causal design awaits owner review/i)
  })

  it('requires scheduled units to be recorded before their effective window', async () => {
    const { design, approval } = await createApprovedDesign()
    await expect(assign(design.id as string, approval.id as string, {
      effectiveFrom: '2020-01-01T00:00:00Z', effectiveThrough: '2099-09-03T00:00:00Z',
    })).rejects.toThrow(/before.*effective|measurement window/i)
  })

  it('allows only precommitted quasi schedules with an explicit source proof', async () => {
    const contract = designContract({
      design_kind: 'quasi_experimental',
      estimand: 'total_contribution_vs_no_ads',
      assignment_method: 'precommitted_matched_geo',
      randomization_seed_hash: null,
      treatment_allocation_bps: null,
      pre_period_start: '2099-08-01T00:00:00Z',
      pre_period_end: '2099-08-31T23:59:59Z',
      analysis_method: 'difference_in_differences',
    })
    const { design, approval } = await createApprovedDesign(contract)
    const unit = await assign(design.id as string, approval.id as string, {
      requestedArm: 'comparator', sourceKind: 'precommitted_schedule',
      proof: `sha256:${'e'.repeat(64)}`,
    })
    expect(unit).toMatchObject({ arm: 'comparator', arm_ref: 'current_paid_state' })
    await expect(assign(design.id as string, approval.id as string, {
      unitHash: `sha256:${'f'.repeat(64)}`, requestedArm: 'treatment',
      sourceKind: 'precommitted_schedule', proof: null, dedupe: 'quasi-without-proof',
    })).rejects.toThrow(/proof/i)
  })

  it('does not preassign eligible visitors before the measurement window opens', async () => {
    const { design, approval } = await createApprovedDesign(designContract({
      assignment_unit: 'eligible_visitor',
      eligible_population: {
        eligibility_rule: 'all_new_eligible_sessions', exclusion_rule: 'staff_and_test_sessions',
        unit_source: 'first_party_session_eligibility_log', timezone: 'America/New_York',
      },
    }))
    await expect(assign(design.id as string, approval.id as string, {
      effectiveFrom: null, effectiveThrough: null,
    })).rejects.toThrow(/measurement window.*not open/i)
  })

  it('keeps the ledger append-only and isolated from browser and direct app-role writes', async () => {
    const { design, approval } = await createApprovedDesign()
    const unit = await assign(design.id as string, approval.id as string)
    await expect(db.query(`DELETE FROM public.causal_assignment_units WHERE id=$1`, [unit.id]))
      .rejects.toThrow(/immutable|append-only/i)
    expect(await one<{ dml: number; browser_reads: number; service_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          WHERE has_table_privilege(role_name,'public.causal_assignment_units',privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          WHERE has_table_privilege(role_name,'public.causal_assignment_units','SELECT')) browser_reads,
        has_table_privilege('service_role','public.causal_assignment_units','SELECT')::int service_reads
    `)).toEqual({ dml: 0, browser_reads: 0, service_reads: 1 })
  })

  it('starts without invented assignments, outcomes, estimates, or action authority', async () => {
    // The estimate table exists since 088 by design; a fresh install must still hold no invented rows.
    expect(await one<{ units: number; outcomes: number; estimates: number; decisions: number }>(`
      SELECT
        (SELECT count(*)::int FROM public.causal_assignment_units) units,
        (SELECT count(*)::int FROM public.causal_contribution_unit_outcomes) outcomes,
        (SELECT count(*)::int FROM public.causal_contribution_estimates) estimates,
        (SELECT count(*)::int FROM public.action_decisions) decisions
    `)).toEqual({ units: 0, outcomes: 0, estimates: 0, decisions: 0 })
  })
})

describe('time-block appointment outcomes', () => {
  it('derives the one matching assignment from booking time and retries idempotently', async () => {
    await createHistoricalTimeBlock()
    await insertAppointment(8301, '2026-01-02T12:00:00Z')
    const first = await linkAppointment(8301)
    const retry = await linkAppointment(8301)
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      outcome_id: outcomeUuid(8301),
      assignment_unit_id: HISTORICAL_UNIT,
      linkage_basis: 'outcome_time_block',
    })
  })

  it('preserves assigned zero-outcome units without manufacturing a booking', async () => {
    await createHistoricalTimeBlock()
    expect(await one<{ units: number; links: number }>(`
      SELECT
        (SELECT count(*)::int FROM public.causal_assignment_units) units,
        (SELECT count(*)::int FROM public.causal_outcome_links) links
    `)).toEqual({ units: MIN_SWITCHBACK_BLOCKS, links: 0 })
  })

  it('uses half-open time blocks and rejects bookings outside every assigned block', async () => {
    await createHistoricalTimeBlock()
    // The exclusive end of the last block, which no assigned block contains.
    await insertAppointment(8302, history.end)
    await expect(linkAppointment(8302)).rejects.toThrow(/exactly one.*time block/i)
  })

  it('rejects ambiguous overlapping time blocks instead of selecting an arm post hoc', async () => {
    await createHistoricalTimeBlock()
    await db.query(`
      INSERT INTO public.causal_assignment_units(
        ad_account_id,experiment_id,design_version_id,design_approval_id,
        design_approval_decision,unit_key_hash,assignment_unit_kind,arm,arm_ref,assigned_at,
        effective_from,effective_through,assignment_source_kind,assignment_source_ref,
        assignment_proof,policy_version,dedupe_key,created_at,schedule_manifest_id
      ) VALUES ($1,$2,$3,$4,'approved',$5,'time_block','comparator','current_paid_state',
        '2025-12-03T00:00:00Z','2026-01-02T06:00:00Z','2026-01-03T06:00:00Z',
        'deterministic_randomizer','historical randomizer',$6,1,'overlapping-unit',
        '2025-12-03T00:00:00Z',$7)
    `, [
      ACCOUNT, HISTORICAL_EXPERIMENT, HISTORICAL_DESIGN, HISTORICAL_APPROVAL,
      `sha256:${'9'.repeat(64)}`, `md5:${'8'.repeat(32)}`, history.manifest,
    ])
    await insertAppointment(8303, '2026-01-02T12:00:00Z')
    await expect(linkAppointment(8303)).rejects.toThrow(/exactly one.*time block/i)
  })

  it('rejects staff or origin-unknown appointments', async () => {
    await createHistoricalTimeBlock()
    await insertClientAppointment(db, {
      id: 8304, account: ACCOUNT, createdAt: '2026-01-02T12:00:00Z', scheduledBy: 'owner',
      observedAt: new Date().toISOString(),
    })
    await expect(linkAppointment(8304)).rejects.toThrow(/proven client-booked origin/i)
  })

  it('rejects impossible origin chronology', async () => {
    await createHistoricalTimeBlock()
    await insertClientAppointment(db, {
      id: 8307, account: ACCOUNT, createdAt: '2026-01-02T12:00:00Z', observedAt: '2026-01-02T11:59:59Z',
    })
    await expect(linkAppointment(8307)).rejects.toThrow(/proven client-booked origin/i)
  })

  it('rejects non-time-block designs instead of accepting caller-selected membership', async () => {
    const { design, approval } = await createApprovedDesign(designContract({
      assignment_unit: 'eligible_visitor',
    }))
    await insertAppointment(8308, '2026-01-02T12:00:00Z')
    await expect(linkAppointment(8308, {
      experiment: EXPERIMENT, design: design.id, approval: approval.id,
    }))
      .rejects.toThrow(/only time-block designs/i)
  })

  it('rejects reuse of an idempotency key for another appointment', async () => {
    await createHistoricalTimeBlock()
    await insertAppointment(8309, '2026-01-02T12:00:00Z')
    await insertAppointment(8310, '2026-01-02T13:00:00Z')
    await linkAppointment(8309, { dedupe: 'same-link-key' })
    await expect(linkAppointment(8310, { dedupe: 'same-link-key' }))
      .rejects.toThrow(/dedupe collision/i)
  })

  it('fails closed after design withdrawal', async () => {
    await createHistoricalTimeBlock()
    await insertAppointment(8305, '2026-01-02T12:00:00Z')
    await db.query(`INSERT INTO public.causal_measurement_design_approvals(
      ad_account_id,experiment_id,artifact_id,artifact_hash,decision,revision,
      previous_approval_id,reviewed_by,reason,dedupe_key,created_at
    ) VALUES ($1,$2,$3,$4,'withdrawn',2,$5,'owner','withdrawn','historical-withdrawal',now())`,
    [ACCOUNT, HISTORICAL_EXPERIMENT, HISTORICAL_DESIGN, HASH, HISTORICAL_APPROVAL])
    await expect(linkAppointment(8305)).rejects.toThrow(/current approved causal design/i)
  })

  it('keeps outcome links append-only with no browser or direct app-role writes', async () => {
    await createHistoricalTimeBlock()
    await insertAppointment(8306, '2026-01-02T12:00:00Z')
    const link = await linkAppointment(8306)
    await expect(db.query(
      `UPDATE public.causal_outcome_links SET outcome_id=$2 WHERE id=$1`, [link.id, outcomeUuid(999)],
    )).rejects.toThrow(/immutable|append-only/i)
    expect(await one<{ dml: number; browser_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          WHERE has_table_privilege(
            role_name,'public.causal_outcome_links',privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          WHERE has_table_privilege(
            role_name,'public.causal_outcome_links','SELECT')) browser_reads
    `)).toEqual({ dml: 0, browser_reads: 0 })
  })
})
