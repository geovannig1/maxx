import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ownerFacingAggregateFiles = [
  'src/components/dashboard/DeliveryDetails.tsx',
  'src/app/report/client/page.tsx',
]

describe('owner-facing aggregate reach/frequency labels', () => {
  it('labels aggregate reach as peak daily reach, never selected-period reach', () => {
    for (const file of ownerFacingAggregateFiles) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toMatch(/Peak daily reach/)
      expect(source, file).not.toMatch(/label="Reach"|label='Reach'/)
      expect(source, file).not.toMatch(/approx over range|period reach|selected-period reach/i)
    }
  })

  it('does not describe multi-day frequency as impressions divided by reach', () => {
    const source = ownerFacingAggregateFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
    const deliveryDetails = readFileSync('src/components/dashboard/DeliveryDetails.tsx', 'utf8')

    expect(source).not.toMatch(/impressions\s*(÷|\/|divided by)\s*reach/i)
    expect(deliveryDetails).toMatch(/Daily frequency unavailable/)
  })
})
