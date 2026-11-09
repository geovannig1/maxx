// Pure launch-cohort scoping for the launch-readiness verdict (audit fix).
//
// A launch verdict must judge the NEW cohort that's actually going live — not the whole historical
// account. Old paused / replaced ad sets are "historical cleanup", never launch blockers. This layer
// only observes synced Meta goals; the CampaignPlan layer decides whether a goal is correct for the
// intended audience, page, offer, CTA, and outcome.

export interface CohortAdSet {
  name: string
  status: string | null // ACTIVE | PAUSED | …
  optimization_goal: string | null
  created?: string | null // observation only; never used to infer plan membership
  in_launch_cohort: boolean // designated part of the launch set?
  planned_relaunch?: boolean // owner explicitly plans to relaunch an old ad set
}

export interface LaunchCohortVerdict {
  ready: boolean | null // null when a launch item is unverified (can't prove ready OR blocked)
  launch_cohort: string[] // ad set names judged as the launch set
  ok: string[] // launch-cohort ad sets that pass
  unverified: string[] // launch items we can't confirm from a synced source (e.g. goal not synced)
  blockers: string[] // ONLY from launch-cohort (or ACTIVE / relaunch-planned) ad sets
  historical_cleanup: string[] // old paused/replaced items — informational, NOT launch blockers
}

/** The cohort-scoped launch observation. This function does not know the approved business objective,
 *  so non-conversion goals are unverified observations, not blockers. */
export function assessLaunchCohort(adSets: CohortAdSet[]): LaunchCohortVerdict {
  const launch_cohort: string[] = []
  const ok: string[] = []
  const unverified: string[] = []
  const blockers: string[] = []
  const historical_cleanup: string[] = []

  for (const s of adSets) {
    if (s.in_launch_cohort) {
      launch_cohort.push(s.name)
      const goal = s.optimization_goal?.trim()
      if (!goal) {
        unverified.push(`Launch ad set "${s.name}" — optimization goal not synced. Re-sync before an approved CampaignPlan can evaluate compatibility.`)
      } else {
        unverified.push(`Launch ad set "${s.name}" has synced optimization goal ${goal}; compatibility is unverified until an approved CampaignPlan declares the intended outcome.`)
      }
    }
  }

  if (launch_cohort.length === 0) {
    unverified.push('No plan-bound launch cohort exists. Name markers and newest-created heuristics are observations, not launch authority.')
  }

  const ready: boolean | null = blockers.length > 0 ? false : null
  return { ready, launch_cohort, ok, unverified, blockers, historical_cleanup }
}
