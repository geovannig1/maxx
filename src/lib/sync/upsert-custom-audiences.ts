import { getAdminClient } from '@/lib/supabase/admin'
import type { MetaCustomAudience } from '@/types/meta-api'

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function metaTimestamp(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null

  const numeric = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null
  const timestampMs = numeric === null
    ? Date.parse(raw)
    : numeric < 100_000_000_000 ? numeric * 1000 : numeric
  if (!Number.isFinite(timestampMs)) return null

  const parsed = new Date(timestampMs)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function lookalikeOrigin(spec: Record<string, unknown> | undefined): {
  id: string | null
  name: string | null
} {
  if (!spec) return { id: null, name: null }
  const rawOrigin = Array.isArray(spec.origin) ? spec.origin[0] : spec.origin
  const origin = rawOrigin && typeof rawOrigin === 'object'
    ? rawOrigin as Record<string, unknown>
    : null
  return {
    id: text(origin?.id ?? spec.origin_audience_id),
    name: text(origin?.name ?? spec.origin_audience_name),
  }
}

export function buildCustomAudienceRow(
  audience: MetaCustomAudience,
  ctx: { adAccountDbId: string; metaAccountId: string; now: string },
) {
  const origin = lookalikeOrigin(audience.lookalike_spec)
  return {
    ad_account_id: ctx.adAccountDbId,
    audience_id: audience.id,
    name: audience.name ?? null,
    subtype: audience.subtype ?? null,
    // The collection endpoint is account-scoped, so its requested account is the trusted owner.
    meta_account_id: ctx.metaAccountId,
    source_audience_id: origin.id,
    source_audience_name: origin.name,
    approximate_count: finiteNumber(audience.approximate_count),
    approximate_count_lower_bound: finiteNumber(audience.approximate_count_lower_bound),
    approximate_count_upper_bound: finiteNumber(audience.approximate_count_upper_bound),
    retention_days: finiteNumber(audience.retention_days),
    lookalike_spec: audience.lookalike_spec ?? null,
    operation_status: audience.operation_status ?? null,
    delivery_status: audience.delivery_status ?? null,
    meta_updated_at: metaTimestamp(audience.time_updated),
    last_synced_at: ctx.now,
  }
}

export async function upsertCustomAudiences(
  adAccountDbId: string,
  metaAccountId: string,
  audiences: MetaCustomAudience[],
): Promise<number> {
  const now = new Date().toISOString()
  const rows = audiences.map((audience) => buildCustomAudienceRow(audience, {
    adAccountDbId,
    metaAccountId,
    now,
  }))
  const { data, error } = await getAdminClient().rpc('replace_custom_audience_inventory', {
    p_ad_account_id: adAccountDbId,
    p_meta_account_id: metaAccountId,
    p_rows: rows,
    p_completed_at: now,
  })
  if (error) throw new Error(`replaceCustomAudienceInventory failed: ${error.message}`)
  const count = Number(data)
  if (!Number.isSafeInteger(count) || count < 0 || count !== rows.length) {
    throw new Error('replaceCustomAudienceInventory returned an invalid row count')
  }
  return count
}
