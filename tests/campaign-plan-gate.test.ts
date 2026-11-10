import { describe, expect, it } from 'vitest'
import {
  CAMPAIGN_PLAN_CREATIVE_BLOCKER,
  CAMPAIGN_PLAN_CREATIVE_BLOCKER_CODE,
  CampaignPlanCreativeUnavailableError,
  campaignPlanCreativeUnavailablePayload,
  requireVerifiedCampaignPlanForCreative,
} from '@/lib/creative/campaign-plan-gate'
import { buildAdImagePrompt, generateAdImage } from '@/lib/creative/image-generator'
import { createUGCVideo } from '@/lib/creative/video-generator'

// Image and video generation is on the roadmap, not shipped: /api/generate/image and /video answer 409
// with this payload, and the generators refuse. Mutation testing found the payload's code and message,
// and the error's name, unasserted (3 survivors): the refusal contract could change unnoticed.

describe('image and video generation stays blocked', () => {
  it('returns the exact blocked payload the generate routes send', () => {
    expect(campaignPlanCreativeUnavailablePayload()).toEqual({
      status: 'BLOCKED',
      code: 'CAMPAIGN_PLAN_NOT_IMPLEMENTED',
      message: CAMPAIGN_PLAN_CREATIVE_BLOCKER,
      blocker_codes: ['campaign_plan_not_implemented'],
    })
    expect(CAMPAIGN_PLAN_CREATIVE_BLOCKER).toMatch(/^Image and video generation is not connected/)
  })

  it('throws a named, coded error from the boundary', () => {
    let thrown: unknown
    try { requireVerifiedCampaignPlanForCreative() } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(CampaignPlanCreativeUnavailableError)
    expect(thrown).toMatchObject({
      name: 'CampaignPlanCreativeUnavailableError',
      code: CAMPAIGN_PLAN_CREATIVE_BLOCKER_CODE,
      message: CAMPAIGN_PLAN_CREATIVE_BLOCKER,
    })
  })

  it('refuses at every generator entry point', async () => {
    await expect(generateAdImage({ prompt: 'p', size: '1024x1024', quality: 'standard' }))
      .rejects.toBeInstanceOf(CampaignPlanCreativeUnavailableError)
    await expect(createUGCVideo({ script: 's', avatar_id: 'a' }))
      .rejects.toBeInstanceOf(CampaignPlanCreativeUnavailableError)
    expect(() => buildAdImagePrompt({ format: 'f', audience: 'consumer', hook: 'h', cta: 'c', visual_direction: 'v' }))
      .toThrow(CampaignPlanCreativeUnavailableError)
  })
})
