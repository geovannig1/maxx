import { describe, it, expect } from 'vitest'
import { splitUtmOffenders, type AdUtmHealth } from '@/lib/tracking/utm-coverage'

// The diagnostics UTM panel showed "4 of 4 active ads correct (100%)" and then dumped ~20 paused ads +
// duplicate rows under an "Ads to fix" list — contradicting its own headline. Offenders must be scoped to
// ACTIVE (what the headline measures), deduped, with paused/historical gaps counted separately.
const ad = (over: Partial<AdUtmHealth>): AdUtmHealth => ({
  meta_ad_id: 'x', ad_name: 'A', campaign_name: 'C', effective_status: 'ACTIVE',
  url_tags: null, tags_source: 'url_tags' as AdUtmHealth['tags_source'], verdict: 'correct', defects: [], corrected: '', ...over,
})

describe('splitUtmOffenders', () => {
  it('separates active offenders from paused/historical, ignoring correct ads', () => {
    const r = splitUtmOffenders([
      ad({ meta_ad_id: '1', effective_status: 'ACTIVE', verdict: 'correct' }),      // active, correct → not an offender
      ad({ meta_ad_id: '2', effective_status: 'ACTIVE', verdict: 'misconfigured' }), // active offender
      ad({ meta_ad_id: '3', effective_status: 'PAUSED', verdict: 'missing' }),        // historical
      ad({ meta_ad_id: '4', effective_status: 'WITH_ISSUES', verdict: 'missing' }),   // historical
    ])
    expect(r.active.map((a) => a.meta_ad_id)).toEqual(['2'])
    expect(r.historicalCount).toBe(2)
  })

  it('dedupes duplicate rows for the same ad (to-many creative-join fan-out)', () => {
    const r = splitUtmOffenders([
      ad({ meta_ad_id: '9', effective_status: 'PAUSED', verdict: 'misconfigured' }),
      ad({ meta_ad_id: '9', effective_status: 'PAUSED', verdict: 'misconfigured' }),
      ad({ meta_ad_id: '9', effective_status: 'PAUSED', verdict: 'misconfigured' }),
    ])
    expect(r.historicalCount).toBe(1) // three rows → one ad
  })

  it('all-active-correct → zero offenders (matches a 100% headline)', () => {
    const r = splitUtmOffenders([ad({ meta_ad_id: 'a' }), ad({ meta_ad_id: 'b' })])
    expect(r.active).toEqual([])
    expect(r.historicalCount).toBe(0)
  })
})
