import { readNameHint, resolveAudience, TARGETING_STALE_HOURS, type AudienceRef, type AudienceResolution } from '@/lib/audience/resolver'
import { resolveObservedOptimizationEvent } from '@/lib/diagnostics/launch-performance'
import type {
  ActiveAdWrapperEvidence, AudienceHealthEvidence, LandingDestinationEvidence,
  MetaSetupEvidenceInput, MetaSetupEvidenceProjection, SetupAdRow, SetupAdsetEvidence,
  SetupAdsetRow, SetupCampaignEvidence, SetupCreativeRow, SetupEvidenceBlockerCode,
} from '@/lib/report/setup-evidence-types'
import { governedMaterialChange } from '@/lib/report/setup-evidence-change'
import { coldWarmConfigurationBlockers } from '@/lib/report/setup-evidence-comparison'

export type {
  ActiveAdWrapperEvidence,
  AudienceHealthEvidence,
  MetaSetupEvidenceInput,
  MetaSetupEvidenceProjection,
  SetupAdRow,
  SetupAdsetRow,
  SetupCampaignRow,
  SetupCreativeRow,
  SetupEvidenceBlockerCode,
} from '@/lib/report/setup-evidence-types'
import type { LatestSetupMaterialChangeV1 } from '@/lib/setup-history'

const PLACEMENT_KEYS = [
  'publisher_platforms',
  'facebook_positions',
  'instagram_positions',
  'messenger_positions',
  'audience_network_positions',
  'device_platforms',
] as const

const GOVERNED_ROLE_SOURCES = new Set(['campaign_plan', 'owner_declared'])

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[]
}

function active(status: string | null, effectiveStatus: string | null): boolean {
  return (effectiveStatus ?? status)?.trim().toUpperCase() === 'ACTIVE'
}

function finiteTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function freshAt(value: string | null, asOfMs: number): boolean {
  const time = finiteTimestamp(value)
  if (time === null || !Number.isFinite(asOfMs)) return false
  const hours = (asOfMs - time) / 3_600_000
  return hours >= 0 && hours <= TARGETING_STALE_HOURS
}

function statusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') return null
  const rawCode = (value as Record<string, unknown>).code
  if (
    (typeof rawCode !== 'number' && typeof rawCode !== 'string')
    || (typeof rawCode === 'string' && rawCode.trim() === '')
  ) return null
  const code = Number(rawCode)
  return Number.isFinite(code) ? code : null
}

function audienceHealth(
  ref: AudienceRef,
  input: MetaSetupEvidenceInput,
  asOfMs: number,
): AudienceHealthEvidence {
  const operation = statusCode(ref.operationStatus)
  const delivery = statusCode(ref.deliveryStatus)
  const lower = typeof ref.approximateCountLowerBound === 'number'
    && ref.approximateCountLowerBound >= 0 ? ref.approximateCountLowerBound : null
  const upper = typeof ref.approximateCountUpperBound === 'number'
    && ref.approximateCountUpperBound >= 0 ? ref.approximateCountUpperBound : null
  let status: AudienceHealthEvidence['status'] = 'ready'
  let reason: string | null = null

  if (!input.audience_inventory.read_available) {
    status = 'unknown'
    reason = input.audience_inventory.reason ?? 'Audience inventory read unavailable.'
  } else if (ref.accountId !== input.meta_account_id) {
    status = ref.accountId === null ? 'unknown' : 'cross_account'
    reason = ref.accountId === null ? 'Owning account is unknown.' : 'Audience belongs to another Meta account.'
  } else if (!freshAt(ref.lastSyncedAt ?? null, asOfMs)) {
    status = 'stale'
    reason = 'Audience inventory is stale or has no valid observation time.'
  } else if ((operation !== null && operation !== 200) || (delivery !== null && delivery !== 200)) {
    status = 'failed'
    reason = `Audience is not ready (operation ${operation ?? 'unknown'}, delivery ${delivery ?? 'unknown'}).`
  } else if (operation === null || delivery === null) {
    status = 'unknown'
    reason = `Audience readiness status is unknown (operation ${operation ?? 'unknown'}, delivery ${delivery ?? 'unknown'}).`
  } else if (ref.subtype === null || lower === null || upper === null) {
    status = 'unknown'
    reason = ref.subtype === null ? 'Audience subtype is unknown.' : 'Audience size is unavailable or invalid.'
  }

  return {
    id: ref.id,
    name: ref.name,
    subtype: ref.subtype,
    source_audience_id: ref.sourceAudienceId ?? null,
    source_audience_name: ref.sourceAudienceName ?? null,
    approximate_count_lower_bound: lower,
    approximate_count_upper_bound: upper,
    retention_days: ref.retentionDays ?? null,
    operation_status_code: operation,
    delivery_status_code: delivery,
    last_synced_at: ref.lastSyncedAt ?? null,
    status,
    reason,
  }
}

function rawAudienceIds(targeting: Record<string, unknown> | null, key: string): string[] {
  if (!targeting || !Array.isArray(targeting[key])) return []
  return uniqueSorted((targeting[key] as unknown[]).map((raw) => {
    if (raw && typeof raw === 'object') return String((raw as Record<string, unknown>).id ?? '')
    return String(raw ?? '')
  }).filter(Boolean))
}

function projectAudience(
  adset: SetupAdsetRow,
  input: MetaSetupEvidenceInput,
  asOfMs: number,
) {
  const referencedIds = uniqueSorted([
    ...rawAudienceIds(adset.targeting, 'custom_audiences'),
    ...rawAudienceIds(adset.targeting, 'excluded_custom_audiences'),
  ])
  const health = referencedIds.map((id) => audienceHealth(
    input.audiences_by_id[id] ?? { id, name: null, subtype: null, accountId: null },
    input,
    asOfMs,
  ))
  const resolved = resolveAudience({
    adsetName: adset.adset_name,
    targeting: adset.targeting,
    targetingSyncedAt: adset.targeting_last_synced_at,
    accountId: input.meta_account_id,
    audiencesById: input.audiences_by_id,
  }, asOfMs)
  const unhealthy = health.some((row) => row.status !== 'ready')
  const mustFreeze = !input.audience_inventory.read_available || resolved.frozen || unhealthy
  const resolution: AudienceResolution = mustFreeze ? {
    ...resolved,
    composition: 'unknown',
    confidence: 0,
    unknownReason: !input.audience_inventory.read_available
      ? input.audience_inventory.reason ?? 'audience inventory unavailable'
      : 'one or more referenced audiences are unhealthy, stale, or unresolved',
    frozen: true,
    evidence: [...resolved.evidence, 'audience inventory failed the projection health gate — comparison conclusions frozen'],
  } : resolved
  return { ...resolution, health, inventory_read: input.audience_inventory }
}

function placements(adset: SetupAdsetRow, asOfMs: number): SetupAdsetEvidence['placements'] {
  if (!adset.targeting || !freshAt(adset.targeting_last_synced_at, asOfMs)) {
    return { mode: 'unknown', selected: {} }
  }
  const selected: Record<string, string[]> = {}
  for (const key of PLACEMENT_KEYS) {
    const value = adset.targeting[key]
    if (Array.isArray(value) && value.length > 0) selected[key] = value.map(String).sort()
  }
  return { mode: Object.keys(selected).length > 0 ? 'manual' : 'advantage_plus', selected }
}

function normalizeAttribution(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null
}

function campaignEvidence(
  campaign: MetaSetupEvidenceInput['campaigns'][number],
  relatedAdsets: SetupAdsetRow[],
): SetupCampaignEvidence {
  const hasCampaignBudget = campaign.daily_budget !== null || campaign.lifetime_budget !== null
  const hasAdsetBudget = relatedAdsets.some((row) => row.daily_budget !== null || row.lifetime_budget !== null)
  return {
    meta_campaign_id: campaign.campaign_id,
    name: campaign.campaign_name,
    objective: campaign.objective,
    buying_type: campaign.buying_type,
    special_ad_category: campaign.special_ad_category,
    budget_control: hasCampaignBudget ? 'cbo' : hasAdsetBudget ? 'abo' : 'unknown',
    budget: { daily_amount: campaign.daily_budget, lifetime_amount: campaign.lifetime_budget },
    advantage_plus_campaign: campaign.advantage_plus_campaign === true
      ? 'enabled' : campaign.advantage_plus_campaign === false ? 'disabled' : 'unknown',
    last_synced_at: campaign.last_synced_at,
  }
}

function nestedLink(value: Record<string, unknown> | null): string | null {
  if (!value) return null
  const nestedObjects = [value.link_data, value.video_data, value.template_data]
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
  for (const row of nestedObjects) {
    if (typeof row.link === 'string' && row.link.trim()) return row.link
    const cta = row.call_to_action
    if (cta && typeof cta === 'object') {
      const ctaValue = (cta as Record<string, unknown>).value
      if (ctaValue && typeof ctaValue === 'object') {
        const link = (ctaValue as Record<string, unknown>).link
        if (typeof link === 'string' && link.trim()) return link
      }
    }
  }
  return null
}

function destination(ad: SetupAdRow, creative: SetupCreativeRow | null): LandingDestinationEvidence {
  const adLevelAvailable = ad.destination_url_read_available === true
  const storyLink = nestedLink(creative?.object_story_spec ?? null)
  const currentAdUrl = adLevelAvailable ? ad.destination_url : null
  const url = currentAdUrl || creative?.link_url || storyLink || null
  const source: LandingDestinationEvidence['source'] = currentAdUrl
    ? 'ad_destination_url' : creative?.link_url ? 'creative_link_url' : storyLink ? 'object_story_spec' : 'unknown'
  const urlTags = adLevelAvailable ? (ad.url_tags || creative?.url_tags || null) : null
  const hasUtm = !!urlTags || !!url?.match(/[?&]utm_[a-z_]+=/i)
  return {
    url,
    source,
    url_tags: urlTags,
    // A creative URL is only a fallback candidate when the ad-level destination read failed: a
    // preserved override may exist. Do not claim the current destination or UTM state in that case.
    utm_status: adLevelAvailable && url ? (hasUtm ? 'present' : 'missing') : 'unknown',
    ad_level_read_available: adLevelAvailable,
    ad_level_synced_at: ad.destination_url_synced_at ?? null,
  }
}

function mediaIdentity(creative: SetupCreativeRow | null): {
  key: string | null
  kind: ActiveAdWrapperEvidence['underlying_media']['media_kind']
} {
  if (!creative) return { key: null, kind: 'unknown' }
  if (creative.video_id) return { key: `video:${creative.video_id}`, kind: 'video' }
  if (creative.image_hash) return { key: `image:${creative.image_hash}`, kind: 'image' }
  if (creative.asset_type?.toLowerCase().includes('carousel')) return { key: null, kind: 'carousel' }
  return { key: null, kind: 'unknown' }
}

function relationshipToChange(ad: SetupAdRow, change: LatestSetupMaterialChangeV1) {
  if (change.status !== 'known') return 'unknown' as const
  const created = finiteTimestamp(ad.meta_created_time)
  const changed = finiteTimestamp(change.occurredAt)
  if (created === null || changed === null) return 'unknown' as const
  return created >= changed ? 'created_at_or_after' as const : 'predates' as const
}

function identitySummary(
  relationship: ActiveAdWrapperEvidence['wrapper_relationship_to_latest_change'],
  status: ActiveAdWrapperEvidence['underlying_media']['status'],
  predates: boolean | null,
): ActiveAdWrapperEvidence['identity_summary'] {
  if (relationship === 'unknown' || status === 'unknown') return 'identity_unknown'
  if (relationship === 'created_at_or_after') {
    if (status === 'reused') return predates === true ? 'new_wrapper_reused_media' : 'new_wrapper_shared_media'
    return 'new_wrapper_media_reuse_not_observed'
  }
  return status === 'reused' ? 'existing_wrapper_reused_media' : 'existing_wrapper_media_reuse_not_observed'
}

/**
 * Pure, diagnostic-only projection of the current Meta setup. It never recommends or executes a
 * change. Unknown inventory, targeting, overlap, or change provenance blocks comparison claims.
 */
export function projectMetaSetupEvidence(input: MetaSetupEvidenceInput): MetaSetupEvidenceProjection {
  const asOfMs = Date.parse(input.as_of)
  const latestMaterialChange = governedMaterialChange(input.latest_material_change)
  const blockers: SetupEvidenceBlockerCode[] = []
  const activeCampaignRows = input.campaigns.filter((row) => active(row.status, row.effective_status))
  const activeCampaignDbIds = new Set(activeCampaignRows.map((row) => row.id))
  const activeAdsetRows = input.adsets.filter((row) => active(row.status, row.effective_status) && activeCampaignDbIds.has(row.campaign_id))
  const activeAdsetDbIds = new Set(activeAdsetRows.map((row) => row.id))
  const activeAdRows = input.ads.filter((row) => active(row.status, row.effective_status) && activeAdsetDbIds.has(row.adset_id))
  const campaignByDbId = new Map(activeCampaignRows.map((row) => [row.id, row]))
  const adsetByDbId = new Map(activeAdsetRows.map((row) => [row.id, row]))
  const creativeByDbId = new Map(input.creatives.map((row) => [row.id, row]))
  const creativeByMetaId = new Map(input.creatives.map((row) => [row.creative_id, row]))
  const creativeFor = (ad: SetupAdRow) =>
    (ad.creative_id ? creativeByDbId.get(ad.creative_id) : null)
    ?? (ad.meta_creative_id ? creativeByMetaId.get(ad.meta_creative_id) : null)
    ?? null
  const activeCreativeRows = [...new Map(activeAdRows.flatMap((ad) => {
    const creative = creativeFor(ad)
    return creative ? [[creative.id, creative] as const] : []
  })).values()]

  if (activeCampaignRows.length === 0) blockers.push('active_campaign_missing')
  if (activeAdsetRows.length === 0) blockers.push('active_adset_missing')
  if (activeAdRows.length === 0) blockers.push('active_ad_missing')
  if (!input.audience_inventory.read_available) blockers.push('audience_inventory_read_failed')
  if (latestMaterialChange.status === 'unknown') {
    blockers.push('latest_material_change_reason_unknown')
  }

  const campaigns = activeCampaignRows.map((campaign) => campaignEvidence(
    campaign,
    activeAdsetRows.filter((adset) => adset.campaign_id === campaign.id),
  )).sort((a, b) => a.meta_campaign_id.localeCompare(b.meta_campaign_id))
  if (campaigns.some((row) => !row.objective)) blockers.push('objective_unknown')
  if (campaigns.some((row) => row.budget_control === 'unknown')) blockers.push('budget_unknown')
  if (campaigns.some((row) => row.advantage_plus_campaign === 'unknown')) {
    blockers.push('campaign_advantage_plus_unknown')
  }

  const adsets = activeAdsetRows.map((row): SetupAdsetEvidence => {
    const campaign = campaignByDbId.get(row.campaign_id)
    const audience = projectAudience(row, input, asOfMs)
    const placement = placements(row, asOfMs)
    const nameHint = readNameHint(row.adset_name)
    const role = row.comparison_role ?? (nameHint === 'none' ? null : nameHint)
    const roleSource = row.comparison_role_source ?? (role ? 'display_name_hint' : null)
    return {
      meta_adset_id: row.adset_id,
      meta_campaign_id: campaign?.campaign_id ?? '',
      name: row.adset_name,
      comparison_role: role,
      comparison_role_source: roleSource,
      objective: campaign?.objective ?? null,
      optimization_goal: row.optimization_goal,
      optimization_event: resolveObservedOptimizationEvent(row.optimization_goal, row.promoted_object),
      attribution_spec: normalizeAttribution(row.attribution_spec),
      budget: { daily_amount: row.daily_budget, lifetime_amount: row.lifetime_budget },
      bid: { strategy: row.bid_strategy, amount: row.bid_amount },
      placements: placement,
      advantage_plus: {
        audience: audience.expansion,
        placements: placement.mode === 'advantage_plus' ? 'enabled' : placement.mode === 'manual' ? 'disabled' : 'unknown',
        observed_targeting_relaxations: row.targeting_optimization_types,
      },
      audience,
      learning_stage: row.learning_stage,
      latest_significant_edit_at: row.last_sig_edit_ts,
      last_synced_at: row.last_synced_at,
    }
  }).sort((a, b) => (a.name ?? a.meta_adset_id).localeCompare(b.name ?? b.meta_adset_id))

  if (adsets.some((row) => !row.optimization_event)) blockers.push('optimization_event_unknown')
  if (adsets.some((row) => row.attribution_spec === null)) blockers.push('attribution_unknown')
  if (adsets.some((row) => !row.bid.strategy)) blockers.push('bid_strategy_unknown')
  if (adsets.some((row) => row.placements.mode === 'unknown')) blockers.push('placements_unknown')
  if (adsets.some((row) => row.audience.frozen)) blockers.push('audience_targeting_unavailable_or_stale')
  if (adsets.some((row) => row.advantage_plus.observed_targeting_relaxations === null)) {
    blockers.push('targeting_relaxations_unknown')
  }
  if (adsets.some((row) => row.audience.health.some((health) => health.status !== 'ready'))) blockers.push('audience_reference_unhealthy')
  if ([...activeCampaignRows, ...activeAdsetRows, ...activeAdRows, ...activeCreativeRows]
    .some((row) => !freshAt(row.last_synced_at, asOfMs))) {
    blockers.push('setup_snapshot_stale')
  }

  const allMedia = new Map<string, SetupAdRow[]>()
  for (const ad of input.ads) {
    const media = mediaIdentity(creativeFor(ad))
    if (!media.key) continue
    allMedia.set(media.key, [...(allMedia.get(media.key) ?? []), ad])
  }
  const activeWrappers = activeAdRows.map((ad): ActiveAdWrapperEvidence => {
    const creative = creativeFor(ad)
    const media = mediaIdentity(creative)
    const group = media.key ? (allMedia.get(media.key) ?? []) : []
    const others = group.filter((row) => row.ad_id !== ad.ad_id).sort((a, b) => a.ad_id.localeCompare(b.ad_id))
    const relationship = relationshipToChange(ad, latestMaterialChange)
    let predates: boolean | null = null
    if (latestMaterialChange.status === 'known') {
      const changed = finiteTimestamp(latestMaterialChange.occurredAt)
      const observed = others.map((row) => finiteTimestamp(row.meta_created_time))
      predates = changed === null || observed.some((time) => time === null)
        ? null : observed.some((time) => time! < changed)
    }
    const mediaStatus = !media.key ? 'unknown' : others.length > 0 ? 'reused' : 'not_observed_reused'
    return {
      meta_ad_id: ad.ad_id,
      meta_adset_id: adsetByDbId.get(ad.adset_id)?.adset_id ?? '',
      name: ad.ad_name,
      meta_creative_id: ad.meta_creative_id,
      concept_id: ad.creative_angle,
      wrapper_created_at: ad.meta_created_time,
      wrapper_updated_at: ad.meta_updated_time,
      wrapper_relationship_to_latest_change: relationship,
      landing_destination: destination(ad, creative),
      underlying_media: {
        status: mediaStatus,
        media_key: media.key,
        media_kind: media.kind,
        other_meta_ad_ids: others.map((row) => row.ad_id),
        predates_latest_change: predates,
      },
      identity_summary: identitySummary(relationship, mediaStatus, predates),
    }
  }).sort((a, b) => a.meta_ad_id.localeCompare(b.meta_ad_id))

  if (activeWrappers.some((row) => row.landing_destination.url === null)) blockers.push('landing_destination_unknown')
  if (activeWrappers.some((row) => !row.landing_destination.ad_level_read_available)) {
    blockers.push('ad_destination_read_unavailable')
  }
  if (activeWrappers.some((row) => row.meta_creative_id === null || row.underlying_media.status === 'unknown')) blockers.push('creative_identity_unknown')
  if (latestMaterialChange.status === 'known'
    && activeWrappers.some((row) => row.wrapper_relationship_to_latest_change === 'unknown')) {
    blockers.push('wrapper_change_relationship_unknown')
  }

  const group = (pairs: Array<[string | null, string]>) => {
    const result = new Map<string, string[]>()
    for (const [key, id] of pairs) if (key) result.set(key, [...(result.get(key) ?? []), id])
    return result
  }
  const creativeGroups = group(activeWrappers.map((row) => [row.meta_creative_id, row.meta_ad_id]))
  const conceptGroups = group(activeWrappers.map((row) => [row.concept_id, row.meta_ad_id]))
  const activeMediaKeys = activeWrappers
    .map((row) => row.underlying_media.media_key)
    .filter((key): key is string => key !== null)
  const activeMediaIdentityComplete = activeMediaKeys.length === activeWrappers.length
  const activeIds = new Set(activeWrappers.map((row) => row.meta_ad_id))
  const reusedMediaGroups = [...allMedia.entries()].filter(([, rows]) =>
    rows.length > 1 && rows.some((row) => activeIds.has(row.ad_id)),
  ).map(([mediaKey, rows]) => ({
    media_key: mediaKey,
    meta_ad_ids: uniqueSorted(rows.map((row) => row.ad_id)),
    spans_active_adsets: new Set(rows.filter((row) => activeIds.has(row.ad_id)).map((row) => row.adset_id)).size > 1,
  })).sort((a, b) => a.media_key.localeCompare(b.media_key))

  const warm = adsets.filter((row) => row.comparison_role === 'warm')
  const cold = adsets.filter((row) => row.comparison_role === 'cold')
  const comparisonBlockers: SetupEvidenceBlockerCode[] = []
  if (!input.audience_inventory.read_available) comparisonBlockers.push('audience_inventory_read_failed')
  if (blockers.includes('campaign_advantage_plus_unknown')) {
    comparisonBlockers.push('campaign_advantage_plus_unknown')
  }
  if (blockers.includes('latest_material_change_reason_unknown')) comparisonBlockers.push('latest_material_change_reason_unknown')
  if (blockers.includes('wrapper_change_relationship_unknown')) comparisonBlockers.push('wrapper_change_relationship_unknown')
  if (warm.length !== 1 || cold.length !== 1) comparisonBlockers.push('comparison_role_cardinality')
  const roleBasis = warm.length === 1 && cold.length === 1
    ? GOVERNED_ROLE_SOURCES.has(warm[0].comparison_role_source ?? '')
      && GOVERNED_ROLE_SOURCES.has(cold[0].comparison_role_source ?? '') ? 'governed' : 'display_name_only'
    : 'unresolved'
  if (roleBasis === 'display_name_only') comparisonBlockers.push('comparison_roles_unverified')
  if (warm.length === 1 && cold.length === 1) {
    const compared = [warm[0], cold[0]]
    comparisonBlockers.push(...coldWarmConfigurationBlockers(compared))
    if (compared.some((row) => row.audience.frozen)) comparisonBlockers.push('audience_targeting_unavailable_or_stale')
    if (compared.some((row) => row.audience.health.some((health) => health.status !== 'ready'))) comparisonBlockers.push('audience_reference_unhealthy')
    if (compared.some((row) => row.audience.expansion === 'enabled')) comparisonBlockers.push('audience_expansion_enabled')
    if (compared.some((row) => row.audience.expansion === 'unknown')) comparisonBlockers.push('audience_expansion_unknown')
    if (warm[0].audience.composition !== 'retargeting_only') comparisonBlockers.push('warm_inventory_not_pure')
    if (!['broad_advantage', 'lookalike'].includes(cold[0].audience.composition)) comparisonBlockers.push('cold_inventory_not_prospecting')
    const warmRow = activeAdsetRows.find((row) => row.adset_id === warm[0].meta_adset_id)!
    const coldRow = activeAdsetRows.find((row) => row.adset_id === cold[0].meta_adset_id)!
    const warmIncluded = rawAudienceIds(warmRow.targeting, 'custom_audiences')
    const coldIncluded = new Set(rawAudienceIds(coldRow.targeting, 'custom_audiences'))
    const coldExcluded = new Set(rawAudienceIds(coldRow.targeting, 'excluded_custom_audiences'))
    if (warmIncluded.length === 0 || warmIncluded.some((id) => !coldExcluded.has(id) || coldIncluded.has(id))) {
      comparisonBlockers.push('cold_warm_overlap_not_excluded')
    }
  }
  blockers.push(...comparisonBlockers)
  const finalBlockers = uniqueSorted(blockers)
  const finalComparisonBlockers = uniqueSorted(comparisonBlockers)
  const knownConcepts = activeWrappers.map((row) => row.concept_id).filter((id): id is string => id !== null)

  return {
    contract_version: 1,
    as_of: input.as_of,
    ad_account_db_id: input.ad_account_db_id,
    meta_account_id: input.meta_account_id,
    status: finalBlockers.length === 0 ? 'available' : 'blocked',
    complete: finalBlockers.length === 0,
    blocker_codes: finalBlockers,
    campaigns,
    adsets,
    active_ad_wrappers: activeWrappers,
    creative_reuse: {
      distinct_active_ad_wrappers: activeWrappers.length,
      distinct_active_meta_creative_ids: new Set(activeWrappers.map((row) => row.meta_creative_id).filter(Boolean)).size,
      distinct_active_media: activeMediaIdentityComplete ? new Set(activeMediaKeys).size : null,
      concept_coverage_complete: knownConcepts.length === activeWrappers.length,
      distinct_known_concepts: knownConcepts.length === 0 ? null : new Set(knownConcepts).size,
      reused_meta_creative_id_groups: [...creativeGroups.entries()].filter(([, ids]) => ids.length > 1)
        .map(([metaCreativeId, ids]) => ({ meta_creative_id: metaCreativeId, meta_ad_ids: uniqueSorted(ids) })),
      reused_media_groups: reusedMediaGroups,
      reused_concept_groups: [...conceptGroups.entries()].filter(([, ids]) => ids.length > 1)
        .map(([conceptId, ids]) => ({ concept_id: conceptId, meta_ad_ids: uniqueSorted(ids) })),
    },
    cold_warm_comparison: {
      status: finalComparisonBlockers.length === 0 ? 'clean' : 'blocked',
      cold_meta_adset_id: cold.length === 1 ? cold[0].meta_adset_id : null,
      warm_meta_adset_id: warm.length === 1 ? warm[0].meta_adset_id : null,
      role_basis: roleBasis,
      blocker_codes: finalComparisonBlockers,
    },
    latest_material_change: latestMaterialChange,
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
  }
}
