import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { causalDb, fixtureUnitIds, insertContributionGenerations } from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000089'
const EXPERIMENT = '00000000-0000-4000-8000-000000000091'
const DESIGN = '00000000-0000-4000-8000-000000000095'
const APPROVAL = '00000000-0000-4000-8000-000000000096'
const GENERATION = '00000000-0000-4000-8000-000000000092'
const TARGET = '00000000-0000-4000-8000-000000000094'
let db: PGlite
let ESTIMATE: string

async function insertDecision(over: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(), account: ACCOUNT, kind: 'budget_scale', targetLevel: 'adset',
    targetId: TARGET, plane: 'meta_modelled', basis: 'calendar_period_signal',
    tier: 'diagnostic_only', ceiling: 'unsupported', policy: 4,
    objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    estimate: null,
    ...over,
  }
  return db.query<{ authority_tier: string; direction_ceiling: string;
    causal_contribution_estimate_id: string | null }>(`INSERT INTO public.action_decisions(
    id,ad_account_id,action_kind,target_level,target_id,evidence_plane,evidence_basis,
    authority_tier,direction_ceiling,policy_version,objective,causal_contribution_estimate_id,
    authority_reason,owner_copy,direction_reason,source_kind,dedupe_key
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
    'fixture authority','fixture copy','fixture direction','evaluator',$13) RETURNING *`,
  [...Object.values(row), `decision-${row.id}`])
}

// A real (authority-free) causal estimate for an experiment targeting the ad set TARGET, computed by
// the shipped estimator from a 15-vs-15 outcome generation.
beforeEach(async () => {
  db = await causalDb(ACCOUNT)
  const units = fixtureUnitIds(0x9089, 30).map((id, i) => ({
    id, arm: (i < 15 ? 'treatment' : 'comparator') as 'treatment' | 'comparator',
  }))
  await insertContributionGenerations(db, {
    account: ACCOUNT, experiment: EXPERIMENT, design: DESIGN, approval: APPROVAL, entityRef: TARGET,
    units,
    designOver: {
      analysis_method: 'difference_in_means',
      analysis_plan: JSON.stringify({
        interval_method: 'bootstrap', bootstrap_iterations: 2000,
        interference_assumption: 'no_cross_unit_interference', maturity_rule: 'horizon',
        missing_outcome_rule: 'zero_after_horizon',
        multiple_testing_policy: 'single_primary_estimand', stop_rule: 'owner_only',
      }),
    },
    generations: [{
      id: GENERATION, declaredUnits: 30,
      outcomes: units.map((unit, i) => ({ unit: unit.id, arm: unit.arm, contribution: i < 15 ? 20000 : 10000 })),
    }],
  })
  const estimate = await db.query<{ id: string }>(`SELECT (public.estimate_causal_incremental_contribution(
    $1,$2,$3,$4,$5,1,'quarantine-estimate')).id`, [ACCOUNT, EXPERIMENT, DESIGN, APPROVAL, GENERATION])
  ESTIMATE = estimate.rows[0].id
})

describe('causal money-authority quarantine', () => {
  // The causal quarantine raised the floor to 4; the current baseline floor is 5. The database and the application must agree.
  it('keeps the floor at or above v4 and equal to the application floor', async () => {
    const floor = await db.query<{ floor: number }>('SELECT public.action_decision_policy_floor() floor')
    expect(floor.rows[0].floor).toBeGreaterThanOrEqual(4)
    expect(floor.rows[0].floor).toBe(ACTION_DECISION_POLICY_FLOOR)
  })

  it('rejects current money authority without exact causal-estimate lineage', async () => {
    await expect(insertDecision({ tier: 'execution_eligible', ceiling: 'execution' }))
      .rejects.toThrow(/action_decisions_v4_money_quarantine|causal-estimate lineage/i)
    await expect(insertDecision({ tier: 'owner_review', ceiling: 'owner_review' }))
      .rejects.toThrow(/action_decisions_v4_money_quarantine|causal-estimate lineage/i)
  })

  it('rejects authority from an exact estimate whose immutable authority is none', async () => {
    await expect(insertDecision({
      plane: 'causal_contribution', basis: 'decision_grade_causal_estimate',
      tier: 'execution_eligible', ceiling: 'execution', estimate: ESTIMATE,
    })).rejects.toThrow(/grants no action authority|execution authority/i)
  })

  it('allows only direction-unsupported money diagnostics when no estimate is available', async () => {
    const result = await insertDecision()
    expect(result.rows[0]).toMatchObject({
      authority_tier: 'diagnostic_only', direction_ceiling: 'unsupported',
      causal_contribution_estimate_id: null,
    })
  })

  it('keeps causal lineage exact to the experiment target and action estimand', async () => {
    await expect(insertDecision({
      targetId: '00000000-0000-4000-8000-000000000099',
      plane: 'causal_contribution', basis: 'decision_grade_causal_estimate', estimate: ESTIMATE,
    })).rejects.toThrow(/exact action target/i)
    await expect(insertDecision({
      kind: 'budget_cut', plane: 'causal_contribution',
      basis: 'decision_grade_causal_estimate', estimate: ESTIMATE,
    })).rejects.toThrow(/estimand.*action kind/i)
  })

  it('does not quarantine non-money owner review and forbids laundering causal lineage into it', async () => {
    const allowed = await insertDecision({
      kind: 'creative_refresh', plane: 'structural', basis: 'calendar_period_signal',
      tier: 'owner_review', ceiling: 'owner_review', estimate: null,
    })
    expect(allowed.rows[0].authority_tier).toBe('owner_review')
    await expect(insertDecision({
      kind: 'creative_refresh', plane: 'causal_contribution',
      basis: 'decision_grade_causal_estimate', tier: 'owner_review',
      ceiling: 'owner_review', estimate: ESTIMATE,
    })).rejects.toThrow(/only support money decisions|v4_money_quarantine/i)
  })
})
