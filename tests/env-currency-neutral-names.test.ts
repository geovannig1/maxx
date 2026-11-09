import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateEnv } from '@/config/env'
import { readDailyBudgetCeiling } from '@/lib/economics/profit-policy'
import { businessHourlyRate } from '@/config/business-display'

// Currency: money settings are in the account currency, so their variables no longer say USD. The
// old names stay accepted for one release (deprecated fallback, startup warning naming the new name).

afterEach(() => vi.unstubAllEnvs())

describe('DAILY_BUDGET_CEILING (was DAILY_BUDGET_CEILING_USD)', () => {
  it('reads the new name, falls back to the deprecated one, and prefers the new one', () => {
    expect(readDailyBudgetCeiling({})).toBe(100)
    expect(readDailyBudgetCeiling({ DAILY_BUDGET_CEILING: '50' })).toBe(50)
    expect(readDailyBudgetCeiling({ DAILY_BUDGET_CEILING_USD: '60' })).toBe(60)
    expect(readDailyBudgetCeiling({ DAILY_BUDGET_CEILING: '50', DAILY_BUDGET_CEILING_USD: '60' })).toBe(50)
  })

  it('refuses an invalid value under either name, naming the variable that was read', () => {
    expect(() => readDailyBudgetCeiling({ DAILY_BUDGET_CEILING: '-1' })).toThrow('DAILY_BUDGET_CEILING must')
    expect(() => readDailyBudgetCeiling({ DAILY_BUDGET_CEILING_USD: 'x' })).toThrow('DAILY_BUDGET_CEILING_USD must')
  })
})

describe('NEXT_PUBLIC_BUSINESS_HOURLY_RATE (was NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD)', () => {
  it('reads the new name, falls back to the deprecated one, and prefers the new one', () => {
    vi.stubEnv('NEXT_PUBLIC_BUSINESS_HOURLY_RATE', '')
    vi.stubEnv('NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD', '')
    expect(businessHourlyRate()).toBe(95)
    vi.stubEnv('NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD', '80')
    expect(businessHourlyRate()).toBe(80)
    vi.stubEnv('NEXT_PUBLIC_BUSINESS_HOURLY_RATE', '120')
    expect(businessHourlyRate()).toBe(120)
  })
})

describe('the schema accepts the old names as deprecated (startup warning)', () => {
  it('warns on each old name and names its replacement; the new names validate clean', () => {
    const issues = validateEnv({ DAILY_BUDGET_CEILING_USD: '60', NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD: '80' })
      .filter((i) => i.name.endsWith('_USD'))
    expect(issues.map((i) => [i.name, i.severity, i.code])).toEqual([
      ['NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD', 'warning', 'deprecated'],
      ['DAILY_BUDGET_CEILING_USD', 'warning', 'deprecated'],
    ].sort((a, b) => issues.findIndex((i) => i.name === a[0]) - issues.findIndex((i) => i.name === b[0])))
    expect(issues.find((i) => i.name === 'DAILY_BUDGET_CEILING_USD')?.message).toContain('set DAILY_BUDGET_CEILING instead')
    expect(validateEnv({ DAILY_BUDGET_CEILING: '60', NEXT_PUBLIC_BUSINESS_HOURLY_RATE: '80' })
      .filter((i) => /BUDGET_CEILING|HOURLY_RATE/.test(i.name))).toEqual([])
  })
})
