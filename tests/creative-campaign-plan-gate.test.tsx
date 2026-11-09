import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CreatePage from '@/app/(dashboard)/create/page'
import { PlacementPreview } from '@/components/creative/PlacementPreview'

const imageGenerate = vi.hoisted(() => vi.fn(async () => ({ data: [{ url: 'https://example.com/generated.png' }] })))

vi.mock('openai', () => ({
  default: class OpenAI {
    images = { generate: imageGenerate }
  },
}))

import { buildAdImagePrompt, generateAdImage } from '@/lib/creative/image-generator'
import { createUGCVideo } from '@/lib/creative/video-generator'

// Pages now call requireOwner() themselves (src/lib/auth/page-owner.ts); this test measures the
// account boundary, not auth, so the owner check is satisfied up front.
vi.mock('@/lib/auth/page-owner', () => ({ requireOwner: async () => ({ email: 'owner@example.test' }) }))
describe('creative generation requires a server-verified CampaignPlan', () => {
  it('does not render free-form static or UGC generation controls while the plan repository is unavailable', async () => {
    const html = renderToStaticMarkup(await CreatePage())

    expect(html).toMatch(/CampaignPlan/i)
    expect(html).toMatch(/unavailable/i)
    expect(html).not.toMatch(/Generate 4 Variations|Generate Video|No brief selected/i)
  })

  it('does not fabricate an image prompt from caller text or static business defaults', () => {
    expect(() => buildAdImagePrompt({
      format: 'studio showcase',
      audience: 'professional',
      hook: 'Book the best studio',
      cta: 'Book now',
      visual_direction: 'Modern professional studio aesthetic',
    })).toThrow(/CampaignPlan/i)
  })

  it('blocks the provider call as well as the UI', async () => {
    await expect(generateAdImage({
      prompt: 'arbitrary caller prompt',
      size: '1024x1024',
      quality: 'high',
    })).rejects.toThrow(/CampaignPlan/i)
    expect(imageGenerate).not.toHaveBeenCalled()
  })

  it('blocks direct UGC provider calls too', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'job-1' }), { status: 200 }),
    )
    vi.stubEnv('CREATIFY_API_KEY', 'test-provider-key')

    try {
      await expect(createUGCVideo({
        script: 'Book this studio now',
        avatar_id: 'avatar-1',
      })).rejects.toThrow(/CampaignPlan/i)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

describe('placement preview never invents missing ad context', () => {
  it('omits the advertiser identity and CTA when no plan-backed creative context was loaded', () => {
    const html = renderToStaticMarkup(
      <PlacementPreview thumbnailUrl="https://example.com/thumb.jpg" adName="Observed live ad" />,
    )

    expect(html).toMatch(/creative-only preview/i)
    expect(html).not.toMatch(/Example Studio|Book Now|Swipe Up/i)
  })
})
