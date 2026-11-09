import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('Meta-only Performance UI', () => {
  it('removes Acuity and checkout-return copy from owner-facing performance surfaces', () => {
    for (const path of [
      'src/components/performance/PerformanceOverview.tsx',
      'src/app/(dashboard)/performance/campaigns/page.tsx',
      'src/app/(dashboard)/performance/adsets/page.tsx',
      'src/app/(dashboard)/performance/ads/page.tsx',
      'src/app/(dashboard)/performance/segments/page.tsx',
    ]) {
      const source = read(path)
      expect(source).not.toMatch(/Acuity owns|Exact paid CPA|appointment value|complete appointment-ID paid-touch join/i)
    }
  })

  it('shows synced creative format and copy context when Meta provides it', () => {
    const source = read('src/components/performance/CreativePerformance.tsx')
    expect(source).toContain('Creative format')
    expect(source).toContain('Primary text')
    expect(source).toContain('Headline')
  })
})
