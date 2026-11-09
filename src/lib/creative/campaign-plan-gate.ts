export const CAMPAIGN_PLAN_CREATIVE_BLOCKER =
  'Image and video generation is not connected to the CampaignPlan repository: a campaign plan (ADR-062) uses creatives already in your ad account, and generated media would need its own verified brief, claims, audience stage, CTA and destination.'

export const CAMPAIGN_PLAN_CREATIVE_BLOCKER_CODE = 'CAMPAIGN_PLAN_NOT_IMPLEMENTED'

export class CampaignPlanCreativeUnavailableError extends Error {
  readonly code = CAMPAIGN_PLAN_CREATIVE_BLOCKER_CODE

  constructor() {
    super(CAMPAIGN_PLAN_CREATIVE_BLOCKER)
    this.name = 'CampaignPlanCreativeUnavailableError'
  }
}

/**
 * Fail-closed boundary while there is no durable CampaignPlan repository. A caller-supplied brief id,
 * prompt, hash, or approval string cannot establish provenance. Replace this boundary only with a
 * server-side lookup that verifies the exact approved plan revision and its account/entity bindings.
 */
export function requireVerifiedCampaignPlanForCreative(): never {
  throw new CampaignPlanCreativeUnavailableError()
}

export function campaignPlanCreativeUnavailablePayload() {
  return {
    status: 'BLOCKED' as const,
    code: CAMPAIGN_PLAN_CREATIVE_BLOCKER_CODE,
    message: CAMPAIGN_PLAN_CREATIVE_BLOCKER,
    blocker_codes: ['campaign_plan_not_implemented'] as const,
  }
}
