import { requireVerifiedCampaignPlanForCreative } from './campaign-plan-gate'

export interface GeneratedImage {
  url: string
  revised_prompt: string | null
  model: string
}

export async function generateAdImage(_params: {
  prompt: string
  size: '1024x1024' | '1792x1024' | '1024x1792'
  quality: 'standard' | 'high'
  n?: number
}): Promise<GeneratedImage[]> {
  void _params
  return requireVerifiedCampaignPlanForCreative()
}

export function buildAdImagePrompt(_params: {
  format: string
  audience: 'professional' | 'consumer'
  hook: string
  cta: string
  visual_direction: string
  business_context?: string
}): string {
  void _params
  return requireVerifiedCampaignPlanForCreative()
}
