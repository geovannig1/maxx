import type { PGlite } from '@electric-sql/pglite'

/**
 * Minimal valid rows for the shipped schema's entity hierarchy and decision tables. Each helper writes
 * only the NOT NULL columns (plus what the caller overrides), so a test states the columns its
 * assertion depends on and nothing else. Use with freshSchemaDb() + insertAdAccount().
 */

const metaIdFor = (prefix: string, id: string) => `${prefix}${id.replace(/-/g, '').slice(-12)}`

export async function insertCampaign(
  db: PGlite, id: string, accountId: string, metaId = metaIdFor('9', id),
): Promise<string> {
  await db.query(
    `INSERT INTO public.campaigns (id, ad_account_id, campaign_id) VALUES ($1, $2, $3)`,
    [id, accountId, metaId],
  )
  return id
}

export async function insertAdset(
  db: PGlite, id: string, accountId: string, campaignId: string, metaId = metaIdFor('8', id),
): Promise<string> {
  await db.query(
    `INSERT INTO public.adsets (id, ad_account_id, campaign_id, adset_id) VALUES ($1, $2, $3, $4)`,
    [id, accountId, campaignId, metaId],
  )
  return id
}

export async function insertAd(
  db: PGlite, id: string, accountId: string, campaignId: string, adsetId: string,
  metaId = metaIdFor('7', id),
): Promise<string> {
  await db.query(
    `INSERT INTO public.ads (id, ad_account_id, campaign_id, adset_id, ad_id) VALUES ($1, $2, $3, $4, $5)`,
    [id, accountId, campaignId, adsetId, metaId],
  )
  return id
}

export const COMMERCIAL_OBJECTIVE = 'maximize_incremental_contribution_from_ad_attributed_collected_revenue'

/**
 * Insert an action_decisions row as the table owner (the only identity the audit guard admits for
 * direct DML). The default is a current-policy, account-level, diagnostic-only observation that
 * satisfies every CHECK; override the columns the test is about.
 */
export async function insertActionDecision(
  db: PGlite, accountId: string, overrides: Record<string, unknown> = {},
): Promise<string> {
  const row: Record<string, unknown> = {
    id: crypto.randomUUID(),
    ad_account_id: accountId,
    action_kind: 'observe',
    target_level: 'account',
    target_id: null,
    evidence_plane: 'structural',
    evidence_basis: 'calendar_period_signal',
    authority_tier: 'diagnostic_only',
    authority_reason: 'Diagnostic evidence only.',
    owner_copy: 'Diagnostic copy.',
    direction_ceiling: 'unsupported',
    direction_reason: 'No action authority.',
    policy_version: 5,
    objective: COMMERCIAL_OBJECTIVE,
    source_kind: 'diagnostic',
    dedupe_key: `decision-${crypto.randomUUID()}`,
    ...overrides,
  }
  const keys = Object.keys(row)
  const result = await db.query<{ id: string }>(
    `INSERT INTO public.action_decisions (${keys.join(',')})
     VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
    Object.values(row),
  )
  return result.rows[0].id
}

/**
 * A recommendation payload for replace_recommendation_generation. The RPC builds rows with
 * jsonb_populate_record over a NULL base, so column defaults do not apply: every NOT NULL column must
 * be present in the payload, exactly as the application writer sends it.
 */
export function recommendationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recommendation_type: 'investigate',
    target_entity_type: 'account',
    target_entity_id: null,
    observed_fact: 'Observed.',
    metric_values: [],
    data_sources: [],
    confidence_score: 0,
    confidence_label: 'insufficient',
    risk_level: 'medium',
    gate_decision: 'hold',
    gate_passed: false,
    what_could_make_this_wrong: [],
    approval_required: true,
    action_allowed_now: false,
    metric_claim_ids: [],
    ...overrides,
  }
}
