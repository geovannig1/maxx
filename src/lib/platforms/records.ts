// Platform-neutral record shapes: what Maxx's core reads from any ad platform, independent of its wire
// format. Each platform maps its own records into these inside its module (Meta:
// src/lib/platforms/meta/records.ts) through the required `records` group of AdPlatform.
//
// Conventions shared by every shape:
//   * ids are the platform's own ids, as strings;
//   * money is in MAJOR units of the ad account's currency (the platform converts its own minor or
//     offset units first), null when the platform did not report it;
//   * a metric the platform did not report is null, never 0;
//   * platform-modelled conversions are deliberately absent: they depend on each platform's attribution
//     windows and event naming, and stay with the platform's own evidence (see docs/platforms.md).

/** Configured on/off state, normalised. `other` covers anything the platform reports that is neither. */
export type PlatformEntityStatus = 'active' | 'paused' | 'archived' | 'deleted' | 'other'

interface PlatformEntityBase {
  id: string
  name: string | null
  /** The configured state, normalised. */
  status: PlatformEntityStatus
  /** The platform's own delivery state, unmodified (Meta: effective_status), or null. */
  deliveryStatus: string | null
}

export interface PlatformCampaign extends PlatformEntityBase {
  objective: string | null
  /** Campaign-level budgets (major units); null when the budget is set on the ad sets or unreported. */
  dailyBudget: number | null
  lifetimeBudget: number | null
}

export interface PlatformAdSet extends PlatformEntityBase {
  campaignId: string
  dailyBudget: number | null
  lifetimeBudget: number | null
  /** What delivery optimises for, in the platform's own vocabulary, or null. */
  optimizationGoal: string | null
}

export interface PlatformAd extends PlatformEntityBase {
  campaignId: string
  adSetId: string
  creativeId: string | null
}

export interface PlatformCreative {
  id: string
  name: string | null
  /** Primary text, headline and destination, when the creative carries them. */
  body: string | null
  title: string | null
  linkUrl: string | null
  imageUrl: string | null
  videoId: string | null
  thumbnailUrl: string | null
  callToAction: string | null
}

export type PlatformInsightLevel = 'account' | 'campaign' | 'adset' | 'ad'

/** One row of delivery over a date range (a day when daily). */
export interface PlatformInsightRow {
  dateStart: string
  dateStop: string
  campaignId: string | null
  adSetId: string | null
  adId: string | null
  spend: number | null
  impressions: number | null
  reach: number | null
  frequency: number | null
  /** Every click the platform counts. */
  clicks: number | null
  /** Clicks that went to the destination (Meta: inline link clicks). Never the same as `clicks`. */
  linkClicks: number | null
}
