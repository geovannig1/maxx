import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// Server-side state of webhook outcome sources: the per-source signing secret and the replay ledger
// (migration 20261109000000). The secret leaves the server exactly once, in the response that creates
// or rotates it; nothing else returns it.

/** 32 random bytes, hex. The HMAC key is this string's UTF-8 bytes, as documented for senders. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

export interface ResolvedWebhookSource {
  sourceId: string
  adAccountId: string
  secret: string
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

/** Replace a webhook source's secret. Null when the id is not a webhook source. */
export async function rotateWebhookSecret(db: SupabaseClient, sourceId: string): Promise<string | null> {
  const secret = generateWebhookSecret()
  const { data, error } = await db.rpc('rotate_outcome_webhook_secret', { p_source_id: sourceId, p_secret: secret })
  if (error) throw new Error(`webhook secret rotation failed: ${error.message}`)
  return data === true ? secret : null
}

/** The enabled webhook source with this id, or null for an unknown, disabled or secretless one. */
export async function resolveWebhookSource(db: SupabaseClient, sourceId: string): Promise<ResolvedWebhookSource | null> {
  const { data, error } = await db.rpc('get_outcome_webhook_source', { p_source_id: sourceId })
  if (error) throw new Error(`webhook source lookup failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : null) as {
    source_id: string; ad_account_id: string; secret: string; timezone_name: string | null; config: unknown
  } | undefined
  if (!row) return null
  return {
    sourceId: row.source_id,
    adAccountId: row.ad_account_id,
    secret: row.secret,
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
