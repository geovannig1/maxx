import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { outcomeSourceId, ensureAcuitySource, outcomeUuid } from './acuity-harness'

const ACCOUNT_A = '00000000-0000-4000-8000-000000000671'
const ACCOUNT_B = '00000000-0000-4000-8000-000000000672'
const TOUCH_A = '00000000-0000-4000-8000-000000000673'
const TOKEN_A = '00000000-0000-4000-8000-000000000674'
const CAPTURE_A = '00000000-0000-4000-8000-000000000675'
const TOUCH_B = '00000000-0000-4000-8000-000000000676'
const TOKEN_B = '00000000-0000-4000-8000-000000000677'
const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const FINGERPRINT_A = `sha256:${'c'.repeat(64)}`
const FINGERPRINT_B = `sha256:${'d'.repeat(64)}`

let db: PGlite

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT_A, 'act_touch_a')
  await insertAdAccount(db, ACCOUNT_B, 'act_touch_b')
  await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [ACCOUNT_B])
})

async function capture(overrides: {
  account?: string
  touch?: string
  token?: string
  capture?: string
  fingerprint?: string
  tokenHash?: string
  previousToken?: string | null
  previousHash?: string | null
  metaAdId?: string | null
} = {}) {
  return one<Record<string, unknown>>(`
    SELECT public.capture_paid_touch(
      $1,$2,$3,$4,$5,$6,$7,$8,
      'meta','IwZXh0bgNhZW0CMTAAAR1','100000000000007','100000000000008',$9,
      'meta','paid_social','Cold Studio','Proof reel','Springfield creators',
      'https://example-studio.test/book/', 'https://l.facebook.com/', 1, 1
    ) AS result`, [
    overrides.account ?? ACCOUNT_A,
    overrides.touch ?? TOUCH_A,
    overrides.token ?? TOKEN_A,
    overrides.capture ?? CAPTURE_A,
    overrides.fingerprint ?? FINGERPRINT_A,
    overrides.tokenHash ?? HASH_A,
    overrides.previousToken ?? null,
    overrides.previousHash ?? null,
    overrides.metaAdId === undefined ? '100000000000009' : overrides.metaAdId,
  ]).then((row) => row.result as Record<string, unknown>)
}

describe('paid-touch capture and token chain', () => {
  it('stamps time in Postgres, keeps immutable ids, and returns the same lineage on an exact retry', async () => {
    const first = await capture()
    expect(first).toMatchObject({
      touch_id: TOUCH_A,
      token_id: TOKEN_A,
      first_touch_id: TOUCH_A,
      last_touch_id: TOUCH_A,
      identity_complete: true,
      contract_version: 1,
      policy_version: 1,
    })
    expect(new Date(String(first.observed_at)).getTime()).toBeLessThanOrEqual(Date.now() + 1_000)

    const retry = await capture({ touch: TOUCH_B, token: TOKEN_B, tokenHash: HASH_B })
    expect(retry.touch_id).toBe(TOUCH_A)
    expect(retry.token_id).toBe(TOKEN_A)

    await expect(capture({ fingerprint: FINGERPRINT_B })).rejects.toThrow(/capture collision/i)
  })

  it('retains incomplete identity as diagnostic evidence but never calls it complete', async () => {
    const result = await capture({ metaAdId: null })
    expect(result.identity_complete).toBe(false)
  })

  it('extends a valid same-account chain and rejects forged, expired, or cross-account predecessors', async () => {
    await capture()
    const chained = await capture({
      touch: TOUCH_B,
      token: TOKEN_B,
      capture: '00000000-0000-4000-8000-000000000678',
      fingerprint: FINGERPRINT_B,
      tokenHash: HASH_B,
      previousToken: TOKEN_A,
      previousHash: HASH_A,
    })
    expect(chained).toMatchObject({ first_touch_id: TOUCH_A, last_touch_id: TOUCH_B })

    await expect(capture({
      touch: '00000000-0000-4000-8000-000000000679',
      token: `00000000-0000-4000-8000-000000000680`,
      capture: '00000000-0000-4000-8000-000000000681',
      fingerprint: `sha256:${'e'.repeat(64)}`,
      tokenHash: `sha256:${'f'.repeat(64)}`,
      previousToken: TOKEN_A,
      previousHash: HASH_B,
    })).rejects.toThrow(/previous token invalid/i)

    await db.exec(`ALTER TABLE public.paid_attribution_tokens DISABLE TRIGGER USER`)
    await db.query(`UPDATE public.paid_attribution_tokens
      SET issued_at=now()-interval '91 days', expires_at=now()-interval '1 day'
      WHERE id=$1`, [TOKEN_A])
    await db.exec(`ALTER TABLE public.paid_attribution_tokens ENABLE TRIGGER USER`)
    await expect(capture({
      touch: '00000000-0000-4000-8000-000000000682',
      token: `00000000-0000-4000-8000-000000000683`,
      capture: '00000000-0000-4000-8000-000000000684',
      fingerprint: `sha256:${'1'.repeat(64)}`,
      tokenHash: `sha256:${'2'.repeat(64)}`,
      previousToken: TOKEN_A,
      previousHash: HASH_A,
    })).rejects.toThrow(/previous token invalid or expired/i)

    await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [ACCOUNT_A])
    await db.query(`UPDATE public.ad_accounts SET is_active=true WHERE id=$1`, [ACCOUNT_B])
    await expect(capture({
      account: ACCOUNT_B,
      touch: '00000000-0000-4000-8000-000000000685',
      token: `00000000-0000-4000-8000-000000000686`,
      capture: '00000000-0000-4000-8000-000000000687',
      fingerprint: `sha256:${'3'.repeat(64)}`,
      tokenHash: `sha256:${'4'.repeat(64)}`,
      previousToken: TOKEN_A,
      previousHash: HASH_A,
    })).rejects.toThrow(/previous token invalid/i)
  })
})

describe('signed-webhook appointment linkage', () => {
  it('links one client booking atomically and makes an exact retry idempotent', async () => {
    const token = await capture()
    // Created after the touch and not in the future: the shipped temporal guard refuses a link
    // recorded before the appointment it links was created.
    await ensureAcuitySource(db, ACCOUNT_A)
    await db.query(`INSERT INTO public.outcomes(
      id,ad_account_id,source_id,external_id,outcome_type,currency,
      occurred_at,gross_value,status,origin,origin_observed_at,origin_observed_source
    ) VALUES ($2,$1,$3,'6701','booking','USD',now(),220,'confirmed','website',now(),'webhook')`,
    [ACCOUNT_A, outcomeUuid(6701), outcomeSourceId(ACCOUNT_A)])

    const linked = await one<{ result: Record<string, unknown> }>(`
      SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) AS result`,
    [ACCOUNT_A, token.token_id, HASH_A, outcomeUuid(6701)])
    expect(linked.result).toMatchObject({
      outcome_id: outcomeUuid(6701),
      token_id: TOKEN_A,
      first_touch_id: TOUCH_A,
      last_touch_id: TOUCH_A,
      last_fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
      policy_version: 1,
    })

    const retry = await one<{ result: Record<string, unknown> }>(`
      SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) AS result`,
    [ACCOUNT_A, token.token_id, HASH_A, outcomeUuid(6701)])
    expect(retry.result.id).toBe(linked.result.id)
  })

  it('rejects a conflicting relink, a post-booking touch, staff/unknown origin, and account mismatch', async () => {
    await capture()
    await capture({
      touch: TOUCH_B,
      token: TOKEN_B,
      capture: '00000000-0000-4000-8000-000000000688',
      fingerprint: FINGERPRINT_B,
      tokenHash: HASH_B,
    })
    // scheduled_by NULL + an observed origin = a by-id-observed client booking ('website');
    // scheduled_by set = 'staff_or_manual'; never observed = origin left at its 'unknown' default.
    await ensureAcuitySource(db, ACCOUNT_A)
    await db.query(`INSERT INTO public.outcomes(
      id,ad_account_id,source_id,external_id,outcome_type,currency,
      occurred_at,gross_value,status,origin,origin_observed_at,origin_observed_source
    ) VALUES
      ($2,$1,$6,'6702','booking','USD',now(),220,'confirmed','website',now(),'webhook'),
      ($3,$1,$6,'6703','booking','USD',now()-interval '5 minutes',220,'confirmed','website',now(),'webhook'),
      ($4,$1,$6,'6704','booking','USD',now(),220,'confirmed','staff_or_manual',now(),'webhook'),
      ($5,$1,$6,'6705','booking','USD',now(),220,'confirmed',DEFAULT,NULL,NULL)`,
    [ACCOUNT_A, outcomeUuid(6702), outcomeUuid(6703), outcomeUuid(6704), outcomeUuid(6705), outcomeSourceId(ACCOUNT_A)])

    await one(`SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) result`, [ACCOUNT_A, TOKEN_A, HASH_A, outcomeUuid(6702)])
    await expect(one(`SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) result`, [ACCOUNT_A, TOKEN_B, HASH_B, outcomeUuid(6702)]))
      .rejects.toThrow(/conflicting paid-touch relink/i)
    await expect(one(`SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) result`, [ACCOUNT_A, TOKEN_A, HASH_A, outcomeUuid(6703)]))
      .rejects.toThrow(/touch must precede appointment/i)
    await expect(one(`SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) result`, [ACCOUNT_A, TOKEN_A, HASH_A, outcomeUuid(6704)]))
      .rejects.toThrow(/client-booked origin/i)
    await expect(one(`SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) result`, [ACCOUNT_A, TOKEN_A, HASH_A, outcomeUuid(6705)]))
      .rejects.toThrow(/client-booked origin/i)

    await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [ACCOUNT_A])
    await db.query(`UPDATE public.ad_accounts SET is_active=true WHERE id=$1`, [ACCOUNT_B])
    await expect(one(`SELECT public.link_outcome_paid_touch($1,$4,$2,$3,1) result`, [ACCOUNT_B, TOKEN_A, HASH_A, outcomeUuid(6702)]))
      .rejects.toThrow(/sole active ad account|account mismatch/i)
  })
})

describe('storage boundary', () => {
  it('denies browser roles and keeps every measurement table append-only', async () => {
    const rows = await one<{
      anon_reads: number
      authenticated_reads: number
      service_reads: number
      rls_tables: number
    }>(`
      WITH governed(name) AS (VALUES
        ('paid_touch_observations'),('paid_attribution_tokens'),('outcome_touch_links'),
        ('paid_measurement_activations'),('paid_cohort_generations'),('paid_cohort_units'))
      SELECT
        (SELECT count(*)::int FROM governed WHERE has_table_privilege('anon','public.'||name,'SELECT')) anon_reads,
        (SELECT count(*)::int FROM governed WHERE has_table_privilege('authenticated','public.'||name,'SELECT')) authenticated_reads,
        (SELECT count(*)::int FROM governed WHERE has_table_privilege('service_role','public.'||name,'SELECT')) service_reads,
        (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN governed g ON c.relname=g.name
          WHERE c.relnamespace='public'::regnamespace AND c.relrowsecurity) rls_tables`)
    expect(rows).toEqual({ anon_reads: 0, authenticated_reads: 0, service_reads: 6, rls_tables: 6 })

    await capture()
    await expect(db.query(`UPDATE public.paid_touch_observations SET utm_campaign='changed' WHERE id=$1`, [TOUCH_A]))
      .rejects.toThrow(/immutable/i)
    await expect(db.query(`TRUNCATE public.paid_cohort_units`)).rejects.toThrow(/append-only/i)
  })
})
