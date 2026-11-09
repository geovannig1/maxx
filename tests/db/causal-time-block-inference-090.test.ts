import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SWITCHBACK_PLAN, SWITCHBACK_START, causalDb, fixtureUnitIds, insertContributionGenerations,
  insertDesign, insertExperiment,
} from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000901'
const EXPERIMENT = '00000000-0000-4000-8000-000000000902'
const GEO_EXPERIMENT = '00000000-0000-4000-8000-000000000905'
const GEO_DESIGN = '00000000-0000-4000-8000-000000000904'
const GEO_APPROVAL = '00000000-0000-4000-8000-000000000906'
const GEO_GENERATION = '00000000-0000-4000-8000-000000000907'
let db: PGlite

// The analysis contract the shipped schema requires of a time-block design (the structured
// fields tightened into a paired switchback with one-day blocks here).
const safePlan = SWITCHBACK_PLAN
// Twelve one-day blocks from a local midnight: the smallest window that contract admits.
const WINDOW_END = '2026-01-13T05:00:00Z'

async function insertTimeBlockDesign(plan: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID()
  await insertDesign(db, {
    id, account: ACCOUNT, experiment: EXPERIMENT, assignmentUnit: 'time_block',
    start: SWITCHBACK_START, end: WINDOW_END, over: { analysis_plan: JSON.stringify(plan) },
  })
  return id
}

// The baseline CHECK constraint, evaluated for a candidate plan exactly as written.
async function precommitAccepts(plan: Record<string, unknown>): Promise<boolean> {
  const { rows } = await db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) def
    FROM pg_constraint WHERE conname='causal_time_block_analysis_precommit'
      AND conrelid='public.causal_measurement_design_versions'::regclass`)
  expect(rows).toHaveLength(1)
  expect(rows[0].def).toMatch(/causal_time_block_analysis_plan_valid\(design_kind, analysis_plan\)/)
  const result = await db.query<{ ok: boolean }>(
    `SELECT public.causal_time_block_analysis_plan_valid('randomized_controlled',$1::jsonb) ok`,
    [JSON.stringify(plan)])
  return result.rows[0].ok
}

beforeEach(async () => {
  db = await causalDb(ACCOUNT)
  await insertExperiment(db, { id: EXPERIMENT, account: ACCOUNT, minSample: 12 })
})

describe('time-block inference quarantine', () => {
  it('rejects new time-block plans with free-text interference or IID intervals', async () => {
    const plan = { ...safePlan, interval_method: 'bootstrap', interference_assumption: 'none' }
    expect(await precommitAccepts(plan)).toBe(false)
    // The insert guard applies the same validator first, so it names the rejection.
    await expect(insertTimeBlockDesign(plan))
      .rejects.toThrow(/balanced supported paired switchback contract/i)
  })

  it('rejects a time-block plan when required structured fields are missing', async () => {
    expect(await precommitAccepts({})).toBe(false)
    await expect(insertTimeBlockDesign({}))
      .rejects.toThrow(/balanced supported paired switchback contract/i)
  })

  it('accepts a structurally precommitted switchback plan but still withholds current estimation', async () => {
    expect(await precommitAccepts(safePlan)).toBe(true)
    const design = await insertTimeBlockDesign(safePlan)
    await expect(db.query(`INSERT INTO public.causal_contribution_estimates VALUES (
      gen_random_uuid(),$1,$2,$3)`, [ACCOUNT, EXPERIMENT, design]))
      .rejects.toThrow(/time-block.*switchback-aware inference/i)
  })

  it('does not block a non-time-block estimate', async () => {
    const units = fixtureUnitIds(0x9090, 2).map((id, i) => ({
      id, arm: (i === 0 ? 'treatment' : 'comparator') as 'treatment' | 'comparator',
    }))
    await insertContributionGenerations(db, {
      account: ACCOUNT, experiment: GEO_EXPERIMENT, design: GEO_DESIGN, approval: GEO_APPROVAL,
      entityRef: 'as_090', units,
      generations: [{
        id: GEO_GENERATION, declaredUnits: 2,
        outcomes: units.map((unit) => ({ unit: unit.id, arm: unit.arm, contribution: 1000 })),
      }],
    })
    await expect(db.query(`INSERT INTO public.causal_contribution_estimates(
      ad_account_id,experiment_id,design_version_id,design_approval_id,outcome_generation_id,
      objective,primary_metric,estimand,bootstrap_iterations,confidence_level,
      minimum_detectable_effect_minor,unit_count,treatment_unit_count,comparator_unit_count,
      estimate_minor,sample_sufficient,evidence_status,materiality_status,source_fingerprint,
      policy_version,dedupe_key
    ) VALUES ($1,$2,$3,$4,$5,
      'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      'causal_incremental_contribution','marginal_contribution_vs_current_state',
      2000,0.95,2500,2,1,1,0,false,'insufficient_sample','insufficient_sample',$6,1,
      'non-time-block-estimate')`, [
      ACCOUNT, GEO_EXPERIMENT, GEO_DESIGN, GEO_APPROVAL, GEO_GENERATION, `md5:${'a'.repeat(32)}`,
    ])).resolves.toBeTruthy()
  })
})
