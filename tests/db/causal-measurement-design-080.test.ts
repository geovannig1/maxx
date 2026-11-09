import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { causalDb } from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000080'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000081'
const EXPERIMENT = '00000000-0000-4000-8000-000000000082'
const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const CAPTURED_AT = new Date().toISOString()
let db: PGlite

type DesignContract = Record<string, unknown>

function randomizedContract(over: Partial<DesignContract> = {}): DesignContract {
  return {
    objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    primary_metric: 'causal_incremental_contribution',
    currency: 'USD',
    hypothesis: 'The challenger increases realized contribution versus the current paid state.',
    design_kind: 'randomized_controlled',
    estimand: 'marginal_contribution_vs_current_state',
    assignment_unit: 'eligible_visitor',
    assignment_method: 'deterministic_hash_randomization',
    treatment_arm_ref: 'challenger_v1',
    comparator_arm_ref: 'current_paid_state',
    eligible_population: {
      eligibility_rule: 'all_new_eligible_sessions',
      exclusion_rule: 'known_staff_and_test_sessions',
      unit_source: 'first_party_session_eligibility_log',
      timezone: 'America/New_York',
    },
    measurement_start: '2099-09-01T00:00:00Z',
    measurement_end: '2099-09-15T00:00:00Z',
    realization_horizon_days: 30,
    confidence_level: 0.95,
    minimum_detectable_effect_minor: 2500,
    randomization_seed_hash: `sha256:${'c'.repeat(64)}`,
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

// The baseline schema admits a time-block design only as a balanced randomized switchback, so the shipped
// schema's precommitted quasi design is the matched-geo one.
function quasiContract(over: Partial<DesignContract> = {}): DesignContract {
  return randomizedContract({
    design_kind: 'quasi_experimental',
    estimand: 'total_contribution_vs_no_ads',
    assignment_unit: 'geo_cell',
    assignment_method: 'precommitted_matched_geo',
    treatment_arm_ref: 'ads_on',
    comparator_arm_ref: 'ads_off',
    randomization_seed_hash: null,
    treatment_allocation_bps: null,
    pre_period_start: '2099-08-01T00:00:00Z',
    pre_period_end: '2099-08-31T23:59:59Z',
    analysis_method: 'difference_in_differences',
    ...over,
  })
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

async function commitDesign(
  contract: DesignContract = randomizedContract(),
  over: Record<string, unknown> = {},
) {
  const args = {
    account: ACCOUNT,
    experiment: EXPERIMENT,
    schemaVersion: 1,
    hash: HASH_A,
    sourceKind: 'owner_entry',
    sourceRef: 'owner-approved causal measurement plan v1',
    capturedAt: CAPTURED_AT,
    dedupe: 'causal-design-v1',
    ...over,
  }
  return one<Record<string, unknown>>(`
    SELECT (public.commit_causal_measurement_design(
      $1,$2,$3,$4::jsonb,$5,$6,$7,$8::timestamptz,$9
    )).*`, [
    args.account, args.experiment, args.schemaVersion, JSON.stringify(contract), args.hash,
    args.sourceKind, args.sourceRef, args.capturedAt, args.dedupe,
  ])
}

async function approveDesign(
  artifactId: string,
  expectedPrevious: string | null = null,
  over: Record<string, unknown> = {},
) {
  const args = {
    account: ACCOUNT,
    experiment: EXPERIMENT,
    hash: HASH_A,
    reviewedBy: 'owner',
    reason: 'Approved before exposure; population, assignment, horizon, and analysis are fixed.',
    dedupe: 'approve-causal-design-v1',
    ...over,
  }
  return one<Record<string, unknown>>(`
    SELECT (public.approve_causal_measurement_design(
      $1,$2,$3,$4,$5,$6,$7,$8
    )).*`, [
    args.account, args.experiment, artifactId, args.hash, expectedPrevious,
    args.reviewedBy, args.reason, args.dedupe,
  ])
}

beforeEach(async () => {
  db = await causalDb(ACCOUNT, OTHER_ACCOUNT)
  await db.query(`
    INSERT INTO public.experiments(
      id,ad_account_id,hypothesis,changed_variable,control_ref,challenger_ref,invariants,
      primary_metric,guardrails,min_sample,min_spend,success_contract,status,entity_level,entity_ref
    ) VALUES (
      $1,$2,'The challenger increases causal contribution','daily_budget','current state',
      'challenger','{}'::jsonb,'causal_incremental_contribution','[]'::jsonb,
      30,500,'Evaluate the precommitted causal contribution interval','draft','adset','adset_80'
    )`, [EXPERIMENT, ACCOUNT])
})

describe('governed causal measurement design', () => {
  it('commits an exact randomized design idempotently and rejects a dedupe collision', async () => {
    const first = await commitDesign()
    const retry = await commitDesign()
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      revision: 1,
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      primary_metric: 'causal_incremental_contribution',
      design_kind: 'randomized_controlled',
      estimand: 'marginal_contribution_vs_current_state',
      assignment_unit: 'eligible_visitor',
      assignment_method: 'deterministic_hash_randomization',
    })
    await expect(commitDesign(randomizedContract({ confidence_level: 0.9 })))
      .rejects.toThrow(/dedupe collision/i)
  })

  it('rejects proxy objectives, proxy metrics, other currencies, and unknown contract keys', async () => {
    await expect(commitDesign(randomizedContract({ objective: 'maximize_platform_roas' })))
      .rejects.toThrow(/objective|check constraint/i)
    await expect(commitDesign(randomizedContract({ primary_metric: 'bookings' })))
      .rejects.toThrow(/primary metric|primary_metric|check constraint/i)
    await expect(commitDesign(randomizedContract({ currency: 'EUR' })))
      .rejects.toThrow(/currency|check constraint/i)
    await expect(commitDesign({ ...randomizedContract(), post_hoc_override: true }))
      .rejects.toThrow(/unknown|contract keys/i)
  })

  it('enforces randomized design shape and precludes post-hoc assignment choices', async () => {
    await expect(commitDesign(randomizedContract({ randomization_seed_hash: null })))
      .rejects.toThrow(/randomized|seed|check constraint/i)
    await expect(commitDesign(randomizedContract({ treatment_allocation_bps: 10_000 })))
      .rejects.toThrow(/allocation|check constraint/i)
    await expect(commitDesign(randomizedContract({ pre_period_start: '2099-08-01T00:00:00Z' })))
      .rejects.toThrow(/randomized|pre-period|check constraint/i)
    await expect(commitDesign(randomizedContract({ analysis_method: 'pick_best_after_test' })))
      .rejects.toThrow(/analysis|check constraint/i)
    await expect(commitDesign(randomizedContract({
      analysis_plan: { interval_method: 'bootstrap' },
    }), { dedupe: 'incomplete-analysis-plan', hash: HASH_B }))
      .rejects.toThrow(/analysis plan|check constraint/i)
    await expect(commitDesign(randomizedContract({
      eligible_population: { eligibility_rule: 'only_converters' },
    }), { dedupe: 'converter-only-population', hash: HASH_B }))
      .rejects.toThrow(/population|check constraint/i)
  })

  it('accepts a precommitted quasi design and rejects incomplete or incoherent controls', async () => {
    const design = await commitDesign(quasiContract())
    expect(design).toMatchObject({
      design_kind: 'quasi_experimental',
      assignment_unit: 'geo_cell',
      analysis_method: 'difference_in_differences',
    })
    await expect(commitDesign(quasiContract({ pre_period_start: null }), {
      dedupe: 'quasi-missing-pre-period', hash: HASH_B,
    })).rejects.toThrow(/quasi|pre-period|check constraint/i)
    await expect(commitDesign(quasiContract({ randomization_seed_hash: `sha256:${'d'.repeat(64)}` }), {
      dedupe: 'quasi-with-seed', hash: HASH_B,
    })).rejects.toThrow(/quasi|randomization|check constraint/i)
    await expect(commitDesign(quasiContract({ assignment_unit: 'eligible_visitor' }), {
      dedupe: 'quasi-wrong-unit', hash: HASH_B,
    })).rejects.toThrow(/quasi|assignment|check constraint/i)
  })

  it('requires a future measurement window and a capture made before treatment', async () => {
    await expect(commitDesign(randomizedContract({
      measurement_start: '2020-01-01T00:00:00Z',
      measurement_end: '2020-01-15T00:00:00Z',
    }))).rejects.toThrow(/before measurement|already started/i)
    await expect(commitDesign(randomizedContract({
      measurement_start: '2099-09-15T00:00:00Z',
      measurement_end: '2099-09-01T00:00:00Z',
    }))).rejects.toThrow(/measurement|check constraint/i)
    await expect(commitDesign(randomizedContract(), {
      capturedAt: '2099-09-02T00:00:00Z',
    })).rejects.toThrow(/capture|measurement|future/i)
  })

  it('approves only the exact latest design before measurement and freezes the brief', async () => {
    const design = await commitDesign()
    const first = await approveDesign(design.id as string)
    const retry = await approveDesign(design.id as string)
    expect(retry).toMatchObject({ id: first.id, revision: 1, decision: 'approved' })
    expect(await one<{ status: string }>(
      `SELECT status FROM public.experiments WHERE id=$1`, [EXPERIMENT],
    )).toEqual({ status: 'proposed' })
    await expect(db.query(
      `UPDATE public.experiments SET status='draft' WHERE id=$1`, [EXPERIMENT],
    )).rejects.toThrow(/causal design approval.*mutable draft/i)
    await expect(approveDesign(design.id as string, first.id as string, {
      hash: HASH_B, dedupe: 'approve-wrong-hash',
    })).rejects.toThrow(/hash mismatch/i)
  })

  it('rejects stale approval heads, superseded artifacts, and already-started experiments', async () => {
    const firstDesign = await commitDesign()
    const firstApproval = await approveDesign(firstDesign.id as string)
    await expect(approveDesign(firstDesign.id as string, null, { dedupe: 'stale-head' }))
      .rejects.toThrow(/stale head/i)

    const secondDesign = await commitDesign(randomizedContract({ confidence_level: 0.9 }), {
      dedupe: 'causal-design-v2', hash: HASH_B,
    })
    await expect(approveDesign(firstDesign.id as string, firstApproval.id as string, {
      dedupe: 'approve-superseded',
    })).rejects.toThrow(/newer causal measurement design/i)

    await db.query(`UPDATE public.experiments SET status='running', started_at=now() WHERE id=$1`, [EXPERIMENT])
    await expect(approveDesign(secondDesign.id as string, firstApproval.id as string, {
      hash: HASH_B, dedupe: 'approve-after-start',
    })).rejects.toThrow(/already started|before.*start/i)
  })

  it('withdraws through an append-only decision and leaves no current approval', async () => {
    const design = await commitDesign()
    const approval = await approveDesign(design.id as string)
    const withdrawn = await one<Record<string, unknown>>(`
      SELECT (public.withdraw_causal_measurement_design_approval(
        $1,$2,$3,'owner','Measurement implementation no longer matches the approved plan',
        'withdraw-causal-design-v1'
      )).*`, [ACCOUNT, EXPERIMENT, approval.id])
    expect(withdrawn).toMatchObject({ revision: 2, decision: 'withdrawn' })
    await expect(one(`
      SELECT public.withdraw_causal_measurement_design_approval(
        $1,$2,$3,'owner','second withdrawal','withdraw-again'
      )`, [ACCOUNT, EXPERIMENT, approval.id])).rejects.toThrow(/stale head|current approval/i)
  })

  it('keeps artifacts immutable and denies all app-role direct writes and browser reads', async () => {
    const design = await commitDesign()
    await expect(db.query(
      `UPDATE public.causal_measurement_design_versions SET hypothesis='changed' WHERE id=$1`,
      [design.id],
    )).rejects.toThrow(/immutable|append-only/i)
    await expect(db.query(
      `DELETE FROM public.causal_measurement_design_versions WHERE id=$1`, [design.id],
    )).rejects.toThrow(/immutable|append-only/i)

    const grants = await one<{ dml: number; browser_reads: number; service_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('causal_measurement_design_versions'),
                             ('causal_measurement_design_approvals')) t(table_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,privilege_name)) AS dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('causal_measurement_design_versions'),
                             ('causal_measurement_design_approvals')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) AS browser_reads,
        (SELECT count(*)::int FROM (VALUES ('causal_measurement_design_versions'),
                                          ('causal_measurement_design_approvals')) t(table_name)
          WHERE has_table_privilege('service_role','public.' || table_name,'SELECT')) AS service_reads
    `)
    expect(grants).toEqual({ dml: 0, browser_reads: 0, service_reads: 2 })
  })

  // The result tables ship with the design tables on purpose. The shipped intent is that
  // a fresh install invents nothing: no design, approval, estimate, outcome or action authority.
  it('starts empty and creates no estimate, result, or action authority', async () => {
    expect(await one<{ designs: number; approvals: number }>(`
      SELECT
        (SELECT count(*)::int FROM public.causal_measurement_design_versions) AS designs,
        (SELECT count(*)::int FROM public.causal_measurement_design_approvals) AS approvals
    `)).toEqual({ designs: 0, approvals: 0 })
    expect(await one<{ estimates: number; outcomes: number; decisions: number }>(`
      SELECT
        (SELECT count(*)::int FROM public.causal_contribution_estimates) AS estimates,
        (SELECT count(*)::int FROM public.causal_contribution_unit_outcomes) AS outcomes,
        (SELECT count(*)::int FROM public.action_decisions) AS decisions
    `)).toEqual({ estimates: 0, outcomes: 0, decisions: 0 })
  })
})
