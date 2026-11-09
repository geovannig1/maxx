import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'

export const runtime = 'nodejs'

/**
 * The legacy reallocation endpoint combined account-wide Meta-modelled outcomes,
 * mutable target defaults, and an independent flag path. It cannot publish a
 * money recommendation until CampaignPlan, governed targets, and complete
 * paid-interaction cohorts exist.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  return Response.json({
    status: 'UNAVAILABLE',
    code: 'CAMPAIGN_PLAN_REQUIRED',
    authority_tier: 'diagnostic_only',
    blocker_codes: [
      'campaign_plan_not_committed',
      'governed_target_policy_not_committed',
      'paid_interaction_cohort_incomplete',
    ],
    message: 'Automated budget moves are unavailable until the campaign plan, governed targets, and paid-interaction outcome cohort are committed.',
  }, { status: 409 })
}
