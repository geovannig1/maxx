import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// Server-side state of webhook outcome sources: the per-source signing secret and the replay ledger
// (migration 20261109000000). The secret leaves the server exactly once, in the response that creates
// or rotates it; nothing else returns it. A rotation may keep the replaced secret verifying for a
// bounded window (0004_secret_rotation_grace.sql); the replaced secret is never returned at all.

/** Default and cap of the rotation grace window, in minutes (the database caps it at 24 hours too). */
export const DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES = 60
export const MAX_WEBHOOK_ROTATION_GRACE_MINUTES = 1440

/** 32 random bytes, hex. The HMAC key is this string's UTF-8 bytes, as documented for senders. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

export interface ResolvedWebhookSource {
  sourceId: string
  adAccountId: string
  secret: string
  /** The replaced secret while its rotation grace window is open, else null. */
  previousSecret: string | null
  timezone: string
  config: Record<string, unknown>
}

export async function createWebhookSource(
  db: SupabaseClient,
  input: { adAccountId: string; label: string; enabled: boolean },
): Promise<{ sourceId: string; secret: string }> {
  const secret = generateWebhookSecret()
  const { data, error } = await db.rpc('create_outcome_webhook_source', {
    p_ad_account_id: input.adAccountId,
    p_label: input.label,
    p_enabled: input.enabled,
    p_secret: secret,
  })
  if (error || typeof data !== 'string') throw new Error(`webhook source create failed: ${error?.message ?? 'no id'}`)
  return { sourceId: data, secret }
}

/**
 * Replace a webhook source's secret, keeping the replaced one verifying for `graceMinutes` (0 stops it
 * at once). Null when the id is not a webhook source. `previousSecretValidUntil` is when the replaced
 * secret stops, or null when it already has.
 */
export async function rotateWebhookSecret(
  db: SupabaseClient,
  sourceId: string,
  graceMinutes: number = DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES,
): Promise<{ secret: string; previousSecretValidUntil: string | null } | null> {
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > MAX_WEBHOOK_ROTATION_GRACE_MINUTES) {
    throw new RangeError('webhook secret grace out of range')
  }
  const secret = generateWebhookSecret()
  const { data, error } = await db.rpc('rotate_outcome_webhook_secret', {
    p_source_id: sourceId, p_secret: secret, p_grace_seconds: graceMinutes * 60,
  })
  if (error) throw new Error(`webhook secret rotation failed: ${error.message}`)
  // The window comes back with the rotation: a second read could fail after the commit and lose the secret.
  const row = (Array.isArray(data) ? data[0] : null) as { rotated?: unknown; grace_until?: unknown } | null | undefined
  if (row?.rotated !== true) return null
  const until = typeof row.grace_until === 'string' ? new Date(row.grace_until) : null
  return { secret, previousSecretValidUntil: until && Number.isFinite(until.getTime()) ? until.toISOString() : null }
}

/** When each source's replaced secret stops verifying, for sources whose grace window is still open.
 *  Reads only the instant, never a secret. */
export async function readWebhookSecretGrace(
  db: SupabaseClient,
  sourceIds: readonly string[],
  nowIso: string = new Date().toISOString(),
): Promise<Record<string, string>> {
  if (sourceIds.length === 0) return {}
  const { data, error } = await db.from('outcome_source_secrets')
    .select('source_id, previous_secret_expires_at')
    .in('source_id', [...sourceIds])
    .gt('previous_secret_expires_at', nowIso)
  if (error) throw new Error(`webhook secret grace read failed: ${error.message}`)
  const out: Record<string, string> = {}
  for (const row of (data ?? []) as Array<{ source_id: string; previous_secret_expires_at: string | null }>) {
    if (row.previous_secret_expires_at) out[row.source_id] = new Date(row.previous_secret_expires_at).toISOString()
  }
  return out
}

/** The enabled webhook source with this id, or null for an unknown, disabled or secretless one. */
export async function resolveWebhookSource(db: SupabaseClient, sourceId: string): Promise<ResolvedWebhookSource | null> {
  const { data, error } = await db.rpc('get_outcome_webhook_source', { p_source_id: sourceId })
  if (error) throw new Error(`webhook source lookup failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : null) as {
    source_id: string; ad_account_id: string; secret: string; timezone_name: string | null; config: unknown
    previous_secret?: string | null
  } | undefined
  if (!row) return null
  return {
    sourceId: row.source_id,
    adAccountId: row.ad_account_id,
    secret: row.secret,
    previousSecret: typeof row.previous_secret === 'string' && row.previous_secret.length > 0 ? row.previous_secret : null,
    timezone: row.timezone_name ?? '',
    config: row.config && typeof row.config === 'object' ? row.config as Record<string, unknown> : {},
  }
}

/** true = first sight of this signed delivery; false = a replay. */
export async function claimWebhookDelivery(db: SupabaseClient, sourceId: string, deliveryKey: string): Promise<boolean> {
  const { data, error } = await db.rpc('claim_outcome_webhook_delivery', { p_source_id: sourceId, p_delivery_key: deliveryKey })
  if (error || typeof data !== 'boolean') throw new Error(`webhook delivery claim failed: ${error?.message ?? 'no result'}`)
  return data
}

export async function releaseWebhookDelivery(db: SupabaseClient, sourceId: string, deliveryKey: string): Promise<void> {
  const { error } = await db.rpc('release_outcome_webhook_delivery', { p_source_id: sourceId, p_delivery_key: deliveryKey })
  if (error) throw new Error(`webhook delivery release failed: ${error.message}`)
}
