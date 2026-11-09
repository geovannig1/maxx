import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

// The durable-generation RPCs run against the SHIPPED schema (freshSchemaDb). freshDb seeds
// the standard owned entities for account uuid(1) (campaigns/adsets/ads uuid(1)..uuid(200)) plus a
// second account uuid(2) for the cross-account tests.

// Deterministic uuids for tests (no Math.random / crypto needed for repeatability).
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// adsets.campaign_id and ads.adset_id are NOT NULL in the shipped schema, so every ad set needs a
// parent. Ad sets a test has not linked (linkAdset) belong to their account's UNLINKED parent: a
// campaign with no budgets and no last_synced_at, i.e. metadata the RPC can never treat as fresh — the
// same "parent unknown" a test sees until it opts in. Ads hang off an UNLINKED ad set the same way.
const unlinkedCampaign = (account: string) => `00000000-0000-4000-9000-${account.slice(-12)}`
const unlinkedAdset = (account: string) => `00000000-0000-4000-a000-${account.slice(-12)}`

async function ensureUnlinkedParents(db: PGlite, account: string) {
  await db.query(
    `INSERT INTO campaigns (id, ad_account_id, campaign_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [unlinkedCampaign(account), account, `unlinked-campaign-${account}`])
  await db.query(
    `INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [unlinkedAdset(account), account, unlinkedCampaign(account), `unlinked-adset-${account}`])
}

export async function freshDb(): Promise<PGlite> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, uuid(1))
  await insertAdAccount(db, uuid(2))
  await ensureUnlinkedParents(db, uuid(1))
  await ensureUnlinkedParents(db, uuid(2))
  // Account uuid(1) owns every entity id the tests use (uuid(1)..uuid(200) in each table), so the RPC's
  // account-ownership check passes for them. The cross-account test references an id OUTSIDE this range.
  const series = `FROM generate_series(1, 200) g`
  const id = `('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid`
  await db.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id)
    SELECT ${id}, $1, 'campaign-' || g ${series}`, [uuid(1)])
  await db.query(`INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id)
    SELECT ${id}, $1, $2, 'adset-' || g ${series}`, [uuid(1), unlinkedCampaign(uuid(1))])
  await db.query(`INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id)
    SELECT ${id}, $1, $2, $3, 'ad-' || g ${series}`, [uuid(1), unlinkedCampaign(uuid(1)), unlinkedAdset(uuid(1))])
  return db
}

/** Register an owned entity for an account (used by the cross-account ownership test). */
export async function seedEntity(db: PGlite, kind: 'campaigns' | 'adsets' | 'ads', id: string, account: string) {
  await ensureUnlinkedParents(db, account)
  if (kind === 'campaigns') {
    await db.query(`INSERT INTO campaigns (id, ad_account_id, campaign_id) VALUES ($1,$2,$3)`, [id, account, `campaign-${id}`])
  } else if (kind === 'adsets') {
    await db.query(`INSERT INTO adsets (id, ad_account_id, campaign_id, adset_id) VALUES ($1,$2,$3,$4)`,
      [id, account, unlinkedCampaign(account), `adset-${id}`])
  } else {
    await db.query(`INSERT INTO ads (id, ad_account_id, campaign_id, adset_id, ad_id) VALUES ($1,$2,$3,$4,$5)`,
      [id, account, unlinkedCampaign(account), unlinkedAdset(account), `ad-${id}`])
  }
}

// ── Structural-closure fixtures ──────────────────────────
// The bulk-seeded campaigns have NULL budgets + NULL last_synced_at (= ABO-shaped but STALE) and the
// bulk adsets sit under the account's unlinked (never-fresh) parent campaign. Step 6b judges ONLY fresh
// metadata reached through the real relationship, and only when a boundary is passed — so every pre-existing test
// (which passes no boundary) is byte-identical, and structural tests OPT IN via these helpers.

/** Set a campaign's budget structure: any non-null budget = CBO; both null = ABO. */
export async function setCampaignBudget(db: PGlite, id: string, b: { daily?: number | null; lifetime?: number | null }) {
  await db.query(`UPDATE campaigns SET daily_budget = $2, lifetime_budget = $3 WHERE id = $1`,
    [id, b.daily ?? null, b.lifetime ?? null])
}

/** Stamp a campaign's last_synced_at (freshness vs the boundary a test passes in p_frozen). */
export async function touchCampaign(db: PGlite, id: string, isoTs: string) {
  await db.query(`UPDATE campaigns SET last_synced_at = $2 WHERE id = $1`, [id, isoTs])
}

/** Link an ad set to its REAL parent campaign (the relationship 6b trusts over denormalized flag data). */
export async function linkAdset(db: PGlite, adsetId: string, campaignId: string) {
  await db.query(`UPDATE adsets SET campaign_id = $2 WHERE id = $1`, [adsetId, campaignId])
}

/** A minimal flag row for p_new_rows. entity is keyed by level; id is caller-supplied (trust boundary). */
export function flagRow(over: {
  id: string; ad_account_id: string; entity_level: 'ad' | 'adset' | 'campaign';
  ad_id?: string | null; adset_id?: string | null; campaign_id?: string | null;
  window_days?: number; flag_type: string; flag_date: string; reason?: string;
}): Record<string, unknown> {
  return {
    id: over.id, ad_account_id: over.ad_account_id, flag_date: over.flag_date,
    window_days: over.window_days ?? 7, entity_level: over.entity_level,
    campaign_id: over.campaign_id ?? null, adset_id: over.adset_id ?? null, ad_id: over.ad_id ?? null,
    flag_type: over.flag_type, confidence: 'high', audience_type: 'unknown',
    reason: over.reason ?? 'test', evidence: {}, created_at: new Date(0).toISOString(),
  }
}

export async function activeFlagKeys(db: PGlite, account: string): Promise<string[]> {
  const r = await db.query<{ k: string }>(
    `SELECT entity_level || ':' || coalesce(ad_id, adset_id, campaign_id)::text || ':' || window_days || ':' || flag_type AS k
     FROM flags WHERE ad_account_id = $1 AND is_active ORDER BY k`, [account])
  return r.rows.map((x) => x.k)
}
