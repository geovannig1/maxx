import type { AdsetDeliverySignals } from '@/lib/diagnostics/delivery'
import type { SpendConcentrationResult } from '@/lib/diagnostics/structure'
import type { WindowSettle } from '@/lib/insights/settle-window'
import { getCreativeDiagnostic, type CreativeDiagnostic } from '@/lib/creative/verdict'
import { aggregateMetrics, INSIGHT_METRIC_COLUMNS, type EntityMetrics } from '@/lib/metrics/aggregate'
import { getAdminClient } from '@/lib/supabase/admin'
import { diagnoseLaunchPerformance, type LaunchPerformanceVerdict } from '@/lib/diagnostics/launch-performance'
import { readPaidCreativeOutcomes } from '@/lib/creative/paid-outcomes-store'
import type { PaidCreativeOutcomes } from '@/lib/creative/paid-outcomes'
import { readVisionPaidAttributeOutcomes } from '@/lib/creative/vision-paid-attribute-outcomes-store'
import type { VisionPaidAttributeOutcomes } from '@/lib/creative/vision-paid-attribute-outcomes'
import {
  isPaidCreativeOutcomesSection,
  normalizeAbsentPaidCreativeSection,
} from '@/lib/diagnostics/owner-paid-outcomes-snapshot'
import {
  isPaidAttributeDistributionSection,
  normalizeAbsentPaidAttributeSection,
} from '@/lib/diagnostics/owner-paid-attribute-snapshot'
import {
  isDeliverySubStatusEvidence,
  normalizePersistedDeliverySubStatus,
  unavailableDeliverySubStatusEvidence,
  type DeliverySubStatusEvidence,
} from '@/lib/platforms/meta/delivery-sub-status'

export interface OwnerDeliveryDiagnostics {
  /** The delivery diagnosis itself. Persisted so downstream readers (the daily digest) can gate on
   *  the verdict rather than re-inferring it from per-ad-set exit counts, which are null whenever
   *  learning has succeeded or learning conversions are unknown. */
  verdict: LaunchPerformanceVerdict
  headline: string
  read: string
  window_settle: WindowSettle | null
  adsets_detail: AdsetDeliverySignals[]
  structure: { spend_concentration: SpendConcentrationResult }
}

export interface OwnerCreativeDiagnostics {
  observations: OwnerCreativeObservation[]
  total: number
  note: string
  prescriptions: []
}

export interface OwnerCreativeObservation {
  ad_id: string
  ad_name: string
  status: string
  delivery_sub_status: DeliverySubStatusEvidence
  metrics: EntityMetrics
  diagnostic: CreativeDiagnostic
}

interface CreativeSourceAd {
  id: string
  ad_id: string
  ad_name: string | null
  status: string | null
  effective_status: string | null
  delivery_sub_status?: unknown
  delivery_sub_status_read_available?: unknown
  delivery_sub_status_synced_at?: unknown
}

type CreativeInsightRow = Record<string, unknown> & { ad_id: string | null }

type OwnerDiagnosticsArgs = {
  adAccountDbId: string
  window: { from: string; to: string }
}

export function buildCreativeOwnerDiagnostics(
  ads: CreativeSourceAd[],
  insightRows: CreativeInsightRow[],
  windowDays: number,
): OwnerCreativeDiagnostics {
  const observations = ads.flatMap((ad): OwnerCreativeObservation[] => {
    const metrics = aggregateMetrics(insightRows.filter((row) => row.ad_id === ad.id))
    if (metrics.spend <= 0 && metrics.impressions <= 0) return []

    return [{
      ad_id: ad.ad_id,
      ad_name: ad.ad_name ?? ad.ad_id,
      status: ad.effective_status ?? ad.status ?? 'UNKNOWN',
      delivery_sub_status: normalizePersistedDeliverySubStatus(
        ad.delivery_sub_status,
        ad.delivery_sub_status_read_available,
        ad.delivery_sub_status_synced_at,
      ),
      metrics,
      diagnostic: getCreativeDiagnostic({
        ctr: metrics.ctr,
        frequency: metrics.frequency,
        earlyViewRate: metrics.hook_rate,
        earlyViewSource: metrics.early_view_source,
        thruplayRate: metrics.thruplay_rate,
        retentionP25Rate: metrics.retention_p25_rate,
        retentionDenominator: metrics.retention_denominator,
        videoStartCoverage: metrics.video_start_coverage,
        derivedMetricWarningCount: metrics.derived_metric_warning_count,
        impressions: metrics.impressions,
        windowDays,
      }),
    }]
  }).sort((left, right) =>
    right.metrics.spend - left.metrics.spend || left.ad_id.localeCompare(right.ad_id),
  )

  return {
    observations,
    total: observations.length,
    note: 'Descriptive Meta delivery and attention evidence only. No creative, budget, or production direction is supplied.',
    prescriptions: [],
  }
}

export async function readCreativeOwnerDiagnostics(
  args: OwnerDiagnosticsArgs,
  db: ReturnType<typeof getAdminClient> = getAdminClient(),
): Promise<OwnerCreativeDiagnostics> {
  const [adsRead, insightsRead] = await Promise.all([
    db
      .from('ads')
      .select('id, ad_id, ad_name, status, effective_status, delivery_sub_status, delivery_sub_status_read_available, delivery_sub_status_synced_at')
      .eq('ad_account_id', args.adAccountDbId),
    db
      .from('daily_insights')
      .select(`ad_id, ${INSIGHT_METRIC_COLUMNS}`)
      .eq('ad_account_id', args.adAccountDbId)
      .eq('entity_level', 'ad')
      .gte('date_start', args.window.from)
      .lte('date_stop', args.window.to),
  ])

  if (adsRead.error) throw new Error(`Creative ad read failed: ${adsRead.error.message}`)
  if (insightsRead.error) throw new Error(`Creative insight read failed: ${insightsRead.error.message}`)

  const parsedWindowDays = Math.round(
    (Date.parse(args.window.to) - Date.parse(args.window.from)) / 86_400_000,
  ) + 1
  const windowDays = Number.isFinite(parsedWindowDays) && parsedWindowDays > 0 ? parsedWindowDays : 0

  return buildCreativeOwnerDiagnostics(
    (adsRead.data ?? []) as CreativeSourceAd[],
    (insightsRead.data ?? []) as CreativeInsightRow[],
    windowDays,
  )
}

export type OwnerDiagnosticSection<T> =
  | { available: true; data: T }
  | { available: false; reason: string }

export interface OwnerDiagnostics {
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
  window: { from: string; to: string }
  delivery: OwnerDiagnosticSection<OwnerDeliveryDiagnostics>
  creative: OwnerDiagnosticSection<OwnerCreativeDiagnostics>
  creative_paid_outcomes: OwnerDiagnosticSection<PaidCreativeOutcomes>
  creative_paid_attribute_distributions: OwnerDiagnosticSection<VisionPaidAttributeOutcomes>
}

export function readOwnerDiagnosticsSnapshot(value: unknown): OwnerDiagnostics | null {
  const normalized = normalizeAbsentPaidAttributeSection(
    normalizeAbsentPaidCreativeSection(addUnavailableStateToLegacySnapshot(value)),
  )
  if (!isRecord(normalized)) return null
  const row = normalized
  if (row.action_authority_tier !== 'diagnostic_only') return null
  if (!isEmptyArray(row.prescriptions)) return null

  const window = row.window
  if (!isRecord(window)) return null
  if (typeof window.from !== 'string' || typeof window.to !== 'string') return null
  if (
    !isDeliverySection(row.delivery)
    || !isCreativeSection(row.creative)
    || !isPaidCreativeOutcomesSection(row.creative_paid_outcomes)
    || !isPaidAttributeDistributionSection(row.creative_paid_attribute_distributions)
  ) return null

  return normalized as unknown as OwnerDiagnostics
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function addStatusToLegacyObservation(value: unknown): unknown {
  if (!isRecord(value) || Object.hasOwn(value, 'delivery_sub_status')) return value
  return { ...value, delivery_sub_status: unavailableDeliverySubStatusEvidence() }
}

function addUnavailableStateToLegacySnapshot(value: unknown): unknown {
  if (!isRecord(value)) return value
  const delivery = value.delivery
  const creative = value.creative

  const normalizedDelivery = isRecord(delivery)
    && delivery.available === true
    && isRecord(delivery.data)
    && Array.isArray(delivery.data.adsets_detail)
    ? {
        ...delivery,
        data: {
          ...delivery.data,
          adsets_detail: delivery.data.adsets_detail.map(addStatusToLegacyObservation),
        },
      }
    : delivery
  const normalizedCreative = isRecord(creative)
    && creative.available === true
    && isRecord(creative.data)
    && Array.isArray(creative.data.observations)
    ? {
        ...creative,
        data: {
          ...creative.data,
          observations: creative.data.observations.map(addStatusToLegacyObservation),
        },
      }
    : creative

  return { ...value, delivery: normalizedDelivery, creative: normalizedCreative }
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isUnavailableSection(value: unknown): boolean {
  return isRecord(value) && value.available === false && typeof value.reason === 'string'
}

function isWindowSettle(value: unknown): boolean {
  if (value === null) return true
  return isRecord(value)
    && (value.state === 'settled' || value.state === 'settling')
    && typeof value.unsettled_days === 'number'
    && typeof value.settled_through === 'string'
    && typeof value.includes_today === 'boolean'
    && typeof value.detail === 'string'
}

function isAdsetDetail(value: unknown): boolean {
  return isRecord(value)
    && typeof value.name === 'string'
    && isStringOrNull(value.learning_phase)
    && isNumberOrNull(value.results_to_exit)
    && isStringOrNull(value.last_sig_edit)
    && isRecord(value.learning_exit_feasibility)
    && typeof value.learning_exit_feasibility.basis === 'string'
    && Array.isArray(value.cause_hints)
    && value.cause_hints.every((hint) => typeof hint === 'string')
    && isDeliverySubStatusEvidence(value.delivery_sub_status)
}

export function isLaunchPerformanceVerdict(value: unknown): value is LaunchPerformanceVerdict {
  return value === 'too_early' || value === 'still_learning'
    || value === 'structurally_starved' || value === 'healthy'
}

function isDeliverySection(value: unknown): boolean {
  if (isUnavailableSection(value)) return true
  if (!isRecord(value) || value.available !== true || !isRecord(value.data)) return false
  const data = value.data
  // `verdict` is newer than the oldest committed snapshots: absent is accepted (readers treat an
  // absent verdict as unknown, never as healthy), but a present one must be a real verdict value.
  return (data.verdict === undefined || isLaunchPerformanceVerdict(data.verdict))
    && typeof data.headline === 'string'
    && typeof data.read === 'string'
    && isWindowSettle(data.window_settle)
    && Array.isArray(data.adsets_detail)
    && data.adsets_detail.every(isAdsetDetail)
    && isRecord(data.structure)
    && isRecord(data.structure.spend_concentration)
    && typeof data.structure.spend_concentration.detail === 'string'
}

function isCreativeSignal(value: unknown): boolean {
  return isRecord(value)
    && typeof value.label === 'string'
    && typeof value.detail === 'string'
}

function isCreativeObservation(value: unknown): boolean {
  return isRecord(value)
    && typeof value.ad_id === 'string'
    && typeof value.ad_name === 'string'
    && typeof value.status === 'string'
    && isDeliverySubStatusEvidence(value.delivery_sub_status)
    && isRecord(value.metrics)
    && typeof value.metrics.spend === 'number'
    && Number.isFinite(value.metrics.spend)
    && typeof value.metrics.impressions === 'number'
    && Number.isFinite(value.metrics.impressions)
    && isRecord(value.diagnostic)
    && value.diagnostic.authority === 'diagnostic_only'
    && isEmptyArray(value.diagnostic.prescriptions)
    && Array.isArray(value.diagnostic.signals)
    && value.diagnostic.signals.every(isCreativeSignal)
}

function isCreativeSection(value: unknown): boolean {
  if (isUnavailableSection(value)) return true
  if (!isRecord(value) || value.available !== true || !isRecord(value.data)) return false
  const data = value.data
  return Array.isArray(data.observations)
    && data.observations.every(isCreativeObservation)
    && typeof data.total === 'number'
    && Number.isFinite(data.total)
    && typeof data.note === 'string'
    && isEmptyArray(data.prescriptions)
}

interface OwnerDiagnosticDependencies {
  readDelivery: () => Promise<OwnerDeliveryDiagnostics>
  readCreative: () => Promise<OwnerCreativeDiagnostics>
  readCreativePaidOutcomes: () => Promise<PaidCreativeOutcomes>
  readCreativePaidAttributeDistributions?: (
    paidOutcomes: PaidCreativeOutcomes,
  ) => Promise<VisionPaidAttributeOutcomes>
}

export async function buildOwnerDiagnostics(
  args: OwnerDiagnosticsArgs,
  dependencies?: OwnerDiagnosticDependencies,
): Promise<OwnerDiagnostics> {
  const readers = dependencies ?? {
    readDelivery: () => diagnoseLaunchPerformance({
      adAccountDbId: args.adAccountDbId,
      window: args.window,
      includeLiveEnrichment: false,
    }),
    readCreative: () => readCreativeOwnerDiagnostics(args),
    readCreativePaidOutcomes: () => readPaidCreativeOutcomes(getAdminClient(), args.adAccountDbId),
  }
  const creativePaidOutcomesPromise = Promise.resolve()
    .then(() => readers.readCreativePaidOutcomes())
  const attributeDistributionsPromise = dependencies?.readCreativePaidAttributeDistributions
    ? creativePaidOutcomesPromise.then((paid) => (
        dependencies.readCreativePaidAttributeDistributions!(paid)
      ))
    : dependencies
      ? Promise.reject(new Error('not_captured_by_test_dependency'))
      : creativePaidOutcomesPromise.then((paid) => readVisionPaidAttributeOutcomes(
          getAdminClient(),
          args.adAccountDbId,
          paid,
        ))
  const [delivery, creative, creativePaidOutcomes, attributeDistributions] = await Promise.allSettled([
    Promise.resolve().then(() => readers.readDelivery()),
    Promise.resolve().then(() => readers.readCreative()),
    creativePaidOutcomesPromise,
    attributeDistributionsPromise,
  ])

  return {
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    window: args.window,
    delivery: delivery.status === 'fulfilled'
      ? {
          available: true,
          data: {
            verdict: delivery.value.verdict,
            headline: delivery.value.headline,
            read: delivery.value.read,
            window_settle: delivery.value.window_settle,
            adsets_detail: delivery.value.adsets_detail,
            structure: { spend_concentration: delivery.value.structure.spend_concentration },
          },
        }
      : { available: false, reason: messageOf(delivery.reason) },
    creative: creative.status === 'fulfilled'
      ? { available: true, data: creative.value }
      : { available: false, reason: messageOf(creative.reason) },
    creative_paid_outcomes: creativePaidOutcomes.status === 'fulfilled'
      ? { available: true, data: creativePaidOutcomes.value }
      : { available: false, reason: messageOf(creativePaidOutcomes.reason) },
    creative_paid_attribute_distributions: attributeDistributions.status === 'fulfilled'
      ? { available: true, data: attributeDistributions.value }
      : { available: false, reason: messageOf(attributeDistributions.reason) },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
