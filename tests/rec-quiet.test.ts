import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { explainQuiet } from '@/lib/recommendations/quiet'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'

const {
  DORMANT_SPEND_30D,
  MIN_ATTRIBUTED_SHARE,
  MAX_DATA_AGE_HOURS,
} = REC_THRESHOLDS

describe('explainQuiet', () => {
  it('pre-launch: cites dormancy without turning fixed spend/bookings into decision proof', () => {
    const q = explainQuiet({ dataMode: 'pre_launch', spend30d: 5 })
    expect(q.title).toMatch(/pre-launch/i)
    const reasons = q.reasons.join(' ')
    expect(reasons).toContain(`$${DORMANT_SPEND_30D}`)
    expect(reasons).toMatch(/fixed spend, booking, day, or learning-event count would not/i)
    expect(q.unlocks.some((u) => /CampaignPlan/.test(u))).toBe(true)
    expect(q.unlocks.some((u) => /immutable Meta IDs/.test(u))).toBe(true)
  })

  it('low-data: asks for the governed decision contract instead of a booking-count shortcut', () => {
    const q = explainQuiet({ dataMode: 'low_data', spend30d: 200 })
    expect(q.reasons.join(' ')).toMatch(/not a decision-sufficiency test/i)
    expect(q.unlocks.join(' ')).toMatch(/exact paid-outcome lineage/i)
  })

  it('stale data: quotes the freshness bar (26h) and offers a re-sync', () => {
    const q = explainQuiet({ dataMode: 'sufficient', stale: true })
    expect(q.reasons.join(' ')).toContain(String(MAX_DATA_AGE_HOURS))
    expect(q.unlocks.some((u) => /re-run the sync/i.test(u))).toBe(true)
  })

  it('low attribution: quotes the attribution floor and the observed coverage', () => {
    const q = explainQuiet({ dataMode: 'low_data', attributionCoverage: 0.2 })
    const reasons = q.reasons.join(' ')
    expect(reasons).toContain(`${Math.round(MIN_ATTRIBUTED_SHARE * 100)}%`) // floor = 50%
    expect(reasons).toContain('20%') // observed coverage
    expect(q.unlocks.some((u) => /UTM coverage alone never unlocks paid ROAS/.test(u))).toBe(true)
  })

  it('open recommendations: flips the title to an "N are open" framing', () => {
    expect(explainQuiet({ dataMode: 'low_data', openCount: 3 }).title).toBe('3 recommendations are open')
    expect(explainQuiet({ dataMode: 'low_data', openCount: 1 }).title).toBe('1 recommendation is open')
  })

  it('quotes the dormancy classifier while withholding decision shortcuts', () => {
    const q = explainQuiet({ dataMode: 'pre_launch', spend30d: 0 })
    expect(q.reasons.join(' ')).toContain(`$${REC_THRESHOLDS.DORMANT_SPEND_30D}`)
    expect(q.reasons.join(' ')).not.toMatch(/needs? at least .*bookings/i)
  })

  it('does not treat learning exit as the unlock for action', () => {
    const q = explainQuiet({ dataMode: 'active_learning' })
    expect(q.reasons.join(' ')).toMatch(/does not by itself prove or disprove/i)
    expect(q.unlocks.join(' ')).not.toMatch(/let ad sets run to|events\/7d/i)
  })
})

// Regression: making the feed render again exposed a new silence — the visible advice is
// the last generation Maxx was allowed to write, and the sync freezes regeneration whenever Meta's
// outcome plane is incomplete. On 2026-08-19 that had held the feed at 2026-08-17 for two days with
// nothing on screen saying so. Age is part of the evidence, not decoration.
describe('recommendation feed age', () => {
  const REC_STALE_BAR_HOURS = 26

  const ageOf = (generatedAt: string) => {
    const hours = (Date.now() - Date.parse(generatedAt)) / 3_600_000
    return { hours, stale: hours > REC_STALE_BAR_HOURS }
  }

  it('marks a two-day-old generation stale', () => {
    const age = ageOf(new Date(Date.now() - 48 * 3_600_000).toISOString())
    expect(age.stale).toBe(true)
    expect(Math.round(age.hours / 24)).toBe(2)
  })

  it('does not mark a fresh generation stale', () => {
    expect(ageOf(new Date(Date.now() - 3 * 3_600_000).toISOString()).stale).toBe(false)
  })
})
