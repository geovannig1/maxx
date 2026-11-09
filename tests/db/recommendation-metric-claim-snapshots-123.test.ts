import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertAdset, insertCampaign } from './decision-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000001231'
const FLAG = '00000000-0000-4000-8000-000000001232'
const FLAG_GENERATION = '00000000-0000-4000-8000-000000001233'
const CLAIM = 'metric_claim:00000000-0000-4000-8000-000000001234'
const TARGET = '00000000-0000-4000-8000-000000001235'
const CAMPAIGN = '00000000-0000-4000-8000-000000001238'
let db: PGlite

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    claimId: CLAIM,
    metricKey: 'meta_delivery.cpa',
    label: 'CPA',
    value: 72,
    unit: 'money',
    formula: null,
    definitionVersion: 1,
    source: {
      system: 'meta', role: 'delivery_truth', head: `flag-generation:${FLAG_GENERATION}`,
      evidencePlane: 'meta_delivery',
    },
    entity: { level: 'adset', id: TARGET },
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
    ...overrides,
  }
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertCampaign(db, CAMPAIGN, ACCOUNT)
  await insertAdset(db, TARGET, ACCOUNT, CAMPAIGN)
  await db.exec(`
    INSERT INTO public.decision_generations(id,ad_account_id,kind,reference_date)
      VALUES ('${FLAG_GENERATION}','${ACCOUNT}','flag','2026-08-21');
    INSERT INTO public.flags(
      id,ad_account_id,generation_id,flag_date,entity_level,campaign_id,adset_id,flag_type,reason,evidence)
      VALUES ('${FLAG}','${ACCOUNT}','${FLAG_GENERATION}','2026-08-21','adset','${CAMPAIGN}','${TARGET}',
        'loser','fixture','{"cpa":72}');
  `)
})

describe('recommendation MetricClaim snapshots', () => {
  it('accepts only a complete flag-backed diagnostic snapshot and keeps it append-only', async () => {
    await db.query(`
      INSERT INTO public.recommendation_metric_claim_snapshots(
        claim_id,ad_account_id,source_flag_id,source_flag_generation_id,source_metric_key,snapshot
      ) VALUES ($1,$2,$3,$4,'cpa',$5::jsonb)
    `, [CLAIM, ACCOUNT, FLAG, FLAG_GENERATION, JSON.stringify(snapshot())])

    const persisted = await db.query<{ claim_id: string; snapshot: { source: { head: string } } }>(
      'SELECT claim_id,snapshot FROM public.recommendation_metric_claim_snapshots WHERE claim_id=$1', [CLAIM],
    )
    expect(persisted.rows[0]).toMatchObject({ claim_id: CLAIM, snapshot: { source: { head: `flag-generation:${FLAG_GENERATION}` } } })
    await expect(db.query(
      `UPDATE public.recommendation_metric_claim_snapshots SET source_metric_key='spend' WHERE claim_id=$1`, [CLAIM],
    )).rejects.toThrow(/append-only|immutable/i)
    await expect(db.query(
      `DELETE FROM public.recommendation_metric_claim_snapshots WHERE claim_id=$1`, [CLAIM],
    )).rejects.toThrow(/append-only|immutable/i)
  })

  it('rejects a claim that omits authoritative scope metadata or does not equal its source flag evidence', async () => {
    const missingFreshness = snapshot()
    delete (missingFreshness as Record<string, unknown>).freshness
    await expect(db.query(`
      INSERT INTO public.recommendation_metric_claim_snapshots(
        claim_id,ad_account_id,source_flag_id,source_flag_generation_id,source_metric_key,snapshot
      ) VALUES ($1,$2,$3,$4,'cpa',$5::jsonb)
    `, ['metric_claim:00000000-0000-4000-8000-000000001236', ACCOUNT, FLAG, FLAG_GENERATION,
      JSON.stringify({ ...missingFreshness, claimId: 'metric_claim:00000000-0000-4000-8000-000000001236' })],
    )).rejects.toThrow(/complete MetricClaim snapshot/i)

    await expect(db.query(`
      INSERT INTO public.recommendation_metric_claim_snapshots(
        claim_id,ad_account_id,source_flag_id,source_flag_generation_id,source_metric_key,snapshot
      ) VALUES ($1,$2,$3,$4,'cpa',$5::jsonb)
    `, ['metric_claim:00000000-0000-4000-8000-000000001237', ACCOUNT, FLAG, FLAG_GENERATION,
      JSON.stringify(snapshot({ claimId: 'metric_claim:00000000-0000-4000-8000-000000001237', value: 73 }))],
    )).rejects.toThrow(/does not match source flag evidence/i)
  })
})
