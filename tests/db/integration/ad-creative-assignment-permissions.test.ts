import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { purgePaidMeasurement } from './paid-measurement-purge'

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return '' } }

const ACCOUNT = '00000000-0000-4000-8000-000000000727'
const CAMPAIGN = '00000000-0000-4000-8000-000000000728'
const ADSET = '00000000-0000-4000-8000-000000000729'
const AD = '00000000-0000-4000-8000-00000000072a'
const META_AD_ID = '1000000000000019'
const CREATIVE_A = '1000000000000037'
const CREATIVE_B = '1000000000000038'
const SYNC_1 = '2026-08-01T10:00:00.000Z'
const SYNC_2 = '2026-08-01T11:00:00.000Z'
const SYNC_3 = '2026-08-01T12:00:00.000Z'
const APP_ROLES = ['service_role', 'authenticated', 'anon'] as const
const BROWSER_ROLES = ['authenticated', 'anon'] as const
const LEDGER = 'public.ad_creative_assignment_observations'

type AppRole = typeof APP_ROLES[number]
type QueryResult<T> = pg.QueryResult<T & pg.QueryResultRow>

let db: pg.Client

function assertLoopbackDatabase(url: string): void {
  const host = hostOf(url)
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `refusing non-loopback creative-assignment permission host: ${host || 'invalid'}`,
    )
  }
}

async function queryAsRole<T>(
  role: AppRole,
  sql: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  await db.query('BEGIN')
  try {
    await db.query(`SET LOCAL ROLE ${role}`)
    const result = await db.query<T & pg.QueryResultRow>(sql, [...params])
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}

async function expectRejectedAtSavepoint(
  statement: string,
  expectedDenial: RegExp,
  params: readonly unknown[] = [],
): Promise<void> {
  await db.query('SAVEPOINT expected_denial')
  try {
    await expect(db.query(statement, [...params])).rejects.toThrow(expectedDenial)
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT expected_denial')
    await db.query('RELEASE SAVEPOINT expected_denial')
  }
}

async function ledgerState(): Promise<Array<{
  id: string
  meta_creative_id: string | null
  observation_fingerprint: string
}>> {
  const { rows } = await db.query(`
    SELECT id,meta_creative_id,observation_fingerprint
    FROM ${LEDGER}
    WHERE ad_account_id=$1 AND meta_ad_id=$2
    ORDER BY observed_at,id
  `, [ACCOUNT, META_AD_ID])
  return rows
}

async function cleanup(): Promise<void> {
  await purgePaidMeasurement(db, [ACCOUNT])
  await db.query(`DELETE FROM public.ads WHERE ad_account_id=$1`, [ACCOUNT])
  await db.query(`DELETE FROM public.adsets WHERE ad_account_id=$1`, [ACCOUNT])
  await db.query(`DELETE FROM public.campaigns WHERE ad_account_id=$1`, [ACCOUNT])
  await db.query(`DELETE FROM public.ad_accounts WHERE id=$1`, [ACCOUNT])
}

async function seedAd(lastSyncedAt = SYNC_1): Promise<void> {
  await db.query(`
    INSERT INTO public.ads(
      id,ad_account_id,campaign_id,adset_id,ad_id,meta_creative_id,
      meta_updated_time,last_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [AD, ACCOUNT, CAMPAIGN, ADSET, META_AD_ID, CREATIVE_A, SYNC_1, lastSyncedAt])
}

beforeAll(async () => {
  assertLoopbackDatabase(DB)
  db = new pg.Client({ connectionString: DB })
  await db.connect()
  await cleanup()
  await db.query(`INSERT INTO public.ad_accounts(id,account_id) VALUES($1,'act_assignment_0727')`,
    [ACCOUNT])
  await db.query(`INSERT INTO public.campaigns(id,ad_account_id,campaign_id) VALUES($1,$2,$3)`,
    [CAMPAIGN, ACCOUNT, '1000000000000030'])
  await db.query(`
    INSERT INTO public.adsets(id,ad_account_id,campaign_id,adset_id)
    VALUES($1,$2,$3,$4)
  `, [ADSET, ACCOUNT, CAMPAIGN, '1000000000000031'])

  // Older integration suites grant every public table to service_role. Reassert the baseline's
  // production contract so file order cannot weaken this suite's permission proof.
  await db.query(`
    REVOKE ALL ON TABLE public.ad_creative_assignment_observations
      FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT ON TABLE public.ad_creative_assignment_observations TO service_role;
    REVOKE ALL ON FUNCTION public.capture_ad_creative_assignment_observation()
      FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public.ad_creative_assignment_append_only_guard()
      FROM PUBLIC, anon, authenticated, service_role
  `)
}, 60_000)

beforeEach(async () => {
  await purgePaidMeasurement(db, [ACCOUNT])
  await db.query(`DELETE FROM public.ads WHERE ad_account_id=$1`, [ACCOUNT])
})

afterAll(async () => {
  if (!db) return
  try {
    await cleanup()
  } finally {
    await db.end()
  }
})

describe('creative-assignment capture through real PostgreSQL roles', () => {
  it('creates exactly one service-readable observation per timestamp-advancing ad write', async () => {
    await seedAd()

    const inserted = await queryAsRole<{
      meta_creative_id: string
      observed_at: Date
      source_kind: string
    }>('service_role', `
      SELECT meta_creative_id,observed_at,source_kind
      FROM public.ad_creative_assignment_observations
      WHERE ad_account_id=$1 AND meta_ad_id=$2
      ORDER BY observed_at
    `, [ACCOUNT, META_AD_ID])
    expect(inserted.rows).toEqual([{
      meta_creative_id: CREATIVE_A,
      observed_at: new Date(SYNC_1),
      source_kind: 'meta_sync',
    }])

    await db.query(`
      UPDATE public.ads
      SET meta_creative_id=$2,meta_updated_time=$3,last_synced_at=$3
      WHERE id=$1
    `, [AD, CREATIVE_B, SYNC_2])
    const advanced = await queryAsRole<{
      meta_creative_id: string
      observed_at: Date
    }>('service_role', `
      SELECT meta_creative_id,observed_at
      FROM public.ad_creative_assignment_observations
      WHERE ad_account_id=$1 AND meta_ad_id=$2
      ORDER BY observed_at
    `, [ACCOUNT, META_AD_ID])
    expect(advanced.rows).toEqual([
      { meta_creative_id: CREATIVE_A, observed_at: new Date(SYNC_1) },
      { meta_creative_id: CREATIVE_B, observed_at: new Date(SYNC_2) },
    ])
  })

  it('does not capture an ad update whose last_synced_at is unchanged', async () => {
    await seedAd()
    await db.query(`UPDATE public.ads SET ad_name='metadata-only edit' WHERE id=$1`, [AD])
    const { rows } = await db.query<{ count: number }>(`
      SELECT count(*)::int count
      FROM public.ad_creative_assignment_observations
      WHERE ad_account_id=$1 AND meta_ad_id=$2
    `, [ACCOUNT, META_AD_ID])
    expect(rows[0].count).toBe(1)
  })

  it('aborts the source ad update when same-time evidence has a different fingerprint', async () => {
    await seedAd()
    await db.query(`UPDATE public.ads SET last_synced_at=$2 WHERE id=$1`, [AD, SYNC_2])
    await db.query(`UPDATE public.ads SET last_synced_at=$2 WHERE id=$1`, [AD, SYNC_3])

    await expect(db.query(`
      UPDATE public.ads SET meta_creative_id=$2,last_synced_at=$3 WHERE id=$1
    `, [AD, CREATIVE_B, SYNC_2])).rejects.toThrow(/creative assignment collision/i)

    const source = await db.query<{ meta_creative_id: string; last_synced_at: Date }>(`
      SELECT meta_creative_id,last_synced_at FROM public.ads WHERE id=$1
    `, [AD])
    expect(source.rows[0]).toEqual({
      meta_creative_id: CREATIVE_A,
      last_synced_at: new Date(SYNC_3),
    })
    const observations = await db.query<{ count: number }>(`
      SELECT count(*)::int count
      FROM public.ad_creative_assignment_observations
      WHERE ad_account_id=$1 AND meta_ad_id=$2
    `, [ACCOUNT, META_AD_ID])
    expect(observations.rows[0].count).toBe(3)
  })
})

describe('creative-assignment effective application permissions', () => {
  it('binds the invoker guard to the capture and ledger owner', async () => {
    const boundary = await db.query<{
      capture_security_definer: boolean
      guard_security_invoker: boolean
      trusted_owners_match: boolean
      fixed_paths: boolean
    }>(`
      SELECT
        capture.prosecdef capture_security_definer,
        NOT guard.prosecdef guard_security_invoker,
        capture.proowner=guard.proowner AND capture.proowner=ledger.relowner
          trusted_owners_match,
        capture.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
          AND guard.proconfig @> ARRAY['search_path=pg_catalog']::text[]
          AND pg_catalog.array_to_string(capture.proconfig, ',') NOT LIKE '%public%'
          AND pg_catalog.array_to_string(guard.proconfig, ',') NOT LIKE '%public%'
          fixed_paths
      FROM pg_catalog.pg_proc capture
      CROSS JOIN pg_catalog.pg_proc guard
      CROSS JOIN pg_catalog.pg_class ledger
      WHERE capture.oid=
          'public.capture_ad_creative_assignment_observation()'::pg_catalog.regprocedure
        AND guard.oid=
          'public.ad_creative_assignment_append_only_guard()'::pg_catalog.regprocedure
        AND ledger.oid=
          'public.ad_creative_assignment_observations'::pg_catalog.regclass
    `)
    expect(boundary.rows).toEqual([{
      capture_security_definer: true,
      guard_security_invoker: true,
      trusted_owners_match: true,
      fixed_paths: true,
    }])
  })

  it('reports only the parsed host when refusing a credential-bearing non-loopback URL', () => {
    const unsafe = 'postgresql://integration-user:do-not-log-me@db.example.test:5432/postgres'
    expect(() => assertLoopbackDatabase(unsafe)).toThrow(
      'refusing non-loopback creative-assignment permission host: db.example.test',
    )
    try {
      assertLoopbackDatabase(unsafe)
    } catch (error) {
      expect(String(error)).not.toContain('integration-user')
      expect(String(error)).not.toContain('do-not-log-me')
      expect(String(error)).not.toContain(unsafe)
    }
  })

  it('keeps service_role read-only and denies every direct mutation', async () => {
    await seedAd()
    const privileges = await db.query<{
      can_select: boolean
      can_insert: boolean
      can_update: boolean
      can_delete: boolean
      can_truncate: boolean
    }>(`
      SELECT
        has_table_privilege('service_role',$1,'SELECT') can_select,
        has_table_privilege('service_role',$1,'INSERT') can_insert,
        has_table_privilege('service_role',$1,'UPDATE') can_update,
        has_table_privilege('service_role',$1,'DELETE') can_delete,
        has_table_privilege('service_role',$1,'TRUNCATE') can_truncate
    `, ['public.ad_creative_assignment_observations'])
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    })

    await expect(queryAsRole('service_role', `
      INSERT INTO public.ad_creative_assignment_observations(
        ad_account_id,meta_ad_id,observed_at,source_kind,observation_fingerprint
      ) VALUES ($1,'1000000000000027',$2,'meta_sync',$3)
    `, [ACCOUNT, SYNC_2, 'a'.repeat(32)])).rejects.toThrow(/permission denied/i)
    await expect(queryAsRole('service_role', `
      UPDATE public.ad_creative_assignment_observations SET meta_creative_id=$1
      WHERE ad_account_id=$2
    `, [CREATIVE_B, ACCOUNT])).rejects.toThrow(/permission denied/i)
    await expect(queryAsRole('service_role', `
      DELETE FROM public.ad_creative_assignment_observations WHERE ad_account_id=$1
    `, [ACCOUNT])).rejects.toThrow(/permission denied/i)
    await expect(queryAsRole('service_role', `
      TRUNCATE public.ad_creative_assignment_observations
    `)).rejects.toThrow(/permission denied/i)
  })

  it.each(BROWSER_ROLES)('%s cannot select or mutate the ledger', async (role) => {
    await seedAd()
    await expect(queryAsRole(role, `
      SELECT id FROM public.ad_creative_assignment_observations LIMIT 1
    `)).rejects.toThrow(/permission denied/i)
    await expect(queryAsRole(role, `
      INSERT INTO public.ad_creative_assignment_observations(
        ad_account_id,meta_ad_id,observed_at,source_kind,observation_fingerprint
      ) VALUES ($1,'1000000000000028',$2,'meta_sync',$3)
    `, [ACCOUNT, SYNC_2, 'b'.repeat(32)])).rejects.toThrow(/permission denied/i)
    await expect(queryAsRole(role, `
      UPDATE public.ad_creative_assignment_observations SET meta_creative_id=$1
      WHERE ad_account_id=$2
    `, [CREATIVE_B, ACCOUNT])).rejects.toThrow(/permission denied/i)
    await expect(queryAsRole(role, `
      DELETE FROM public.ad_creative_assignment_observations WHERE ad_account_id=$1
    `, [ACCOUNT])).rejects.toThrow(/permission denied/i)
    await expect(queryAsRole(role, `
      TRUNCATE public.ad_creative_assignment_observations
    `)).rejects.toThrow(/permission denied/i)
  })

  it.each(APP_ROLES)('%s cannot bypass the ledger after a full table grant', async (role) => {
    await seedAd()
    const before = await ledgerState()
    await db.query('BEGIN')
    try {
      await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ${LEDGER} TO ${role}`)
      await db.query(`SET LOCAL ROLE ${role}`)

      const visible = await db.query(`
        SELECT id FROM ${LEDGER} WHERE ad_account_id=$1 AND meta_ad_id=$2
      `, [ACCOUNT, META_AD_ID])
      expect(visible.rows).toHaveLength(role === 'service_role' ? 1 : 0)

      await expectRejectedAtSavepoint(`
        INSERT INTO ${LEDGER}(
          ad_account_id,meta_ad_id,meta_creative_id,observed_at,meta_updated_time,
          source_kind,observation_fingerprint
        ) VALUES ($1,'1000000000000029',$2,$3,NULL,'meta_sync',$4)
      `, role === 'service_role'
        ? /direct creative assignment inserts are forbidden/i
        : /row-level security policy|direct creative assignment inserts are forbidden/i,
      [ACCOUNT, CREATIVE_B, SYNC_2, 'f'.repeat(32)])

      if (role === 'service_role') {
        await expectRejectedAtSavepoint(`
          UPDATE ${LEDGER} SET meta_creative_id=$1 WHERE ad_account_id=$2
        `, /immutable and append-only/i, [CREATIVE_B, ACCOUNT])
        await expectRejectedAtSavepoint(`
          DELETE FROM ${LEDGER} WHERE ad_account_id=$1
        `, /immutable and append-only/i, [ACCOUNT])
      } else {
        const update = await db.query(`
          UPDATE ${LEDGER} SET meta_creative_id=$1 WHERE ad_account_id=$2
        `, [CREATIVE_B, ACCOUNT])
        expect(update.rowCount).toBe(0)
        const deletion = await db.query(`DELETE FROM ${LEDGER} WHERE ad_account_id=$1`, [ACCOUNT])
        expect(deletion.rowCount).toBe(0)
      }

      await expectRejectedAtSavepoint(
        `TRUNCATE ${LEDGER}`,
        /append-only; truncate is forbidden/i,
      )
    } finally {
      await db.query('ROLLBACK').catch(() => undefined)
    }

    expect(await ledgerState()).toEqual(before)
    const privileges = await db.query<{
      can_select: boolean
      can_insert: boolean
      can_update: boolean
      can_delete: boolean
      can_truncate: boolean
    }>(`
      SELECT
        has_table_privilege($1,$2,'SELECT') can_select,
        has_table_privilege($1,$2,'INSERT') can_insert,
        has_table_privilege($1,$2,'UPDATE') can_update,
        has_table_privilege($1,$2,'DELETE') can_delete,
        has_table_privilege($1,$2,'TRUNCATE') can_truncate
    `, [role, LEDGER])
    expect(privileges.rows[0]).toEqual({
      can_select: role === 'service_role',
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    })
  })

  it('rejects an unexpected nested service-role insert at trigger depth two', async () => {
    const forgedAdId = '1000000000000020'
    await db.query('BEGIN')
    try {
      await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ${LEDGER} TO service_role`)
      await db.query(`CREATE TABLE public.assignment_forge_source_072(id integer PRIMARY KEY)`)
      await db.query(`
        CREATE FUNCTION public.assignment_forge_insert_072()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY INVOKER
        SET search_path = pg_catalog
        AS $forge$
        BEGIN
          INSERT INTO public.ad_creative_assignment_observations(
            ad_account_id,meta_ad_id,meta_creative_id,observed_at,meta_updated_time,
            source_kind,observation_fingerprint
          ) VALUES (
            '${ACCOUNT}','${forgedAdId}','${CREATIVE_B}','${SYNC_2}',NULL,
            'meta_sync','${'e'.repeat(32)}'
          );
          RETURN NEW;
        END;
        $forge$
      `)
      await db.query(`
        CREATE TRIGGER assignment_forge_insert_072_trg
        AFTER INSERT ON public.assignment_forge_source_072
        FOR EACH ROW EXECUTE FUNCTION public.assignment_forge_insert_072()
      `)
      await db.query(`GRANT INSERT ON public.assignment_forge_source_072 TO service_role`)
      await db.query('SET LOCAL ROLE service_role')

      await expectRejectedAtSavepoint(
        `INSERT INTO public.assignment_forge_source_072(id) VALUES (1)`,
        /direct creative assignment inserts are forbidden/i,
      )
      const forged = await db.query<{ count: number }>(`
        SELECT count(*)::int count FROM ${LEDGER} WHERE meta_ad_id=$1
      `, [forgedAdId])
      expect(forged.rows[0].count).toBe(0)
    } finally {
      await db.query('ROLLBACK').catch(() => undefined)
    }

    const residue = await db.query<{ source_table: string | null; forge_function: string | null }>(`
      SELECT
        pg_catalog.to_regclass('public.assignment_forge_source_072')::text source_table,
        pg_catalog.to_regprocedure('public.assignment_forge_insert_072()')::text forge_function
    `)
    expect(residue.rows[0]).toEqual({ source_table: null, forge_function: null })
  })
})
