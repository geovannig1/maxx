// The ad-platform interface: everything Maxx's core needs from an ad platform.
// Core code (sync, engine, diagnostics, reporting, routes, MCP tools) reaches a platform only through
// getAdPlatform() in ./registry and the types below, never through a platform's own modules.
//
// Only operations the code actually calls are declared. Two groups are required (entities, insights);
// every other group is an optional capability. A platform that lacks one simply omits the group, and
// capabilitiesOf() / requireCapability() in ./registry turn that into flags and a typed refusal.
//
// Record and result SHAPES are Meta's today: Meta is the first implementation and the warehouse
// ingests its wire shapes. They are re-exported here under platform-neutral names so core code does
// not import Meta modules. A second platform maps its records into these shapes; widening them into a
// platform-neutral model is a later, separate change.
//
// Credentials are each platform's own concern: no operation takes a token except conversions.send,
// whose credential the platform itself resolves (conversions.resolveSendCredentials) or, for the
// reference adapter's own sender, the sender resolves and passes.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  MetaAd,
  MetaAdAccount,
  MetaAdSet,
  MetaCampaign,
  MetaCreative,
  MetaCustomAudience,
  MetaInsightRow,
} from '@/types/meta-api'
import type { GovernedWriteRequest } from '@/lib/writes/write-authority'
import type { FetchInsightsParams, FetchNativePeriodDeliveryParams } from './meta/fetch-insights'
import type { BreakdownRow, BreakdownType, fetchBreakdowns } from './meta/fetch-breakdowns'
import type { DaypartInsightRow, fetchDaypartInsights } from './meta/fetch-daypart'
import type { ActiveAdSetBudget, ActiveCampaignBudget, TodayCampaignSpendResult } from './meta/pacing'
import type { CapiResponseVerdict, DeliveryRecordInput, MetaConversionResponse } from './meta/conversions-delivery'
import type { MetaBudgetRow } from './meta/writes'
import type { DatasetStatsResult, fetchDatasetEventVolume } from './meta/fetch-dataset-stats'
import type { DatasetQualityResult, fetchDatasetQuality } from './meta/fetch-dataset-quality'
import type { MetaRecommendation, MetaRecommendationsResult } from './meta/fetch-meta-recommendations'
import type { DeliveryEstimateResult } from './meta/fetch-delivery-estimate'
import type { MetaReportOptions } from './meta/reporting/meta-reader'
import type { MetaReport, ReportSection, ReportingContext } from '@/lib/reporting/contracts'

/** Registered platform ids. Add an id here when a platform is registered in ./registry. */
export type AdPlatformId = 'meta'

// ── Record shapes (Meta wire shapes today; see the header) ─────────────────────────────────────
export type AdAccountRecord = MetaAdAccount
export type CampaignRecord = MetaCampaign
export type AdSetRecord = MetaAdSet
export type AdRecord = MetaAd
export type CreativeRecord = MetaCreative
export type AudienceRecord = MetaCustomAudience
export type InsightRecord = MetaInsightRow
export type InsightsQuery = FetchInsightsParams
export type PeriodDeliveryQuery = FetchNativePeriodDeliveryParams
export type { BreakdownRow, BreakdownType, DaypartInsightRow }
export type BreakdownQuery = Parameters<typeof fetchBreakdowns>[0]
export type DaypartQuery = Parameters<typeof fetchDaypartInsights>[0]
export type { TodayCampaignSpendResult, ActiveCampaignBudget, ActiveAdSetBudget }
export type { CapiResponseVerdict, DeliveryRecordInput }
export type ConversionDeliveryResponse = MetaConversionResponse
export type BudgetRow = MetaBudgetRow
export type WriteAction = GovernedWriteRequest['actionType']
export type { DatasetStatsResult, DatasetQualityResult }
export type DatasetEventVolumeQuery = Parameters<typeof fetchDatasetEventVolume>[0]
export type DatasetQualityQuery = Parameters<typeof fetchDatasetQuality>[0]
export type NativeRecommendation = MetaRecommendation
export type NativeRecommendationsResult = MetaRecommendationsResult
export type { DeliveryEstimateResult }
export type ReportOptions = MetaReportOptions
export type PlatformReport = MetaReport

/** An error raised by a platform's API client, classified the way the sync engine retries and reports. */
export interface AdPlatformApiError extends Error {
  code: number
  subcode?: number
  isTokenError(): boolean
  isRateLimit(): boolean
  isTransient(): boolean
}

// ── Required groups ─────────────────────────────────────────────────────────────────────────────

/** Account structure. Account ids are the platform's own (Meta: `act_<id>` or bare digits). */
export interface EntityReader {
  fetchAccount(accountId: string): Promise<AdAccountRecord>
  fetchCampaigns(accountId: string): Promise<CampaignRecord[]>
  fetchAdSets(accountId: string): Promise<AdSetRecord[]>
  fetchAds(accountId: string): Promise<AdRecord[]>
  fetchCreatives(creativeIds: string[]): Promise<CreativeRecord[]>
  fetchCustomAudiences(accountId: string): Promise<AudienceRecord[]>
}

/** Delivery and results over a date window. */
export interface InsightsReader {
  /** Daily rows at one level of the hierarchy. */
  fetchInsights(query: InsightsQuery): Promise<InsightRecord[]>
  /** One account-level row for the whole window (deduplicated reach and frequency). */
  fetchPeriodDelivery(query: PeriodDeliveryQuery): Promise<InsightRecord[]>
}

// ── Optional capabilities ───────────────────────────────────────────────────────────────────────

/** Intraday spend against budgets (the midday pacing check). */
export interface PacingReader {
  /** A Graph-level error is returned, not thrown; a transport failure throws. */
  fetchTodaySpendByCampaign(accountId: string): Promise<TodayCampaignSpendResult>
  /** Best effort: never throws; returns the rows read before any failure. */
  fetchActiveCampaignBudgets(accountId: string): Promise<ActiveCampaignBudget[]>
  /** A Graph-level error ends paging early; a transport failure throws. */
  fetchActiveAdSetBudgets(accountId: string): Promise<ActiveAdSetBudget[]>
}

/** Delivery split by a breakdown dimension, and its warehouse write. */
export interface BreakdownSource {
  fetch(query: BreakdownQuery): Promise<BreakdownRow[]>
  upsert(adAccountDbId: string, dateStart: string, rows: BreakdownRow[]): Promise<number>
}

/** Hour-of-day / day-of-week delivery, and its warehouse write. */
export interface DaypartSource {
  fetch(query: DaypartQuery): Promise<DaypartInsightRow[]>
  upsert(adAccountDbId: string, since: string, until: string, rows: DaypartInsightRow[]): Promise<number>
}

/** The outcome fields a platform reads to report one outcome as a server-side conversion event. */
export interface ConversionOutcome {
  id: string
  occurred_at: string | null
  gross_value: string | number | null
  currency: string
  email: string | null
  phone: string | null
  first_name: string | null
  last_name: string | null
  /** Browser identifiers captured with the outcome (Meta: the _fbp and _fbc cookies). */
  fbp: string | null
  fbc: string | null
  landing_page: string | null
  /** The sender's browser-pixel event id, when it supplied one; otherwise the platform derives it. */
  conversion_event_id?: string | null
}

export interface ConversionEventOptions { eventName: string; testEventCode?: string | null; nowMs?: number }

/** A built event: the platform's payload plus the neutral fields the delivery record stores. */
export type ConversionEventBuild =
  | { ok: true; payload: Record<string, unknown>; event: { id: string; timeSec: number; value: number | null; currency: string | null } }
  | { ok: false; skip: 'expired' | 'no_event_source_url' | 'no_user_data' }

/** Where and with what credential to send; null when unavailable. */
export interface ConversionSendCredentials { destinationId: string | null; accessToken: string | null }

/** Server-side conversion events (Meta: the Conversions API). */
export interface ConversionsDelivery {
  /** Sends one single-event payload. Never throws; a network failure is its own outcome. */
  send(destinationId: string, accessToken: string, payload: Record<string, unknown>): Promise<ConversionDeliveryResponse>
  /** Decides whether the platform actually accepted the event. Pure. */
  interpretResponse(httpOk: boolean, httpStatus: number, parsed: unknown): CapiResponseVerdict
  /** Persists the delivery attempt atomically and validates what was persisted. */
  recordDelivery(input: DeliveryRecordInput, supabase?: SupabaseClient): Promise<{ ok: boolean; message?: string; errorClass?: string }>
  /** Pure: the platform's event for one outcome, or the terminal reason it cannot be built. */
  buildOutcomeEvent(outcome: ConversionOutcome, options: ConversionEventOptions): ConversionEventBuild
  /** The platform's test event code in this environment, or null (test sending is then off). */
  testEventCode(env: Record<string, string | undefined>): string | null
  /** Destination and credential for sending, read from this environment (and the account when unset). */
  resolveSendCredentials(env: Record<string, string | undefined>): Promise<ConversionSendCredentials>
}

/** Live changes. Only ever called by the write executor after its gates (WRITE_MODE_ENABLED, human
 * approval, expiry, idempotency, ownership, budget bounds) have passed. */
export interface ChangeWriter {
  /** True when a write credential is configured. Reads no network. */
  isConfigured(): boolean
  /** The entity's current fields, or null when unreadable. */
  readEntity(entityId: string, fields: string): Promise<Record<string, unknown> | null>
  /** Every page of active campaign and ad-set budget rows; a list is null when any page failed. */
  readActiveBudgetRows(accountId: string): Promise<{ campaigns: BudgetRow[] | null; adsets: BudgetRow[] | null }>
  /** Applies one already-validated change; partial success is reported as ok with the error attached. */
  apply(action: WriteAction, entityId: string, params: Record<string, unknown>): Promise<{ ok: boolean; response: unknown; newEntityId?: string }>
}

/** Creating a campaign plan's objects (ADR-062). Only the campaign-plan executor calls it, after its
 * gates; every object is created PAUSED and nothing here can set ACTIVE. */
export interface CampaignCreator {
  isConfigured(): boolean
  /** POST one object under an edge (act_<id>/campaigns|adsets|ads|adcreatives). */
  create(edge: string, body: Record<string, string>): Promise<{ ok: true; id: string } | { ok: false; error: { code: string; message?: string; meta_code?: number; meta_subcode?: number } }>
  /** The object under an edge whose name carries the marker; null when none; ok false when unreadable or ambiguous. */
  findMarked(edge: string, marker: string): Promise<{ ok: true; id: string | null } | { ok: false }>
  read(id: string, fields: string): Promise<Record<string, unknown> | null>
  setStatus(id: string, status: 'PAUSED' | 'ARCHIVED'): Promise<{ ok: boolean; error?: { code: string; message?: string } }>
}

/** Public competitor ads (Meta: the Ad Library). */
export interface AdLibrary {
  /** Fetches and stores a competitor page's ads; returns the number stored. */
  fetchCompetitorAds(competitorId: string, pageId: string): Promise<number>
}

/** Browser tracking tag status (Meta: the pixel). */
export interface TrackingHealthSource {
  /** The tag's raw status body; throws when the endpoint returns no readable response. */
  fetchPixelStatus(pixelId: string): Promise<unknown>
}

/** Event volume and match quality of the platform's conversion dataset. */
export interface DatasetDiagnostics {
  fetchEventVolume(query?: DatasetEventVolumeQuery): Promise<DatasetStatsResult>
  /** Pure: weekly volume of one event from a fetched result. */
  eventPerWeek(stats: DatasetStatsResult, eventName: string): number
  fetchQuality(query?: DatasetQualityQuery): Promise<DatasetQualityResult>
}

/** The platform's own optimization recommendations. */
export interface NativeRecommendations {
  fetch(): Promise<NativeRecommendationsResult>
  /** Pure: whether a recommendation is too old to act on. */
  isStale(recommendation: NativeRecommendation, nowMs: number, maxAgeDays?: number): boolean
}

/** Audience size estimate for an ad set. */
export interface DeliveryEstimates {
  fetch(adSetId: string): Promise<DeliveryEstimateResult>
}

/** The platform's section of the reporting packet: delivery, inventory and breakdowns for a window. */
export interface ReportingReader {
  readReport(context: ReportingContext, options?: ReportOptions): Promise<ReportSection<PlatformReport>>
}

/** Setup/doctor connection check: explicit credentials and an injected fetch, so it runs offline in tests. */
export interface PlatformConnectionInput {
  accessToken: string
  accountId: string
  appSecret?: string
  appSecretProof?: boolean
  fetch: typeof fetch
  timeoutMs?: number
}

export interface PlatformConnectionResult {
  reachable: boolean
  tokenValid: boolean
  /** Granted permissions, or null when the token could not be read. */
  scopes: string[] | null
  account: { name: string | null; currency: string | null; timezone: string | null; status: number | null } | null
  /** The platform's error text (never a credential), or null. */
  error: string | null
  apiVersion: string
}

export interface ConnectionCheck {
  check(input: PlatformConnectionInput): Promise<PlatformConnectionResult>
}

/** The platform's own integer units for budget and spend-cap fields, which need not follow ISO 4217
 *  (Meta: currency-offset.ts). Every value sent to or read from such a field goes through these. */
export interface BudgetUnits {
  /** Whether the platform supports `currency` as an ad-account currency at all. */
  supports(currency: string): boolean
  /** A major-unit amount as the platform's integer field value. Throws for an unsupported currency. */
  toMinor(amount: number, currency?: string): number
  /** A field value back in major units. Throws for an unsupported currency. */
  fromMinor(minor: number, currency?: string): number
}

export interface AdPlatform {
  readonly id: AdPlatformId
  /** Human-readable name for UI and messages. */
  readonly label: string
  isApiError(err: unknown): err is AdPlatformApiError
  readonly budgetUnits: BudgetUnits
  readonly entities: EntityReader
  readonly insights: InsightsReader
  readonly pacing?: PacingReader
  readonly breakdowns?: BreakdownSource
  readonly daypart?: DaypartSource
  readonly conversions?: ConversionsDelivery
  readonly writes?: ChangeWriter
  readonly campaignCreation?: CampaignCreator
  readonly adLibrary?: AdLibrary
  readonly trackingHealth?: TrackingHealthSource
  readonly datasetDiagnostics?: DatasetDiagnostics
  readonly recommendations?: NativeRecommendations
  readonly deliveryEstimate?: DeliveryEstimates
  readonly connectionCheck?: ConnectionCheck
  readonly reporting?: ReportingReader
}

/** Operation groups: the two required ones plus every optional capability. */
export type AdPlatformCapability = Exclude<keyof AdPlatform, 'id' | 'label' | 'isApiError' | 'budgetUnits'>
