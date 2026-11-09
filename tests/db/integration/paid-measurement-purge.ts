import type pg from 'pg'

// ADR-056 protects every paid-measurement table with ON DELETE RESTRICT against ad_accounts, because
// an account row disappearing must never silently erase paid touches, appointment links, or the
// activation boundary that §7 depends on. The schema is deliberate; the OBLIGATION it creates is on
// the harness: a suite that produces paid-measurement rows must remove them before any later suite
// reuses that account id and deletes ad_accounts.
//
// session_replication_role = replica is what makes this possible at all — it suspends the append-only
// triggers for the duration of the transaction, which the schema explicitly permits for isolated
// fixture setup and forbids everywhere else. It is SET LOCAL, so it dies with the transaction.
//
// Delete order covers both immutable ledgers: creative assignments have no ledger children, then the
// ADR-056 chain is units → generations → links → tokens → observations → activations. Reordering the
// ADR-056 chain will produce a constraint violation, not a silent partial purge.
//
// A pre-squash migration added outcome_collected_value_observations, with ON DELETE RESTRICT to BOTH ad_accounts and
// outcome_appointments, and did not add it here. Every suite that uses this fixture then failed in
// setup, unnoticed while the CI workflow was invalid and no job ran. The list is the rot vector: it has to be updated by hand every
// time a migration adds a RESTRICT child, and one miss takes the whole suite down.
//
// outcome_collected_value_observations is a child of outcome_appointments, so it must be deleted before the
// appointment rows seedBase removes; it is placed at the head for that reason.
// The table list used to be written out by hand here, and that was the defect. A pre-squash migration added
// outcome_collected_value_observations as a RESTRICT child and did not add it to the list, so every suite
// using this helper died in setup on `DELETE FROM ad_accounts` — 43 of the 46 integration failures on
// this branch. Fixing 127/128 so recommendation MetricClaims finally publish immediately produced the
// same failure again from two more tables (recommendation_metric_claim_snapshots and _bindings), which
// is the proof that the list itself is the problem: it has to be edited by every migration that adds a
// RESTRICT child, across 20+ fixtures, and one miss takes whole suites down with an error that names a
// constraint rather than the omission.
//
// So derive it. The catalog already knows exactly which tables block an account delete; asking it costs
// one query and cannot go stale. Deletion order does not matter because session_replication_role =
// replica suspends FK triggers for the transaction (the schema permits this for isolated fixture
// setup and forbids it everywhere else), which is also why this must stay inside that transaction.
async function accountRestrictChildren(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(`
    SELECT DISTINCT child.relname AS table_name
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    JOIN pg_attribute acct
      ON acct.attrelid = child.oid AND acct.attname = 'ad_account_id' AND acct.attnum > 0 AND NOT acct.attisdropped
    WHERE ns.nspname = 'public'
      AND fk.contype = 'f'
      AND fk.confdeltype = 'r'                       -- ON DELETE RESTRICT: exactly what blocks teardown
      AND parent.relname IN ('ad_accounts', 'outcomes')
      -- The business ledger itself is not paid measurement. Before ADR-058 its account FK was
      -- ON DELETE SET NULL, so it never appeared here and a purge left bookings in place; outcomes
      -- and outcome_sources are RESTRICT now, and keeping them out preserves that meaning. A caller
      -- that deletes the account deletes its outcomes and outcome source explicitly.
      AND child.relname NOT IN ('outcomes', 'outcome_sources')
    ORDER BY 1
  `)
  return rows.map((row) => row.table_name)
}

export async function purgePaidMeasurement(
  client: pg.Client,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL session_replication_role = replica')
    for (const table of await accountRestrictChildren(client)) {
      await client.query(
        // The identifier comes from pg_class, not from any caller, so it cannot carry injection.
        `DELETE FROM public.${table} WHERE ad_account_id = ANY($1::uuid[])`,
        [[...accountIds]],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

/**
 * Remove immutable executive-report and setup-history rows created by loopback integration fixtures.
 * Production code never calls this. The transaction uses the same replica-only teardown boundary as
 * the paid-measurement purge, and deletes every dependent row before its parent to avoid residue.
 */
export async function purgeExecutiveEvidence(
  client: pg.Client,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return
  const ids = [...accountIds]
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(`DELETE FROM public.daily_digest_delivery_attempts
      WHERE report_id IN (SELECT id FROM public.daily_reports
        WHERE ad_account_id = ANY($1::uuid[]))`, [ids])
    await client.query(`DELETE FROM public.weekly_executive_delivery_attempts
      WHERE report_id IN (SELECT id FROM public.weekly_reports
        WHERE ad_account_id = ANY($1::uuid[]))`, [ids])
    await client.query(`DELETE FROM public.daily_reports
      WHERE ad_account_id = ANY($1::uuid[])`, [ids])
    await client.query(`DELETE FROM public.weekly_reports
      WHERE ad_account_id = ANY($1::uuid[])`, [ids])
    await client.query(`DELETE FROM public.executive_evidence_generations
      WHERE ad_account_id = ANY($1::uuid[])`, [ids])
    await client.query(`DELETE FROM public.setup_material_changes
      WHERE ad_account_id = ANY($1::uuid[])`, [ids])
    await client.query(`DELETE FROM public.meta_setup_entity_snapshots
      WHERE ad_account_id = ANY($1::uuid[])`, [ids])
    await client.query(`DELETE FROM public.meta_setup_generations
      WHERE ad_account_id = ANY($1::uuid[])`, [ids])
    await client.query(`DELETE FROM public.setup_change_plans
      WHERE ad_account_id = ANY($1::uuid[])`, [ids])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
