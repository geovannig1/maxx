import { ToolInputError } from '@/lib/security/api-error'
import { diagnoseLaunchPerformance } from '@/lib/diagnostics/launch-performance'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readLatestClosedAccountDeliveryDate } from '@/lib/accounts/closed-delivery-date'

// MCP tool: deterministic OBSERVATIONS about delivery, learning and signal volume. It deliberately
// emits no setting prescription: compatibility with the business outcome requires an approved
// CampaignPlan, and any later action must resolve through the shared ActionAuthority pipeline.

export async function getLaunchPerformanceDiagnosis(args: { window_days?: number }): Promise<object> {
  const requestedWindowDays = args?.window_days ?? 30
  if (!Number.isSafeInteger(requestedWindowDays)) {
    throw new ToolInputError('Diagnosis window_days must be an integer.')
  }
  const windowDays = Math.min(Math.max(requestedWindowDays, 7), 90)
  const activeAccount = await resolveOnlyActiveAccount()
  let diagnosis: object
  if (!activeAccount.ok) {
    diagnosis = { available: false, reason: `active account ${activeAccount.reason}` }
  } else {
    const to = await readLatestClosedAccountDeliveryDate(activeAccount.account.id)
    if (to === null) {
      diagnosis = { available: false, reason: 'latest closed account delivery day unavailable' }
    } else {
      const fromDate = new Date(`${to}T00:00:00Z`)
      fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1))
      diagnosis = await diagnoseLaunchPerformance({
        adAccountDbId: activeAccount.account.id,
        window: { from: fromDate.toISOString().slice(0, 10), to },
        includeLiveEnrichment: false,
      })
    }
  }
  return {
    diagnosis,
    action_authority: {
      tier: 'diagnostic_only',
      prescriptions: [],
      reason_code: 'diagnostic_surface_no_campaign_plan',
      reason:
        'This tool did not evaluate an approved CampaignPlan or create an ActionCandidate. Its prescriptions are intentionally empty.',
    },
    note:
      'Deterministic diagnostic-only observations. verdict ∈ too_early | still_learning | structurally_starved | healthy. ' +
      'launch.days_delivering is the observed time since first spend. optimization_compatibility remains unknown ' +
      'until an approved CampaignPlan is evaluated. Do not translate observations into an objective, event, budget, ' +
      'audience, page or creative instruction. Read current governed actions from get_recommendations; a novel ' +
      'proposal must go through evaluate_recommendation and the shared authority layer.',
  }
}
