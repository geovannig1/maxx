import { describe, it, expect } from 'vitest'
import { classifyFormat, computeFormatMix } from '@/lib/creative/format-diversity'

describe('classifyFormat', () => {
  it('video_id wins even over a generic SHARE object_type', () => {
    expect(classifyFormat({ asset_type: 'SHARE', video_id: 'v1' })).toBe('video')
    expect(classifyFormat({ asset_type: 'VIDEO', video_id: null })).toBe('video')
  })
  it('classifies static and carousel; unknown otherwise', () => {
    expect(classifyFormat({ asset_type: 'PHOTO', video_id: null })).toBe('static')
    expect(classifyFormat({ asset_type: 'CAROUSEL', video_id: null })).toBe('carousel')
    expect(classifyFormat({ asset_type: 'SHARE', video_id: null })).toBe('unknown')
    expect(classifyFormat({ asset_type: null, video_id: null })).toBe('unknown')
  })
})

describe('computeFormatMix', () => {
  it('shares by count and spend', () => {
    const mix = computeFormatMix([
      { asset_type: 'VIDEO', video_id: 'v1', spend: 60 },
      { asset_type: 'VIDEO', video_id: 'v2', spend: 20 },
      { asset_type: 'PHOTO', video_id: null, spend: 20 },
    ])
    expect(mix.total_creatives).toBe(3)
    expect(mix.total_spend).toBe(100)
    const video = mix.shares.find((s) => s.format === 'video')!
    expect(video.count).toBe(2)
    expect(video.count_share).toBeCloseTo(0.667, 3)
    expect(video.spend_share).toBe(0.8)
    expect(mix.single_format_warning).toBeNull()
  })

  it('single-format warning fires when every creative (≥2) is one known format — the video-only case', () => {
    const mix = computeFormatMix([
      { asset_type: 'VIDEO', video_id: 'v1', spend: 50 },
      { asset_type: 'VIDEO', video_id: 'v2', spend: 30 },
      { asset_type: 'VIDEO', video_id: 'v3', spend: 20 },
      { asset_type: 'VIDEO', video_id: 'v4', spend: 10 },
    ])
    expect(mix.single_format_warning).toMatch(/All 4 creatives are video-format/)
    expect(mix.single_format_warning).toMatch(/ONE labeled format test/)
  })

  it('no warning on a single creative (too small to judge) or when formats are unknown', () => {
    expect(computeFormatMix([{ asset_type: 'VIDEO', video_id: 'v1', spend: 50 }]).single_format_warning).toBeNull()
    expect(
      computeFormatMix([
        { asset_type: 'SHARE', video_id: null, spend: 10 },
        { asset_type: 'SHARE', video_id: null, spend: 10 },
      ]).single_format_warning,
    ).toBeNull()
  })

  it('empty input degrades to an empty mix', () => {
    const mix = computeFormatMix([])
    expect(mix.total_creatives).toBe(0)
    expect(mix.shares).toHaveLength(0)
    expect(mix.single_format_warning).toBeNull()
  })
})
