import { REC_THRESHOLDS } from './thresholds'

export interface CampaignOperatingState {
  id: string
  status: string | null
  effectiveStatus: string | null
  lastSyncedAt: string | null
  /** When the entity itself last CHANGED, per Meta — not when we last read it. `lastSyncedAt` is
   *  re-stamped on every sync whether or not anything changed, so it cannot answer "has this been
   *  edited since?". Null = unknown. */
  lastMaterialChangeAt: string | null
}

export interface AdsetOperatingState extends CampaignOperatingState {
  campaignId: string
}

export interface AdOperatingState extends AdsetOperatingState {
  adsetId: string
}

export interface OperatingEntitySnapshot {
  campaigns: Map<string, CampaignOperatingState>
  adsets: Map<string, AdsetOperatingState>
  ads: Map<string, AdOperatingState>
}

export interface RecommendationOperatingTarget {
  recommendationType: string
  targetEntityType: string
  targetEntityId: string | null
}

function normalizedStatus(value: string | null): string {
  return (value ?? '').trim().toUpperCase()
}

function isFresh(lastSyncedAt: string | null, nowMs: number): boolean {
  if (!lastSyncedAt) return false
  const syncedMs = Date.parse(lastSyncedAt)
  if (!Number.isFinite(syncedMs)) return false
  const ageHours = Math.max(0, nowMs - syncedMs) / 3_600_000
  return ageHours <= REC_THRESHOLDS.MAX_DATA_AGE_HOURS
}

function isActivelyDelivering(
  state: Pick<CampaignOperatingState, 'status' | 'effectiveStatus' | 'lastSyncedAt'> | undefined,
  nowMs: number,
): boolean {
  if (!state || !isFresh(state.lastSyncedAt, nowMs)) return false
  return normalizedStatus(state.effectiveStatus ?? state.status) === 'ACTIVE'
}

function isFreshPausedTarget(
  state: Pick<CampaignOperatingState, 'status' | 'effectiveStatus' | 'lastSyncedAt'> | undefined,
  nowMs: number,
): boolean {
  if (!state || !isFresh(state.lastSyncedAt, nowMs)) return false
  return normalizedStatus(state.status) === 'PAUSED'
    && normalizedStatus(state.effectiveStatus ?? state.status) === 'PAUSED'
}

/**
 * Decide whether a recommendation belongs in the CURRENT OPERATING feed.
 *
 * Recommendation lifecycle status is not entity delivery status: a historical flag can remain
 * active for audit/freeze semantics after its ad has been paused. The live dashboard/MCP must not
 * present that row as current operating advice. Historical generation reads intentionally bypass
 * this filter so reports remain reproducible.
 */
export function recommendationTargetsCurrentOperatingEntity(
  recommendation: RecommendationOperatingTarget,
  entities: OperatingEntitySnapshot,
  nowMs: number = Date.now(),
): boolean {
  const { recommendationType, targetEntityType, targetEntityId } = recommendation
  // These targets are operating diagnostics, not Meta delivery entities. Their own authority
  // policy decides whether they are actionable; campaign/ad-set/ad lifecycle checks do not apply.
  if (['account', 'none', 'audience', 'creative'].includes(targetEntityType)) return true
  if (!targetEntityId) return false

  const activating = recommendationType === 'activate'

  if (targetEntityType === 'campaign') {
    const campaign = entities.campaigns.get(targetEntityId)
    return activating
      ? isFreshPausedTarget(campaign, nowMs)
      : isActivelyDelivering(campaign, nowMs)
  }

  if (targetEntityType === 'adset') {
    const adset = entities.adsets.get(targetEntityId)
    if (!adset) return false
    const campaign = entities.campaigns.get(adset.campaignId)
    if (!isActivelyDelivering(campaign, nowMs)) return false
    return activating
      ? isFreshPausedTarget(adset, nowMs)
      : isActivelyDelivering(adset, nowMs)
  }

  if (targetEntityType === 'ad') {
    const ad = entities.ads.get(targetEntityId)
    if (!ad) return false
    const adset = entities.adsets.get(ad.adsetId)
    const campaign = entities.campaigns.get(ad.campaignId)
    if (!adset || adset.campaignId !== ad.campaignId) return false
    if (!isActivelyDelivering(adset, nowMs) || !isActivelyDelivering(campaign, nowMs)) return false
    return activating
      ? isFreshPausedTarget(ad, nowMs)
      : isActivelyDelivering(ad, nowMs)
  }

  return false
}
