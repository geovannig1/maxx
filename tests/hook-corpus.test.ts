import { describe, it, expect } from 'vitest'
import { HOOK_CORPUS, hookPatternMenu } from '@/lib/creative/hook-corpus'
import { checkCopyTone } from '@/lib/creative/copy-tone'

describe('hook corpus', () => {
  it('is non-empty and every entry cites a real source', () => {
    expect(HOOK_CORPUS.length).toBeGreaterThan(0)
    for (const h of HOOK_CORPUS) {
      expect(h.source.trim().length).toBeGreaterThan(0)
      // practitioner-tier entries carry a verifiable URL; principle-tier cite a named published work.
      if (h.evidence_tier === 'practitioner') {
        expect(h.source_url).toMatch(/^https?:\/\//)
      }
    }
  })

  it('every example obeys the copy-tone ruleset (no slop in our own corpus)', () => {
    for (const h of HOOK_CORPUS) {
      expect(checkCopyTone(h.example), `${h.key} example: "${h.example}"`).toEqual([])
    }
  })

  it('the injected pattern menu contains no em dashes', () => {
    expect(hookPatternMenu().includes('—')).toBe(false)
  })

  it('keys are unique', () => {
    const keys = HOOK_CORPUS.map((h) => h.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
