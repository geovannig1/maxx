import type pg from 'pg'

// Integration fixtures write Acuity bookings into the generic outcomes ledger (ADR-058): every row
// needs the account's Acuity outcome_sources parent, the Acuity id as external_id, outcome_type
// 'booking' and the account currency. The source row matches what the app's ensureAcuitySource
// creates, so app code and fixtures share one source per account.

/** Find or create the account's Acuity outcome source and return its id. */
export async function outcomeSourceId(client: pg.Client, accountId: string): Promise<string> {
  await client.query(
    `INSERT INTO outcome_sources (ad_account_id, kind, label, enabled)
     VALUES ($1, 'acuity', 'Acuity Scheduling', true)
     ON CONFLICT (ad_account_id, kind, label) DO NOTHING`,
    [accountId],
  )
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM outcome_sources WHERE ad_account_id=$1 AND kind='acuity' AND label='Acuity Scheduling'`,
    [accountId],
  )
  return rows[0].id
}

/**
 * Insert one Acuity booking outcome for `accountId` with Acuity id `externalId`. `columns` uses
 * outcomes column names (gross_value, collected_value, status, occurred_at, business_date, ...);
 * fixed test-authored keys only. Returns the outcome uuid.
 */
export async function insertOutcomeOutcome(
  client: pg.Client,
  accountId: string,
  externalId: number | string,
  columns: Record<string, unknown> = {},
): Promise<string> {
  const row: Record<string, unknown> = {
    ad_account_id: accountId,
    source_id: await outcomeSourceId(client, accountId),
    external_id: String(externalId),
    outcome_type: 'booking',
    currency: 'USD',
    ...columns,
  }
  const names = Object.keys(row)
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outcomes (${names.join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(row),
  )
  return rows[0].id
}

/**
 * Remove the accounts' outcomes and Acuity outcome source so the accounts themselves can be deleted.
 * Before ADR-058 the ledger's account FK was ON DELETE SET NULL and a bare account delete went
 * through; outcomes and outcome_sources are RESTRICT now. Call it after purgePaidMeasurement, which
 * removes the RESTRICT children of outcomes.
 */
export async function removeAccountOutcomes(client: pg.Client, accountIds: readonly string[]): Promise<void> {
  if (accountIds.length === 0) return
  await client.query('DELETE FROM outcomes WHERE ad_account_id = ANY($1::uuid[])', [[...accountIds]])
  await client.query('DELETE FROM outcome_sources WHERE ad_account_id = ANY($1::uuid[])', [[...accountIds]])
}
