import { getAdminClient } from '@/lib/supabase/admin'
import { randomUUID } from 'node:crypto'
import type { Recommendation } from './types'
import { readActionDecisionsBySource, type PersistedActionDecision } from '@/lib/authority/action-decision-store'
import { resolveDisplayAuthority } from '@/lib/authority/legacy-cutover'
import type { RecommendationEvidenceItem } from '@/lib/cockpit/contracts'
import {
  recommendationTargetsCurrentOperatingEntity,
  type AdOperatingState,
  type AdsetOperatingState,
  type CampaignOperatingState,
  type OperatingEntitySnapshot,
} from './live-eligibility'

// Persist / read structured recommendations (`recommendations`; durable generations). Writes no longer
// go through here directly — recToRow maps a built Recommendation to the row shape that
// replace_recommendation_generation inserts atomically (supersede + insert + head
// rotation in ONE locked, CAS-guarded transaction). Reads degrade to [] if the table isn't applied yet.

/** Map a built Recommendation to the row the durable-generation RPC persists. ad_account_id,
 *  generation_id, status, generated_at, created_at are FORCED by replace_recommendation_generation from
 *  its params (and dropped from the payload by its column whitelist) — never set them here. */
export function recToRow(rec: Recommendation, sourceFlagId?: string | null): Record<string, unknown> {
  return {
    id: randomUUID(),
    source_flag_id: sourceFlagId ?? null,
    recommendation_type: rec.recommendation_type,
    target_entity_type: rec.target_entity_type,
    target_entity_id: rec.target_entity_id,
    target_entity_name: rec.target_entity_name,
    observed_fact: rec.observed_fact,
    metric_values: rec.metric_values as unknown as Record<string, unknown>,
    date_range_start: rec.date_range?.start ?? null,
    date_range_end: rec.date_range?.end ?? null,
    data_sources: rec.data_sources,
    evidence_summary: rec.evidence_summary,
    reason_for_action: rec.reason_for_action,
    confidence_score: rec.confidence_score,
    confidence_label: rec.confidence_label,
    risk_level: rec.risk_level,
    gate_decision: rec.grounding.decision,
    gate_passed: rec.grounding.passed,
    what_could_make_this_wrong: rec.what_could_make_this_wrong,
    approval_required: rec.approval_required,
    action_allowed_now: rec.action_allowed_now,
    low_data_warning: rec.low_data_warning,
    estimate_warning: rec.estimate_warning,
    attribution_warning: rec.attribution_warning,
    no_oscillation_allowed: rec.no_oscillation_check.is_reversal_class ? rec.no_oscillation_check.allowed : null,
    no_oscillation_reason: rec.no_oscillation_check.is_reversal_class ? rec.no_oscillation_check.reason : null,
    recommended_next_check_date: rec.recommended_next_check_date,
    target_metric: rec.target_evaluation?.metric ?? null,
    target_status: rec.target_evaluation?.status ?? null,
    target_confidence: rec.target_evaluation?.confidence ?? null,
    target_language: rec.target_evaluation?.language ?? null,
    grounding_json: rec.grounding as unknown as Record<string, unknown>,
    // Honesty fields. external_knowledge_used is stored as jsonb.
    attribution_confidence: rec.attribution_confidence ?? null,
    external_knowledge_used: (rec.external_knowledge_used ?? null) as unknown as Record<string, unknown> | null,
    prior_learning_used: rec.prior_learning_used ?? null,
    expected_upside: rec.expected_upside ?? null,
    possible_downside: rec.possible_downside ?? null,
    minimum_data_needed: rec.minimum_data_needed ?? null,
    learning_eligibility: rec.learning_eligibility ?? false,
    // The generation RPC rejects malformed IDs; do not invent, trim, or recover lineage here.
    metric_claim_ids: rec.metric_claim_ids ?? [],
  }
}

export interface StoredRecommendation {
  id: string
  recommendation_type: string
  target_entity_type: string
  target_entity_id: string | null
  target_entity_name: string | null
  observed_fact: string
  reason_for_action: string
  /** Original persisted prose. Audit-only; never render this as current authority. */
  reason_for_action_legacy_raw?: string
  action_decision: PersistedActionDecision | null
  action_authority_tier: 'execution_eligible' | 'owner_review' | 'diagnostic_only'
  action_authority_legacy: boolean
  action_authority_prose_warning: boolean
  /** Immutable references to source MetricClaims. Never synthesized by the read path. */
  metric_claim_ids: string[]
  /** True only when every persisted claim reference resolves to its immutable, account-bound snapshot. */
  metric_claim_lineage_verified?: boolean
  date_range_start: string | null
  date_range_end: string | null
  // Provenance + honesty fields — stored by the insert but were previously dropped at read (audit fix),
  // so the dashboard can now show a source chip + "what could make this wrong".
  data_sources: string[] | null
  evidence_summary: string | null
  what_could_make_this_wrong: string[] | null
  confidence_label: string
  confidence_score: number
  risk_level: string
  gate_decision: string
  approval_required: boolean
  action_allowed_now: boolean
  low_data_warning: string | null
  estimate_warning: string | null
  attribution_warning: string | null
  recommended_next_check_date: string | null
  target_metric: string | null
  target_status: string | null
  target_confidence: string | null
  target_language: string | null
  // Honesty fields — surfaced so the dashboard can show upside/downside,
  // what more data is needed, external-knowledge citations, and the learning eligibility of each rec.
  attribution_confidence: number | null
  external_knowledge_used: string[] | null
  prior_learning_used: string | null
  expected_upside: string | null
  possible_downside: string | null
  minimum_data_needed: string | null
  learning_eligibility: boolean | null
  status: string
  generated_at: string
}

/** Upper bound on rows scanned when verifying a generation's MetricClaim lineage. A recommendation
 *  generation is a bounded publication (tens of rows; the largest to date is 19), so this is a runaway
 *  guard, not a page size — lineage must be judged across the whole generation, never a display slice. */
const GENERATION_LINEAGE_SCAN_CAP = 500

const REC_COLUMNS =
  'id, generation_id, recommendation_type, target_entity_type, target_entity_id, target_entity_name, observed_fact, reason_for_action, date_range_start, date_range_end, data_sources, evidence_summary, what_could_make_this_wrong, confidence_label, confidence_score, risk_level, gate_decision, approval_required, action_allowed_now, low_data_warning, estimate_warning, attribution_warning, recommended_next_check_date, target_metric, target_status, target_confidence, target_language, attribution_confidence, external_knowledge_used, prior_learning_used, expected_upside, possible_downside, minimum_data_needed, learning_eligibility, metric_claim_ids, status, generated_at'

type RecommendationRow = Omit<StoredRecommendation,
  'action_decision' | 'action_authority_tier' | 'action_authority_legacy' | 'action_authority_prose_warning'> & {
    generation_id: string | null
  }

const MAX_OPEN_RECOMMENDATIONS_TO_EVALUATE = 1_000

export type OpenRecommendationReadHealth = 'healthy' | 'degraded' | 'unavailable'

export type OpenRecommendationReadReasonCode =
  | 'account_unresolved'
  | 'recommendations_read_failed'
  | 'current_generation_read_failed'
  | 'current_generation_changed'
  | 'not_current_generation'
  | 'entity_metadata_read_failed'
  | 'target_not_current'
  | 'predates_entity_sync'
  | 'action_authority_read_failed'
  | 'metric_claim_lineage_read_failed'
  | 'metric_claim_lineage_invalid'
  | 'evaluation_cap_reached'

export interface OpenRecommendationReadReason {
  code: OpenRecommendationReadReasonCode
  /** Number of known recommendations affected; null means the source read failed before a count existed. */
  affectedCount: number | null
  message: string
}

/**
 * Health-bearing read for CURRENT recommendations only. `visibleCount` is the number of eligible rows in
 * the bounded current snapshot before the caller's display limit; `quarantinedCount` is null when the
 * source snapshot itself could not be read. Historical generation reads intentionally do not use this.
 */
export interface OpenRecommendationsReadResult {
  health: OpenRecommendationReadHealth
  recommendations: StoredRecommendation[]
  visibleCount: number
  quarantinedCount: number | null
  reasons: OpenRecommendationReadReason[]
  /** Recommendation ID → resolved evidence items + placeholders for missing claim IDs. */
  evidence: Map<string, RecommendationEvidenceItem[]>
}

export function unavailableOpenRecommendationsRead(
  code: Extract<OpenRecommendationReadReasonCode, 'account_unresolved' | 'recommendations_read_failed'>,
  message: string,
): OpenRecommendationsReadResult {
  return {
    health: 'unavailable',
    recommendations: [],
    visibleCount: 0,
    quarantinedCount: null,
    reasons: [{ code, affectedCount: null, message }],
    evidence: new Map(),
  }
}

interface OperatingEntitySnapshotRead {
  snapshot: OperatingEntitySnapshot
  failedTables: Array<'ads' | 'adsets' | 'campaigns'>
}

/** The later of two nullable ISO timestamps; null only when both are absent. */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** Was this recommendation generated AFTER the last time its target (or any parent) actually changed?
 *
 *  This used to compare against `last_synced_at`, which the sync re-stamps on every run whether or not
 *  anything changed. So a recommendation generated at 10:36 on one day was invalidated by the next
 *  morning's sync at 10:43 — and because recommendations only regenerate when the whole fail-stop chain
 *  completes, a single `partial` sync silently voided the ENTIRE feed until a fully successful one ran,
 *  quarantining open recommendations that were all valid: they postdated every real change to their
 *  targets by days.
 *
 *  The question the guard means to ask is "has this been EDITED since?", so it now compares against the
 *  entity's own change clock — Meta's `updated_time`, and for an ad set also `last_sig_edit_ts`, the edit
 *  that reset its learning counter. Unknown still fails closed. */
function metaRecommendationPostdatesEntityChange(
  row: RecommendationRow,
  snapshot: OperatingEntitySnapshot,
): boolean {
  if (!['campaign', 'adset', 'ad'].includes(row.target_entity_type)) return true
  if (!row.target_entity_id) return false

  const states: Array<CampaignOperatingState | AdsetOperatingState | AdOperatingState | undefined> = []
  if (row.target_entity_type === 'campaign') {
    states.push(snapshot.campaigns.get(row.target_entity_id))
  } else if (row.target_entity_type === 'adset') {
    const adset = snapshot.adsets.get(row.target_entity_id)
    states.push(adset, adset ? snapshot.campaigns.get(adset.campaignId) : undefined)
  } else {
    const ad = snapshot.ads.get(row.target_entity_id)
    states.push(
      ad,
      ad ? snapshot.adsets.get(ad.adsetId) : undefined,
      ad ? snapshot.campaigns.get(ad.campaignId) : undefined,
    )
  }

  // Fail closed on an unresolved entity or an unknown change clock: "we do not know when this last
  // changed" must never read as "it has not changed".
  if (states.some((state) => !state?.lastMaterialChangeAt)) return false
  const generatedAt = Date.parse(row.generated_at)
  const changedAt = states.map((state) => Date.parse(state!.lastMaterialChangeAt!))
  if (!Number.isFinite(generatedAt) || changedAt.some((value) => !Number.isFinite(value))) return false
  return generatedAt > Math.max(...changedAt)
}

async function loadOperatingEntitySnapshot(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  rows: RecommendationRow[],
): Promise<OperatingEntitySnapshotRead> {
  const campaigns = new Map<string, CampaignOperatingState>()
  const adsets = new Map<string, AdsetOperatingState>()
  const ads = new Map<string, AdOperatingState>()
  const campaignIds = new Set(rows
    .filter((row) => row.target_entity_type === 'campaign' && row.target_entity_id)
    .map((row) => row.target_entity_id!))
  const adsetIds = new Set(rows
    .filter((row) => row.target_entity_type === 'adset' && row.target_entity_id)
    .map((row) => row.target_entity_id!))
  const adIds = [...new Set(rows
    .filter((row) => row.target_entity_type === 'ad' && row.target_entity_id)
    .map((row) => row.target_entity_id!))]
  const readErrors: string[] = []
  const failedTables: Array<'ads' | 'adsets' | 'campaigns'> = []

  if (adIds.length > 0) {
    const { data, error } = await db
      .from('ads')
      .select('id, campaign_id, adset_id, status, effective_status, last_synced_at, meta_updated_time')
      .eq('ad_account_id', adAccountDbId)
      .in('id', adIds)
    if (error) {
      readErrors.push(`ads: ${error.message}`)
      failedTables.push('ads')
    }
    for (const row of (data ?? []) as Array<{
      id: string; campaign_id: string; adset_id: string; status: string | null
      effective_status: string | null; last_synced_at: string | null; meta_updated_time: string | null
    }>) {
      ads.set(row.id, {
        id: row.id,
        campaignId: row.campaign_id,
        adsetId: row.adset_id,
        status: row.status,
        effectiveStatus: row.effective_status,
        lastSyncedAt: row.last_synced_at,
        lastMaterialChangeAt: row.meta_updated_time,
      })
      campaignIds.add(row.campaign_id)
      adsetIds.add(row.adset_id)
    }
  }

  if (adsetIds.size > 0) {
    const { data, error } = await db
      .from('adsets')
      .select('id, campaign_id, status, effective_status, last_synced_at, meta_updated_time, last_sig_edit_ts')
      .eq('ad_account_id', adAccountDbId)
      .in('id', [...adsetIds])
    if (error) {
      readErrors.push(`adsets: ${error.message}`)
      failedTables.push('adsets')
    }
    for (const row of (data ?? []) as Array<{
      id: string; campaign_id: string; status: string | null
      effective_status: string | null; last_synced_at: string | null
      meta_updated_time: string | null; last_sig_edit_ts: string | null
    }>) {
      adsets.set(row.id, {
        id: row.id,
        campaignId: row.campaign_id,
        status: row.status,
        effectiveStatus: row.effective_status,
        lastSyncedAt: row.last_synced_at,
        // An ad set carries two change clocks; the later governs. last_sig_edit_ts is the edit that
        // reset Meta's learning counter, which is the most consequential kind of change for a
        // recommendation about delivery.
        lastMaterialChangeAt: laterOf(row.meta_updated_time, row.last_sig_edit_ts),
      })
      campaignIds.add(row.campaign_id)
    }
  }

  if (campaignIds.size > 0) {
    const { data, error } = await db
      .from('campaigns')
      .select('id, status, effective_status, last_synced_at, meta_updated_time')
      .eq('ad_account_id', adAccountDbId)
      .in('id', [...campaignIds])
    if (error) {
      readErrors.push(`campaigns: ${error.message}`)
      failedTables.push('campaigns')
    }
    for (const row of (data ?? []) as Array<{
      id: string; status: string | null; effective_status: string | null
      last_synced_at: string | null; meta_updated_time: string | null
    }>) {
      campaigns.set(row.id, {
        id: row.id,
        status: row.status,
        effectiveStatus: row.effective_status,
        lastSyncedAt: row.last_synced_at,
        lastMaterialChangeAt: row.meta_updated_time,
      })
    }
  }

  if (readErrors.length > 0) {
    console.warn(`[Recommendations] Entity lifecycle read failed; affected live recommendations were quarantined: ${readErrors.join('; ')}`)
  }
  return { snapshot: { campaigns, adsets, ads }, failedTables }
}

function attachAuthority(
  rows: RecommendationRow[],
  decisions: Map<string, PersistedActionDecision>,
  verifiedMetricClaimRecommendations: ReadonlySet<string>,
): StoredRecommendation[] {
  return rows.map((row) => {
    const decision = decisions.get(row.id) ?? null
    const resolved = resolveDisplayAuthority(decision, row.reason_for_action)
    return {
      ...row,
      metric_claim_ids: Array.isArray(row.metric_claim_ids)
        ? row.metric_claim_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [],
      metric_claim_lineage_verified: verifiedMetricClaimRecommendations.has(row.id),
      reason_for_action: resolved.copy,
      ...(resolved.legacyRawForAudit ? { reason_for_action_legacy_raw: resolved.legacyRawForAudit } : {}),
      action_decision: decision,
      action_authority_tier: resolved.tier,
      action_authority_legacy: resolved.legacy,
      action_authority_prose_warning: resolved.prosePhraseWarning,
      // These old booleans can only narrow what the durable decision permits, never promote it.
      approval_required: resolved.tier === 'diagnostic_only' ? false : row.approval_required,
      action_allowed_now: resolved.tier === 'execution_eligible' && row.action_allowed_now,
    }
  })
}

export interface VerifiedRecommendationsResult {
  verified: Set<string>
  /** Recommendation ID → resolved evidence items + placeholders for missing claim IDs. */
  evidence: Map<string, RecommendationEvidenceItem[]>
}

function evidenceItemFromSnapshot(claimId: string, snapshot: unknown): RecommendationEvidenceItem | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const s = snapshot as Record<string, unknown>
  const source = s.source && typeof s.source === 'object' ? s.source as Record<string, unknown> : null
  const window = s.window && typeof s.window === 'object' ? s.window as Record<string, unknown> : null
  const maturity = s.maturity && typeof s.maturity === 'object' ? s.maturity as Record<string, unknown> : null
  const freshness = s.freshness && typeof s.freshness === 'object' ? s.freshness as Record<string, unknown> : null
  const availability = s.availability && typeof s.availability === 'object' ? s.availability as Record<string, unknown> : null
  if (!source || !window || !maturity || !freshness || !availability) return null
  const unit = typeof s.unit === 'string' ? s.unit : null
  if (!unit || !['money', 'count', 'ratio', 'percent', 'state'].includes(unit)) return null
  return {
    claimId,
    metricKey: typeof s.metricKey === 'string' ? s.metricKey : claimId,
    label: typeof s.label === 'string' ? s.label : claimId,
    value: typeof s.value === 'number' || typeof s.value === 'string' ? s.value : null,
    unit: unit as RecommendationEvidenceItem['unit'],
    window: {
      start: typeof window.start === 'string' ? window.start : '',
      end: typeof window.end === 'string' ? window.end : '',
    },
    sourceSystem: typeof source.system === 'string' ? source.system as RecommendationEvidenceItem['sourceSystem'] : 'maxx',
    maturity: typeof maturity.state === 'string' ? maturity.state as RecommendationEvidenceItem['maturity'] : 'not_applicable',
    freshness: typeof freshness.state === 'string' ? freshness.state as RecommendationEvidenceItem['freshness'] : 'unknown',
    availability: typeof availability.state === 'string' ? availability.state as RecommendationEvidenceItem['availability'] : 'unavailable',
    missing: false,
  }
}

/**
 * Read the durable recommendation→claim bindings rather than treating claim-shaped strings as evidence.
 * The migration validates the nested source snapshot at write time; this read additionally requires an
 * exact one-for-one match with the recommendation's immutable claim ID array. A failed read is distinct
 * from an empty valid set and callers quarantine both cases.
 *
 * Returns both the verified set and a per-recommendation evidence map. Evidence items carry their own
 * snapshot window; missing claim IDs become explicit placeholders so the UI can say "referenced but not
 * found" instead of silently omitting them.
 */
async function readVerifiedMetricClaimRecommendations(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  rows: RecommendationRow[],
): Promise<VerifiedRecommendationsResult> {
  if (rows.length === 0) return { verified: new Set(), evidence: new Map() }
  const { data, error } = await db
    .from('recommendation_metric_claim_bindings')
    .select('recommendation_id, claim_id, ad_account_id, source_flag_id, source_flag_generation_id, metric_claim:recommendation_metric_claim_snapshots!inner(claim_id, ad_account_id, source_flag_id, source_flag_generation_id, snapshot)')
    .eq('ad_account_id', adAccountDbId)
    .in('recommendation_id', rows.map((row) => row.id))
  if (error) throw new Error(error.message)

  const claimsByRecommendation = new Map<string, Set<string>>()
  const snapshotByClaim = new Map<string, unknown>()
  for (const value of (data ?? []) as Array<Record<string, unknown>>) {
    const recommendationId = typeof value.recommendation_id === 'string' ? value.recommendation_id : null
    const claimId = typeof value.claim_id === 'string' ? value.claim_id : null
    const joined = Array.isArray(value.metric_claim) ? value.metric_claim[0] : value.metric_claim
    if (!recommendationId || !claimId || !joined || typeof joined !== 'object') continue
    const snapshot = (joined as Record<string, unknown>).snapshot
    const source = joined as Record<string, unknown>
    if (value.ad_account_id !== adAccountDbId
        || source.ad_account_id !== adAccountDbId
        || source.claim_id !== claimId
        || source.source_flag_id !== value.source_flag_id
        || source.source_flag_generation_id !== value.source_flag_generation_id) continue
    const claims = claimsByRecommendation.get(recommendationId) ?? new Set<string>()
    claims.add(claimId)
    claimsByRecommendation.set(recommendationId, claims)
    snapshotByClaim.set(claimId, snapshot)
  }

  const verified = new Set<string>()
  const evidence = new Map<string, RecommendationEvidenceItem[]>()
  for (const row of rows) {
    const ids = Array.isArray(row.metric_claim_ids) ? row.metric_claim_ids : []
    const bindings = claimsByRecommendation.get(row.id)
    const isVerified = ids.length > 0
        && new Set(ids).size === ids.length
        && bindings?.size === ids.length
        && ids.every((id) => bindings.has(id))
    if (isVerified) verified.add(row.id)

    const items: RecommendationEvidenceItem[] = []
    for (const claimId of ids) {
      const snapshot = snapshotByClaim.get(claimId)
      const resolved = snapshot ? evidenceItemFromSnapshot(claimId, snapshot) : null
      if (resolved) {
        items.push(resolved)
      } else {
        items.push({
          claimId,
          metricKey: claimId,
          label: 'Referenced claim',
          value: null,
          unit: 'state',
          window: { start: '', end: '' },
          sourceSystem: 'maxx',
          maturity: 'not_applicable',
          freshness: 'unknown',
          availability: 'unavailable',
          missing: true,
        })
      }
    }
    evidence.set(row.id, items)
  }
  return { verified, evidence }
}

/** Health-bearing open recommendations read for dashboard/MCP current-state surfaces. */
export async function readOpenRecommendations(
  adAccountDbId: string,
  limit = 20
): Promise<OpenRecommendationsReadResult> {
  let db: ReturnType<typeof getAdminClient>
  try {
    db = getAdminClient()
  } catch (error) {
    console.warn(`[Recommendations] Client initialization failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return unavailableOpenRecommendationsRead(
      'recommendations_read_failed',
      'The current recommendation snapshot could not be read. Maxx cannot claim that there are no recommendations.',
    )
  }

  let currentGenerationId: string | null = null
  try {
    const { data: heads, error } = await db
      .from('decision_generations')
      .select('id')
      .eq('ad_account_id', adAccountDbId)
      .eq('kind', 'recommendation')
      .eq('is_current', true)
      .limit(2)
    if (error) throw new Error(error.message)
    const headRows = (heads ?? []) as Array<{ id: string }>
    if (headRows.length > 1) throw new Error('multiple current recommendation generations')
    currentGenerationId = headRows[0]?.id ?? null
  } catch (error) {
    console.warn(`[Recommendations] Current generation read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return {
      health: 'unavailable',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: null,
      reasons: [{
        code: 'current_generation_read_failed',
        affectedCount: null,
        message: 'The current recommendation generation could not be resolved; all open rows were quarantined.',
      }],
      evidence: new Map(),
    }
  }

  // Count first, then query ONLY the current generation. The previous implementation selected the
  // newest 1,000 open rows across every generation and filtered afterward, so a large legacy backlog
  // could hide every current row. Exact counts also make the safety cap fail closed rather than
  // returning a plausible-looking partial feed.
  let totalOpenCount: number
  let currentOpenCount = 0
  try {
    const totalResult = await db
      .from('recommendations')
      .select('id', { count: 'exact' })
      .eq('ad_account_id', adAccountDbId)
      .eq('status', 'open')
      .limit(1)
    if (totalResult.error || totalResult.count == null) {
      throw new Error(totalResult.error?.message ?? 'open recommendation count unavailable')
    }
    totalOpenCount = totalResult.count

    if (currentGenerationId) {
      const currentResult = await db
        .from('recommendations')
        .select('id', { count: 'exact' })
        .eq('ad_account_id', adAccountDbId)
        .eq('status', 'open')
        .eq('generation_id', currentGenerationId)
        .limit(1)
      if (currentResult.error || currentResult.count == null) {
        throw new Error(currentResult.error?.message ?? 'current recommendation count unavailable')
      }
      currentOpenCount = currentResult.count
    }
  } catch (error) {
    console.warn(`[Recommendations] Current snapshot count failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return unavailableOpenRecommendationsRead(
      'recommendations_read_failed',
      'The current recommendation snapshot could not be counted completely. Maxx cannot claim that there are no recommendations.',
    )
  }

  if (currentOpenCount > MAX_OPEN_RECOMMENDATIONS_TO_EVALUATE) {
    return {
      health: 'unavailable',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: totalOpenCount,
      reasons: [{
        code: 'evaluation_cap_reached',
        affectedCount: currentOpenCount,
        message: `The current generation contains ${currentOpenCount} open rows, above the ${MAX_OPEN_RECOMMENDATIONS_TO_EVALUATE}-row safety cap. The feed was withheld rather than returned partially.`,
      }],
      evidence: new Map(),
    }
  }

  let generationRows: RecommendationRow[] = []
  if (currentGenerationId && currentOpenCount > 0) {
    try {
      const result = await db
        .from('recommendations')
        .select(REC_COLUMNS)
        .eq('ad_account_id', adAccountDbId)
        .eq('status', 'open')
        .eq('generation_id', currentGenerationId)
        .order('generated_at', { ascending: false })
        .limit(MAX_OPEN_RECOMMENDATIONS_TO_EVALUATE)
      if (result.error) throw new Error(result.error.message)
      generationRows = (result.data ?? []) as unknown as RecommendationRow[]
      if (generationRows.length !== currentOpenCount) {
        throw new Error(`current generation count/read mismatch (${currentOpenCount} counted, ${generationRows.length} read)`)
      }
    } catch (error) {
      console.warn(`[Recommendations] Current generation rows failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      return unavailableOpenRecommendationsRead(
        'recommendations_read_failed',
        'The current recommendation generation could not be read completely. Maxx cannot claim that there are no recommendations.',
      )
    }
  }

  const nonCurrentGenerationCount = Math.max(0, totalOpenCount - currentOpenCount)
  let metadata: OperatingEntitySnapshotRead
  try {
    metadata = await loadOperatingEntitySnapshot(db, adAccountDbId, generationRows)
  } catch (error) {
    console.warn(`[Recommendations] Entity lifecycle request threw; Meta-target recommendations were quarantined: ${error instanceof Error ? error.message : 'unknown error'}`)
    const failedTables = new Set<'ads' | 'adsets' | 'campaigns'>()
    for (const row of generationRows) {
      if (row.target_entity_type === 'ad') {
        failedTables.add('ads')
        failedTables.add('adsets')
        failedTables.add('campaigns')
      } else if (row.target_entity_type === 'adset') {
        failedTables.add('adsets')
        failedTables.add('campaigns')
      } else if (row.target_entity_type === 'campaign') {
        failedTables.add('campaigns')
      }
    }
    metadata = {
      snapshot: { campaigns: new Map(), adsets: new Map(), ads: new Map() },
      failedTables: [...failedTables],
    }
  }
  const lifecycleEligibleRows = generationRows
    .filter((row) => recommendationTargetsCurrentOperatingEntity({
      recommendationType: row.recommendation_type,
      targetEntityType: row.target_entity_type,
      targetEntityId: row.target_entity_id,
    }, metadata.snapshot))
  const targetNotCurrentCount = generationRows.length - lifecycleEligibleRows.length
  const eligibleRows = lifecycleEligibleRows.filter((row) => metaRecommendationPostdatesEntityChange(row, metadata.snapshot))
  const predatesEntitySyncCount = lifecycleEligibleRows.length - eligibleRows.length
  const lifecycleQuarantinedCount = nonCurrentGenerationCount + generationRows.length - eligibleRows.length
  const reasons: OpenRecommendationReadReason[] = []

  if (nonCurrentGenerationCount > 0) {
    reasons.push({
      code: 'not_current_generation',
      affectedCount: nonCurrentGenerationCount,
      message: `${nonCurrentGenerationCount} open recommendation${nonCurrentGenerationCount === 1 ? ' belongs' : 's belong'} to a non-current or missing generation and was quarantined.`,
    })
  }
  if (metadata.failedTables.length > 0) {
    reasons.push({
      code: 'entity_metadata_read_failed',
      affectedCount: targetNotCurrentCount,
      message: `Current ${metadata.failedTables.join(', ')} lifecycle metadata could not be read; affected recommendations were quarantined.`,
    })
  }
  if (targetNotCurrentCount > 0) {
    reasons.push({
      code: 'target_not_current',
      affectedCount: targetNotCurrentCount,
      message: `${targetNotCurrentCount} open recommendation${targetNotCurrentCount === 1 ? ' was' : 's were'} quarantined because its target or parent was inactive, stale, missing, or unreadable.`,
    })
  }
  if (predatesEntitySyncCount > 0) {
    reasons.push({
      code: 'predates_entity_sync',
      affectedCount: predatesEntitySyncCount,
      message: `${predatesEntitySyncCount} Meta-target recommendation${predatesEntitySyncCount === 1 ? '' : 's'} predated a later target or parent sync and was quarantined pending fresh evidence.`,
    })
  }
  // Claim lineage is evaluated before the caller limit. Otherwise an invalid row beyond the first page
  // would disappear from the quarantine count, and applying the display limit before this filter could
  // hide later verified rows behind an unsafe row.
  let verifiedMetricClaimRecommendations = new Set<string>()
  let recommendationEvidence = new Map<string, RecommendationEvidenceItem[]>()
  if (eligibleRows.length > 0) {
    try {
      const result = await readVerifiedMetricClaimRecommendations(db, adAccountDbId, eligibleRows)
      verifiedMetricClaimRecommendations = result.verified
      recommendationEvidence = result.evidence
    } catch {
      reasons.push({
        code: 'metric_claim_lineage_read_failed',
        affectedCount: eligibleRows.length,
        message: 'Immutable MetricClaim bindings could not be read; eligible recommendations were quarantined.',
      })
    }
  }
  const invalidMetricClaimLineageCount = eligibleRows.length - verifiedMetricClaimRecommendations.size
  if (invalidMetricClaimLineageCount > 0 && !reasons.some((reason) => reason.code === 'metric_claim_lineage_read_failed')) {
    reasons.push({
      code: 'metric_claim_lineage_invalid',
      affectedCount: invalidMetricClaimLineageCount,
      message: `${invalidMetricClaimLineageCount} eligible recommendation${invalidMetricClaimLineageCount === 1 ? ' is' : 's are'} missing an exact immutable MetricClaim binding and was quarantined.`,
    })
  }
  const lineageEligibleRows = eligibleRows.filter((row) => verifiedMetricClaimRecommendations.has(row.id))
  const rows = lineageEligibleRows.slice(0, Math.max(0, limit))
  let decisions = new Map<string, PersistedActionDecision>()
  if (rows.length > 0) {
    try {
      decisions = await readActionDecisionsBySource(db, adAccountDbId, 'recommendation', rows.map((r) => r.id))
    } catch {
      // Availability over authority: recommendations remain visible, but every unresolved row takes the
      // structural legacy path below and is diagnostic-only. A read error can never promote an action.
      reasons.push({
        code: 'action_authority_read_failed',
        affectedCount: rows.length,
        message: 'Action-authority records could not be read; visible recommendations were forced to diagnostic-only.',
      })
    }
  }
  const recommendations = attachAuthority(rows, decisions, verifiedMetricClaimRecommendations)

  // Re-read the head after every dependent read. A generation can rotate between the initial head
  // lookup and the recommendation/entity/authority queries; returning the old rows as "current" would
  // be a false authority claim. This provides a linearization check without pretending PostgREST gave
  // us a cross-request transaction.
  try {
    const { data: heads, error } = await db
      .from('decision_generations')
      .select('id')
      .eq('ad_account_id', adAccountDbId)
      .eq('kind', 'recommendation')
      .eq('is_current', true)
      .limit(2)
    if (error) throw new Error(error.message)
    const headRows = (heads ?? []) as Array<{ id: string }>
    if (headRows.length > 1) throw new Error('multiple current recommendation generations')
    const verifiedGenerationId = headRows[0]?.id ?? null
    if (verifiedGenerationId !== currentGenerationId) {
      return {
        health: 'unavailable',
        recommendations: [],
        visibleCount: 0,
        quarantinedCount: totalOpenCount,
        reasons: [{
          code: 'current_generation_changed',
          affectedCount: currentOpenCount,
          message: 'The current recommendation generation changed during the read. The stale snapshot was withheld; retry for a complete current view.',
        }],
        evidence: new Map(),
      }
    }
  } catch (error) {
    console.warn(`[Recommendations] Current generation verification failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return {
      health: 'unavailable',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: null,
      reasons: [{
        code: 'current_generation_read_failed',
        affectedCount: null,
        message: 'The current recommendation generation could not be verified after the snapshot read; all rows were withheld.',
      }],
      evidence: new Map(),
    }
  }

  return {
    health: reasons.length > 0 ? 'degraded' : 'healthy',
    recommendations,
    visibleCount: lineageEligibleRows.length,
    quarantinedCount: lifecycleQuarantinedCount + invalidMetricClaimLineageCount,
    reasons,
    evidence: recommendationEvidence,
  }
}

/** Backwards-compatible array read. New owner/agent surfaces must use readOpenRecommendations so a failed
 *  or quarantined feed cannot be mislabeled as a genuinely empty one. */
export async function getOpenRecommendations(
  adAccountDbId: string,
  limit = 20,
): Promise<StoredRecommendation[]> {
  return (await readOpenRecommendations(adAccountDbId, limit)).recommendations
}

/** Recommendations belonging to EXACTLY one generation (account-scoped), ignoring lifecycle status — the
 *  report reads the generation it was pinned to, not "whatever is currently open" (which a newer sync may
 *  have advanced). THROWS on a real DB error (fail-stop): a read failure must NOT be indistinguishable
 *  from a genuinely empty generation, or the report would commit silently omitting its pinned recs. An
 *  empty result (no rows) returns []. */
export async function getRecommendationsByGeneration(
  adAccountDbId: string,
  generationId: string,
  limit = 20
): Promise<StoredRecommendation[]> {
  const db = getAdminClient()
  const { data, error } = await db
    .from('recommendations')
    .select(REC_COLUMNS)
    .eq('ad_account_id', adAccountDbId)
    .eq('generation_id', generationId)
    .order('generated_at', { ascending: false })
    // Lineage is evaluated across the WHOLE generation, before the display limit — the same ordering
    // the open-recommendation reader documents. Limiting first made the lineage verdict depend on which
    // rows happened to sort into the first `limit`, which is not a safety property.
    .limit(GENERATION_LINEAGE_SCAN_CAP)

  if (error) throw new Error(`getRecommendationsByGeneration(${generationId}): ${error.message}`)
  const generationRows = (data ?? []) as unknown as RecommendationRow[]
  // Reports are durable claims. Unlike the live dashboard, an authority read error must fail-stop so a
  // report cannot be committed with a silently downgraded or missing decision plane.
  let verifiedMetricClaimRecommendations: Set<string>
  try {
    const result = await readVerifiedMetricClaimRecommendations(db, adAccountDbId, generationRows)
    verifiedMetricClaimRecommendations = result.verified
  } catch (error) {
    throw new Error(`getRecommendationsByGeneration(${generationId}) MetricClaim lineage read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  // Two different things fail verification, and they are NOT the same failure.
  //
  //   • A row that CLAIMS lineage whose binding does not resolve is corruption or tampering: the row
  //     asserts evidence that is not there. A report must never be committed over that, so it still
  //     fail-stops, exactly as before.
  //   • A row that claims NO lineage (an empty metric_claim_ids array) is a designed outcome.
  //     buildRecommendationMetricClaimBindings deliberately returns an empty array when a source clock,
  //     entity, window or finite Meta value is absent, and says so: the row is quarantined. The
  //     open-recommendation reader above already treats it that way, per row, with a recorded reason.
  //
  // readVerifiedMetricClaimRecommendations reports both as simply "not verified", so failing on the
  // aggregate count punished the second case with the penalty meant for the first: a minority of rows
  // without lineage withheld every published row, and the daily report committed with zero
  // recommendations.
  const assertsUnresolvedLineage = generationRows.filter(
    (row) => (Array.isArray(row.metric_claim_ids) ? row.metric_claim_ids.length : 0) > 0
      && !verifiedMetricClaimRecommendations.has(row.id),
  )
  if (assertsUnresolvedLineage.length > 0) {
    throw new Error(`getRecommendationsByGeneration(${generationId}) MetricClaim lineage is incomplete; report recommendations were withheld`)
  }
  const lineageEligible = generationRows.filter((row) => verifiedMetricClaimRecommendations.has(row.id))
  const withheld = generationRows.length - lineageEligible.length
  if (withheld > 0) {
    // Visible, never silent: a partial report must announce what it dropped and why.
    console.warn(`[Report] ${withheld} of ${generationRows.length} recommendation(s) in generation ${generationId} carry no MetricClaim lineage and were quarantined`)
  }
  const rows = lineageEligible.slice(0, Math.max(0, limit))
  const decisions = await readActionDecisionsBySource(db, adAccountDbId, 'recommendation', rows.map((r) => r.id))
  return attachAuthority(rows, decisions, verifiedMetricClaimRecommendations)
}
