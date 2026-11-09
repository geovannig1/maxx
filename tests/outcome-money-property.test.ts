import { describe, expect, it } from 'vitest'
import { aggregateOutcomeFacts } from '@/lib/outcomes/facts'
import type { OutcomeLite, OutcomeStatus } from '@/lib/outcomes/model'

// Plan section 7.1 (money): NULL is "not observed" and never collapses to 0; an observed 0 is coverage;
// fractional cents and negatives are carried, not rounded away; cancelled or refunded outcomes never
// contribute. A seeded property test over many generated populations, checked against an exact
// decimal reference computed in integer micro-units.

const VALUES = [null, 0, 0.005, 0.01, 0.1, 0.2, -5.25, 125, 129.99, 1e-6, 999999.999999] as const
const STATUSES: OutcomeStatus[] = ['pending', 'confirmed', 'cancelled', 'refunded']

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
/** Exact decimal sum in integer micro-units (6 decimal places, the webhook's money precision). */
const exactSum = (xs: number[]): number => Number(xs.reduce((s, x) => s + BigInt(Math.round(x * 1e6)), BigInt(0))) / 1e6

function population(seed: number): OutcomeLite[] {
  const r = rng(seed)
  return Array.from({ length: 1 + Math.floor(r() * 40) }, (_, i) => ({
    id: `o-${i}`,
    grossValue: pick(r, VALUES),
    collectedValue: pick(r, VALUES),
    status: pick(r, STATUSES),
    origin: pick(r, ['website', 'staff_or_manual', 'unknown', null] as const),
  }))
}

const active = (row: OutcomeLite) => row.status === 'pending' || row.status === 'confirmed'

describe('outcome money (property, 500 seeded populations)', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const rows = population(seed)
    const facts = aggregateOutcomeFacts(rows)
    const live = rows.filter(active)
    const observed = live.filter((r) => r.collectedValue !== null)

    it(`seed ${seed}: NULL never becomes 0, observed 0 is coverage, sums are the exact decimal sums`, () => {
      // NULL ≠ 0: the exact total exists only when every active outcome recorded a collected value.
      expect(facts.collectedValue === null).toBe(observed.length !== live.length)
      if (facts.collectedValue !== null) expect(facts.collectedValue).toBe(facts.observedCollectedValue)
      // An observed 0 (and a negative) counts as recorded coverage; NULL does not.
      expect(facts.collectedValueCoverage).toEqual({ withRecordedValue: observed.length, total: live.length })
      // Fractional cents and negatives are carried, never rounded or dropped.
      expect(Math.abs(facts.observedCollectedValue - exactSum(observed.map((r) => r.collectedValue!)))).toBeLessThan(1e-6)
      // Gross value counts value-bearing (gross > 0) active outcomes only: 0, NULL and negatives add nothing.
      const bearing = live.filter((r) => (r.grossValue ?? 0) > 0)
      expect(facts.valueBearingOutcomes).toBe(bearing.length)
      expect(Math.abs(facts.grossValue - exactSum(bearing.map((r) => r.grossValue!)))).toBeLessThan(1e-6)
      // Cancelled and refunded outcomes never contribute money or active counts.
      expect(facts.activeOutcomes).toBe(live.length)
      expect(facts.cancelledOutcomes).toBe(rows.length - live.length)
    })
  }

  it('an empty population is an observed zero, distinct from an unavailable total (control)', () => {
    expect(aggregateOutcomeFacts([])).toMatchObject({ collectedValue: 0, observedCollectedValue: 0 })
    expect(aggregateOutcomeFacts([{ id: 1, grossValue: 10, collectedValue: null, status: 'confirmed' }]).collectedValue).toBeNull()
    expect(aggregateOutcomeFacts([{ id: 1, grossValue: 10, collectedValue: 0, status: 'confirmed' }]).collectedValue).toBe(0)
  })
})
