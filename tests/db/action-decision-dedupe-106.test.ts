import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { COMMERCIAL_OBJECTIVE } from './decision-fixture'

const ACCOUNT = fixtureUuid(106)
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})

async function commit(ownerCopy = 'Diagnostic copy') {
  return db.query<{ id: string }>(`SELECT (public.commit_action_decision(
    p_ad_account_id => $1,
    p_action_kind => 'observe',
    p_target_level => 'account',
    p_target_id => NULL,
    p_evidence_plane => 'structural',
    p_evidence_basis => 'calendar_period_signal',
    p_authority_tier => 'diagnostic_only',
    p_authority_reason => 'Diagnostic evidence only.',
    p_owner_copy => $2,
    p_direction_ceiling => 'unsupported',
    p_direction_reason => 'No action authority.',
    p_policy_version => 5,
    p_dedupe_key => 'same-decision',
    p_source_kind => 'diagnostic',
    p_objective => $3
  )).*`, [ACCOUNT, ownerCopy, COMMERCIAL_OBJECTIVE])
}

describe('current-shape ActionDecision dedupe', () => {
  it('returns the existing row for an identical retry and rejects a real collision', async () => {
    const first = await commit()
    const retry = await commit()
    expect(retry.rows[0].id).toBe(first.rows[0].id)
    await expect(commit('Different immutable copy')).rejects.toThrow(/dedupe collision/i)
  })

  it('keeps execution restricted to service_role', async () => {
    const result = await db.query<{ service: boolean; anonymous: boolean }>(`
      SELECT
        has_function_privilege('service_role',p.oid,'EXECUTE') service,
        has_function_privilege('anon',p.oid,'EXECUTE') anonymous
      FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.proname='commit_action_decision'`)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toEqual({ service: true, anonymous: false })
  })
})
