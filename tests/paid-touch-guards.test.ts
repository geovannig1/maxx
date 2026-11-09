import { describe, expect, it } from 'vitest'
import { paidTouchGlobalLimits } from '@/lib/attribution/paid-touch-guards'
import { rateLimitAddress } from '@/lib/security/client-address'

describe('paid-touch rate-limit address', () => {
  it('buckets IPv6 by /64 in every notation, and keeps IPv4 as is', () => {
    const bucket = '2001:db8:1:2::/64'
    for (const address of ['2001:db8:1:2::a', '2001:0DB8:0001:0002:ffff:ffff:ffff:ffff', '[2001:db8:1:2::1]', '2001:db8:1:2::1%eth0']) {
      expect(rateLimitAddress(address)).toBe(bucket)
    }
    expect(rateLimitAddress('2001:db8:1:3::a')).not.toBe(bucket)
    expect(rateLimitAddress('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitAddress('203.0.113.8')).toBe('203.0.113.8')
    expect(rateLimitAddress('203.0.113.8:5555')).toBe('203.0.113.8')
    expect(rateLimitAddress('::ffff:203.0.113.8')).toBe('203.0.113.8')
    expect(rateLimitAddress('unavailable')).toBe('unavailable')
  })

  it('reads positive integer global caps from the environment, else the defaults', () => {
    expect(paidTouchGlobalLimits({})).toEqual({ captures: 2000, acks: 4000, unknownAdCaptures: 200 })
    expect(paidTouchGlobalLimits({
      PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR: '300',
      PAID_TOUCH_GLOBAL_ACKS_PER_HOUR: '600',
      PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR: '20',
    })).toEqual({ captures: 300, acks: 600, unknownAdCaptures: 20 })
    expect(paidTouchGlobalLimits({
      PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR: '-1',
      PAID_TOUCH_GLOBAL_ACKS_PER_HOUR: 'lots',
      PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR: '0',
    })).toEqual({ captures: 2000, acks: 4000, unknownAdCaptures: 200 })
  })
})
