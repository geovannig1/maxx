import { randomUUID } from 'node:crypto'
import {
  assertNoCrossPlaneLineage,
  createMetricClaim,
  type MetricClaim,
  type MetricClaimInput,
} from '@/lib/cockpit/contracts'
import { getAdminClient } from '@/lib/supabase/admin'
import type { ActionDecisionCommit } from '@/lib/authority/action-decision-store'
import type { DateRange, MetricValue } from './types'
import { accountTimezone } from '@/config/business-config'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const CLAIM_POLICY_VERSION = 'recommendation_metric_claim_v1'
const FRESHNESS_MAX_AGE_HOURS = 26

type BoundEntityLevel = 'campaign' | 'adset' | 'ad'

interface MetricDefinition {
  sourceMetricKey: 'cpa' | 'frequency' | 'spend' | 'bookings'
  metricKey: string
  label: string
  unit: MetricClaimInput['unit']
  attributionScope: MetricClaimInput['attributionScope']
  coverage: MetricClaimInput['coverage']
  measurementKind: MetricClaimInput['measurementKind']
  formula: string | null
}

const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  cpa: {
    sourceMetricKey: 'cpa', metricKey: 'meta_delivery.cpa', label: 'CPA', unit: 'money',
    attributionScope: 'meta_platform_modelled',
    coverage: { state: 'complete', numerator: 2, denominator: 2 },
    measurementKind: 'derived', formula: `meta_delivery.spend / meta_delivery.${OW.many}`,
  },
  frequency: {
    sourceMetricKey: 'frequency', metricKey: 'meta_delivery.frequency', label: 'Frequency', unit: 'ratio',
    attributionScope: 'none', coverage: { state: 'complete', numerator: 1, denominator: 1 },
    measurementKind: 'measured', formula: 'Meta native daily frequency',
  },
  spend: {
    sourceMetricKey: 'spend', metricKey: 'meta_delivery.spend', label: 'Spend', unit: 'money',
    attributionScope: 'none', coverage: { state: 'not_applicable', numerator: null, denominator: null },
    measurementKind: 'measured', formula: 'sum(Meta delivery spend)',
  },
  bookings: {
    sourceMetricKey: 'bookings', metricKey: 'meta_delivery.bookings', label: `Meta-reported ${OW.many}`, unit: 'count',
    attributionScope: 'meta_platform_modelled',
    coverage: { state: 'not_applicable', numerator: null, denominator: null },
    measurementKind: 'modelled', formula: 'sum(Meta-modelled AppointmentConfirmed results)',
  },
}

export interface MetricClaimSnapshotCommit {
  claim_id: string
  source_flag_id: string
  source_flag_generation_id: string
  source_metric_key: MetricDefinition['sourceMetricKey']
  snapshot: MetricClaim
}

export interface RecommendationMetricClaimBinding {
  claimIds: string[]
  snapshots: MetricClaimSnapshotCommit[]
}

/**
 * Atomize only exact, fresh Meta facts already held by an immutable flag snapshot. This function
 * deliberately returns no IDs when a source clock, entity, window, or finite Meta value is absent:
 * callers publish an empty lineage array and the owner-decision boundary quarantines the row.
 */
export function buildRecommendationMetricClaimBindings(input: {
  sourceFlagId: string
  sourceFlagGenerationId: string
  target: { level: BoundEntityLevel; id: string }
  window: DateRange
  metrics: MetricValue[]
  sourceObservedAt: string | null
  asOf: string
}): RecommendationMetricClaimBinding {
  if (!isUsableSource(input)) return { claimIds: [], snapshots: [] }

  const freshness = freshSnapshot(input.sourceObservedAt!, input.asOf)
  if (!freshness) return { claimIds: [], snapshots: [] }

  const metrics = new Map<string, number>()
  for (const metric of input.metrics) {
    const key = metric.name.trim().toLowerCase()
    if (METRIC_DEFINITIONS[key] && metric.source === 'meta_api' && Number.isFinite(metric.value)) metrics.set(key, metric.value!)
  }
  const snapshots: MetricClaimSnapshotCommit[] = []
  const claimIdBySourceMetric = new Map<string, string>()
  const addSnapshot = (definition: MetricDefinition, value: number, inputClaimIds: string[] = []) => {
    if (definition.sourceMetricKey === 'frequency' && input.window.start !== input.window.end) return
    const claimId = `metric_claim:${randomUUID()}`
    const snapshot = createMetricClaim({
      claimId,
      metricKey: definition.metricKey,
      label: definition.label,
      value,
      unit: definition.unit,
      formula: definition.formula,
      definitionVersion: 1,
      source: {
        system: 'meta',
        role: 'delivery_truth',
        head: `flag-generation:${input.sourceFlagGenerationId}`,
        evidencePlane: 'meta_delivery',
      },
      entity: input.target,
      attributionScope: definition.attributionScope,
      window: { ...input.window, basis: 'closed_account_days', timezone: accountTimezone() },
      comparison: { method: 'none', window: null },
      asOf: input.asOf,
      availability: { state: 'available', blockerCodes: [] },
      coverage: definition.coverage,
      maturity: { state: 'not_applicable', matureThrough: null },
      freshness,
      setupFingerprint: null,
      // A recommendation MetricClaim is a factual delivery snapshot. It is intentionally incapable
      // of granting action authority; ActionDecision remains the separate durable authority record.
      authority: { state: 'diagnostic', policyVersion: CLAIM_POLICY_VERSION },
      measurementKind: definition.measurementKind,
      inputClaimIds,
    })
    snapshots.push({
      claim_id: claimId,
      source_flag_id: input.sourceFlagId,
      source_flag_generation_id: input.sourceFlagGenerationId,
      source_metric_key: definition.sourceMetricKey,
      snapshot,
    })
    claimIdBySourceMetric.set(definition.sourceMetricKey, claimId)
  }

  // Materialize the factual/modelled inputs first. A derived claim can only exist when its exact
  // source claims are also frozen in the same immutable recommendation snapshot.
  for (const sourceMetricKey of ['spend', 'bookings', 'frequency'] as const) {
    const value = metrics.get(sourceMetricKey)
    if (value !== undefined) addSnapshot(METRIC_DEFINITIONS[sourceMetricKey], value)
  }
  const cpa = metrics.get('cpa')
  const spend = metrics.get('spend')
  const bookings = metrics.get('bookings')
  const spendClaimId = claimIdBySourceMetric.get('spend')
  const bookingsClaimId = claimIdBySourceMetric.get('bookings')
  if (cpa !== undefined && spend !== undefined && bookings !== undefined && bookings > 0 && spendClaimId && bookingsClaimId) {
    // CPA is a derived claim; its value must agree with the frozen operands, not a duplicate
    // display calculation supplied by an upstream recommendation object.
    addSnapshot(METRIC_DEFINITIONS.cpa, spend / bookings, [spendClaimId, bookingsClaimId])
  }
  // The SECOND claim-construction site. `assertNoCrossPlaneLineage` guarded only the cockpit
  // assembler, which made "a blended cost-per-booking cannot be constructed" true of one file rather
  // than of the system. This path builds a derived CPA with real lineage and is safe today only
  // because it hardcodes evidencePlane 'meta_delivery' above — an accident of the current code, not a
  // property anyone asserted. It stops being true the moment a business-truth metric is bound here.
  // Called while it is a no-op, which is the only cheap time to add it.
  assertNoCrossPlaneLineage(Object.fromEntries(
    snapshots.map((snapshot) => [snapshot.claim_id, snapshot.snapshot]),
  ))
  return { claimIds: snapshots.map((snapshot) => snapshot.claim_id), snapshots }
}

function isUsableSource(input: {
  sourceFlagId: string
  sourceFlagGenerationId: string
  target: { level: BoundEntityLevel; id: string }
  window: DateRange
  sourceObservedAt: string | null
  asOf: string
}): boolean {
  if (!input.sourceFlagId.trim() || !input.sourceFlagGenerationId.trim() || !input.target.id.trim()) return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.window.start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.window.end)) return false
  if (input.window.start > input.window.end) return false
  return typeof input.sourceObservedAt === 'string' && isIsoTimestamp(input.sourceObservedAt) && isIsoTimestamp(input.asOf)
}

function freshSnapshot(observedAt: string, asOf: string): MetricClaimInput['freshness'] | null {
  const ageMs = Date.parse(asOf) - Date.parse(observedAt)
  if (ageMs < 0 || ageMs > FRESHNESS_MAX_AGE_HOURS * 3_600_000) return null
  return { state: 'fresh', observedAt, maxAgeHours: FRESHNESS_MAX_AGE_HOURS }
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
}

/**
 * One RPC commits validated claim snapshots before the typed recommendation + ActionDecision
 * generation. If any claim or decision is rejected the database transaction rolls back all three.
 */
export async function replaceRecommendationGenerationWithMetricClaims(
  db: ReturnType<typeof getAdminClient>,
  input: {
    adAccountId: string
    generationId: string
    expectedPrev: string | null
    sourceFlagGeneration: string
    referenceDate: string
    newRows: Record<string, unknown>[]
    decisions: ActionDecisionCommit[]
    metricClaims: MetricClaimSnapshotCommit[]
  },
): Promise<{ generation_id: string; row_count: number }> {
  const { data, error } = await db.rpc('replace_recommendation_generation_with_claims_and_decisions', {
    p_account: input.adAccountId,
    p_generation_id: input.generationId,
    p_expected_prev: input.expectedPrev,
    p_source_flag_generation: input.sourceFlagGeneration,
    p_reference_date: input.referenceDate,
    p_new_rows: input.newRows,
    p_decisions: input.decisions,
    p_metric_claims: input.metricClaims,
  })
  if (error) throw new Error(`replace_recommendation_generation_with_claims_and_decisions: ${error.message}`)
  return data as { generation_id: string; row_count: number }
}
