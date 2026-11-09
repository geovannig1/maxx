import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatMoney, currencyFractionDigits } from '@/lib/utils/format-currency'
import { RECOMMENDATION_EVIDENCE_VALUE_FORMATTER } from '@/lib/cockpit/contracts'
import { formatKpiValue } from '@/lib/report/daily-digest'
import { accountLocale } from '@/config/business-config'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'

// Currency: money on owner screens and reports is labelled with the account's currency in the
// account's locale, through one formatter. A EUR account never sees a dollar sign.

afterEach(() => vi.unstubAllEnvs())

describe('money formatting follows the account currency and locale', () => {
  it('formats a EUR account in German conventions across the shared formatters', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'EUR')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_LOCALE', 'de-DE')
    const outputs = [
      formatMoney(1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      RECOMMENDATION_EVIDENCE_VALUE_FORMATTER.money(1234.5),
      formatKpiValue({ key: 'spend', label: 'Amount Spent', unit: 'money', value: 1234.5 } as never),
    ]
    for (const text of outputs) {
      expect(text).toBe('1.234,50 €')
      expect(text).not.toContain('$')
    }
  })

  it('keeps the USD default byte-identical to the previous dollar formatting (control)', () => {
    expect(formatMoney(1000, { minimumFractionDigits: 0, maximumFractionDigits: 2 })).toBe('$1,000')
    expect(formatMoney(1000.5, { minimumFractionDigits: 0, maximumFractionDigits: 2 })).toBe('$1,000.5')
    expect(RECOMMENDATION_EVIDENCE_VALUE_FORMATTER.money(12)).toBe('$12.00')
  })

  it('knows each currency\'s minor-unit digits and refuses an invalid locale', () => {
    expect([currencyFractionDigits('USD'), currencyFractionDigits('JPY'), currencyFractionDigits('KWD')]).toEqual([2, 0, 3])
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_LOCALE', 'not a locale!')
    expect(() => accountLocale()).toThrow(/BCP 47/)
  })

  it('upgrades a stored usd unit to the money unit, and no other value named usd (control)', () => {
    expect(upgradeLegacyVocabulary({ unit: 'usd', exposure: { unit: 'usd' }, budget: { usd: 5 }, label: 'usd' }, []))
      .toEqual({ unit: 'money', exposure: { unit: 'money' }, budget: { usd: 5 }, label: 'usd' })
  })
})
