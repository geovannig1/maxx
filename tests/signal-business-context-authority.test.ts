import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('expert-signal business context authority', () => {
  it('does not hard-code mutable spend, CPA, radius, audience, or action advice', () => {
    const source = fs.readFileSync('src/lib/signals/fetcher.ts', 'utf8')
    expect(source).not.toMatch(/\$\d+\/day|\$\d+ target|\d+-mile local radius/)
    expect(source).toMatch(/Budget, targets, radius, audience, offer, funnel stage and campaign setup are UNAVAILABLE/)
    expect(source).toMatch(/suggested_action: null/)
    expect(source).not.toMatch(/parsed\.suggested_action/)
  })
})
