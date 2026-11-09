import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  imageProvider: vi.fn(async () => []),
  videoProvider: vi.fn(async () => ({ job_id: 'job-1' })),
  admin: vi.fn(() => { throw new Error('database should not be reached') }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) },
  })),
}))

vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: state.admin }))
vi.mock('@/lib/creative/image-generator', () => ({ generateAdImage: state.imageProvider }))
vi.mock('@/lib/creative/video-generator', () => ({ createUGCVideo: state.videoProvider }))

describe('creative generation route boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects free-form image generation before provider or database work', async () => {
    const { POST } = await import('@/app/api/generate/image/route')
    const response = await POST(new NextRequest('http://localhost/api/generate/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Book now', brief_id: 'unbound-brief' }),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'CAMPAIGN_PLAN_NOT_IMPLEMENTED',
      blocker_codes: ['campaign_plan_not_implemented'],
    })
    expect(state.imageProvider).not.toHaveBeenCalled()
    expect(state.admin).not.toHaveBeenCalled()
  })

  it('rejects free-form UGC generation before provider or database work', async () => {
    const { POST } = await import('@/app/api/generate/video/route')
    const response = await POST(new NextRequest('http://localhost/api/generate/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'Book now', avatar_id: 'avatar-1', brief_id: 'unbound-brief' }),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'CAMPAIGN_PLAN_NOT_IMPLEMENTED',
      blocker_codes: ['campaign_plan_not_implemented'],
    })
    expect(state.videoProvider).not.toHaveBeenCalled()
    expect(state.admin).not.toHaveBeenCalled()
  })
})
