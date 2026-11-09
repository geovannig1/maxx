import { describe, expect, it } from 'vitest'
import { aggregateOutcomeFacts } from '@/lib/outcomes/facts'
import type { OutcomeLite } from '@/lib/outcomes/model'

// Exact money — decision: money totals stay IEEE-754 double sums. Exact decimal sums would change the
// golden snapshots (tests/golden: `bookedValue: 7649.849999999994` is the double sum of the golden
// population; an exact sum is 7649.85), and goldens may only change by a reviewed semantic decision.
//
// The precise bound (docs/operations.md, "Money arithmetic"): stored money has at most 15 integer and 6
// fraction digits. Converting each value to a double costs at most u·|x| (u = 2^-53), and a left-to-right
// sum of n terms adds at most (n-1)·u·Σ|x| (Higham, γ_{n-1}). So a total is within
//     n · u · Σ|x|
// of the exact decimal total, which is below half a minor unit h whenever n · Σ|x| < h / u, i.e.
// n · Σ|x| < 4.5e13 for a two-digit currency (h = 0.005) and 4.5e12 for a three-digit one. Example: 100,000
// outcomes totalling 100,000,000 gives 1e13 < 4.5e13. Beyond that the guarantee does not hold (control below).

const U = 2 ** -53
const SCALE = BigInt(1000000)

/** Deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A stored decimal string with up to `fraction` fraction digits and a value below `max`. */
function decimal(next: () => number, max: number, fraction: number): string {
  const whole = Math.floor(next() * max)
  const digits = Math.floor(next() * (fraction + 1))
  const frac = digits === 0 ? '' : '.' + String(Math.floor(next() * 10 ** digits)).padStart(digits, '0')
  return `${whole}${frac}`
}

function exactMicros(values: readonly string[]): bigint {
  return values.reduce((sum, v) => {
    const [w, f = ''] = v.split('.')
    return sum + BigInt(w) * SCALE + BigInt((f + '000000').slice(0, 6))
  }, BigInt(0))
}

const toNumber = (micros: bigint) => Number(micros) / 1e6

function rows(values: readonly string[]): OutcomeLite[] {
  return values.map((v, i) => ({ id: i + 1, grossValue: Number(v), collectedValue: Number(v), status: 'confirmed', origin: 'website' }))
}

describe('money totals stay within half a minor unit of the exact decimal total inside the documented bound', () => {
  const CASES = [
    { name: 'a small business month', seed: 1, n: 300, max: 500, fraction: 2 },
    { name: 'an enterprise quarter (100k outcomes, six fraction digits)', seed: 2, n: 100_000, max: 2_000, fraction: 6 },
    { name: 'large tickets', seed: 3, n: 2_000, max: 5_000_000, fraction: 2 },
  ]
  for (const c of CASES) {
    it(`${c.name}: gross and collected totals round-trip to the stored decimals`, () => {
      const next = rng(c.seed)
      const values = Array.from({ length: c.n }, () => decimal(next, c.max, c.fraction))
      const exact = exactMicros(values)
      const absTotal = toNumber(exact)
      // Inside the bound for a two-digit currency, by construction of the case.
      expect(c.n * absTotal).toBeLessThan(0.005 / U)
      const facts = aggregateOutcomeFacts(rows(values))
      for (const total of [facts.grossValue, facts.observedCollectedValue, facts.collectedValue!]) {
        const error = Math.abs(total - toNumber(exact))
        expect(error).toBeLessThanOrEqual(c.n * U * absTotal + Number.EPSILON * absTotal)
        expect(error).toBeLessThan(0.005)
        // Rounded to the minor unit, the double total equals the exact total rounded the same way.
        expect(Math.round(total * 100)).toBe(Number((exact + BigInt(5000)) / BigInt(10000)))
      }
    })
  }

  it('reproduces the golden float artefact the decision preserves (known-present control)', () => {
    const values = ['0.1', '0.2']
    const facts = aggregateOutcomeFacts(rows(values))
    expect(facts.grossValue).toBe(0.30000000000000004)
    expect(facts.grossValue).not.toBe(toNumber(exactMicros(values)))
  })

  it('loses the guarantee outside the bound: fifteen-integer-digit values drift past half a cent (control)', () => {
    const values = Array.from({ length: 10 }, () => '999999999999999.99')
    const facts = aggregateOutcomeFacts(rows(values))
    expect(10 * toNumber(exactMicros(values))).toBeGreaterThan(0.005 / U)
    // At this magnitude the double total is an integer; compare it exactly, in micro-units.
    const driftMicros = BigInt(facts.grossValue) * SCALE - exactMicros(values)
    expect(driftMicros < BigInt(0) ? -driftMicros : driftMicros).toBeGreaterThan(BigInt(5000))
  })
})
