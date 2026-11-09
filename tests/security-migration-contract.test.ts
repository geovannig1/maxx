import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freshSchemaDb } from './db/schema-db'

// The security boundary the pre-squash migrations established, asserted on the live catalog of
// the shipped schema rather than on the text of files that no longer exist.
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

let db: PGlite
beforeAll(async () => { db = await freshSchemaDb() })
afterAll(async () => { await db?.close() })

async function existingRelations(names: string[]): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM unnest($1::text[]) name WHERE to_regclass('public.' || name) IS NOT NULL ORDER BY name`, [names])
  return rows.map((row) => row.name)
}

/** Every privilege the role still holds on the named relations, as `table:PRIVILEGE`. */
async function heldPrivileges(role: string, tables: string[]): Promise<string[]> {
  const { rows } = await db.query<{ held: string }>(`
    SELECT t || ':' || p AS held FROM unnest($2::text[]) t, unnest($3::text[]) p
     WHERE has_table_privilege($1, 'public.' || t, p) ORDER BY 1`, [role, tables, TABLE_PRIVILEGES])
  return rows.map((row) => row.held)
}

/** Policies from the list that still exist, as `table.policy`; `name ON public.table` scopes to one table. */
async function remainingPolicies(policies: string[]): Promise<string[]> {
  const scoped = policies.map((entry) => {
    const [policy, table] = entry.split(' ON public.')
    return { policy, table: table ?? null }
  })
  const { rows } = await db.query<{ found: string }>(`
    SELECT p.tablename || '.' || p.policyname AS found
      FROM pg_policies p JOIN jsonb_to_recordset($1::jsonb) AS wanted(policy text, "table" text)
        ON p.policyname = wanted.policy AND (wanted."table" IS NULL OR p.tablename = wanted."table")
     WHERE p.schemaname = 'public' ORDER BY 1`, [JSON.stringify(scoped)])
  return rows.map((row) => row.found)
}

describe('forward-only security boundary migration', () => {
  it('removes authenticated direct reads on the live catalog', async () => {
    // Control: the same instruments see a policy and a privilege that do exist.
    expect(await remainingPolicies(['service_role_all_daily_reports'])).toEqual(['daily_reports.service_role_all_daily_reports'])
    expect(await heldPrivileges('service_role', ['daily_reports'])).toContain('daily_reports:SELECT')

    expect(await remainingPolicies([
      'action_decisions_auth_read',
      'outcome_appointments_auth_read',
      'outcome_obs_auth_read',
      'outcome_capi_deliveries_auth_read',
      // The same policies under the generic-outcomes names (migration 20261108000000 renames by fragment).
      'outcomes_auth_read',
      'outcome_obs_auth_read',
      'conversion_deliveries_auth_read',
    ])).toEqual([])

    const tables = [
      'recommendations',
      'flags',
      'alerts',
      'audit_tasks',
      'daily_reports',
      'weekly_reports',
      'decision_generations',
      'pending_approvals',
      'tests',
      'creative_briefs',
      'ad_setup_decisions',
      'recommendation_decisions',
      'learned_patterns',
      'agent_memory',
      'memory_entries',
      'expert_insights',
      'custom_audiences',
      'action_decisions',
      'change_requests',
      'outcomes',
      'outcome_observations',
      'conversion_deliveries',
      'v_business_outcomes',
    ]
    // Every relation the boundary names must exist, or "holds nothing" would pass vacuously.
    expect(await existingRelations(tables)).toEqual([...tables].sort())
    for (const role of ['authenticated', 'anon']) {
      expect(await heldPrivileges(role, tables), `${role} privileges`).toEqual([])
    }

    expect(await remainingPolicies([
      'recommendations_auth_select',
      'authenticated_select_flags',
      'authenticated_select_alerts',
      'authenticated_update_alerts',
      'authenticated_select_audit_tasks',
      'authenticated_update_audit_tasks',
      'authenticated_select_daily_reports',
      'weekly_reports_auth_select',
      'authenticated_select_decision_generations',
      'auth_select ON public.pending_approvals',
      'auth_update ON public.pending_approvals',
      'authenticated_select_tests',
      'authenticated_update_tests',
      'authenticated_select_briefs',
      'ad_setup_decisions_auth_read',
      'rec_decisions_auth_read',
      'auth_select_learned_patterns',
      'auth_select ON public.agent_memory',
      'authenticated_select_memory',
      'authenticated_select_expert_insights',
      'custom_audiences_auth_read',
    ])).toEqual([])
  })

  it('reasserts change-request update denial and freezes proposal context only', async () => {
    expect(await remainingPolicies(['auth_select_change_requests', 'auth_update_change_requests'])).toEqual([])
    expect(await heldPrivileges('authenticated', ['change_requests'])).toEqual([])
    expect(await heldPrivileges('service_role', ['change_requests'])).toEqual(expect.arrayContaining([
      'change_requests:SELECT', 'change_requests:INSERT', 'change_requests:UPDATE', 'change_requests:DELETE',
    ]))

    const trigger = (await db.query<{ definition: string; guard: string }>(`
      SELECT pg_get_triggerdef(t.oid) AS definition, pg_get_functiondef(t.tgfoid) AS guard
        FROM pg_trigger t
       WHERE t.tgrelid = 'public.change_requests'::regclass AND NOT t.tgisinternal
         AND pg_get_functiondef(t.tgfoid) LIKE '%change_request_approval_context_is_immutable%'`)).rows
    expect(trigger).toHaveLength(1)
    expect(trigger[0].definition).toMatch(/BEFORE UPDATE OF/i)
    for (const column of [
      'reason', 'confidence', 'risk_level', 'rollback_plan', 'requested_by',
      'evidence', 'data_source', 'expires_at',
    ]) {
      expect(trigger[0].definition).toMatch(new RegExp(`\\b${column}\\b`))
      expect(trigger[0].guard).toMatch(new RegExp(`NEW\\.${column}`))
      expect(trigger[0].guard).toMatch(new RegExp(`OLD\\.${column}`))
    }
  })

  it('adds a service-role-only durable fixed-window rate-limit RPC', async () => {
    expect(await existingRelations(['api_rate_limit_windows'])).toEqual(['api_rate_limit_windows'])
    const rpc = (await db.query<Record<string, unknown>>(`SELECT p.prosecdef AS security_definer,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
      FROM pg_proc p WHERE p.oid = 'public.consume_api_rate_limit(text,text,integer,integer)'::regprocedure`)).rows
    expect(rpc).toEqual([{ security_definer: true, service_execute: true, authenticated_execute: false, anon_execute: false }])
  })
})
