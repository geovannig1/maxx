import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { insertActionDecision, insertAdset, insertCampaign } from './decision-fixture'

const ACCOUNT_A = '00000000-0000-4000-8000-000000001241'
const ACCOUNT_B = '00000000-0000-4000-8000-000000001242'
const FLAG_A = '00000000-0000-4000-8000-000000001243'
const FLAG_B = '00000000-0000-4000-8000-000000001244'
const FLAG_GENERATION_A = '00000000-0000-4000-8000-000000001245'
const FLAG_GENERATION_B = '00000000-0000-4000-8000-000000001246'
const REC_GENERATION_A = '00000000-0000-4000-8000-000000001247'
const REC_A = '00000000-0000-4000-8000-000000001248'
const REC_B = '00000000-0000-4000-8000-000000001249'
const DECISION_A = '00000000-0000-4000-8000-000000001250'
const CLAIM_A = 'metric_claim:00000000-0000-4000-8000-000000001251'
const CAMPAIGN_A = fixtureUuid(1252)
const CAMPAIGN_B = fixtureUuid(1253)
const ADSET_A = fixtureUuid(1254)
const ADSET_B = fixtureUuid(1255)
let db: PGlite

// A complete, flag-anchored diagnostic snapshot: the shipped schema refuses anything less.
const claimSnapshot = {
  claimId: CLAIM_A,
  metricKey: 'meta_delivery.cpa',
  label: 'CPA',
  value: 72,
  unit: 'money',
  formula: null,
  definitionVersion: 1,
  source: {
    system: 'meta', role: 'delivery_truth', head: `flag-generation:${FLAG_GENERATION_A}`,
    evidencePlane: 'meta_delivery',
  },
  entity: { level: 'adset', id: ADSET_A },
  attributionScope: 'meta_platform_modelled',
  window: { start: '2026-08-15', end: '2026-08-21', basis: 'closed_account_days', timezone: 'America/New_York' },
  comparison: { method: 'none', window: null },
  asOf: '2026-08-21T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'not_applicable', numerator: null, denominator: null },
  maturity: { state: 'not_applicable', matureThrough: null },
  freshness: { state: 'fresh', observedAt: '2026-08-21T10:00:00.000Z', maxAgeHours: 26 },
  setupFingerprint: null,
  authority: { state: 'diagnostic', policyVersion: 'recommendation_metric_claim_v1' },
  measurementKind: 'measured',
  inputClaimIds: [],
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT_A)
  await insertAdAccount(db, ACCOUNT_B)
  await insertCampaign(db, CAMPAIGN_A, ACCOUNT_A)
  await insertCampaign(db, CAMPAIGN_B, ACCOUNT_B)
  await insertAdset(db, ADSET_A, ACCOUNT_A, CAMPAIGN_A)
  await insertAdset(db, ADSET_B, ACCOUNT_B, CAMPAIGN_B)
  await db.exec(`
    INSERT INTO public.decision_generations(id,ad_account_id,kind,reference_date,parent_generation_id)
      VALUES ('${FLAG_GENERATION_A}','${ACCOUNT_A}','flag','2026-08-21',NULL),
             ('${FLAG_GENERATION_B}','${ACCOUNT_B}','flag','2026-08-21',NULL),
             ('${REC_GENERATION_A}','${ACCOUNT_A}','recommendation','2026-08-21','${FLAG_GENERATION_A}');
    INSERT INTO public.flags(
      id,ad_account_id,generation_id,flag_date,entity_level,campaign_id,adset_id,flag_type,reason,evidence)
      VALUES ('${FLAG_A}','${ACCOUNT_A}','${FLAG_GENERATION_A}','2026-08-21','adset','${CAMPAIGN_A}',
                '${ADSET_A}','loser','fixture','{"cpa":72}'),
             ('${FLAG_B}','${ACCOUNT_B}','${FLAG_GENERATION_B}','2026-08-21','adset','${CAMPAIGN_B}',
                '${ADSET_B}','loser','fixture','{"cpa":72}');
    INSERT INTO public.recommendations(
      id,ad_account_id,generation_id,source_flag_id,target_entity_type,target_entity_id,
      recommendation_type,observed_fact,metric_claim_ids)
      VALUES ('${REC_A}','${ACCOUNT_A}','${REC_GENERATION_A}','${FLAG_A}','adset','adset-a','pause',
                'Observed.',ARRAY['${CLAIM_A}']),
             ('${REC_B}','${ACCOUNT_B}','${REC_GENERATION_A}','${FLAG_B}','adset','adset-b','pause',
                'Observed.',ARRAY['${CLAIM_A}']);
  `)
  await db.query(
    `INSERT INTO public.recommendation_metric_claim_snapshots(
      claim_id,ad_account_id,source_flag_id,source_flag_generation_id,source_metric_key,snapshot
    ) VALUES ($1,$2,$3,$4,'cpa',$5::jsonb)`,
    [CLAIM_A, ACCOUNT_A, FLAG_A, FLAG_GENERATION_A, JSON.stringify(claimSnapshot)],
  )
  await insertActionDecision(db, ACCOUNT_A, {
    id: DECISION_A,
    source_kind: 'recommendation',
    source_id: REC_A,
    authority_tier: 'owner_review',
    direction_ceiling: 'owner_review',
  })
})

describe('recommendation MetricClaim lineage hardening', () => {
  async function bindValidClaim() {
    await db.query(
      `INSERT INTO public.recommendation_metric_claim_bindings(
        recommendation_id,claim_id,ad_account_id,source_flag_id,source_flag_generation_id
      ) VALUES ($1,$2,$3,$4,$5)`,
      [REC_A, CLAIM_A, ACCOUNT_A, FLAG_A, FLAG_GENERATION_A],
    )
  }

  it('atomically records a protected owner transition only after an exact immutable binding exists', async () => {
    await bindValidClaim()
    const result = await db.query<{ user_decision: string; action_taken: boolean }>(
      `SELECT * FROM public.commit_recommendation_owner_transition(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )`,
      [ACCOUNT_A, REC_A, 'adset-a', 'pause', 'accepted', 'reviewed', 'owner@example.com', false, null, null],
    )
    expect(result.rows[0]).toMatchObject({ user_decision: 'accepted', action_taken: false })
    const persisted = await db.query<{ recommendation_id: string }>('SELECT recommendation_id FROM public.recommendation_decisions')
    expect(persisted.rows).toEqual([{ recommendation_id: REC_A }])
  })

  it('denies missing, forged, and cross-account MetricClaim references without persisting a partial transition', async () => {
    await expect(db.query(
      `SELECT * FROM public.commit_recommendation_owner_transition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ACCOUNT_A, REC_A, 'adset-a', 'pause', 'accepted', null, 'owner@example.com', false, null, null],
    )).rejects.toThrow(/MetricClaim lineage/i)

    await expect(db.query(
      `INSERT INTO public.recommendation_metric_claim_bindings(
        recommendation_id,claim_id,ad_account_id,source_flag_id,source_flag_generation_id
      ) VALUES ($1,$2,$3,$4,$5)`,
      [REC_A, CLAIM_A, ACCOUNT_A, FLAG_B, FLAG_GENERATION_B],
    )).rejects.toThrow(/source flag|cross-account|generation/i)

    await expect(db.query(
      `SELECT * FROM public.commit_recommendation_owner_transition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ACCOUNT_B, REC_A, 'adset-a', 'pause', 'accepted', null, 'owner@example.com', false, null, null],
    )).rejects.toThrow(/missing or cross-account/i)

    const decisionCount = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM public.recommendation_decisions')
    expect(decisionCount.rows[0]?.count).toBe(0)
  })

  it('rejects implementation without a governed ActionDecision and preserves the existing record', async () => {
    await bindValidClaim()
    await db.query('DELETE FROM public.action_decisions WHERE id=$1', [DECISION_A])
    await expect(db.query(
      `SELECT * FROM public.commit_recommendation_owner_transition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ACCOUNT_A, REC_A, 'adset-a', 'pause', 'acted_on', null, 'owner@example.com', true, null, null],
    )).rejects.toThrow(/ActionDecision/i)
    const decisionCount = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM public.recommendation_decisions')
    expect(decisionCount.rows[0]?.count).toBe(0)
  })
})
