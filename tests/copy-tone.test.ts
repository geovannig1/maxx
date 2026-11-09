import { describe, it, expect } from 'vitest'
import { checkCopyTone, checkBriefTone, COPY_TONE_RULES, COPY_SYSTEM_PROMPT } from '@/lib/creative/copy-tone'

describe('checkCopyTone', () => {
  it('passes clean, human copy', () => {
    expect(checkCopyTone('Book the daylight studio. Paper backdrops, changing room.')).toEqual([])
  })

  it('flags an em dash', () => {
    const v = checkCopyTone('Great light — great space.')
    expect(v.map((x) => x.rule)).toContain('no_em_dash')
  })

  it('flags banned buzzwords (case-insensitive)', () => {
    const v = checkCopyTone('Unlock your best shoot and elevate your brand.')
    const banned = v.find((x) => x.rule === 'banned_words')
    expect(banned).toBeTruthy()
    expect(banned?.detail.toLowerCase()).toContain('unlock')
    expect(banned?.detail.toLowerCase()).toContain('elevate')
  })

  it('flags hype punctuation', () => {
    expect(checkCopyTone('Book now!!').map((x) => x.rule)).toContain('hype_punctuation')
  })

  it('reports multiple violations at once', () => {
    const v = checkCopyTone('Supercharge your brand — look no further!!')
    expect(v.length).toBeGreaterThanOrEqual(3)
  })

  it('handles null/empty', () => {
    expect(checkCopyTone(null)).toEqual([])
    expect(checkCopyTone('')).toEqual([])
  })
})

describe('checkBriefTone', () => {
  it('tags violations by field across a brief', () => {
    const msgs = checkBriefTone({ hook: 'Unlock more bookings', headline: 'A calm, clean studio.', script: 'Shoot here — you will love it.' })
    expect(msgs.some((m) => m.startsWith('hook:'))).toBe(true)
    expect(msgs.some((m) => m.startsWith('script:'))).toBe(true)
    expect(msgs.some((m) => m.startsWith('headline:'))).toBe(false) // headline is clean
  })

  it('returns [] for a fully clean brief', () => {
    expect(checkBriefTone({ hook: 'Your next shoot, sorted.', headline: 'Private Springfield studio.' })).toEqual([])
  })
})

describe('the prompts practice what they preach', () => {
  it('the tone ruleset and copy system prompt contain no em dashes', () => {
    expect(COPY_TONE_RULES.includes('—')).toBe(false)
    expect(COPY_SYSTEM_PROMPT.includes('—')).toBe(false)
  })
})
