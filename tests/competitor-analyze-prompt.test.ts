import { describe, it, expect } from 'vitest'
import { buildCompetitorAdPrompt } from '@/lib/competitors/analyze-ad'

// Regression: the prompt claimed "The ad snapshot image is attached" whenever ad_snapshot_url was present,
// then callAnthropicWithImage silently fell back to text-only (the URL is an Ad Library HTML page, not an
// image) — so the model was told it could see an image it never saw and filled format/price/proof from
// phantom evidence. The prompt is now honest: text-only, never claims an attached image.

describe('buildCompetitorAdPrompt — prompt honesty (text-only)', () => {
  const ad = {
    ad_creative_bodies: ['Book your dream photoshoot today — 20% off first session!'],
    ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=123',
    page_name: 'Rival Studio',
    estimated_days_running: 42,
  }

  it('never claims an image is attached', () => {
    const { user } = buildCompetitorAdPrompt(ad)
    expect(user).not.toMatch(/image is attached/i)
    expect(user).not.toMatch(/attached/i)
  })

  it('states the analysis is text-only and the snapshot URL is not viewable', () => {
    const { user } = buildCompetitorAdPrompt(ad)
    expect(user).toMatch(/TEXT-ONLY/i)
    expect(user).toMatch(/not viewable/i)
  })

  it('includes the ad body text and the required JSON fields', () => {
    const { system, user } = buildCompetitorAdPrompt(ad)
    expect(user).toContain('20% off first session')
    expect(user).toContain('"format_guess"')
    expect(user).toContain('"evidence_basis"')
    expect(system).toContain('the business') // no fixed business name; neutral when unconfigured
    expect(system).not.toContain('Example Studio')
  })

  it('degrades gracefully with no body and no snapshot', () => {
    const { user } = buildCompetitorAdPrompt({})
    expect(user).toContain('(no body text)')
    expect(user).toContain('(no Ad Library ID)')
    expect(user).not.toMatch(/attached/i)
  })
})
