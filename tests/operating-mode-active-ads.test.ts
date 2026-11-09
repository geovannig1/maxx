import { describe, expect, it } from 'vitest'
import { countCurrentlyActiveDeliveringAds } from '@/mcp/tools/operating-mode'

describe('operating-mode active delivery count', () => {
  it('does not count replaced or paused ads that spent earlier in the seven-day window', () => {
    expect(countCurrentlyActiveDeliveringAds(
      [
        { meta_ad_id: 'active-1', spend: 10 },
        { meta_ad_id: 'active-2', spend: 5 },
        { meta_ad_id: 'replaced-1', spend: 20 },
        { meta_ad_id: 'paused-1', spend: 30 },
      ],
      [
        { ad_id: 'active-1', effective_status: 'ACTIVE' },
        { ad_id: 'active-2', effective_status: 'ACTIVE' },
        { ad_id: 'replaced-1', effective_status: 'DELETED' },
        { ad_id: 'paused-1', effective_status: 'PAUSED' },
      ],
    )).toBe(2)
  })
})
