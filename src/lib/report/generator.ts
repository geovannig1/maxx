import { BUSINESS_PROFILE } from '@/config/business-profile'
import { getAdminClient } from '@/lib/supabase/admin'
import { getRecommendationsByGeneration, type StoredRecommendation } from '@/lib/recommendations/store'
import { commitDailyReportGeneration, getRecLineageStatus, type ReportCommitResult } from '@/lib/flags/generations'
import { renderStoredRecommendation } from '@/mcp/tools/open-recommendations'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { generateText } from '@/lib/ai'
import { runTaskRevalidation } from './task-revalidation'
import { buildCommittedDailyDigest } from './daily-digest-wiring'
import { renderDailyDigestMarkdown, type DailyDigestV3 } from './daily-digest'
import { buildExecutiveEvidenceForReport } from './executive-evidence-production'
import { commitExecutiveEvidenceGeneration } from './executive-evidence-store'
import type { ExecutiveMetaOutcomePlaneV1 } from './executive-evidence.types'
import { businessLocaleFromAccount } from '@/config/business-config'
import { outcomeArrivalLine, reportSourceCompleteness, type ReportOutcomeArrival } from '@/lib/outcomes/report-gate'

type MetaOutcomePlaneContextV1 = ExecutiveMetaOutcomePlaneV1 | {
  complete: boolean
  blockerCodes: string[]
  coverageBlockerCodes?: string[]
  policyVersion?: number
}

function normalizeMetaOutcomePlaneContext(
  value: MetaOutcomePlaneContextV1,
  sourceNotBefore: string,
): ExecutiveMetaOutcomePlaneV1 {
  if (
    value &&
    'status' in value &&
    ['complete', 'incomplete'].includes(value.status) &&
    Array.isArray(value.blockerCodes) &&
    value.blockerCodes.every((code) => typeof code === 'string') &&
    (value.sourceNotBefore === null || Number.isFinite(Date.parse(value.sourceNotBefore))) &&
    Array.isArray(value.checkedLevels) &&
    value.checkedLevels.every((level) => ['campaign', 'adset', 'ad'].includes(level))
  ) {
    return value
  }
  if (
    value &&
    'complete' in value &&
    typeof value.complete === 'boolean' &&
    Array.isArray(value.blockerCodes) &&
    value.blockerCodes.every((code) => typeof code === 'string')
  ) {
    // The coercion must carry coverage across, or a plane with status 'complete' would arrive at the
    // report announcing completeness while its coverage gaps silently vanished — the split's failure
    // mode, flagged in review before it could ship.
    return {
      status: value.complete ? 'complete' : 'incomplete',
      blockerCodes: value.blockerCodes,
      coverageBlockerCodes: value.coverageBlockerCodes ?? [],
      policyVersion: value.policyVersion,
      sourceNotBefore,
      checkedLevels: ['campaign', 'adset', 'ad'],
    }
  }
  throw new Error('Daily V3 generation requires a valid Meta outcome-plane reconciliation result')
}

/** Exact inclusive calendar window used by every source labelled trailing Nd in this report. */
export function trailingInclusiveWindow(endDate: string, days: number): {
  from: string
  to: string
  days: number
} {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('Trailing window days must be a positive integer.')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('Trailing window end must be a valid YYYY-MM-DD date.')
  }
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== endDate) {
    throw new Error('Trailing window end must be a valid YYYY-MM-DD date.')
  }
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return { from: start.toISOString().slice(0, 10), to: endDate, days }
}

export function governedRecommendationAppendix(rows: StoredRecommendation[]): string {
  const bodies = rows.map((row) => renderStoredRecommendation(row))
  return [
    '', '---', '', '## Governed Recommendations', '',
    bodies.length > 0
      ? bodies.join('\n\n')
      : 'The committed recommendation snapshot contains 0 recommendations.',
  ].join('\n')
}

export type DiagnosticRecommendationSnapshotState = 'committed_withheld' | 'unavailable'

function diagnosticRecommendationAppendix(state: DiagnosticRecommendationSnapshotState): string {
  return [
    '', '---', '', '## Governed Recommendations', '',
    state === 'committed_withheld'
      ? 'A committed recommendation snapshot exists, but its recommendations are withheld during the diagnostics-only rollout.'
      : 'No committed recommendation snapshot is available; recommendations are withheld.',
  ].join('\n')
}

/** Current report prose is a deterministic projection of committed evidence. The language model
 * remains available to legacy callers of generateReport(), but it is not part of the V3 publication
 * path and cannot originate a conclusion or action in a current daily report. */
export function projectCurrentDailyReport(
  digest: DailyDigestV3,
  _governedRecommendations: StoredRecommendation[],
  recommendationSnapshotState: DiagnosticRecommendationSnapshotState,
): {
  fullReportMd: string
  summaryText: string
  modelUsed: 'deterministic-daily-v3'
  promptTokens: 0
  completionTokens: 0
} {
  void _governedRecommendations
  const containedMarkdown = renderDailyDigestMarkdown({
    ...digest,
    decisions: ['Governed actions are withheld while report authority is diagnostic only.'],
  })
  return {
    fullReportMd: `${containedMarkdown}${diagnosticRecommendationAppendix(recommendationSnapshotState)}`,
    summaryText: digest.narrative.text,
    modelUsed: 'deterministic-daily-v3',
    promptTokens: 0,
    completionTokens: 0,
  }
}

export function governedRecommendationTasks(rows: StoredRecommendation[]) {
  return rows.flatMap((row) => {
    const decision = row.action_decision
    if (!decision || row.action_authority_tier === 'diagnostic_only') return []
    const target = row.target_entity_name ?? row.target_entity_id ?? row.target_entity_type
    return [{
      action_decision_id: decision.id,
      title: `Review governed ${row.recommendation_type.replace(/_/g, ' ')} decision for ${target}`,
      description: row.observed_fact,
      recommendation: row.reason_for_action,
      priority: row.action_authority_tier === 'execution_eligible' ? 'high' as const : 'medium' as const,
      due_date: row.recommended_next_check_date,
    }]
  })
}

const REPORT_NARRATIVE_MAX_TOKENS = 8_000
const REPORT_NARRATIVE_TIMEOUT_MS = 120_000

/**
 * Legacy narrative generation (not on the V3 publication path, which is deterministic). One call to
 * the configured AI provider through the gateway. With AI off it throws `AiDisabledError`; a
 * refusal or a max-token stop throws its typed error rather than returning partial text.
 */
export async function generateReport(system: string, userMessage: string): Promise<{
  text: string
  modelUsed: string
  promptTokens: number
  completionTokens: number
}> {
  const result = await generateText({
    feature: 'report_narrative',
    system,
    user: userMessage,
    maxTokens: REPORT_NARRATIVE_MAX_TOKENS,
    timeoutMs: REPORT_NARRATIVE_TIMEOUT_MS,
    cacheSystemPrompt: true,
  })
  console.log(`[Report] Narrative from ${result.provider} (${result.model})`)
  return {
    text: result.text,
    modelUsed: result.model,
    promptTokens: result.usage.inputTokens,
    completionTokens: result.usage.outputTokens,
  }
}

/** The deterministic statement for a PINNED generation that contains zero recommendations. The
 *  LLM must be able to distinguish "a complete evaluation found nothing" (this line) from "no
 *  recommendation information was supplied" (the section being absent) and from "no committed snapshot
 *  exists" (NO_SNAPSHOT_NOTICE). Copy is lineage-NEUTRAL: it also appears under a
 *  stale/unknown caveat, where claiming the snapshot is "current" would contradict the caveat above it. */
export const EMPTY_SNAPSHOT_NOTICE = 'The pinned recommendation snapshot contains 0 open recommendations.'

/** PURE: compose the narrative's recommendations block from the lineage notice + the rendered
 *  recommendation bodies. NEVER null for a pinned generation: an EMPTY generation emits the
 *  deterministic zero-count statement (plus its stale/unknown caveat when lineage is degraded), so the
 *  prompt's structured-recommendations section is always present and unambiguous. Exported for direct
 *  unit + prompt-level testing. */
export function composeOpenRecommendations(notice: string | null, bodies: string[]): string {
  const parts = [notice ? `_${notice}_` : null, ...(bodies.length > 0 ? bodies : [EMPTY_SNAPSHOT_NOTICE])]
    .filter((p): p is string => Boolean(p))
  return parts.join('\n\n')
}

export async function generateDailyReport(
  adAccountDbId: string,
  date: string,
  // Durable generations: the recommendation generation this report is pinned to. Non-null = narrate exactly
  // that generation's recs and commit only if it is still the latest for the date. null = the governed
  // sync produced no recommendation snapshot, so the report uses the I1-labeled no-manifest path and
  // the RPC's null-generation guard. Out-of-band and historical generation are not permitted.
  recGenerationId: string | null,
  context: {
    setupGenerationId?: string | null
    sourceNotBefore: string
    metaOutcomePlane: MetaOutcomePlaneContextV1
    /** Set when every enabled outcome source is push-only: recorded as how outcomes arrived. */
    outcomeArrival?: ReportOutcomeArrival | null
  },
): Promise<ReportCommitResult> {
  if (!context.sourceNotBefore || !Number.isFinite(Date.parse(context.sourceNotBefore))) {
    throw new Error('Daily V3 generation requires a valid synchronized-source boundary')
  }
  const metaOutcomePlane = normalizeMetaOutcomePlaneContext(context.metaOutcomePlane, context.sourceNotBefore)
  const supabase = getAdminClient()
  const genStart = Date.now()

  // --- 6. Fetch account name ---
  const { data: accountRow } = await supabase
    .from('ad_accounts')
    .select('account_name, timezone_name')
    .eq('id', adAccountDbId)
    .maybeSingle()

  const accountName = (accountRow?.account_name as string) ?? BUSINESS_PROFILE.name
  const timezone = businessLocaleFromAccount(accountRow).timezone

  // --- 6f. Structured recommendations for THIS report's PINNED generation — the daily
  // engine's gate-evaluated output (same rows the owner sees). Read by generation, not "whatever is open
  // now" (a newer sync may have advanced it). The narrative must reconcile with them, not contradict.
  // Lineage is computed for EVERY non-null generation — a legitimately EMPTY generation still
  // carries its stale/unknown caveat — and a lineage-verification failure yields the honest 'unknown'
  // notice, never a silent no-caveat. The flag generation the lineage was computed against is threaded
  // into the commit as a race guard (a newer flag gen for the date arriving mid-generation rejects). ---
  let lineageFlagGeneration: string | null = null
  if (recGenerationId !== null) {
    // FAIL-STOP: the pinned read is intentionally UNGUARDED — a DB/permission/schema error must abort the
    // report (it propagates to the orchestrator, which records a partial error and leaves the prior report
    // standing), never commit a report that silently omits its pinned recommendation generation.
    await getRecommendationsByGeneration(adAccountDbId, recGenerationId, 8)
    try {
      const status = await getRecLineageStatus(supabase, adAccountDbId, recGenerationId)
      // Race guard: only when lineage verified CURRENT do we pin the commit to that flag generation —
      // stale/unknown lineage stays diagnostic-only, so no guard is needed there.
      if (status.state === 'current') lineageFlagGeneration = status.parentFlagGeneration
    } catch (err) {
      console.warn('[Report] lineage verification failed — keeping recommendation details withheld:', err)
    }
  }

  // One read-only, cross-source evidence snapshot is built after the lifecycle sync has refreshed
  // entities, placements, outcome sources/CAPI, and paid cohorts. It is committed before the report and then
  // bound to that report by the database trigger; any missing source stays unavailable in the snapshot.
  const evidenceAsOf = new Date().toISOString()
  const executiveEvidence = await buildExecutiveEvidenceForReport({
    accountId: adAccountDbId,
    accountName,
    timezone,
    asOf: evidenceAsOf,
    lastCompleteDate: date,
  }, {
    db: supabase,
    currentRunSetupGenerationId: context.setupGenerationId,
    currentRunSourceNotBefore: context.sourceNotBefore,
    currentRunMetaOutcomePlane: metaOutcomePlane,
  })
  const executiveEvidenceGeneration = await commitExecutiveEvidenceGeneration(supabase, executiveEvidence)

  // THE digest path lives in daily-digest-wiring.ts so every wiring decision — budget target, both
  // booking planes, the governed read, and the markdown re-render — is executable under test.
  const dailyDigest = await buildCommittedDailyDigest({
    reportDate: date,
    accountName,
    accountInsights: null,
    sevenDayDailyAverage: null,
    ledgerBookingsToday: null,
    ledgerBookingsPriorSevenDayAverage: null,
    executiveEvidence,
  })

  const {
    fullReportMd: projectedReportMd,
    summaryText,
    modelUsed,
    promptTokens,
    completionTokens,
  } = projectCurrentDailyReport(
    dailyDigest,
    [],
    recGenerationId === null ? 'unavailable' : 'committed_withheld',
  )
  // Push-only outcome sources have no completeness proof: the report names how their outcomes arrived.
  const arrivalLine = outcomeArrivalLine(context.outcomeArrival)
  const fullReportMd = arrivalLine ? `${projectedReportMd}\n\n${arrivalLine}` : projectedReportMd

  const digestValue = (key: DailyDigestV3['kpis'][number]['key']): number | null =>
    dailyDigest.kpis.find((row) => row.key === key)?.value ?? null
  const reportSpend = digestValue('spend')
  const reportLeads = digestValue('leads')
  const reportMetaBookings = digestValue('bookings_meta')
  const reportOutcomeBookings = digestValue('bookings_real')
  const reportCpl = digestValue('cpl')
  const reportCpb = reportSpend !== null && reportMetaBookings !== null && reportMetaBookings > 0
    ? reportSpend / reportMetaBookings
    : null
  const lastDayOutcome = executiveEvidence.outcomes?.byWindow.lastDay ?? null
  const outcomeSourceAvailable = executiveEvidence.sources.outcomes.availability !== 'unavailable'
    && lastDayOutcome !== null

  const generationMs = Date.now() - genStart

  // --- 9. Persist via commit_daily_report_generation — commits ONLY if this report's
  // recommendation generation is still the latest for the date (non-null path) or no rec manifest exists
  // for the date (null path). A non-committed result is a logged SKIP: a newer sync won the date, the
  // prior report row stands, and we do NOT create tasks against a report that didn't persist. ---
  const commit = await commitDailyReportGeneration(supabase, {
    adAccountId: adAccountDbId,
    reportDate: date,
    recGeneration: recGenerationId,
    // Lineage-race guard: when the narrative verified lineage CURRENT against a specific flag
    // generation, the commit rejects if a newer flag gen for the date arrived mid-generation — an
    // uncaveated "current" narrative can never persist over silently-staled lineage.
    expectedFlagGeneration: lineageFlagGeneration,
    payload: {
      summary_text: summaryText,
      full_report_md: fullReportMd,
      report_json: {
        dailyDigest,
        action_authority_policy_version: ACTION_DECISION_POLICY_FLOOR,
        money_basis: {
          version: 1,
          basis: 'outcome_collected_value',
          source_available: outcomeSourceAvailable,
          // Collected-value coverage: every active outcome in the window has a recorded collected value.
          // It says nothing about the sources' completeness, stated in source_completeness.
          revenue_complete: outcomeSourceAvailable
            && lastDayOutcome.activeAmountPaidRevenue !== null,
          observed_collected_value_lower_bound: lastDayOutcome?.activeAmountPaidObserved ?? null,
          covered_outcomes: lastDayOutcome?.amountPaidCoverage.withRecordedAmount ?? null,
          total_outcomes: lastDayOutcome?.amountPaidCoverage.total ?? null,
          active_outcome_value_basis: 'active_outcomes_only',
          source_completeness: reportSourceCompleteness(context.outcomeArrival),
        },
        ...(context.outcomeArrival ? { outcome_arrival: context.outcomeArrival } : {}),
      },
      executive_evidence_generation_id: executiveEvidenceGeneration.id,
      total_spend: reportSpend,
      total_leads: reportLeads,
      total_bookings: reportMetaBookings,
      // outcome ledger = canonical business truth; total_bookings stays Meta-attributed. The persisted
      // column names predate the owner-confirmed revenue contract; going forward business_revenue is
      // Outcome-source amount_paid checkout revenue after discounts. Booked value remains in report_json.
      business_outcomes: reportOutcomeBookings,
      business_revenue: lastDayOutcome?.activeAmountPaidRevenue ?? null,
      avg_cpl: reportCpl,
      avg_cpb: reportCpb,
      model_used: modelUsed,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      generation_ms: generationMs,
    },
  })

  if (!commit.committed) {
    console.warn(`[Report] ${date} NOT committed (${commit.reason}) — prior report stands; tasks skipped`)
    return commit
  }
  const reportId = commit.report_id as string

  // --- 10. Current diagnostic reports cannot create recommendation tasks. Re-validate existing open
  // tasks against current reality (positive-invalidation-only) — auto-closes
  // dormant-era fossils whose premise is now provably false; never touches items it can't disprove. ---
  try {
    const closed = await runTaskRevalidation(adAccountDbId)
    if (closed > 0) console.log(`[Report] Re-validation auto-closed ${closed} stale task(s)`)
  } catch (revErr) {
    console.warn(`[Report] Task re-validation skipped (non-fatal):`, revErr instanceof Error ? revErr.message : revErr)
  }

  console.log(
    `[Report] Generated report ${reportId} for ${date} — ` +
    `model: ${modelUsed}, ${promptTokens}pt + ${completionTokens}ct tokens, ${generationMs}ms, 0 tasks`
  )

  return commit
}
