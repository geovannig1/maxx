import { describe, it, expect } from 'vitest'
import { classifyChannel } from '@/lib/ga4/client'

// Pins the Paid/Organic boundary used by the dashboard's Complete/Paid/Organic split. This is the exact
// classification the source views depend on — paid = GA4's paid channel groups, organic = everything else
// (organic search/social, direct, referral, email, unassigned).
describe('classifyChannel — the paid/organic provenance boundary', () => {
  it('treats GA4 paid channel groups as paid', () => {
    for (const g of ['Paid Search', 'Paid Social', 'Paid Shopping', 'Paid Video', 'Display', 'Cross-network', 'Paid Other']) {
      expect(classifyChannel(g)).toBe('paid')
    }
  })

  it('treats everything non-paid as organic', () => {
    for (const g of ['Organic Search', 'Organic Social', 'Organic Video', 'Direct', 'Referral', 'Email', 'Affiliates', 'Audio', 'SMS', 'Mobile Push Notifications', 'Unassigned', '(unknown)', '']) {
      expect(classifyChannel(g)).toBe('organic')
    }
  })

  it('is exact-match (does not paid-classify an unknown "Paid-ish" string)', () => {
    expect(classifyChannel('Paid')).toBe('organic') // only the explicit GA4 group names count
    expect(classifyChannel('paid social')).toBe('organic') // case-sensitive to GA4's exact labels
  })
})
