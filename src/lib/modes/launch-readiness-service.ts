import type { AdUtmHealth } from '@/lib/tracking/utm-coverage'
import { checkTrackingHealth } from '@/lib/tracking/health-monitor'
import { getAdminClient } from '@/lib/supabase/admin'
import {
  resolveGovernedPlanningContextForAccount,
  type GovernedPlanningContext,
} from '@/lib/planning-context/resolver'
import { assessLaunchCohort, type LaunchCohortVerdict } from './launch-cohort'
import { buildLaunchVerdict, type LaunchReadinessVerdict, type TrackingSummary } from './launch-verdict'

// Read-only launch-readiness glue. Until an immutable CampaignPlan repository and exact entity bindings
// exist, it deliberately resolves no launch cohort and makes no setup judgment. Account tracking can still
// be reported as an observation; it cannot establish that a particular event belongs to an intended launch.

export interface LaunchReadinessResolved {
  verdict: LaunchReadinessVerdict
  cohort: LaunchCohortVerdict
  utm: { scope: string; coverage: number | null; adsUnverified: number; source_label: string }
  tracking: (TrackingSummary & { evaluated: boolean }) | null
  planningContext: GovernedPlanningContext | null
}

export interface ResolveLaunchOpts {
  /** Skip the (Meta-API + write) tracking-health check — cheap cohort+UTM verdict for the operating-mode
   *  signal. The pixel then reports UNVERIFIED (honest for that lightweight context). */
  skipTracking?: boolean
  /** Exact landing-page identity selected by a future CampaignPlan. Missing is a stable fail-closed
   *  context state; this service never guesses the homepage or /book. */
  landingPageUrl?: string | null
  /** Callers that only need legacy cohort/UTM observations must not manufacture a missing-page result
   *  or add a planning-context database dependency. */
  skipPlanningContext?: boolean
}

export async function resolveLaunchReadiness(
  adAccountDbId: string,
  opts?: ResolveLaunchOpts,
): Promise<LaunchReadinessResolved> {
  if (!adAccountDbId) throw new Error('An exact active ad-account id is required.')

  // Cohort identity must come from an immutable CampaignPlan entity binding. Name markers and
  // newest-created heuristics are not authority, so the legacy resolver intentionally evaluates no
  // cohort and no launch-scoped UTM set until that repository exists.
  const cohort = assessLaunchCohort([])
  const utm = {
    scope: 'plan_cohort_unbound',
    coverage: null,
    adsUnverified: 0,
    source_label: 'Not evaluated — no immutable CampaignPlan entity binding exists.',
  }
  const utmAds: AdUtmHealth[] = []

  // Load governed inputs through the one account-scoped resolver. A missing migration, read
  // failure, absent owner approval, expired review, or missing exact URL resolves to stable blockers.
  // It never throws into a permissive fallback and never emits campaign settings.
  const planningContext = opts?.skipPlanningContext
    ? null
    : await resolveGovernedPlanningContextForAccount(
        getAdminClient(),
        adAccountDbId,
        opts?.landingPageUrl ?? null,
      )

  // Tracking / AppointmentConfirmed is retained as an account observation only. A future plan decides
  // whether this event is relevant to the intended launch.
  //    actually evaluate (no pixel id / API error → empty pixel_id) is ALSO unverified, not critical.
  //    Skipped for the lightweight operating-mode signal (leaves the pixel unverified — honest).
  let tracking: (TrackingSummary & { evaluated: boolean }) | null = null
  if (!opts?.skipTracking) {
    try {
      const t = await checkTrackingHealth(adAccountDbId)
      const evaluated = t.pixel_id !== ''
      tracking = {
        status: evaluated ? t.status : 'unverified',
        dormant: t.dormant,
        issues: t.issues,
        evaluated,
      }
    } catch (err) {
      tracking = {
        status: 'unverified',
        dormant: false,
        issues: [`Tracking health could not be evaluated: ${err instanceof Error ? err.message : String(err)}`],
        evaluated: false,
      }
    }
  }

  // 5. Synthesize the one honest, cohort-scoped verdict.
  const verdict = buildLaunchVerdict({
    cohort,
    utmAds,
    utmCoverageScope: utm.scope,
    tracking,
    planningContext,
  })

  return {
    verdict,
    cohort,
    utm: { scope: utm.scope, coverage: utm.coverage, adsUnverified: utm.adsUnverified, source_label: utm.source_label },
    tracking,
    planningContext,
  }
}
