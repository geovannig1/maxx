import { describe, expect, it } from 'vitest'
import { mediaRange } from './creative-media-fixture.mjs'

describe('original media range fixture', () => {
  it('serves a full entity when there is no range and honors bounded/open/suffix ranges', () => {
    expect(mediaRange(undefined, 100)).toBeNull()
    expect(mediaRange('bytes=0-31', 100)).toEqual({ start: 0, end: 31 })
    expect(mediaRange('bytes=32-', 100)).toEqual({ start: 32, end: 99 })
    expect(mediaRange('bytes=-16', 100)).toEqual({ start: 84, end: 99 })
    expect(mediaRange('bytes=80-200', 100)).toEqual({ start: 80, end: 99 })
  })
  it.each(['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-8', 'bytes=9007199254740992-', 'characters=0-1'])('rejects %s for a 416 response', value => {
    expect(mediaRange(value, 100)).toBe(false)
  })
})
