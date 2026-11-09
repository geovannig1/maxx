import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pages = [
  'src/app/(dashboard)/performance/campaigns/page.tsx',
  'src/app/(dashboard)/performance/adsets/page.tsx',
  'src/app/(dashboard)/performance/ads/page.tsx',
]

const read = (path: string) => readFileSync(path, 'utf8')

describe('performance drilldowns preserve Meta and warehouse metric semantics', () => {
  it.each(pages)('%s labels the modelled outcome and its cost without calling either a booking', (path) => {
    const source = read(path)

    expect(source).toMatch(/Meta Results \(modelled 7dc\/1dv\)/)
    expect(source).toMatch(/Meta cost \/ Result/)
    expect(source).not.toMatch(/label=["'](?:Total )?Bookings?["']|Cost \/ Booking/)
    expect(source).not.toMatch(/sel\.(?:appointment_value|roas)|metrics\.(?:appointment_value|roas)/)
  })

  it.each(pages)('%s calls the daily statistic peak daily reach', (path) => {
    const source = read(path)

    expect(source).toMatch(/Peak daily reach/)
    expect(source).not.toMatch(/label=["']Reach["']/)
  })

  it.each(pages)('%s withholds frequency outside a one-day window', (path) => {
    const source = read(path)

    expect(source).toMatch(/Daily frequency/)
    expect(source).toMatch(/days === 1/)
    expect(source).toMatch(/selectedWindowMetrics/)
    expect(source).toMatch(/windowDays === 1/)
    expect(source).toMatch(/frequency: null/)
    // Either the page passes it to MetricBodyCells directly, or it supplies it as EntityTable's
    // per-row metrics resolver. Both route every row's metrics through selectedWindowMetrics,
    // which is what withholds frequency outside a one-day window.
    expect(source).toMatch(/metrics=\{selectedWindowMetrics\(|forRow:\s*\([a-z]+\) => selectedWindowMetrics\(/)
    expect(source).not.toMatch(/Avg Frequency|avgFreq|sel\.frequency\s*(?:>=|<=|>|<)\s*\d/)
    expect(source).not.toMatch(/diagnostic threshold|warning band/i)
  })

  it.each(pages)('%s treats a malformed successful API response as an error', (path) => {
    const source = read(path)
    const entity = path.includes('/campaigns/') ? 'campaigns' : path.includes('/adsets/') ? 'adsets' : 'ads'

    expect(source).toContain(`Array.isArray(data.${entity})`)
  })

  it('keeps ad daily observations descriptive instead of diagnosing fatigue', () => {
    const source = read(pages[2])

    expect(source).toMatch(/Daily observations/)
    expect(source).not.toMatch(/Fatigue Over Time|fatigue trend|burning out/i)
  })

  it.each([
    'src/app/(dashboard)/performance/adsets/page.tsx',
    'src/app/(dashboard)/performance/ads/page.tsx',
  ])('%s renders aggregate cards unavailable when no entity is measured', (path) => {
    const source = read(path)

    expect(source).toMatch(/measuredEntityCount/)
    // The measured branch formats the amount (through formatMoney since the v1 release); the other is 'Unavailable'.
    expect(source).toMatch(/measuredEntityCount > 0[^\n]*\?[^\n]*(?:toFixed|formatMoney)\([^\n]*:[^\n]*'Unavailable'/)
  })
})
