import { describe, expect, it } from 'vitest'
import { resolveInventoryAudience, presentCreative } from '@/lib/platforms/meta/reporting/meta-inventory'
import type { ReportingContext } from '@/lib/reporting/contracts'
const context: ReportingContext = { account: { id: 'db', metaAccountId: '123', name: null }, range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' }, timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z' }
it('rejects stale targeting and never resolves audience from a name', () => {
  expect(resolveInventoryAudience(context, { name: 'Warm', targeting: {} }, {}, '2026-09-01T16:00:00Z').audience).toBe('unknown')
  expect(resolveInventoryAudience(context, { name: 'Warm' }, {}, context.asOf).audience).toBe('unknown')
})
describe('safe creative presentation', () => {
  it('joins only explicit matching creative IDs and safe HTTPS destinations', () => {
    expect(presentCreative('a', { id: 'b', image_url: 'https://test/image' })).toBeNull()
    const creative = presentCreative('a', { id: 'a', image_url: 'javascript:alert(1)', link_url: 'https://token:secret@test/path', body: 'Real text' })
    expect(creative?.imageUrl).toBeNull()
    expect(creative?.destination).toBeNull()
    expect(creative?.body).toBe('Real text')
  })
  it('does not collapse dynamic asset variants into an invented winning asset', () => {
    const creative = presentCreative('a', { id: 'a', asset_feed_spec: { images: [{ url: 'https://test/1' }, { url: 'https://test/2' }], bodies: [{ text: 'one' }, { text: 'two' }] } })
    expect(creative?.imageUrl).toBeNull()
    expect(creative?.body).toBeNull()
  })
})
