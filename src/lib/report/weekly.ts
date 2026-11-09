import { randomUUID } from 'node:crypto'
import { getAdminClient } from '@/lib/supabase/admin'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { readExecutiveEvidenceGeneration } from './executive-evidence-store'
import { buildWeeklyExecutiveDigest, type WeeklyExecutiveDigestV1 } from './weekly-executive'
import { outcomeArrivalLine, reportSourceCompleteness, type ReportOutcomeArrival } from '@/lib/outcomes/report-gate'

// ── Weekly knowledge & learning digest (brain-audit hole 15) ────────────────────────────────
// Deterministic markdown appended to the weekly report AFTER the LLM narrative (renders even when no
// LLM is configured): what entered/left the knowledge base and what the learning loop is waiting on.

export interface KnowledgeDigestInput {
  insights: { review_status: string | null; expires_at: string | null; title: string }[]
  patterns: { dimension: string; segment: string; verdict: string | null }[]
  pendingOutcomeReviews: number
  today: string
}

/** PURE: render the digest section (exported for tests). */
export function renderKnowledgeDigest(d: KnowledgeDigestInput): string {
  const approved = d.insights.filter((i) => i.review_status === 'approved')
  const pending = d.insights.filter((i) => (i.review_status ?? 'pending') === 'pending')
  const soon = new Date(new Date(d.today + 'T00:00:00Z').getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  const expiring = approved.filter((i) => i.expires_at && i.expires_at.slice(0, 10) <= soon)

  const verdictCounts = new Map<string, number>()
  for (const p of d.patterns) {
    const v = p.verdict ?? 'insufficient'
    verdictCounts.set(v, (verdictCounts.get(v) ?? 0) + 1)
  }
  const reviewed = d.patterns.filter((p) => p.dimension === 'recommendation_type')

  const lines: string[] = ['', '---', '', '## Knowledge & Learning (system digest)', '']
  lines.push(`- **Expert insights:** ${approved.length} approved (citable) · ${pending.length} pending your review on Signals${pending.length > 0 ? ' ← review these' : ''}.`)
  if (expiring.length > 0) {
    lines.push(`- **Expiring ≤14 days** (re-approve or let lapse): ${expiring.slice(0, 5).map((i) => `"${i.title.slice(0, 60)}" (${i.expires_at!.slice(0, 10)})`).join(' · ')}${expiring.length > 5 ? ` · +${expiring.length - 5} more` : ''}`)
  }
  const vc = [...verdictCounts.entries()].map(([v, n]) => `${n} ${v}`).join(' · ')
  lines.push(`- **Owner-reviewed recommendation history:** ${reviewed.length} owner-reviewed pattern(s) (${vc || 'none yet'}).`)
  if (reviewed.length > 0) {
    lines.push(`- **Historical outcomes:** ${reviewed.slice(0, 6).map((p) => `${p.segment} = ${p.verdict}`).join(' · ')}${reviewed.length > 6 ? ` · +${reviewed.length - 6} more` : ''}. These do not authorize a current action.`)
  }
  lines.push(`- **Outcome reviews waiting:** ${d.pendingOutcomeReviews} lesson(s) pending your approve/reject — the learning loop stays frozen on these until reviewed.`)
  return lines.join('\n')
}

/** Current weekly prose is the exact deterministic projection stored in the evidence-bound digest.
 * Legacy LLM report helpers remain readable for historical rows but are not called for new reports. */
export function projectCurrentWeeklyReport(digest: WeeklyExecutiveDigestV1): {
  fullReportMd: string
  summaryText: string
  modelUsed: 'deterministic-weekly-v1'
} {
  return {
    fullReportMd: digest.text,
    summaryText: digest.context.current_week,
    modelUsed: 'deterministic-weekly-v1',
  }
}

// ── Pure helpers (exported for tests) ──────────────────────────────────────────

export interface WeeklyAgg {
  days: number
  spend: number
  leads: number
  bookings: number
  impressions: number
  reach: number
  clicks: number
  apptValue: number
  cpl: number | null
  cpb: number | null
  ctr: number | null
  cpm: number | null
  roas: number | null
}

/** Aggregate account-level daily rows into weekly totals; rates recomputed from totals. */
export function aggregateWeekly(rows: Array<Record<string, unknown>>): WeeklyAgg {
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)
  const spend = sum('spend')
  const leads = sum('leads')
  const bookings = sum('bookings')
  const impressions = sum('impressions')
  const reach = sum('reach')
  const clicks = sum('clicks')
  const apptValue = sum('appointment_value')
  return {
    days: rows.length,
    spend,
    leads,
    bookings,
    impressions,
    reach,
    clicks,
    apptValue,
    cpl: leads > 0 ? spend / leads : null,
    cpb: bookings > 0 ? spend / bookings : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    roas: apptValue > 0 && spend > 0 ? apptValue / spend : null,
  }
}

/** Week-over-week percent change; null when the prior value is 0 (can't form a ratio). */
export function pctDelta(curr: number, prev: number): number | null {
  if (!isFinite(prev) || prev === 0) return null
  return ((curr - prev) / prev) * 100
}

// ── Weekly report ──────────────────────────────────────────────────────────────

/**
 * Generates (and upserts) a weekly report for [weekStart, weekEnd] (inclusive, NY dates).
 * Metrics persist even when no LLM is configured (narrative is best-effort), mirroring the
 * daily generator's decoupling so the dashboard always has weekly numbers.
 */
export async function generateWeeklyReport(
  adAccountDbId: string,
  weekStart: string,
  weekEnd: string,
  dailyReportId: string,
  /** outcomeArrival: set when every enabled outcome source is push-only; recorded as how outcomes arrived. */
  options: { outcomeArrival?: ReportOutcomeArrival | null } = {},
): Promise<string> {
  const db = getAdminClient()

  // Monday's weekly report reuses the exact immutable evidence generation committed for Sunday's
  // daily report. There is one source snapshot for both reports; missing lineage blocks publication
  // rather than causing a second best-effort reconstruction of the week.
  const dailyEvidenceRead = await db
    .from('daily_reports')
    .select('id,executive_evidence_generation_id')
    .eq('id', dailyReportId)
    .eq('ad_account_id', adAccountDbId)
    .eq('report_date', weekEnd)
    .maybeSingle()
  if (dailyEvidenceRead.error) {
    throw new Error(`generateWeeklyReport: daily evidence binding unavailable (${dailyEvidenceRead.error.message})`)
  }
  const boundDaily = dailyEvidenceRead.data as {
    id?: string | null
    executive_evidence_generation_id?: string | null
  } | null
  const evidenceGenerationId = boundDaily?.executive_evidence_generation_id ?? null
  if (boundDaily?.id !== dailyReportId || !evidenceGenerationId) {
    throw new Error('generateWeeklyReport: daily evidence binding unavailable')
  }
  const executiveEvidence = await readExecutiveEvidenceGeneration(db, {
    id: evidenceGenerationId,
    accountId: adAccountDbId,
    reportDate: weekEnd,
  })

  // Never trust a pre-existing row as current evidence. Each attempt proposes a self-consistent new
  // identity; the database lock either commits it or returns the already-validated current row.
  const weeklyReportId = randomUUID()
  const weeklyDigest = buildWeeklyExecutiveDigest(executiveEvidence, {
    weeklyReportId,
    weekStart,
    weekEnd,
  })

  const { fullReportMd: projectedReportMd, summaryText, modelUsed } = projectCurrentWeeklyReport(weeklyDigest)
  // Push-only outcome sources have no completeness proof: the report names how their outcomes arrived.
  const arrivalLine = outcomeArrivalLine(options.outcomeArrival)
  const fullReportMd = arrivalLine ? `${projectedReportMd}\n\n${arrivalLine}` : projectedReportMd
  const snapshotMeta = executiveEvidence.meta?.byWindow.trailing7 ?? null
  const snapshotPriorMeta = executiveEvidence.meta?.byWindow.prior7 ?? null
  const snapshotOutcome = executiveEvidence.outcomes?.byWindow.trailing7 ?? null
  const snapshotOutcomeAvailable = executiveEvidence.sources.outcomes.availability !== 'unavailable'
    && snapshotOutcome !== null
  const snapshotCpl = snapshotMeta && snapshotMeta.leads !== null && snapshotMeta.leads > 0
    ? snapshotMeta.spendAmount / snapshotMeta.leads
    : null
  const snapshotCpb = snapshotMeta && snapshotMeta.modeledBookings !== null && snapshotMeta.modeledBookings > 0
    ? snapshotMeta.spendAmount / snapshotMeta.modeledBookings
    : null

  const payload = {
    id: weeklyReportId,
    ad_account_id: adAccountDbId,
    week_start: weekStart,
    week_end: weekEnd,
    summary_text: summaryText,
    full_report_md: fullReportMd,
    report_json: {
      weeklyDigest,
      action_authority_policy_version: ACTION_DECISION_POLICY_FLOOR,
      money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: snapshotOutcomeAvailable,
        // Collected-value coverage, not source completeness (source_completeness).
        revenue_complete: snapshotOutcomeAvailable
          && snapshotOutcome.activeAmountPaidRevenue !== null,
        observed_collected_value_lower_bound: snapshotOutcome?.activeAmountPaidObserved ?? null,
        covered_outcomes: snapshotOutcome?.amountPaidCoverage.withRecordedAmount ?? null,
        total_outcomes: snapshotOutcome?.amountPaidCoverage.total ?? null,
        active_outcome_value_basis: 'active_outcomes_only',
        source_completeness: reportSourceCompleteness(options.outcomeArrival),
      },
      ...(options.outcomeArrival ? { outcome_arrival: options.outcomeArrival } : {}),
    } as unknown as Record<string, unknown>,
    total_spend: snapshotMeta?.spendAmount ?? null,
    total_leads: snapshotMeta?.leads ?? null,
    total_bookings: snapshotMeta?.modeledBookings ?? null,
    // outcome ledger = canonical business truth; total_bookings stays Meta-attributed. The persisted
    // column names predate the owner-confirmed revenue contract; business_revenue now stores
    // Outcome-source amount_paid checkout revenue after discounts. Booked value remains in report_json.
    business_outcomes: snapshotOutcome?.valueBearingBookings ?? null,
    business_revenue: snapshotOutcome?.activeAmountPaidRevenue ?? null,
    avg_cpl: snapshotCpl,
    avg_cpb: snapshotCpb,
    // GA CONFIRMATION EVENTS and GA event VALUE (web-only, blended). Telemetry, not bookings/revenue.
    ga4_bookings: null, // persisted legacy column; unavailable is NULL, never a measured zero
    ga4_revenue: null, // persisted legacy column; unavailable is NULL, never a measured zero
    prev_total_spend: snapshotPriorMeta?.spendAmount ?? null,
    prev_total_bookings: snapshotPriorMeta?.modeledBookings ?? null,
    model_used: modelUsed,
    generated_at: new Date().toISOString(),
    executive_evidence_generation_id: evidenceGenerationId,
  }
  const { data: committedId, error } = await db.rpc('commit_weekly_executive_report', {
    p_account: adAccountDbId,
    p_week_start: weekStart,
    p_week_end: weekEnd,
    p_payload: payload,
  })
  if (error) throw new Error(`generateWeeklyReport: atomic commit failed: ${error.message}`)
  if (typeof committedId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(committedId)) {
    throw new Error('generateWeeklyReport: atomic commit returned an invalid report identity')
  }
  return committedId
}
