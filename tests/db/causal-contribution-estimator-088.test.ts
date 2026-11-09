import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { causalDb, fixtureUnitIds, insertContributionGenerations } from './causal-fixture'

const A = '00000000-0000-4000-8000-000000000141'
const X = '00000000-0000-4000-8000-000000000142'
const D = '00000000-0000-4000-8000-000000000143'
const DA = '00000000-0000-4000-8000-000000000144'
const G = '00000000-0000-4000-8000-000000000145'
const SMALL_G = '00000000-0000-4000-8000-000000000146'
const BAD_G = '00000000-0000-4000-8000-000000000147'
let db: PGlite

type Row = Record<string, unknown>

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

async function estimate(generation = G, dedupe = `estimate-${generation}`) {
  return one<Row>(`SELECT (public.estimate_causal_incremental_contribution(
    $1,$2,$3,$4,$5,1,$6
  )).*`, [A, X, D, DA, generation, dedupe])
}

const DIFFERENCE_IN_MEANS = {
  analysis_method: 'difference_in_means',
  analysis_plan: JSON.stringify({
    interval_method: 'bootstrap', bootstrap_iterations: 2000,
    interference_assumption: 'no_cross_unit_interference', maturity_rule: 'horizon',
    missing_outcome_rule: 'zero_after_horizon', multiple_testing_policy: 'single_primary_estimand',
    stop_rule: 'owner_only',
  }),
}

// 30 assigned units, the first 15 treatment. G covers all of them; SMALL_G is a 2-vs-1 sample; BAD_G
// declares 31 units but carries outcomes for only 30.
async function seed(designOver: Record<string, unknown> = DIFFERENCE_IN_MEANS) {
  db = await causalDb(A)
  const units = fixtureUnitIds(0x9000, 30).map((id, i) => ({
    id, arm: (i < 15 ? 'treatment' : 'comparator') as 'treatment' | 'comparator',
  }))
  await insertContributionGenerations(db, {
    account: A, experiment: X, design: D, approval: DA, entityRef: 'as_088', units, designOver,
    generations: [
      {
        id: G, declaredUnits: 30,
        outcomes: units.map((unit, i) => ({
          unit: unit.id, arm: unit.arm,
          contribution: i < 15 ? 20000 + (i + 1) * 100 : 10000 + (i - 14) * 100,
        })),
      },
      {
        id: SMALL_G, declaredUnits: 3,
        outcomes: [
          { unit: units[0].id, arm: 'treatment', contribution: 20000 },
          { unit: units[1].id, arm: 'treatment', contribution: 21000 },
          { unit: units[15].id, arm: 'comparator', contribution: 10000 },
        ],
      },
      {
        id: BAD_G, declaredUnits: 31,
        outcomes: units.map((unit, i) => ({ unit: unit.id, arm: unit.arm, contribution: i < 15 ? 20000 : 10000 })),
      },
    ],
  })
}

beforeEach(async () => {
  await seed()
})

describe('causal contribution estimator', () => {
  it('computes a deterministic bootstrap interval over contribution, not proxy metrics', async () => {
    const result = await estimate()
    expect(Number(result.estimate_minor)).toBe(10000)
    expect(Number(result.interval_lower_minor)).toBeGreaterThan(0)
    expect(Number(result.interval_upper_minor)).toBeGreaterThan(Number(result.interval_lower_minor))
    expect(Number(result.bootstrap_probability_positive)).toBe(1)
    expect(result).toMatchObject({
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      primary_metric: 'causal_incremental_contribution',
      estimand: 'marginal_contribution_vs_current_state',
      evidence_status: 'directional_positive', materiality_status: 'exceeds_mde',
      sample_sufficient: true, action_authority: 'none', budget_increase_authority: 'none',
    })
  })

  it('is idempotent and produces the same interval from the pinned generation', async () => {
    const first = await estimate()
    const retry = await estimate()
    expect(retry).toMatchObject({
      id: first.id,
      interval_lower_minor: first.interval_lower_minor,
      interval_upper_minor: first.interval_upper_minor,
    })
  })

  it('labels small samples insufficient and publishes no fabricated interval', async () => {
    const result = await estimate(SMALL_G)
    expect(result).toMatchObject({
      sample_sufficient: false, evidence_status: 'insufficient_sample',
      materiality_status: 'insufficient_sample', interval_lower_minor: null,
      interval_upper_minor: null, bootstrap_probability_positive: null,
      action_authority: 'none', budget_increase_authority: 'none',
    })
  })

  it('rejects a generation whose declared unit population is incomplete', async () => {
    await expect(estimate(BAD_G)).rejects.toThrow(/unit population.*incomplete/i)
  })

  it('rejects an analysis plan it cannot faithfully execute', async () => {
    // Design versions are immutable, so the unsupported plan is the one approved from the start.
    await seed({ analysis_method: 'regression_adjusted_intent_to_treat' })
    await expect(estimate()).rejects.toThrow(/precommitted difference-in-means bootstrap/i)
  })

  it('keeps estimates append-only, private, and structurally unable to authorize spend', async () => {
    const result = await estimate()
    await expect(db.query(`UPDATE public.causal_contribution_estimates
      SET evidence_status='directional_negative' WHERE id=$1`, [result.id]))
      .rejects.toThrow(/immutable|append-only/i)
    expect(await one<{ dml: number; browser_reads: number; authority: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          WHERE has_table_privilege(role_name,'public.causal_contribution_estimates',privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          WHERE has_table_privilege(role_name,'public.causal_contribution_estimates','SELECT')) browser_reads,
        (SELECT count(*)::int FROM public.causal_contribution_estimates
          WHERE action_authority<>'none' OR budget_increase_authority<>'none') authority
    `)).toEqual({ dml: 0, browser_reads: 0, authority: 0 })
  })
})
