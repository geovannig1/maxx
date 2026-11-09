import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TodayPerformanceCockpit } from '@/components/dashboard/TodayPerformanceCockpit'
import { PerformanceCockpitDataSchema, type PerformanceCockpitData } from '@/lib/cockpit/contracts'
import { assemblePerformanceCockpitData, type CockpitEvidence } from '@/lib/cockpit/builder'
import { evaluateGa4TelemetryHealth } from '@/lib/ga4/telemetry-health'

/**
 * Ledger G. Multi-plane source health.
 *
 * The rule under test throughout is ABSENT vs DOWN. A plane nobody asked about must produce no row;
 * a plane that answered badly must produce a loud one; and a plane that answered badly but feeds no
 * number on the page must produce a QUIET one, because an alarm about a source no rendered figure
 * depends on is a false alarm.
 */

const NOW = Date.parse('2026-04-25T12:00:00.000Z')
const WINDOW = { start: '2026-04-06', end: '2026-04-24', basis: 'closed_account_days' as const, timezone: 'America/New_York' as const }

function evidence(planeHealth?: CockpitEvidence['planeHealth']): CockpitEvidence {
  return {
    account: { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'Example Studio' },
    range: WINDOW,
    asOf: '2026-04-25T12:00:00.000Z',
    delivery: {
      available: true, spendAvailable: true, resultsAvailable: true, purchaseAvailable: true, leadAvailable: true,
      linkCtrAvailable: true, cpmAvailable: true, frequencyAvailable: false,
      spend: 963.4, results: 17, purchaseValue: 2410, purchaseCount: 11, leads: 26, linkClicks: 47,
      impressions: 15_000, nativeFrequency: null, dailyBudget: 55, spendCoveredDays: 19, coveredDays: 19, expectedDays: 19,
      synchronizedAt: '2026-04-25T11:55:00.000Z', blockerCodes: [],
    },
    planeHealth,
    partialToday: { available: true, date: '2026-04-25', spend: 5.31, dailyBudget: 55, synchronizedAt: '2026-04-25T11:57:00.000Z', blockerCodes: [] },
    synchronizedAt: '2026-04-25T11:55:00.000Z', decisionIds: [], primaryDecisionId: null, primaryDecision: null,
  }
}

describe('GA4 telemetry health is read, never inferred', () => {
  it('returns null when the monitoring run never recorded an answer', () => {
    // ABSENT, not down. The cockpit omits the plane rather than asserting an outage it never saw.
    expect(evaluateGa4TelemetryHealth(undefined, NOW)).toBeNull()
    expect(evaluateGa4TelemetryHealth(null, NOW)).toBeNull()
    expect(evaluateGa4TelemetryHealth('not json', NOW)).toBeNull()
    // POSITIVE CONTROL: the same function DOES return a value for a well-formed snapshot, so the
    // nulls above mean "absent" and not "this evaluator returns null for everything".
    expect(evaluateGa4TelemetryHealth(
      JSON.stringify({ checked_at: '2026-04-25T11:00:00.000Z', available: true }), NOW,
    )).toEqual({ state: 'available', synchronizedAt: '2026-04-25T11:00:00.000Z', blockerCodes: [] })
  })

  it('separates unavailable, incomplete, stale and unreadable', () => {
    const at = (checked_at: string, rest: Record<string, unknown> = {}) => JSON.stringify({ checked_at, ...rest })
    expect(evaluateGa4TelemetryHealth(at('2026-04-25T11:00:00.000Z', { available: false }), NOW))
      .toMatchObject({ state: 'unavailable', blockerCodes: ['ga4_telemetry_unavailable'] })
    // `available` absent is NOT `available: false`; both are non-healthy but they are different facts.
    expect(evaluateGa4TelemetryHealth(at('2026-04-25T11:00:00.000Z'), NOW))
      .toMatchObject({ state: 'unavailable', blockerCodes: ['ga4_telemetry_health_incomplete'] })
    expect(evaluateGa4TelemetryHealth(at('2026-04-22T11:00:00.000Z', { available: true }), NOW))
      .toMatchObject({ state: 'stale', blockerCodes: ['ga4_telemetry_health_stale'] })
    expect(evaluateGa4TelemetryHealth(JSON.stringify({ checked_at: 'nonsense', available: true }), NOW))
      .toMatchObject({ state: 'unavailable', blockerCodes: ['ga4_telemetry_health_invalid'] })
    // A future stamp cannot bound age either, so it must not read as fresh.
    expect(evaluateGa4TelemetryHealth(at('2026-04-29T11:00:00.000Z', { available: true }), NOW))
      .toMatchObject({ state: 'unavailable', blockerCodes: ['ga4_telemetry_health_invalid_future_timestamp'] })
  })
})

describe('the builder emits a plane only when it was established', () => {
  it('omits every plane no reader supplied', () => {
    const cockpit = assemblePerformanceCockpitData(evidence())
    expect(cockpit.sourceHealth.map((row) => row.plane)).toEqual(['meta_delivery'])
  })

  it('emits supplied planes and marks the ones Today does not read', () => {
    const cockpit = assemblePerformanceCockpitData(evidence([
      { plane: 'outcome_business', state: 'available', synchronizedAt: '2026-04-25T06:00:00.000Z', blockerCodes: [] },
      { plane: 'ga4_telemetry', state: 'unavailable', synchronizedAt: '2026-04-25T11:00:00.000Z', blockerCodes: ['ga4_telemetry_unavailable'] },
    ]))
    expect(cockpit.sourceHealth.map((row) => row.plane)).toEqual(['meta_delivery', 'outcome_business', 'ga4_telemetry'])
    // Meta is the only plane any cockpit claim reads, so it is the only one marked consumed. This is
    // DERIVED from the assembled claims — a caller cannot assert it, so it cannot drift from the page.
    expect(cockpit.sourceHealth.find((row) => row.plane === 'meta_delivery')?.consumedByToday).toBe(true)
    expect(cockpit.sourceHealth.find((row) => row.plane === 'ga4_telemetry')?.consumedByToday).toBe(false)
    expect(cockpit.sourceHealth.find((row) => row.plane === 'outcome_business')?.consumedByToday).toBe(false)
  })

  it('REJECTS a payload missing Meta delivery, or carrying a plane twice', () => {
    // Fails on purpose. A schema that only ever sees valid input is a schema nobody knows works.
    const valid = assemblePerformanceCockpitData(evidence())
    expect(() => PerformanceCockpitDataSchema.parse({ ...valid, sourceHealth: [] })).toThrow()
    expect(() => PerformanceCockpitDataSchema.parse({
      ...valid,
      sourceHealth: [{ plane: 'ga4_telemetry', state: 'available', synchronizedAt: null, blockerCodes: [], consumedByToday: false }],
    })).toThrow(/meta_delivery/)
    expect(() => PerformanceCockpitDataSchema.parse({
      ...valid,
      sourceHealth: [...valid.sourceHealth, { ...valid.sourceHealth[0] }],
    })).toThrow(/one row per evidence plane/)
    // POSITIVE CONTROL: the unmodified payload parses, so the throws above are the refinements
    // firing and not a fixture that never validated.
    expect(() => PerformanceCockpitDataSchema.parse(valid)).not.toThrow()
  })
})

function render(sourceHealth: PerformanceCockpitData['sourceHealth']): string {
  const cockpit = { ...assemblePerformanceCockpitData(evidence()), sourceHealth }
  return renderToStaticMarkup(
    <TodayPerformanceCockpit data={cockpit as PerformanceCockpitData} rangeControl={<div />} />,
  )
}

describe('Today surfaces a degraded plane without an interaction, and stays quiet otherwise', () => {
  const meta = (over: Partial<PerformanceCockpitData['sourceHealth'][number]> = {}) => ({
    plane: 'meta_delivery' as const, state: 'available' as const,
    synchronizedAt: '2026-04-25T11:55:00.000Z', blockerCodes: [] as string[], consumedByToday: true, ...over,
  })

  it('names the source in use when every established plane is fine', () => {
    const html = render([meta()])
    // NAMES it. The previous assertion locked in `Sources checked: N. No issues.` — a cardinal number
    // the owner cannot act on, attached to a claim this component is not entitled to make (below).
    expect(html).toContain('In use on this page:')
    expect(html).toContain('Meta delivery')
    expect(html).toContain('current')
    // No alarm heading. A permanent status board is wallpaper, and wallpaper is skipped on the one
    // day it matters.
    expect(html).not.toContain('is not current')
  })

  it('names a degraded plane in the page body, outside the drawer', () => {
    const html = render([meta({ state: 'stale', blockerCodes: [] })])
    expect(html).toContain('Meta delivery is not current')
    expect(html).not.toContain('No issues.')
    // The strip must precede the <details> drawer, or "without an interaction" is not true.
    expect(html.indexOf('Meta delivery is not current')).toBeLessThan(html.indexOf('<details'))
  })

  it('does NOT alarm on a plane Today never reads, and never prints the raw enum', () => {
    const html = render([
      meta(),
      { plane: 'ga4_telemetry', state: 'unavailable', synchronizedAt: null, blockerCodes: ['ga4_telemetry_unavailable'], consumedByToday: false },
    ])
    // GA4 is down and it is deliberately NOT an alarm: no rendered number depends on it.
    expect(html).not.toContain('is not current')
    // But it must NOT be reported as all-clear either. This is the exact defect the old assertion
    // locked in: `isQuiet` returns true for ANY unconsumed plane whatever its state, so the strip
    // counted a dead source and then declared "No issues." over it. Observed in practice:
    // the Acuity ledger resolves `unavailable` for any range ending today and is not read by Today.
    expect(html).not.toContain('No issues.')
    // The degraded-but-unread plane is NAMED, with its state, and marked as not used here.
    expect(html).toContain('GA4 telemetry')
    // Copy changed with the N1 fix: per-plane clauses read '<Plane> is <state>. It is not used on
    // this page.' rather than welding 'and not used here' onto a shared state list.
    expect(html).toContain('not used on this page')
    // It is still disclosed, in owner words, with the schema token nowhere on the page.
    expect(html).toContain('Not a Today source')
    expect(html).toContain('GA4 telemetry')
    expect(html).not.toContain('ga4_telemetry<')
  })

  it('goes loud once a plane Today DOES read degrades', () => {
    const html = render([
      meta({ state: 'partial' }),
      { plane: 'ga4_telemetry', state: 'unavailable', synchronizedAt: null, blockerCodes: [], consumedByToday: false },
    ])
    expect(html).toContain('Meta delivery is not current')
    expect(html).not.toContain('No issues.')
  })
})
