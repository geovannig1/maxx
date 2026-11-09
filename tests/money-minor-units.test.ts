import { afterEach, describe, expect, it, vi } from 'vitest'
import { fromMinorUnits, toMinorUnits } from '@/lib/utils/format-currency'

// Currency: Meta budgets travel in the currency's minor unit. A fixed x100 is right for USD and EUR
// but 100x too large for JPY (0 decimals) and 10x too small for KWD (3 decimals).

afterEach(() => vi.unstubAllEnvs())

describe('minor-unit conversion follows the currency', () => {
  it('converts by the currency fraction digits', () => {
    expect(toMinorUnits(12.34, 'USD')).toBe(1234)
    expect(toMinorUnits(5000, 'JPY')).toBe(5000)
    expect(toMinorUnits(1.234, 'KWD')).toBe(1234)
    expect(fromMinorUnits(1234, 'USD')).toBe(12.34)
    expect(fromMinorUnits(5000, 'JPY')).toBe(5000)
    expect(fromMinorUnits(1234, 'KWD')).toBe(1.234)
  })

  it('defaults to the account currency', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'JPY')
    expect(toMinorUnits(5000)).toBe(5000)
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'EUR')
    expect(toMinorUnits(50)).toBe(5000)
  })

  it('rounds to a whole minor unit and refuses non-finite amounts', () => {
    expect(toMinorUnits(10.005, 'USD')).toBe(1001)
    expect(() => toMinorUnits(Number.NaN, 'USD')).toThrow()
  })
})

describe('Meta budget paths use Meta\'s offset table (no fixed x100 left)', () => {
  // Meta budget fields use Meta's own offsets (currency-offset.ts), reached outside the platform
  // directory through the registry's budgetUnits; the ISO helpers above are for display only.
  it('has no fixed cents conversion in the Meta budget readers and writers', async () => {
    const { readFileSync } = await import('node:fs')
    for (const file of ['src/lib/platforms/meta/writes.ts', 'src/lib/platforms/meta/fetch-adsets.ts',
      'src/lib/platforms/meta/fetch-campaigns.ts', 'src/app/api/sync/midday/route.ts']) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/\* 100\)\)|cents \/ 100|daily_budget\) \/ 100/)
      expect(text, file).toMatch(/MetaMinorUnits\(|budgetUnits\.(from|to)Minor\(/)
      expect(text, file).not.toMatch(/\b(to|from)MinorUnits\(/)
    }
  })
})
