import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { outcomeWords } from '@/config/outcome-nouns'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export async function getLearnings(args: {
  dimension?: string
  verdict?: string
  limit?: number
}): Promise<object> {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return {
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured; learned decision context is unavailable.'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account is configured.'
          : 'The active ad account could not be resolved; learned decision context is unavailable.',
      error_code: activeAccountErrorCode(activeAccount.reason),
      patterns: [],
      recent_outcomes: [],
    }
  }
  const accountId = activeAccount.account.id
  void args.dimension
  void args.verdict

  // recent_outcomes MUST use the same trust gate as patterns.ts:266-270 so the MCP tool and the pattern
  // engine can never disagree: account-scoped, human-review-approved (`review_status`), and estimate-only
  // lessons (GA4 attribution < 50%, marked in outcome_note) excluded so they can't pose as verified wins.
  const rawRecent = (
    await db
      .from('recommendation_outcomes')
      .select('flag_type, metric_name, outcome, outcome_note, audience_type, meta_entity_id, recommended_on, baseline_value, observed_value, review_status')
      .eq('ad_account_id', accountId)
      .eq('review_status', 'approved')
      .not('outcome', 'is', null)
      .order('evaluated_at', { ascending: false })
      .limit(Math.min(Math.max(args.limit ?? 60, 1), 100))
  ).data

  const recent = (rawRecent ?? [])
    .filter((r) => isCausalContributionMetric(r.metric_name))
    .filter((r) => !((r.outcome_note as string) ?? '').includes('estimate-only'))
    .slice(0, 25)

  return {
    // learned_patterns predates causal-contribution lineage, so old CPA-based rows are withheld.
    patterns: [],
    recent_outcomes: recent,
    note: `Commercial learning is frozen until an owner-reviewed outcome is measured as causal incremental contribution dollars. Legacy CPA/${OW.many} patterns and attributed-only outcomes are withheld.`,
  }
}
