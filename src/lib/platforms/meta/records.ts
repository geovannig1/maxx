import type { MetaAd, MetaAdSet, MetaCampaign, MetaCreative, MetaInsightRow } from '@/types/meta-api'
import type {
  PlatformAd,
  PlatformAdSet,
  PlatformCampaign,
  PlatformCreative,
  PlatformEntityStatus,
  PlatformInsightRow,
} from '../records'

// Meta's wire records mapped into the platform-neutral shapes (../records.ts). Pure.
//
// Budgets: Meta's fetchers (fetch-campaigns.ts, fetch-adsets.ts) already convert daily_budget and
// lifetime_budget from Meta's offset units into major units of the account currency, so a budget here is
// read as a major-unit decimal string. Insight metrics arrive as decimal strings.

const STATUS: Readonly<Record<string, PlatformEntityStatus>> = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
}

function status(value: string | undefined): PlatformEntityStatus {
  return (value && Object.hasOwn(STATUS, value) ? STATUS[value] : undefined) ?? 'other'
}

/** A reported decimal string as a finite number; null when absent, empty or not a number. */
function metric(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const text = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value)

export function metaCampaignRecord(campaign: MetaCampaign): PlatformCampaign {
  return {
    id: campaign.id,
    name: text(campaign.name),
    status: status(campaign.status),
    deliveryStatus: text(campaign.effective_status),
    objective: text(campaign.objective),
    dailyBudget: metric(campaign.daily_budget),
    lifetimeBudget: metric(campaign.lifetime_budget),
  }
}

export function metaAdSetRecord(adSet: MetaAdSet): PlatformAdSet {
  return {
    id: adSet.id,
    name: text(adSet.name),
    status: status(adSet.status),
    deliveryStatus: text(adSet.effective_status),
    campaignId: adSet.campaign_id,
    dailyBudget: metric(adSet.daily_budget),
    lifetimeBudget: metric(adSet.lifetime_budget),
    optimizationGoal: text(adSet.optimization_goal),
  }
}

export function metaAdRecord(ad: MetaAd): PlatformAd {
  return {
    id: ad.id,
    name: text(ad.name),
    status: status(ad.status),
    deliveryStatus: text(ad.effective_status),
    campaignId: ad.campaign_id,
    adSetId: ad.adset_id,
    creativeId: text(ad.creative?.id),
  }
}

export function metaCreativeRecord(creative: MetaCreative): PlatformCreative {
  return {
    id: creative.id,
    name: text(creative.name),
    body: text(creative.body),
    title: text(creative.title),
    linkUrl: text(creative.link_url),
    imageUrl: text(creative.image_url),
    videoId: text(creative.video_id),
    thumbnailUrl: text(creative.thumbnail_url),
    callToAction: text(creative.call_to_action_type),
  }
}

/** Delivery only: Meta's modelled results (actions, results, conversions) stay in its own evidence. */
export function metaInsightRecord(row: MetaInsightRow): PlatformInsightRow {
  return {
    dateStart: row.date_start,
    dateStop: row.date_stop,
    campaignId: text(row.campaign_id),
    adSetId: text(row.adset_id),
    adId: text(row.ad_id),
    spend: metric(row.spend),
    impressions: metric(row.impressions),
    reach: metric(row.reach),
    frequency: metric(row.frequency),
    clicks: metric(row.clicks),
    linkClicks: metric(row.inline_link_clicks),
  }
}
