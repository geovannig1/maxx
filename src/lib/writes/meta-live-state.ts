import type { GovernedWriteRequest } from './write-authority'

export type LiveWriteAction = GovernedWriteRequest['actionType']

export const META_SNAPSHOT_CONTRACT_VERSION = 1
const META_ENTITY_ID = /^[A-Za-z0-9_-]{1,128}$/

const AD_FIELDS = 'id,account_id,adset_id,campaign_id,name,status'
const ADSET_FIELDS = [
  'id', 'account_id', 'campaign_id', 'name', 'status',
  'daily_budget', 'lifetime_budget', 'bid_strategy', 'bid_amount',
  'billing_event', 'optimization_goal', 'targeting', 'promoted_object',
  'attribution_spec', 'destination_type', 'start_time', 'end_time',
].join(',')

export function fieldsForWriteSnapshot(actionType: LiveWriteAction): string {
  return actionType === 'pause_ad' || actionType === 'activate_ad' ? AD_FIELDS : ADSET_FIELDS
}

export function expectedEntityLevel(actionType: LiveWriteAction): 'ad' | 'adset' {
  return actionType === 'pause_ad' || actionType === 'activate_ad' ? 'ad' : 'adset'
}

export function isSafeMetaEntityId(value: unknown): value is string {
  return typeof value === 'string' && META_ENTITY_ID.test(value)
}

export function normalizeMetaAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^act_/, '')
  return normalized.length > 0 ? normalized : null
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalValue(value: unknown): unknown {
  return value === undefined ? null : value
}

/**
 * Project Meta's response to the exact state the owner approves. Volatile delivery fields are
 * deliberately excluded; configured status/parents/account and the mutation-relevant settings are
 * retained. A projection failure is a hard stop, never an "unknown" approval preview.
 */
export function projectWriteSnapshot(
  actionType: LiveWriteAction,
  entityId: string,
  raw: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!isSafeMetaEntityId(entityId) || !raw || requiredString(raw.id) !== entityId) return null
  const accountId = normalizeMetaAccountId(raw.account_id)
  const status = requiredString(raw.status)
  if (!accountId || !status) return null

  if (actionType === 'pause_ad' || actionType === 'activate_ad') {
    const adsetId = requiredString(raw.adset_id)
    const campaignId = requiredString(raw.campaign_id)
    if (!adsetId || !campaignId) return null
    return {
      snapshot_contract_version: META_SNAPSHOT_CONTRACT_VERSION,
      entity_level: 'ad',
      id: entityId,
      account_id: accountId,
      adset_id: adsetId,
      campaign_id: campaignId,
      name: optionalValue(raw.name),
      status,
    }
  }

  const campaignId = requiredString(raw.campaign_id)
  if (!campaignId) return null
  if (actionType === 'adjust_budget' && raw.daily_budget == null) return null
  return {
    snapshot_contract_version: META_SNAPSHOT_CONTRACT_VERSION,
    entity_level: 'adset',
    id: entityId,
    account_id: accountId,
    campaign_id: campaignId,
    name: optionalValue(raw.name),
    status,
    daily_budget: optionalValue(raw.daily_budget),
    lifetime_budget: optionalValue(raw.lifetime_budget),
    bid_strategy: optionalValue(raw.bid_strategy),
    bid_amount: optionalValue(raw.bid_amount),
    billing_event: optionalValue(raw.billing_event),
    optimization_goal: optionalValue(raw.optimization_goal),
    targeting: optionalValue(raw.targeting),
    promoted_object: optionalValue(raw.promoted_object),
    attribution_spec: optionalValue(raw.attribution_spec),
    destination_type: optionalValue(raw.destination_type),
    start_time: optionalValue(raw.start_time),
    end_time: optionalValue(raw.end_time),
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

export function writeSnapshotsMatch(
  approved: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): boolean {
  if (!approved || !current) return false
  return JSON.stringify(canonical(approved)) === JSON.stringify(canonical(current))
}

export function snapshotHasExpectedOwnership(
  snapshot: Record<string, unknown> | null,
  actionType: LiveWriteAction,
  entityId: string,
  metaAccountId: string,
): boolean {
  return !!snapshot
    && snapshot.snapshot_contract_version === META_SNAPSHOT_CONTRACT_VERSION
    && snapshot.entity_level === expectedEntityLevel(actionType)
    && snapshot.id === entityId
    && normalizeMetaAccountId(snapshot.account_id) === normalizeMetaAccountId(metaAccountId)
}
