import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { recommendationRow } from './decision-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000122'
const FLAG_GENERATION = '00000000-0000-4000-8000-000000000123'
const REC_GENERATION = '00000000-0000-4000-8000-000000000124'
const REC = '00000000-0000-4000-8000-000000000125'
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})

describe('governed MetricClaim lineage', () => {
  it('publishes claim IDs through the typed recommendation whitelist and keeps them immutable', async () => {
    await db.query(
      `INSERT INTO public.decision_generations(id,ad_account_id,kind,reference_date,is_current)
       VALUES ($1,$2,'flag','2026-08-21',true)`,
      [FLAG_GENERATION, ACCOUNT],
    )

    await db.query(
      `SELECT public.replace_recommendation_generation($1,$2,NULL,$3,'2026-08-21',$4::jsonb)`,
      [ACCOUNT, REC_GENERATION, FLAG_GENERATION, JSON.stringify([recommendationRow({
        id: REC,
        recommendation_type: 'investigate',
        target_entity_type: 'account',
        target_entity_id: null,
        observed_fact: 'Delivery state requires review.',
        metric_claim_ids: ['claim:delivery-state'],
      })])],
    )

    const persisted = await db.query<{ metric_claim_ids: string[] }>(
      'SELECT metric_claim_ids FROM public.recommendations WHERE id=$1', [REC],
    )
    expect(persisted.rows[0].metric_claim_ids).toEqual(['claim:delivery-state'])
    await expect(db.query(
      `UPDATE public.recommendations SET metric_claim_ids=ARRAY['claim:rewritten'] WHERE id=$1`, [REC],
    )).rejects.toThrow(/metric_claim_ids are immutable/i)
  })

  it('rejects blank, untrimmed, or duplicated MetricClaim IDs at the durable boundary', async () => {
    await expect(db.query(
      `INSERT INTO public.recommendations(id,ad_account_id,recommendation_type,target_entity_type,observed_fact,metric_claim_ids)
       VALUES ($1,$2,'investigate','account','Observed.',ARRAY[''])`,
      ['00000000-0000-4000-8000-000000000126', ACCOUNT],
    )).rejects.toThrow(/metric_claim_ids must be nonblank/i)
    await expect(db.query(
      `INSERT INTO public.recommendations(id,ad_account_id,recommendation_type,target_entity_type,observed_fact,metric_claim_ids)
       VALUES ($1,$2,'investigate','account','Observed.',ARRAY[' claim:one'])`,
      ['00000000-0000-4000-8000-000000000128', ACCOUNT],
    )).rejects.toThrow(/metric_claim_ids must be nonblank/i)
    await expect(db.query(
      `INSERT INTO public.recommendations(id,ad_account_id,recommendation_type,target_entity_type,observed_fact,metric_claim_ids)
       VALUES ($1,$2,'investigate','account','Observed.',ARRAY['claim:one','claim:one'])`,
      ['00000000-0000-4000-8000-000000000127', ACCOUNT],
    )).rejects.toThrow(/metric_claim_ids must be unique/i)
  })
})
