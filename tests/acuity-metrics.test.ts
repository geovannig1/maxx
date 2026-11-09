import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { aggregateBusinessFacts, classifyBusinessState } from '@/lib/outcomes/business-facts'

// acuity/metrics.ts held a SECOND, independent implementation of "what is a booking" — it
// counted every non-canceled row (including zero-value ones) as a booking while business-facts.ts
// counted only value-bearing ones. Both were labelled "bookings" and both reached production, so the
// two-definitions problem had moved rather than disappeared.
//
// metrics.ts now delegates. These pin BOTH halves: the one classifier's behaviour, and the absence of
// any classification logic in the module that used to duplicate it.

const row = (o: Partial<{ id: number; price: number | null; amount_paid: number | null; canceled: boolean }> = {}) =>
  ({ id: o.id ?? 1, price: o.price === undefined ? 100 : o.price, amount_paid: o.amount_paid ?? null, canceled: o.canceled ?? false })

describe('metrics.ts no longer classifies — it delegates', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/outcomes/business-facts-reader.ts'), 'utf8')
  // the scoped read moved to the generic reader; metrics.ts delegates to it.
  const reader = readFileSync(resolve(process.cwd(), 'src/lib/outcomes/reader.ts'), 'utf8')

  it('contains no independent definition of a booking', () => {
    // The old body filtered on `!r.canceled` and summed price itself. Any business state RETURNED from
    // this file means a second classifier has reappeared.
    expect(src).not.toMatch(/return\s+'active_value_bearing'/)
    expect(src).not.toMatch(/return\s+'active_zero_value'/)
    expect(src).toMatch(/from '\.\/business-facts'/)
    expect(src).toMatch(/businessFactsFromOutcomeFacts/)
    expect(reader).not.toMatch(/return\s+'active_value_bearing'/)
    expect(reader).not.toMatch(/return\s+'active_zero_value'/)
  })

  it('requires an account id on every read — the ledger table is account-agnostic', () => {
    for (const fn of ['getBusinessFactsForWindow', 'getBusinessFactsByDay', 'getBusinessFactsByLabel']) {
      expect(src.includes(`export async function ${fn}(`), `${fn} must exist`).toBe(true)
      const body = src.slice(src.indexOf(`export async function ${fn}(`))
      expect(/^\s*adAccountDbId: string/m.test(body.slice(0, 200)),
        `${fn} must take adAccountDbId as its first parameter`).toBe(true)
    }
    expect(reader).toMatch(/\.eq\('ad_account_id', adAccountId\)/)
    expect(reader).toMatch(/\.eq\('source_enabled', true\)/)
  })

  it('reads the canonical VIEW, ordered, so paging is deterministic', () => {
    expect(reader).toMatch(/from\('v_business_outcomes'\)/)
    expect(reader).toMatch(/\.order\('id', \{ ascending: true \}\)/)
  })
})

describe('the one classifier', () => {
  it('separates the three states', () => {
    expect(classifyBusinessState(row({ price: 236 }))).toBe('active_value_bearing')
    expect(classifyBusinessState(row({ price: 0 }))).toBe('active_zero_value')
    expect(classifyBusinessState(row({ price: 236, canceled: true }))).toBe('canceled')
  })

  it('counts confirmed appointments AND value-bearing bookings — the two the old code conflated', () => {
    const f = aggregateBusinessFacts([
      row({ id: 1, price: 300 }), row({ id: 2, price: 0 }), row({ id: 3, price: 250, canceled: true }),
    ])
    expect(f.confirmedAppointments).toBe(2)   // what metrics.ts used to call "bookings"
    expect(f.valueBearingBookings).toBe(1)    // what the reconciler called "bookings"
    expect(f.zeroValueAppointments).toBe(1)
    expect(f.canceledAppointments).toBe(1)
    expect(f.bookedValue).toBe(300)           // only the charged one
    expect(f.observedCollectedValue).toBe(0) // observed lower bound; no amount_paid was present
    expect(f.recordedOutcomeValue).toBeNull() // incomplete input is unavailable, never exact $0
    expect(f.amountPaidCoverage).toEqual({ withRecordedAmount: 0, total: 2 })
  })

  it('empty input yields zeros that were genuinely measured, not defaults for a failed read', () => {
    const f = aggregateBusinessFacts([])
    expect(f).toMatchObject({ confirmedAppointments: 0, valueBearingBookings: 0, bookedValue: 0 })
    expect(f.recordedOutcomeValue).toBe(0)
    expect(f.amountPaidCoverage).toEqual({ withRecordedAmount: 0, total: 0 })
  })

  it('a null price is zero-value — not a crash, and not revenue', () => {
    const f = aggregateBusinessFacts([row({ price: null })])
    expect(f.zeroValueAppointments).toBe(1)
    expect(f.bookedValue).toBe(0)
    expect(f.recordedOutcomeValue).toBeNull()
    expect(f.amountPaidCoverage).toEqual({ withRecordedAmount: 0, total: 1 })
  })

  it('uses Acuity amount_paid after discount as owner-declared checkout revenue', () => {
    const f = aggregateBusinessFacts([
      row({ id: 10, price: 290, amount_paid: 215 }),
      row({ id: 11, price: 92, amount_paid: 76 }),
    ])
    expect(f.bookedValue).toBe(382)
    expect(f.recordedOutcomeValue).toBe(291)
    expect(f.amountPaidCoverage).toEqual({ withRecordedAmount: 2, total: 2 })
  })

  it('counts every active appointment in amount-paid coverage and preserves zero-price payments', () => {
    const f = aggregateBusinessFacts([
      row({ id: 20, price: 0, amount_paid: 25 }),
      row({ id: 21, price: 0, amount_paid: null }),
    ])
    expect(f.observedCollectedValue).toBe(25)
    expect(f.recordedOutcomeValue).toBeNull()
    expect(f.amountPaidCoverage).toEqual({ withRecordedAmount: 1, total: 2 })
  })
})
