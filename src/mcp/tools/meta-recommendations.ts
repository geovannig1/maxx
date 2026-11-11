import { requireCapability } from '@/lib/platforms/registry'
import { loadActiveAccountPlatform } from '@/lib/platforms/account-platform'
import { getAdminClient } from '@/lib/supabase/admin'
import type { NativeRecommendations, NativeRecommendationsResult as MetaRecommendationsResult } from '@/lib/platforms/types'

// MCP tool: Meta's OWN recommendation engine for this account (the suggestions behind Ads Manager's
// opportunity score, sometimes with estimated lift). An empty list is a real state — "no pending
// recommendations", consistent with a high opportunity score. Anything here is Meta's suggestion, not
// Maxx's: it must still pass evaluate_recommendation (grounding gate + decision memory) before being
// endorsed. During the CampaignPlan rescue, even faithfully labelled raw suggestion prose is too easy
// for a model to repeat as Maxx advice. Keep the complete record inside the fetch/audit layer and expose
// only presence, freshness, paging and contract health here.

/** `isStale` is the staleness rule of the platform the recommendations came from. */
export function projectMetaRecommendationsForModel(
  result: MetaRecommendationsResult,
  nowMs: number,
  isStale: NativeRecommendations['isStale'],
): object {
  if (!result.available) {
    return {
      available: false,
      reason: result.reason,
      paging: result.paging ?? null,
      partial_count: result.partialRecommendations?.length ?? 0,
      violation: result.violation ?? null,
      raw_suggestions_withheld: true,
      action_authority: {
        tier: 'diagnostic_only',
        prescriptions: [],
        reason_code: 'meta_advisory_not_governed',
      },
    }
  }

  const staleCount = result.recommendations.filter((recommendation) =>
    isStale(recommendation, nowMs),
  ).length

  return {
    available: true,
    count: result.recommendations.length,
    stale_count: staleCount,
    group_count: result.groupCount,
    violations_count: result.violations.length,
    fetched_at: result.fetchedAt,
    paging: result.paging,
    evidence_class: 'advisory',
    raw_suggestions_withheld: true,
    action_authority: {
      tier: 'diagnostic_only',
      prescriptions: [],
      reason_code: 'meta_advisory_not_governed',
    },
    note:
      result.recommendations.length === 0
        ? 'Meta has no pending recommendations. This is a complete advisory read, not proof that the account setup or performance is healthy.'
        : `${result.recommendations.length} Meta advisory suggestion(s) exist; ${staleCount} are stale or undated. Their instruction text, destination URLs and lift claims are withheld until each can be converted into a governed ActionCandidate and evaluated against first-party evidence.`,
  }
}

export async function getMetaRecommendations(nowMs: number = Date.now()): Promise<object> {
  // The recommendations of the active account's own platform.
  const recommendations = requireCapability(await loadActiveAccountPlatform(getAdminClient()), 'recommendations')
  const result = await recommendations.fetch()
  return projectMetaRecommendationsForModel(result, nowMs, (recommendation, at) => recommendations.isStale(recommendation, at))
}
