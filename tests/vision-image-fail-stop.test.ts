import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_API_ENV, anthropicText, jsonResponse, stubFetch, useAiEnv } from './helpers/ai-stub'

/**
 * Image fail-stop for vision analysis. Ported in the v1 release from `callAnthropicWithImage` to the gateway:
 * the image is loaded by `loadVisionImage` and attached by the vision analyzer, and the model is a
 * STUB provider at the transport level. The three guarantees are unchanged: a failed image fetch is
 * a typed error, no model request is made, and a fetched image is sent as base64 bytes.
 */

const mocks = vi.hoisted(() => ({
  fetchTrustedMetaImage: vi.fn(),
  writes: 0,
}))

vi.mock('@/lib/report/trusted-meta-image', () => ({
  fetchTrustedMetaImage: mocks.fetchTrustedMetaImage,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => {
    mocks.writes += 1
    throw new Error('no database in this test')
  },
}))

import { VisionImageUnavailableError, loadVisionImage } from '@/lib/creative/vision-image'
import { analyzeCreative } from '@/lib/creative/vision-analyzer'

const creative = {
  id: '00000000-0000-4000-8000-000000000923',
  ad_account_id: '00000000-0000-4000-8000-000000000921',
  creative_id: '1000000000000005',
  thumbnail_url: 'https://scontent.example/expired.jpg',
  body: 'Studio rental',
  title: 'Create here',
  object_type: 'IMAGE',
}

const ANALYSIS = {
  format: 'static', has_text_overlay: false, hook_text: null, shows_price: false, talent_type: 'none',
  setting: 'studio', color_mood: 'bright', cta_visible: false, hook_strength_score: 3, notes: null,
}

describe('vision image fail-stop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writes = 0
    useAiEnv({ ...CLAUDE_API_ENV })
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('throws VisionImageUnavailableError and never calls the model when the image fetch fails', async () => {
    mocks.fetchTrustedMetaImage.mockRejectedValue(new Error('upstream returned 403'))
    const model = stubFetch(() => jsonResponse(anthropicText(JSON.stringify(ANALYSIS))))

    await expect(loadVisionImage('https://scontent.example/expired.jpg')).rejects.toMatchObject({
      name: 'VisionImageUnavailableError',
      message: expect.stringContaining('upstream returned 403'),
    })
    // The analyzer fails the analysis (null) and makes no model request.
    await expect(analyzeCreative(creative)).resolves.toBeNull()
    expect(model.requests).toHaveLength(0)
    expect(mocks.writes).toBe(0)
  })

  it('rejects with the typed error class, not a generic Error', async () => {
    mocks.fetchTrustedMetaImage.mockRejectedValue(new Error('timeout'))
    await expect(loadVisionImage('https://scontent.example/slow.jpg')).rejects.toBeInstanceOf(VisionImageUnavailableError)
  })

  it('attaches the fetched image bytes when the fetch succeeds', async () => {
    mocks.fetchTrustedMetaImage.mockResolvedValue({ mediaType: 'image/png', bytes: Buffer.from('img-bytes') })
    const model = stubFetch(() => jsonResponse(anthropicText(JSON.stringify(ANALYSIS))))

    // The database is unavailable in this test, so the analysis is not persisted (null); the model
    // request is what is under test here.
    await analyzeCreative({ ...creative, thumbnail_url: 'https://scontent.example/live.jpg' })

    expect(model.requests).toHaveLength(1)
    const messages = model.requests[0].body!.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from('img-bytes').toString('base64') },
    })
  })
})
