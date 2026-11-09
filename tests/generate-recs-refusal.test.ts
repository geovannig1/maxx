import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('direct recommendation script authority', () => {
  it('refuses to create generations without a governed current-sync manifest', () => {
    const source = fs.readFileSync('scripts/generate-recs.ts', 'utf8')
    expect(source).toMatch(/refus/i)
    expect(source).toMatch(/governed current sync manifest/i)
    expect(source).not.toMatch(/runFlagEngine\(/)
    expect(source).not.toMatch(/generateRecommendationsFromFlags\(/)
  })
})
