import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { insertAdset, insertCampaign } from './decision-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000721'
const BASELINE_AD = '00000000-0000-4000-8000-000000000722'
const SYNC_AD = '00000000-0000-4000-8000-000000000723'
const COLLISION_AD = '00000000-0000-4000-8000-000000000724'
const CAMPAIGN = fixtureUuid(726)
const ADSET = fixtureUuid(727)
const BASELINE_META_AD = '1000000000000014'

let db: PGlite

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_072')
  await insertCampaign(db, CAMPAIGN, ACCOUNT)
  await insertAdset(db, ADSET, ACCOUNT, CAMPAIGN)
  // One synced ad, so the ledger holds a row for the append-only guards to act on.
  await db.query(`INSERT INTO public.ads(
      campaign_id,adset_id,id,ad_account_id,ad_id,meta_creative_id,meta_updated_time,last_synced_at
    ) VALUES ('${CAMPAIGN}','${ADSET}',$1,$2,'${BASELINE_META_AD}','1000000000000032',
      '2026-07-31T12:00:00Z','2026-07-31T12:01:00Z')`, [BASELINE_AD, ACCOUNT])
})

afterEach(async () => {
  await db.close()
})

describe('creative-assignment schema', () => {
  it('creates only the source-identity columns and all three ledger triggers', async () => {
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='ad_creative_assignment_observations'
      ORDER BY ordinal_position
    `)
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      'id',
      'ad_account_id',
      'meta_ad_id',
      'meta_creative_id',
      'observed_at',
      'meta_updated_time',
      'source_kind',
      'observation_fingerprint',
      'created_at',
    ])
    expect(columns.rows.map(({ column_name }) => column_name).some(
      (name) => /customer|url|utm/i.test(name),
    )).toBe(false)

    const triggers = await db.query<{ tgname: string }>(`
      SELECT tgname FROM pg_catalog.pg_trigger
      WHERE tgrelid IN (
        'public.ads'::pg_catalog.regclass,
        'public.ad_creative_assignment_observations'::pg_catalog.regclass
      ) AND NOT tgisinternal
      ORDER BY tgname
    `)
    const triggerNames = triggers.rows.map(({ tgname }) => tgname)
    expect(triggerNames).toEqual(expect.arrayContaining([
      'ad_creative_assignment_capture_trg',
      'ad_creative_assignment_append_only_trg',
      'ad_creative_assignment_no_truncate_trg',
    ]))

    const guard = await one<{ trigger_type: number; correct_function: boolean }>(`
      SELECT
        tgtype::int trigger_type,
        tgfoid = 'public.ad_creative_assignment_append_only_guard()'::pg_catalog.regprocedure
          correct_function
      FROM pg_catalog.pg_trigger
      WHERE tgname='ad_creative_assignment_append_only_trg'
        AND tgrelid='public.ad_creative_assignment_observations'::pg_catalog.regclass
        AND NOT tgisinternal
    `)
    expect(guard).toEqual({ trigger_type: 31, correct_function: true })
  })
})

describe('creative-assignment capture', () => {
  it('captures inserts only with sync time and preserves observed null identity', async () => {
    await db.query(`INSERT INTO public.ads(
      campaign_id,adset_id,id,ad_account_id,ad_id,meta_creative_id,meta_updated_time,last_synced_at
    ) VALUES ('${CAMPAIGN}','${ADSET}',$1,$2,'1000000000000015',NULL,'2026-08-01T10:00:00Z',NULL)`,
    [SYNC_AD, ACCOUNT])
    expect((await one<{ n: number }>(`
      SELECT count(*)::int n FROM public.ad_creative_assignment_observations
    `)).n).toBe(1)

    await db.query(`UPDATE public.ads SET meta_updated_time='2026-08-01T10:07:00Z' WHERE id=$1`, [SYNC_AD])
    expect((await one<{ n: number }>(`
      SELECT count(*)::int n FROM public.ad_creative_assignment_observations
    `)).n).toBe(1)

    await db.query(`UPDATE public.ads SET last_synced_at='2026-08-01T10:08:00Z' WHERE id=$1`, [SYNC_AD])
    expect(await one(`
      SELECT meta_ad_id,meta_creative_id,observed_at,meta_updated_time,source_kind
      FROM public.ad_creative_assignment_observations
      WHERE meta_ad_id='1000000000000015'
    `)).toMatchObject({
      meta_ad_id: '1000000000000015',
      meta_creative_id: null,
      observed_at: new Date('2026-08-01T10:08:00Z'),
      meta_updated_time: new Date('2026-08-01T10:07:00Z'),
      source_kind: 'meta_sync',
    })

    await db.query(`INSERT INTO public.ads(
      campaign_id,adset_id,id,ad_account_id,ad_id,meta_creative_id,meta_updated_time,last_synced_at
    ) VALUES ('${CAMPAIGN}','${ADSET}',
      '00000000-0000-4000-8000-000000000725',$1,'1000000000000016',
      '1000000000000033','2026-08-01T11:00:00Z','2026-08-01T11:01:00Z'
    )`, [ACCOUNT])
    expect((await one<{ n: number }>(`
      SELECT count(*)::int n FROM public.ad_creative_assignment_observations
      WHERE source_kind='meta_sync' AND meta_ad_id <> '${BASELINE_META_AD}'
    `)).n).toBe(2)
  })

  it('captures updates only when last_synced_at changes', async () => {
    await db.query(`INSERT INTO public.ads(
      campaign_id,adset_id,id,ad_account_id,ad_id,meta_creative_id,meta_updated_time,last_synced_at
    ) VALUES ('${CAMPAIGN}','${ADSET}',$1,$2,'1000000000000017','1000000000000034',NULL,'2026-08-01T12:00:00Z')`,
    [SYNC_AD, ACCOUNT])
    await db.query(`UPDATE public.ads SET meta_creative_id='1000000000000035' WHERE id=$1`, [SYNC_AD])
    await db.query(`UPDATE public.ads SET last_synced_at=last_synced_at WHERE id=$1`, [SYNC_AD])
    expect((await one<{ n: number }>(`
      SELECT count(*)::int n FROM public.ad_creative_assignment_observations
      WHERE meta_ad_id='1000000000000017'
    `)).n).toBe(1)

    await db.query(`UPDATE public.ads
      SET last_synced_at='2026-08-01T12:01:00Z',meta_updated_time='2026-08-01T11:59:00Z'
      WHERE id=$1`, [SYNC_AD])
    expect((await one<{ n: number }>(`
      SELECT count(*)::int n FROM public.ad_creative_assignment_observations
      WHERE meta_ad_id='1000000000000017'
    `)).n).toBe(2)
  })

  it('replays identical evidence idempotently and rejects changed evidence at the same key', async () => {
    await db.query(`INSERT INTO public.ads(
      campaign_id,adset_id,id,ad_account_id,ad_id,meta_creative_id,meta_updated_time,last_synced_at
    ) VALUES ('${CAMPAIGN}','${ADSET}',$1,$2,'1000000000000018','1000000000000035',
      '2026-08-01T13:00:00Z','2026-08-01T13:01:00Z')`, [COLLISION_AD, ACCOUNT])
    await db.query(`UPDATE public.ads SET last_synced_at='2026-08-01T13:02:00Z' WHERE id=$1`, [COLLISION_AD])
    await db.query(`UPDATE public.ads SET last_synced_at='2026-08-01T13:03:00Z' WHERE id=$1`, [COLLISION_AD])
    await db.query(`UPDATE public.ads SET last_synced_at='2026-08-01T13:02:00Z' WHERE id=$1`, [COLLISION_AD])
    expect((await one<{ n: number }>(`
      SELECT count(*)::int n FROM public.ad_creative_assignment_observations
      WHERE meta_ad_id='1000000000000018'
    `)).n).toBe(3)

    await db.query(`UPDATE public.ads SET last_synced_at='2026-08-01T13:03:00Z' WHERE id=$1`, [COLLISION_AD])
    await expect(db.query(`UPDATE public.ads SET
      meta_creative_id='1000000000000036',last_synced_at='2026-08-01T13:02:00Z'
      WHERE id=$1`, [COLLISION_AD])).rejects.toThrow(/creative assignment collision/i)
    expect((await one<{ creative: string; synced: Date }>(`
      SELECT meta_creative_id creative,last_synced_at synced FROM public.ads WHERE id=$1
    `, [COLLISION_AD]))).toEqual({
      creative: '1000000000000035',
      synced: new Date('2026-08-01T13:03:00Z'),
    })
  })
})

describe('creative-assignment integrity and access', () => {
  it('rejects a valid direct insert while nested ads-trigger capture remains available', async () => {
    await expect(db.query(`INSERT INTO public.ad_creative_assignment_observations(
      ad_account_id,meta_ad_id,meta_creative_id,observed_at,meta_updated_time,
      source_kind,observation_fingerprint
    ) VALUES (
      $1,'1000000000000021','1000000000000039','2026-08-02T00:00:00Z',NULL,
      'meta_sync','${'0'.repeat(32)}'
    )`, [ACCOUNT])).rejects.toThrow(/direct creative assignment inserts are forbidden/i)

    await db.query(`INSERT INTO public.ads(
      campaign_id,adset_id,id,ad_account_id,ad_id,meta_creative_id,meta_updated_time,last_synced_at
    ) VALUES ('${CAMPAIGN}','${ADSET}',
      $1,$2,'1000000000000021','1000000000000039',
      '2026-08-02T00:00:00Z','2026-08-02T00:01:00Z'
    )`, [SYNC_AD, ACCOUNT])
    expect((await one<{ n: number }>(`
      SELECT count(*)::int n FROM public.ad_creative_assignment_observations
      WHERE meta_ad_id='1000000000000021'
    `)).n).toBe(1)
  })

  it.each([
    ['invalid ad id', 'not-numeric', null, '2026-08-02T00:00:00Z', null, 'meta_sync', 'a'.repeat(32)],
    ['invalid creative id', '1000000000000022', '9'.repeat(33), '2026-08-02T00:01:00Z', null, 'meta_sync', 'b'.repeat(32)],
    ['invalid observed time', '1000000000000023', null, 'infinity', null, 'meta_sync', 'c'.repeat(32)],
    ['invalid mutation time', '1000000000000024', null, '2026-08-02T00:03:00Z', '-infinity', 'meta_sync', 'd'.repeat(32)],
    ['invalid source', '1000000000000025', null, '2026-08-02T00:04:00Z', null, 'manual', 'e'.repeat(32)],
    ['invalid fingerprint', '1000000000000026', null, '2026-08-02T00:05:00Z', null, 'meta_sync', 'ABC'],
  ])('rejects %s', async (_name, adId, creativeId, observedAt, updatedAt, source, fingerprint) => {
    await db.exec(`ALTER TABLE public.ad_creative_assignment_observations
      DISABLE TRIGGER ad_creative_assignment_append_only_trg`)
    try {
      await expect(db.query(`INSERT INTO public.ad_creative_assignment_observations(
        ad_account_id,meta_ad_id,meta_creative_id,observed_at,meta_updated_time,
        source_kind,observation_fingerprint
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        ACCOUNT, adId, creativeId, observedAt, updatedAt, source, fingerprint,
      ])).rejects.toThrow(/constraint/i)
    } finally {
      await db.exec(`ALTER TABLE public.ad_creative_assignment_observations
        ENABLE TRIGGER ad_creative_assignment_append_only_trg`)
    }
  })

  it('rejects update, delete, and truncate', async () => {
    await expect(db.exec(`UPDATE public.ad_creative_assignment_observations
      SET meta_creative_id='1000000000000040'`)).rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec(`DELETE FROM public.ad_creative_assignment_observations`))
      .rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec(`TRUNCATE public.ad_creative_assignment_observations`))
      .rejects.toThrow(/append-only|truncate/i)
  })

  it('binds the invoker guard to the fixed-path capture and ledger owner', async () => {
    const boundary = await one<{
      capture_security_definer: boolean
      guard_security_invoker: boolean
      trusted_owners_match: boolean
      fixed_paths: number
      rls: boolean
      service_select: boolean
      service_insert: boolean
      anon_select: boolean
      authenticated_select: boolean
      app_execute: number
    }>(`
      WITH capture AS (
        SELECT * FROM pg_catalog.pg_proc
        WHERE oid='public.capture_ad_creative_assignment_observation()'::pg_catalog.regprocedure
      ), guard AS (
        SELECT * FROM pg_catalog.pg_proc
        WHERE oid='public.ad_creative_assignment_append_only_guard()'::pg_catalog.regprocedure
      ), ledger AS (
        SELECT * FROM pg_catalog.pg_class
        WHERE oid='public.ad_creative_assignment_observations'::pg_catalog.regclass
      ), functions AS (
        SELECT * FROM capture UNION ALL SELECT * FROM guard
      )
      SELECT
        (SELECT prosecdef FROM capture) capture_security_definer,
        (SELECT NOT prosecdef FROM guard) guard_security_invoker,
        (SELECT capture.proowner=guard.proowner AND capture.proowner=ledger.relowner
          FROM capture CROSS JOIN guard CROSS JOIN ledger) trusted_owners_match,
        (SELECT count(*)::int FROM functions
          WHERE (proconfig @> ARRAY['search_path=pg_catalog']::text[]
                 OR proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[])
            AND pg_catalog.array_to_string(proconfig, ',') NOT LIKE '%public%') fixed_paths,
        (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid='public.ad_creative_assignment_observations'::pg_catalog.regclass) rls,
        has_table_privilege('service_role','public.ad_creative_assignment_observations','SELECT') service_select,
        has_table_privilege('service_role','public.ad_creative_assignment_observations','INSERT') service_insert,
        has_table_privilege('anon','public.ad_creative_assignment_observations','SELECT') anon_select,
        has_table_privilege('authenticated','public.ad_creative_assignment_observations','SELECT') authenticated_select,
        (SELECT count(*)::int
          FROM (VALUES ('anon'),('authenticated'),('service_role')) roles(role_name)
          CROSS JOIN (VALUES
            ('public.capture_ad_creative_assignment_observation()'::pg_catalog.regprocedure),
            ('public.ad_creative_assignment_append_only_guard()'::pg_catalog.regprocedure)
          ) guarded_functions(fn)
          WHERE has_function_privilege(
            role_name,
            fn,
            'EXECUTE'
          )) app_execute
    `)
    expect(boundary).toEqual({
      capture_security_definer: true,
      guard_security_invoker: true,
      trusted_owners_match: true,
      fixed_paths: 2,
      rls: true,
      service_select: true,
      service_insert: false,
      anon_select: false,
      authenticated_select: false,
      app_execute: 0,
    })
  })
})
