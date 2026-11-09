import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blockerLabel, measurementKindLabel } from '@/lib/diagnostics/blocker-labels'
import { MEASUREMENT_KINDS } from '@/lib/cockpit/contracts'

/**
 * Every trend blocker the cockpit can emit must have an owner-facing label.
 *
 * These shipped unmapped, so `blockerLabel` fell through to `code.replaceAll('_',' ')` and the
 * dashboard rendered `trend window coverage incomplete` under a metric — precisely what
 * `blocker-labels.ts` says it exists to stop ("the codes were being rendered directly to the owner").
 *
 * The codes are read from the SHIPPED `TREND_BLOCKERS` in builder.ts, not from a list transcribed
 * here. A transcribed list would go stale the moment a blocker is added — which is exactly how these
 * eight came to be missing.
 */
const source = readFileSync(join(process.cwd(), 'src/lib/cockpit/builder.ts'), 'utf8')

function shippedTrendBlockers(): string[] {
  const block = /const TREND_BLOCKERS = \{([\s\S]*?)\} as const/.exec(source)
  if (!block) throw new Error('TREND_BLOCKERS not found — this test can no longer see the real codes')
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

describe('every trend blocker reaches the owner in English', () => {
  it('finds the shipped codes (so this file cannot pass by checking nothing)', () => {
    expect(shippedTrendBlockers().length).toBeGreaterThanOrEqual(7)
    expect(shippedTrendBlockers()).toContain('trend_prior_period_zero')
  })

  it.each(shippedTrendBlockers())('%s is labelled, not echoed', (code) => {
    const label = blockerLabel(code)
    // The fallback is `code.replaceAll('_', ' ')`. If that is what came back, the code is unmapped.
    expect(label).not.toBe(code.replaceAll('_', ' '))
    expect(label).not.toContain('_')
    expect(label.length).toBeGreaterThan(code.length / 2)
  })

  it('states the ZERO-BASELINE case correctly, not as its opposite', () => {
    // "trend prior period zero" reads as "the trend was zero" — i.e. flat. It means there was no
    // baseline. A label that states the reverse of the fact is worse than the raw code.
    const label = blockerLabel('trend_prior_period_zero')
    expect(label).toContain('nothing to compare against')
    expect(label).not.toMatch(/^trend/)
  })

  it('explains the settling case in terms of Meta restating data, not of "uncomparable windows"', () => {
    expect(blockerLabel('trend_window_uncomparable')).toContain('still restating')
  })

  it('says WHY a small sample is refused, WITHOUT naming a unit it does not gate on', () => {
    // It read "too few bookings" — but `EVENT_BACKED_METRICS` gates purchase value and ROAS on
    // PURCHASE COUNT and cost-per-Lead on LEADS. So the sentence was false under three of the five
    // cells it guards, and an account that never records `leads` makes it false every day.
    // Same class of defect as `trend_prior_period_zero` reading as its own opposite.
    const label = blockerLabel('trend_sample_too_small')
    expect(label).toContain('too few')
    expect(label).toContain('for a percentage to mean anything')
    expect(label).not.toContain('bookings')
  })

  it('an unrelated unmapped code still degrades readably rather than throwing', () => {
    expect(blockerLabel('some_unmapped_code')).toBe('some unmapped code')
  })
})

/**
 * EVERY blocker literal in builder.ts, not one object.
 *
 * The harvester above reads `TREND_BLOCKERS` only. That scope is what let commit `1fe28d9` ship
 * `meta_native_reach_unavailable` and `meta_optimization_rate_inputs_unavailable` as bare literals at
 * the call site — invisible to the mechanism written to prevent exactly this — and the sweep then
 * found FOURTEEN more that had been rendering raw under metric cells the whole time
 * (`meta purchase roas inputs unavailable`, `historical budget continuity unproven`).
 *
 * The failure was never the list; it was harvesting a container instead of the population. This reads
 * every `blockerCodes: [...]` array in the file, so a code added anywhere fails here rather than
 * arriving on the dashboard as an enum.
 */
/**
 * ALL THREE emitting files, because the population spans them.
 *
 * The first version of this harvester read one OBJECT. Widening it to one FILE found fourteen
 * unlabelled codes. Widening it to the FILES THAT ACTUALLY EMIT found thirty more: `source-readers`
 * and `loader` push codes into `delivery.blockerCodes`, which the builder spreads into every claim,
 * so they reach the owner through exactly the same cell. Scoping a completeness check to one
 * container proves only that the container is complete.
 */
const EMITTING_FILES = [
  'src/lib/cockpit/builder.ts',
  'src/lib/cockpit/loader.ts',
  'src/lib/cockpit/source-readers.ts',
] as const

const allSources = EMITTING_FILES.map((file) => readFileSync(join(process.cwd(), file), 'utf8')).join('\n')

function shippedCellBlockers(): string[] {
  const codes = new Set<string>()
  for (const match of allSources.matchAll(/blockerCodes:\s*(?:sorted\()?\[([\s\S]*?)\]/g)) {
    // Literals in CODE position only. One array picks its code with a ternary
    // (`state === 'available' ? … : …`), so a naive scan harvests the comparison operand and the
    // test then fails on a string that is not a blocker at all.
    const body = match[1].replace(/[=!]==\s*'[a-z_]+'/g, '')
    for (const literal of body.matchAll(/'([a-z][a-z0-9_]*)'/g)) codes.add(literal[1])
  }
  // `.push('code')` and `.push(`code:${date}`)` — the readers build their arrays imperatively, so a
  // scan for `blockerCodes: [...]` alone sees none of them.
  for (const match of allSources.matchAll(/Blockers\.push\(\s*[`']([a-z][a-z0-9_]*)/g)) codes.add(match[1])
  for (const match of allSources.matchAll(/blockerCodes\.push\(\s*[`']([a-z][a-z0-9_]*)/g)) codes.add(match[1])
  return [...codes].sort()
}

describe('every cockpit cell blocker reaches the owner in English', () => {
  it('finds the shipped literals (so this file cannot pass by checking nothing)', () => {
    const found = shippedCellBlockers()
    expect(found.length).toBeGreaterThanOrEqual(40)
    // Two the narrow harvester structurally could not see.
    expect(found).toContain('meta_native_reach_unavailable')
    expect(found).toContain('meta_optimization_rate_inputs_unavailable')
    // Emitted by the READERS, invisible to a builder-only scan — thirty of these were unlabelled.
    expect(found).toContain('meta_native_period_all_days_coverage_invalid')
    expect(found).toContain('partial_today_row_invalid')
    expect(found).toContain('cockpit_trend_read_threw')
  })

  it('maps every one of them — no raw enum reaches a metric cell', () => {
    const raw = shippedCellBlockers().filter((code) => blockerLabel(code) === code.replaceAll('_', ' '))
    expect(raw).toEqual([])
  })

  it('labels read as English, not as the code with the underscores taken out', () => {
    for (const code of shippedCellBlockers()) {
      const label = blockerLabel(code)
      expect(label, code).not.toBe(code)
      // The tell of a fallback label: every word of the code, in order, is the whole label.
      expect(label, code).not.toBe(code.replaceAll('_', ' '))
      // AND NOT BLANK. Emptying any label to '' survived the mutation sweep: `??` only falls back on
      // null/undefined, so '' is returned verbatim and the cell renders "Unavailable" with no reason
      // under it — strictly worse for the owner than the raw code this file exists to replace, and
      // invisible to an assertion that only checks the label is not the fallback.
      expect(label.trim().length, code).toBeGreaterThan(10)
      expect(label.trim().split(/\s+/).length, code).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('every measurement kind reaches the owner in English', () => {
  it('maps every kind the contract allows', () => {
    // TOTALITY over the shipped enum. The cockpit printed `Meta · ${claim.measurementKind}` under
    // every available cell — the raw axis — because it was a hand-written template rather than a
    // code passing through a table. A kind added to the contract must fail here, not ship.
    for (const kind of MEASUREMENT_KINDS) {
      const label = measurementKindLabel(kind)
      expect(label, kind).not.toBe(kind.replaceAll('_', ' '))
      // Same blank-label gap as the blocker codes above — emptying these survived the sweep.
      expect(label.trim().length, kind).toBeGreaterThan(10)
      expect(label.trim().split(/\s+/).length, kind).toBeGreaterThanOrEqual(3)
    }
  })

  it('distinguishes a counted fact from Meta’s estimate', () => {
    // These two must not collapse into one sentence: `modelled` is Meta's attribution guess and
    // `measured` is a number Ads Manager counted. An earlier fix mapped six kinds onto one string.
    expect(measurementKindLabel('measured')).not.toBe(measurementKindLabel('modelled'))
    expect(measurementKindLabel('modelled')).toMatch(/estimate/i)
  })
})

/**
 * A code that carries a DATE still reads as English.
 *
 * `source-readers.ts` emits one `meta_account_spend_day_missing:2026-08-04` per missing day. An
 * exact-match table never matches those, so every one fell through to the raw fallback with the
 * timestamp welded on — the leak this file exists to stop, in the shape the table could not see.
 */
describe('date-stamped codes resolve to their family', () => {
  it('keeps the date, drops the enum', () => {
    const out = blockerLabel('meta_account_spend_day_missing:2026-08-04')
    expect(out).toContain('2026-08-04')
    expect(out).not.toContain('meta_account_spend_day_missing')
    expect(out).toContain('no spend row')
  })

  it('still degrades readably when the family is genuinely unknown', () => {
    expect(blockerLabel('totally_unknown_code:2026-08-04')).toBe('totally unknown code:2026-08-04')
  })
})
