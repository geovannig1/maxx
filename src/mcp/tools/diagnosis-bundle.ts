import { logToolError } from '@/lib/security/api-error'
import { diagnoseLaunchPerformance } from '@/lib/diagnostics/launch-performance'
import { buildQualityReport } from '@/lib/diagnostics/quality-report'
import { buildAnomalyReport } from '@/lib/diagnostics/anomaly-report'
import { buildReconciliationReport } from '@/lib/diagnostics/reconciliation-report'
import { getApprovedVerticalBenchmarks } from '@/lib/targets/vertical-benchmarks'
import { requireCapability } from '@/lib/platforms/registry'
import { loadAccountPlatform } from '@/lib/platforms/account-platform'
import { getAdminClient } from '@/lib/supabase/admin'
import { getEconomics } from './economics'
import { getCreativeInsights } from './creative-insights'
import type { NativeRecommendationsResult as MetaRecommendationsResult } from '@/lib/platforms/types'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readLatestClosedAccountDeliveryDate } from '@/lib/accounts/closed-delivery-date'

// MCP tool: ONE server-side gather of the full diagnostic briefing — everything the DIAGNOSIS ANSWER
// CONTRACT needs in a single tool round instead of 6–8: deterministic observations (with
// per-ad-set adsets_detail), auction quality + delivery evidence, metric anomalies, the results
// reconciliation (a Meta-modelled vs GA-telemetry plane conflict + signal health), the profit view,
// creative insights with separate Meta-modelled and governed last-paid-touch planes, including
// format_mix and per-ad delivery sub-status, Meta's own recommendations, and any owner-approved vertical
// benchmarks. Each section degrades independently ({ available:false, reason } / error string) — a
// failed section is reported, never fabricated. Read-only.

type Section = Record<string, unknown> | object

async function section<T extends Section>(p: Promise<T>, label: string): Promise<T | { available: false; reason: string }> {
  try {
    return await p
  } catch (e) {
    return { available: false, reason: `${label} failed: ${logToolError('get_diagnosis_bundle', 'DIAGNOSIS_SECTION_FAILED', e)}` }
  }
}

/** The diagnosis bundle may report that Meta suggestions exist, but it must not smuggle Meta's
 * instruction-shaped prose around ActionAuthority. Model-facing tools expose only diagnostic
 * presence/completeness metadata; the fetch/parser layer retains the internal audit input. */
export function projectMetaRecommendationDiagnostic(result: MetaRecommendationsResult): Record<string, unknown> {
  if (!result.available) {
    return {
      available: false,
      reason: result.reason,
      paging: result.paging ?? null,
      partial_count: result.partialRecommendations?.length ?? 0,
      raw_suggestions_withheld: true,
      action_authority_tier: 'diagnostic_only',
    }
  }
  return {
    available: true,
    count: result.recommendations.length,
    group_count: result.groupCount,
    fetched_at: result.fetchedAt,
    paging: result.paging,
    violations_count: result.violations.length,
    evidence_class: 'advisory',
    raw_suggestions_withheld: true,
    action_authority_tier: 'diagnostic_only',
    note:
      'Meta suggestion text is withheld because it has no governed ActionDecision. The dedicated get_meta_recommendations tool exposes only completeness, count, freshness and contract-health metadata; the fetched payload remains an internal audit input.',
  }
}

export async function getDiagnosisBundle(args: { window_days?: number }): Promise<object> {
  const windowDays = Math.min(Math.max(args?.window_days ?? 30, 7), 90)
  const activeAccount = await resolveOnlyActiveAccount()
  if (!activeAccount.ok) {
    return {
      available: false,
      reason: `active account ${activeAccount.reason}`,
      action_authority: { tier: 'diagnostic_only', prescriptions: [] },
    }
  }
  const to = await readLatestClosedAccountDeliveryDate(activeAccount.account.id)
  if (to === null) {
    return {
      available: false,
      reason: 'latest closed account delivery day unavailable',
      action_authority: { tier: 'diagnostic_only', prescriptions: [] },
    }
  }
  const fromDate = new Date(`${to}T00:00:00Z`)
  fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1))
  const from = fromDate.toISOString().slice(0, 10)
  const range = { start_date: from, end_date: to }

  const [diagnosis, quality, anomalies, reconciliation, economics, creative, meta_recommendations, vertical_benchmarks] =
    await Promise.all([
      section(diagnoseLaunchPerformance({
        adAccountDbId: activeAccount.account.id,
        window: { from, to },
        includeLiveEnrichment: false,
      }), 'diagnosis'),
      section(buildQualityReport({ from, to }), 'auction quality'),
      section(buildAnomalyReport({ from, to, adAccountId: activeAccount.account.id }), 'anomalies'),
      section(buildReconciliationReport({ from, to, adAccountId: activeAccount.account.id }), 'reconciliation'),
      section(getEconomics(range), 'economics'),
      section(getCreativeInsights(range), 'creative insights'),
      loadAccountPlatform(getAdminClient(), activeAccount.account.id).then((platform) => requireCapability(platform, 'recommendations').fetch()),
      getApprovedVerticalBenchmarks().catch(() => []),
    ])

  return {
    window: { from, to, days: windowDays },
    // Step 0 of the answer contract: state the Meta-modelled vs GA-telemetry conflict BEFORE narrating.
    reconciliation,
    // The deterministic verdict + per-ad-set delivery narration (learning counter, results_to_exit,
    // narrow-audience inference, budget overshoot). Never average the audiences.
    diagnosis,
    quality,
    anomalies,
    economics,
    creative,
    meta_recommendations: projectMetaRecommendationDiagnostic(meta_recommendations),
    // Owner-approved, cited, external_heuristic CONTEXT only — empty until approved on /signals.
    vertical_benchmarks,
    action_authority: {
      tier: 'diagnostic_only',
      prescriptions: [],
      reason_code: 'diagnostic_bundle_no_action_candidate',
      reason:
        'This bundle assembles evidence but does not create or resolve an ActionCandidate. Its prescriptions are intentionally empty.',
    },
    note: 'One-round diagnostic-only briefing. Sections degrade independently — an { available:false } section is honestly unavailable, not zero. Creative Meta-modelled observations stay separate from creative.paid_outcomes associated via governed last-paid-touch with booked value and from creative.paid_attribute_distributions, whose attribute groups are non-additive; never flatten or reconcile their counts. Follow the DIAGNOSIS ANSWER CONTRACT: reconciliation preamble first, per-ad-set delivery sub-status from diagnosis.adsets_detail, per-ad delivery sub-status from creative.ad_delivery_sub_statuses, and benchmarks as labeled context only. Do not derive an action from this bundle; use get_recommendations, or send a novel proposal through evaluate_recommendation.',
  }
}
