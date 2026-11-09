import { describe, expect, it } from 'vitest'
import { presentCreative } from '@/lib/platforms/meta/reporting/meta-inventory'
import { describeCreativeIdentity, ReportCreativeIdentitySchema } from '@/lib/reporting/creative-identity'
import { ReportCreativeSchema } from '@/lib/reporting/contracts'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { snapshotPacket } from './fixtures/reporting-snapshot'

const asOf = '2026-09-05T16:00:00.000Z'
describe('observed creative media identity', () => {
  it('retains one identified feed video and its playback without losing asset-feed provenance', () => {
    const video = { id: '22', source: 'https://cdn.test/22.mp4', length: 10 }
    expect(presentCreative('11', { id: '11', video_id: '22' }, video, asOf)).toMatchObject({
      format: 'video', videoUrl: video.source, durationSeconds: 10,
    })
    const row = { id: '11', image_url: 'https://cdn.test/poster.jpg', asset_feed_spec: { videos: [{ video_id: '22' }] } }
    expect(presentCreative('11', row, video)).toMatchObject({ format: 'video', videoUrl: video.source, durationSeconds: 10 })
    expect(presentCreative('11', row, video, asOf)).toMatchObject({ format: 'video', videoUrl: video.source,
      durationSeconds: 10, identity: { structure: 'asset_feed', unresolvedSourcePaths: ['/image_url'] } })
    expect(presentCreative('11', { ...row, asset_feed_spec: {
      videos: [{ video_id: '22' }, { video_id: '33' }],
    } }, video, asOf)).toMatchObject({ format: 'video', videoUrl: null, durationSeconds: null })
    for (const feed of [
      { videos: [{ video_id: '22' }], images: [{ hash: 'other-media' }] },
      { videos: [{ video_id: '22' }, { video_id: 33 }] },
    ]) expect(presentCreative('11', { ...row, asset_feed_spec: feed }, video, asOf)).toMatchObject({
      format: 'unknown', videoUrl: null, durationSeconds: null,
    })
  })

  it.each([
    { extra: { object_story_spec: { video_data: { video_id: 33 } } }, path: '/object_story_spec/video_data/video_id' },
    { extra: { asset_feed_spec: 'invalid' }, path: '/asset_feed_spec' },
  ])('withholds singular media when an alternate slot is malformed: $path', ({ extra, path }) => {
    const video = { id: '22', source: 'https://cdn.test/22.mp4', length: 10 }
    const row = { id: '11', video_id: '22', image_url: 'https://cdn.test/poster.jpg' }
    expect(presentCreative('11', row, video, asOf)).toMatchObject({ format: 'video', videoUrl: video.source, durationSeconds: 10 })
    const creative = presentCreative('11', { ...row, ...extra }, video, asOf)!
    expect(creative.identity?.members).toContainEqual({ kind: 'video', id: '22', role: 'media', sourcePaths: ['/video_id'] })
    expect(creative.identity?.unresolvedSourcePaths).toContain(path)
    expect(creative).toMatchObject({ format: 'unknown', videoUrl: null, durationSeconds: null })
  })

  it('preserves media IDs and merges matching source paths without treating the poster as delivered media', () => {
    const identity = describeCreativeIdentity({ id: '11', video_id: '22', image_hash: 'poster-hash',
      object_story_spec: { video_data: { video_id: '22', image_hash: 'poster-hash' } } }, asOf)
    expect(identity).toMatchObject({ version: 1, basis: 'current_meta_configuration', observedAt: asOf,
      structure: 'single', completeness: 'observed_fields_only' })
    expect(identity.members).toEqual([
      { kind: 'image', id: 'poster-hash', role: 'poster', sourcePaths: ['/image_hash', '/object_story_spec/video_data/image_hash'] },
      { kind: 'video', id: '22', role: 'media', sourcePaths: ['/object_story_spec/video_data/video_id', '/video_id'] },
    ])
    expect(ReportCreativeIdentitySchema.parse(identity)).toEqual(identity)
  })

  it('retains every supplied dynamic and carousel member with its own source path', () => {
    const dynamic = describeCreativeIdentity({ asset_feed_spec: {
      videos: [{ video_id: '22' }, { video_id: '33' }], images: [{ hash: 'hash-a' }, { hash: 'hash-b' }],
    } }, asOf)
    expect(dynamic.structure).toBe('asset_feed')
    expect(dynamic.members.map(member => member.id).sort()).toEqual(['22', '33', 'hash-a', 'hash-b'])
    const carousel = describeCreativeIdentity({ object_story_spec: { link_data: { child_attachments: [
      { image_hash: 'hash-a' }, { video_id: '33', image_hash: 'poster-b' },
    ] } } }, asOf)
    expect(carousel.structure).toBe('carousel')
    expect(carousel.members.find(member => member.id === 'poster-b')?.role).toBe('poster')
    expect(carousel.members.find(member => member.id === '33')?.sourcePaths).toEqual(['/object_story_spec/link_data/child_attachments/1/video_id'])
    expect(JSON.stringify(carousel)).not.toMatch(/spend|bookings|performance/)
  })

  it('keeps malformed and URL-only slots unresolved instead of fabricating IDs', () => {
    const identity = describeCreativeIdentity({ image_url: 'https://cdn.example.test/not-an-id.jpg',
      asset_feed_spec: { videos: [{ video_id: 22 }, null, { video_id: 'https://cdn.test/video.mp4' }], images: [{ url: 'https://cdn.test/image.jpg' }] },
    }, asOf)
    expect(identity.members).toEqual([])
    expect(identity.unresolvedSourcePaths).toEqual(expect.arrayContaining([
      '/image_url', '/asset_feed_spec/videos/0/video_id', '/asset_feed_spec/videos/1',
      '/asset_feed_spec/videos/2/video_id', '/asset_feed_spec/images/0',
    ]))
    expect(() => ReportCreativeIdentitySchema.parse({ ...identity, members: [{ kind: 'video', id: 'https://cdn.test/a', role: 'media', sourcePaths: ['/video_id'] }] })).toThrow()
  })

  it('classifies a video-only singleton conflict while refusing to select one as the playable creative', () => {
    const row = { id: '11', video_id: '22', object_story_spec: { video_data: { video_id: '33' } } }
    const identity = describeCreativeIdentity(row, asOf)
    expect(identity.members.map(member => member.id)).toEqual(['22', '33'])
    expect(identity.structure).toBe('unknown')
    expect(identity.unresolvedSourcePaths).toEqual(expect.arrayContaining(['/video_id', '/object_story_spec/video_data/video_id']))
    const creative = presentCreative('11', row, { id: '22', source: 'https://cdn.test/video.mp4', length: 10 }, asOf)
    expect(creative).toMatchObject({ format: 'video', videoUrl: null, durationSeconds: null })

    const storyPreview = presentCreative('11', row, { id: '33', source: 'https://cdn.test/story-video.mp4', length: 11 }, asOf, '33')
    expect(storyPreview).toMatchObject({
      format: 'video', videoUrl: 'https://cdn.test/story-video.mp4', durationSeconds: 11,
      videoPreviewEvidence: { videoId: '33', basis: 'object_story_spec_video_id' },
      identity: { structure: 'unknown', unresolvedSourcePaths: ['/object_story_spec/video_data/video_id', '/video_id'] },
    })
    expect(storyPreview?.identity?.members.map(member => member.id)).toEqual(['22', '33'])
    expect(() => ReportCreativeSchema.parse({ ...storyPreview, videoUrl: null })).toThrow()
    expect(() => ReportCreativeSchema.parse({ ...storyPreview,
      videoPreviewEvidence: { videoId: '22', basis: 'object_story_spec_video_id' } })).toThrow()
    expect(presentCreative('11', row, { id: '22', source: 'https://cdn.test/root-video.mp4', length: 10 }, asOf, '22'))
      .toMatchObject({ format: 'video', videoUrl: null, durationSeconds: null })
  })

  it('marks competing singleton image fields unresolved while retaining both opaque identities', () => {
    const identity = describeCreativeIdentity({ image_hash: 'hash-a', object_story_spec: { link_data: { image_hash: 'hash-b' } } }, asOf)
    expect(identity.structure).toBe('unknown')
    expect(identity.members.map(member => member.id)).toEqual(['hash-a', 'hash-b'])
    expect(identity.unresolvedSourcePaths).toEqual(expect.arrayContaining(['/image_hash', '/object_story_spec/link_data/image_hash']))
  })

  it('preserves top-level carousel identities and malformed containers without guessing their contents', () => {
    const identity = describeCreativeIdentity({ child_attachments: [{ image_hash: 'hash-a' }, null], asset_feed_spec: { videos: 'not-an-array' } }, asOf)
    expect(identity.members[0].sourcePaths).toEqual(['/child_attachments/0/image_hash'])
    expect(identity.unresolvedSourcePaths).toEqual(expect.arrayContaining(['/child_attachments/1', '/asset_feed_spec/videos']))
    expect(describeCreativeIdentity({ object_story_spec: 'invalid' }, asOf).unresolvedSourcePaths).toContain('/object_story_spec')
  })

  it('adds observed descriptors to native presentation while old optional-field packets remain valid', () => {
    const row = { id: '11', image_hash: 'hash-a', image_url: 'https://cdn.test/image.jpg' }
    const creative = presentCreative('11', row, undefined, asOf)!
    expect(creative.identity?.members).toContainEqual({ kind: 'image', id: 'hash-a', role: 'media', sourcePaths: ['/image_hash'] })
    expect(ReportCreativeSchema.parse(creative)).toEqual(creative)
    const { identity: _identity, ...old } = creative
    expect(_identity).toBeDefined()
    expect(ReportCreativeSchema.parse(old)).toEqual(old)
    expect(presentCreative('11', { ...row, image_url: 'javascript:alert(1)' }, undefined, asOf)?.imageUrl).toBeNull()
  })
  it('binds media observations to configuration time and rejects a nanosecond beyond the report cutoff', () => {
    const packet = snapshotPacket()
    const observedAt = packet.context.asOf
    const creative = presentCreative('11', { id: '11', image_hash: 'hash-a' }, undefined, observedAt)!
    const entity = { id: '301', level: 'ad' as const, name: 'Synthetic', campaignId: null, campaignName: null,
      adsetId: null, adsetName: null, status: 'UNKNOWN', configurationAsOf: observedAt, audience: 'unknown' as const,
      audienceLabel: 'Unknown', creative, metrics: {} }
    const current = { ...packet, result: { ...packet.result, data: { ...packet.result.data!, entities: [entity] } } }
    expect(() => validateReportingPacket(current)).not.toThrow()
    const later = '2026-09-05T17:00:00.000000001Z'
    const bad = { ...entity, configurationAsOf: later, creative: { ...creative, identity: { ...creative.identity!, observedAt: later } } }
    expect(() => validateReportingPacket({ ...current, result: { ...current.result, data: { ...current.result.data, entities: [bad] } } })).toThrow()
    expect(() => validateReportingPacket({ ...current, result: { ...current.result, data: { ...current.result.data, entities: [{ ...entity, configurationAsOf: null }] } } })).toThrow()
  })
})
