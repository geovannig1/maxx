import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { getAdminClient } from '@/lib/supabase/admin'
import { getRecommendationsByGeneration, readOpenRecommendations } from '@/lib/recommendations/store'
import { purgePaidMeasurement } from './paid-measurement-purge'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const API = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000f5'
const CAMP = '00000000-0000-4000-8000-0000000000c5'
const ADSET = '00000000-0000-4000-8000-0000000000a5'
const AD = '00000000-0000-4000-8000-0000000000d5'
const CURRENT_GEN = '00000000-0000-4000-8000-000000000155'
const OLD_GEN = '00000000-0000-4000-8000-000000000154'
const CURRENT_REC = '00000000-0000-4000-8000-000000000255'
const OLD_REC = '00000000-0000-4000-8000-000000000254'
const FLAG_GEN = '00000000-0000-4000-8000-000000000355'
const SOURCE_FLAG = '00000000-0000-4000-8000-000000000455'
const CURRENT_CLAIM = 'metric_claim:current-read:current'
const OLD_CLAIM = 'metric_claim:current-read:old'

let client: pg.Client
let connected = false

async function cleanup() {
  // This isolated, loopback-only fixture owns append-only evidence rows. Disable constraints/triggers
  // inside its cleanup transaction rather than weakening production append-only guards.
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL session_replication_role = replica`)
    await client.query(`DELETE FROM action_decisions WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM recommendation_metric_claim_bindings WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM recommendations WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM recommendation_metric_claim_snapshots WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM flags WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM decision_generations WHERE ad_account_id=$1`, [ACCT])
    await purgePaidMeasurement(client, [ACCT])
    await client.query(`DELETE FROM ads WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM adsets WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM campaigns WHERE ad_account_id=$1`, [ACCT])
    await client.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

beforeAll(async () => {
  for (const url of [DB, API]) {
    if (!LOOPBACK.has(hostOf(url))) throw new Error(`refusing non-loopback recommendation-read test target: ${url}`)
  }
  client = new pg.Client({ connectionString: DB })
  await client.connect()
  connected = true
  await cleanup()
  await client.query(`INSERT INTO ad_accounts(id,account_id) VALUES($1,'act-current-read')`, [ACCT])
  await client.query(
    `INSERT INTO campaigns(id,ad_account_id,campaign_id,status,effective_status,last_synced_at)
     VALUES($1,$2,'meta-c-current','ACTIVE','ACTIVE',now()-interval '1 minute')`, [CAMP, ACCT])
  await client.query(`UPDATE campaigns SET meta_updated_time=now()-interval '30 days' WHERE id=$1`, [CAMP])
  await client.query(
    `INSERT INTO adsets(id,ad_account_id,campaign_id,adset_id,status,effective_status,last_synced_at)
     VALUES($1,$2,$3,'meta-as-current','ACTIVE','ACTIVE',now()-interval '1 minute')`, [ADSET, ACCT, CAMP])
  await client.query(`UPDATE adsets SET meta_updated_time=now()-interval '30 days' WHERE id=$1`, [ADSET])
  await client.query(
    `INSERT INTO ads(id,ad_account_id,campaign_id,adset_id,ad_id,status,effective_status,last_synced_at)
     VALUES($1,$2,$3,$4,'1000000000000013','ACTIVE','ACTIVE',now()-interval '1 minute')`, [AD, ACCT, CAMP, ADSET])
  // Entities are re-synced constantly but were last EDITED 30 days ago — the normal state of a live
  // account, and the condition under which the sync-timestamp guard wrongly quarantined everything.
  await client.query(`UPDATE ads SET meta_updated_time=now()-interval '30 days' WHERE id=$1`, [AD])
  await client.query(
    `INSERT INTO decision_generations(id,ad_account_id,kind,reference_date,row_count,is_current,committed_at)
     VALUES($1,$4,'flag',current_date,1,true,now()),
           ($2,$4,'recommendation',current_date-1,1,false,now()-interval '2 minutes'),
           ($3,$4,'recommendation',current_date,1,true,now())`, [FLAG_GEN, OLD_GEN, CURRENT_GEN, ACCT])
  await client.query(
    `UPDATE decision_generations
     SET parent_generation_id=$2
     WHERE id IN ($1,$3)`, [OLD_GEN, FLAG_GEN, CURRENT_GEN])
  await client.query(
    `INSERT INTO flags(
       id,ad_account_id,generation_id,flag_date,window_days,entity_level,ad_id,meta_ad_id,
       flag_type,confidence,audience_type,reason,evidence
     ) VALUES ($1,$2,$3,current_date,7,'ad',$4,'1000000000000013','watchlist','medium','unknown','Fixture evidence.','{"spend":12.5}'::jsonb)`,
    [SOURCE_FLAG, ACCT, FLAG_GEN, AD])
  await client.query(
    `INSERT INTO recommendations(
       id,ad_account_id,generation_id,recommendation_type,target_entity_type,target_entity_id,target_entity_name,
       observed_fact,metric_values,data_sources,reason_for_action,confidence_score,confidence_label,risk_level,
       gate_decision,gate_passed,approval_required,action_allowed_now,source_flag_id,metric_claim_ids,status,generated_at)
     VALUES
       ($1,$3,$4,'keep','ad',$5,'Current ad','Current observation','{}','{meta_api}',
        'Current diagnostic.',0.5,'medium','low','hold',false,false,false,$7,ARRAY[$8], 'open',now()),
       ($2,$3,$6,'keep','ad',$5,'Current ad','Old observation','{}','{meta_api}',
        'Old diagnostic.',0.5,'medium','low','hold',false,false,false,$7,ARRAY[$9], 'open',now()-interval '2 minutes')`,
    [CURRENT_REC, OLD_REC, ACCT, CURRENT_GEN, AD, OLD_GEN, SOURCE_FLAG, CURRENT_CLAIM, OLD_CLAIM])
  for (const claimId of [CURRENT_CLAIM, OLD_CLAIM]) {
    await client.query(
      `INSERT INTO recommendation_metric_claim_snapshots(
         claim_id,ad_account_id,source_flag_id,source_flag_generation_id,source_metric_key,snapshot
       ) VALUES (
         $1::text,$2::uuid,$3::uuid,$4::uuid,'spend',
         jsonb_build_object(
           'claimId',$1::text,'metricKey','meta_delivery.spend','label','Meta spend','value',12.5,'unit','money',
           'formula','Meta spend','definitionVersion','fixture-v1',
           'source',jsonb_build_object('system','meta','role','delivery_truth','head','flag-generation:' || $4::uuid::text,'evidencePlane','meta_delivery'),
           'entity',jsonb_build_object('level','ad','id',$5::uuid::text),'attributionScope','7d_click_1d_view',
           'window',jsonb_build_object('start','2026-08-01','end','2026-08-07','basis','closed_account_days','timezone','America/New_York'),
           'comparison',jsonb_build_object('method','none','window',null),'asOf',now()::text,
           'availability',jsonb_build_object('state','available','blockerCodes',jsonb_build_array()),
           'coverage',jsonb_build_object('state','complete','numerator',1,'denominator',1),
           'maturity',jsonb_build_object('state','mature','matureThrough','2026-08-07'),
           'freshness',jsonb_build_object('state','fresh','observedAt',now()::text,'maxAgeHours',1),
           'setupFingerprint','fixture','authority',jsonb_build_object('state','diagnostic','policyVersion','fixture-v1'),
           'measurementKind','measured','inputClaimIds',jsonb_build_array()
         )
       )`, [claimId, ACCT, SOURCE_FLAG, FLAG_GEN, AD])
  }
  await client.query(
    `INSERT INTO recommendation_metric_claim_bindings(
       recommendation_id,claim_id,ad_account_id,source_flag_id,source_flag_generation_id
     ) VALUES ($1,$3,$5,$7,$9), ($2,$4,$6,$8,$9)`,
    [CURRENT_REC, OLD_REC, CURRENT_CLAIM, OLD_CLAIM, ACCT, ACCT, SOURCE_FLAG, SOURCE_FLAG, FLAG_GEN])
}, 60000)

afterAll(async () => {
  if (connected) {
    await cleanup()
    await client.end()
    connected = false
  }
})

describe('current recommendation read over PostgREST', () => {
  it('shows only the current generation and preserves the old row in exact-generation history', async () => {
    const read = await readOpenRecommendations(ACCT, 20)
    expect(read.health).toBe('degraded')
    expect(read.recommendations.map((row) => row.id)).toEqual([CURRENT_REC])
    expect(read.quarantinedCount).toBe(1)
    expect(read.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'not_current_generation', affectedCount: 1 }),
    ]))

    const history = await getRecommendationsByGeneration(ACCT, OLD_GEN, 20)
    expect(history.map((row) => row.id)).toEqual([OLD_REC])
  })

  it('keeps the current row after a later entity SYNC that changed nothing', async () => {
    // Regression over the real PostgREST path: the daily sync re-stamps last_synced_at on every run.
    // Treating that as an edit voided the whole feed after any partial sync.
    await client.query(`UPDATE ads SET last_synced_at=now()+interval '1 minute' WHERE id=$1`, [AD])
    const read = await readOpenRecommendations(ACCT, 20)

    expect(read.recommendations.map((row) => row.id)).toEqual([CURRENT_REC])
    expect(read.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'predates_entity_sync' }),
    ]))
  })

  it('quarantines the current row after a later entity CHANGE', async () => {
    await client.query(`UPDATE ads SET meta_updated_time=now()+interval '1 minute' WHERE id=$1`, [AD])
    const read = await readOpenRecommendations(ACCT, 20)

    expect(read.recommendations).toEqual([])
    expect(read.quarantinedCount).toBe(2)
    expect(read.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'predates_entity_sync', affectedCount: 1 }),
    ]))
  })

  it('uses the same loopback service-role path as production reads', async () => {
    const { data, error } = await getAdminClient()
      .from('decision_generations')
      .select('id')
      .eq('ad_account_id', ACCT)
      .eq('kind', 'recommendation')
      .eq('is_current', true)
    expect(error).toBeNull()
    expect(data).toEqual([{ id: CURRENT_GEN }])
  })
})
