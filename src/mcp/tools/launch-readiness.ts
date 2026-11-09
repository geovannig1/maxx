import { ToolInputError, logToolError } from '@/lib/security/api-error'
import { resolveLaunchReadiness } from '@/lib/modes/launch-readiness-service'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'
import { normalizeCanonicalUrl } from '@/lib/planning-context/contracts'

/**
 * Fail-closed launch status while the immutable CampaignPlan repository is not implemented. It reports
 * current tracking observations but does not infer a cohort from names or accept caller-supplied plan
 * evidence. Nothing here can return ready=true until the account-scoped plan resolver exists.
 *
 * Read-only. Until a plan provides exact entity bindings and a tracking-contract version, it does not
 * select a cohort or emit paste-ready settings. Account tracking health remains an observation only.
 */
export interface GetLaunchReadinessArgs {
  /** Exact page selected for evaluation. The tool never guesses a destination. */
  landing_page_url?: string
}

export async function getLaunchReadiness(args: GetLaunchReadinessArgs = {}): Promise<object> {
  const runtimeArgs = args as unknown
  const validObject = runtimeArgs != null && typeof runtimeArgs === 'object' && !Array.isArray(runtimeArgs)
  const requestedLandingPageUrl = validObject
    ? (runtimeArgs as { landing_page_url?: unknown }).landing_page_url
    : undefined
  let landingPageUrl: string | null = null
  try {
    if (!validObject || (requestedLandingPageUrl !== undefined && typeof requestedLandingPageUrl !== 'string')) {
      throw new ToolInputError('invalid launch-readiness input')
    }
    landingPageUrl = requestedLandingPageUrl === undefined
      ? null
      : normalizeCanonicalUrl(requestedLandingPageUrl)
  } catch {
    return {
      ready: null,
      ready_label: 'unverified',
      error: 'landing_page_url must be an absolute, credential-free HTTP(S) URL within the governed size limit.',
      error_code: 'LANDING_PAGE_URL_INVALID',
      campaign_settings_authorized: false,
      meta_write_performed: false,
    }
  }

  const activeAccount = await resolveOnlyActiveAccount(getAdminClient())
  if (!activeAccount.ok) {
    return {
      ready: null,
      ready_label: 'unverified',
      error: `Launch readiness unavailable because active account ownership is ${activeAccount.reason}.`,
      error_code: activeAccountErrorCode(activeAccount.reason),
      campaign_settings_authorized: false,
      meta_write_performed: false,
    }
  }
  let resolved
  try {
    resolved = await resolveLaunchReadiness(activeAccount.account.id, {
      landingPageUrl,
    })
  } catch (e) {
    return {
      ready: null,
      ready_label: 'unverified',
      error: `Launch readiness unavailable: ${logToolError('get_launch_readiness', 'LAUNCH_READINESS_UNAVAILABLE', e)}`,
      error_code: 'LAUNCH_READINESS_UNAVAILABLE',
      campaign_settings_authorized: false,
      meta_write_performed: false,
    }
  }

  const { verdict, utm, tracking, planningContext } = resolved
  if (!planningContext) {
    return {
      ready: null,
      ready_label: 'unverified',
      error: 'Governed planning context was not evaluated for this launch-readiness request.',
      error_code: 'PLANNING_CONTEXT_NOT_EVALUATED',
      campaign_settings_authorized: false,
      meta_write_performed: false,
    }
  }
  const readyLabel = verdict.ready === true ? 'ready' : verdict.ready === false ? 'not_ready' : 'unverified'

  return {
    ready: verdict.ready,
    ready_label: readyLabel,
    evaluated_cohort: verdict.evaluated_cohort,
    source_of_truth: verdict.source_of_truth,
    confirmed: verdict.confirmed,
    unverified: verdict.unverified,
    launch_blockers: verdict.blockers,
    historical_cleanup: verdict.historical_cleanup,
    before_launch: verdict.before_launch,
    after_launch: verdict.after_launch,
    utm_scope: utm.scope,
    utm_coverage: utm.coverage,
    utm_ads_unverified: utm.adsUnverified,
    utm_source_label: utm.source_label,
    tracking_status: tracking?.status ?? 'unverified',
    tracking_dormant: tracking?.dormant ?? null,
    tracking_contract_status: 'unavailable_until_campaign_plan',
    planning_context_status: planningContext.status,
    planning_context_available: planningContext.context_available_for_campaign_plan,
    planning_context_blockers: planningContext.blocker_codes,
    business_context: {
      status: planningContext.business_context.status,
      version_id: planningContext.business_context.version_id,
      approval_id: planningContext.business_context.approval_id,
    },
    landing_page_context: {
      status: planningContext.landing_page.status,
      canonical_url: planningContext.landing_page.canonical_url,
      snapshot_id: planningContext.landing_page.snapshot_id,
      approval_id: planningContext.landing_page.approval_id,
    },
    campaign_settings_authorized: false,
    meta_write_performed: false,
    note:
      'CAMPAIGN_PLAN_REQUIRED. ready=null means UNVERIFIED, not a pass. Cohort names, newest-created rows, and caller-supplied summaries are not accepted as launch authority. Read-only — nothing writes to Meta.',
  }
}
