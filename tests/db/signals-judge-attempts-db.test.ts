import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearTransientFailures, readTransientFailures, recordTransientFailure,
} from '@/lib/signals/judge-attempts'
import { pgliteSupabase } from './postgrest-pglite'
import { fixtureUuid, freshSchemaDb, insertAdAccount } from './schema-db'

// The signals judge's retry counter against the shipped schema, through the real Supabase SDK, as the
// service role the cron uses (migration 20261110120000).

const ACCOUNT = fixtureUuid(1201)
const OTHER = fixtureUuid(1202)
const TITLE = 'Creative testing cadence for local studios'

let db: PGlite
let client: SupabaseClient
beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER)
  await db.exec('SET ROLE service_role')
  client = pgliteSupabase(db)
})
afterEach(async () => { await db?.close() })

describe('expert_insight_judge_attempts', () => {
  it('counts, replaces and clears one item per account and title', async () => {
    expect(await readTransientFailures(client, ACCOUNT, TITLE)).toBe(0)
    await recordTransientFailure(client, ACCOUNT, TITLE, 1, 'server')
    await recordTransientFailure(client, OTHER, TITLE, 1, 'timeout')
    await recordTransientFailure(client, ACCOUNT, TITLE, 2, 'rate_limit')

    expect(await readTransientFailures(client, ACCOUNT, TITLE)).toBe(2)
    const { rows } = await db.query<{ ad_account_id: string; transient_failures: number; last_failure_kind: string }>(
      'SELECT ad_account_id, transient_failures, last_failure_kind FROM public.expert_insight_judge_attempts ORDER BY ad_account_id')
    expect(rows).toEqual([
      { ad_account_id: ACCOUNT, transient_failures: 2, last_failure_kind: 'rate_limit' },
      { ad_account_id: OTHER, transient_failures: 1, last_failure_kind: 'timeout' },
    ])

    await clearTransientFailures(client, ACCOUNT, TITLE)
    expect(await readTransientFailures(client, ACCOUNT, TITLE)).toBe(0)
    expect(await readTransientFailures(client, OTHER, TITLE)).toBe(1)
  })

  it('rejects a kind that is not transient and a count below one', async () => {
    await expect(recordTransientFailure(client, ACCOUNT, TITLE, 1, 'bad_request' as never)).rejects.toThrow(/write failed/)
    await expect(recordTransientFailure(client, ACCOUNT, TITLE, 0, 'server')).rejects.toThrow(/write failed/)
    expect(await readTransientFailures(client, ACCOUNT, TITLE)).toBe(0)
  })

  it('accepts a network failure as a transient kind', async () => {
    await recordTransientFailure(client, ACCOUNT, TITLE, 1, 'network')
    const { rows } = await db.query<{ last_failure_kind: string }>('SELECT last_failure_kind FROM public.expert_insight_judge_attempts')
    expect(rows).toEqual([{ last_failure_kind: 'network' }])
  })

  it('is removed with its account', async () => {
    await recordTransientFailure(client, ACCOUNT, TITLE, 1, 'server')
    await db.exec('RESET ROLE')
    await db.query('DELETE FROM public.ad_accounts WHERE id = $1', [ACCOUNT])
    const { rows } = await db.query('SELECT 1 FROM public.expert_insight_judge_attempts')
    expect(rows).toEqual([])
  })

  it('gives the browser roles nothing', async () => {
    await db.exec('RESET ROLE')
    const { rows } = await db.query<{ role: string; any: boolean }>(`
      SELECT r AS role, (has_table_privilege(r, 'public.expert_insight_judge_attempts', 'SELECT')
        OR has_table_privilege(r, 'public.expert_insight_judge_attempts', 'INSERT')
        OR has_table_privilege(r, 'public.expert_insight_judge_attempts', 'UPDATE')
        OR has_table_privilege(r, 'public.expert_insight_judge_attempts', 'DELETE')) AS any
        FROM unnest(array['anon', 'authenticated', 'service_role']) r ORDER BY r`)
    expect(rows).toEqual([
      { role: 'anon', any: false }, { role: 'authenticated', any: false }, { role: 'service_role', any: true },
    ])
  })
})
