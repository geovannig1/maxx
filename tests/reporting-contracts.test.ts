import { describe, expect, it } from 'vitest'
import { assertNoCrossPlaneLineage, MetricClaimSchema } from '@/lib/cockpit/contracts'
import { makeReportMetric } from '@/lib/reporting/claims'
import { ReportingContextSchema } from '@/lib/reporting/contracts'
import { previousReportingRange, resolveReportingRange } from '@/lib/reporting/range'

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}
const complete = { state: 'complete' as const, numerator: 1, denominator: 1 }
const base = {
  context, key: 'spend', label: 'Spend', definition: 'Meta-reported spend for the selected period.',
  source: 'meta' as const, unit: 'money' as const, current: 12, previous: 10,
  coverage: complete, previousCoverage: complete,
}

describe('reporting periods', () => {
  it('matches the immediately preceding equal calendar period across a month boundary', () => {
    expect(previousReportingRange(context.range)).toEqual(context.comparison)
  })
  it('rejects impossible dates, partial custom periods and entirely future ranges', () => {
    const now = new Date(context.asOf)
    expect(() => resolveReportingRange({ from: '2026-02-30', to: '2026-03-02' }, now)).toThrow()
    expect(() => resolveReportingRange({ from: '2026-09-02' }, now)).toThrow()
    expect(() => resolveReportingRange({ from: '2026-09-06', to: '2026-09-07' }, now)).toThrow()
  })
  it('keeps valid custom dates ahead of a preset and exposes a future-end clamp', () => {
    expect(resolveReportingRange({ ...context.range, range: '1m' }, new Date(context.asOf)))
      .toMatchObject({ ...context.range, preset: 'custom' })
    expect(resolveReportingRange({ from: '2026-09-02', to: '2026-09-08' }, new Date(context.asOf)))
      .toMatchObject({ to: '2026-09-04', clampedFuture: true })
  })
  it('rejects a context that claims the wrong comparison duration', () => {
    expect(ReportingContextSchema.safeParse(context).success).toBe(true)
    expect(ReportingContextSchema.safeParse({ ...context, comparison: context.range }).success).toBe(false)
  })
})

describe('reporting claims', () => {
  it('retains explicit zero and marks an absent value unavailable', () => {
    expect(makeReportMetric({ ...base, current: 0 }).current.value).toBe(0)
    const missing = makeReportMetric({ ...base, current: null, reason: 'Meta did not supply spend.' })
    expect(missing.current.availability.state).toBe('unavailable')
    expect(missing.current.value).toBeNull()
  })
  it('keeps prior values in their own period and supports real watch-duration units', () => {
    const metric = makeReportMetric({ ...base, key: 'average_watch', unit: 'seconds', current: 3.5 })
    expect(metric.current.unit).toBe('seconds')
    expect(metric.previous?.window).toMatchObject({ start: context.comparison.from, end: context.comparison.to })
    expect(MetricClaimSchema.safeParse(metric.current).success).toBe(true)
  })
  it('does not publish a ratio when coverage is incomplete', () => {
    const metric = makeReportMetric({ ...base, key: 'ctr', unit: 'percent', current: 2,
      coverage: { state: 'partial', numerator: 1, denominator: 2 } })
    expect(metric.current.value).toBeNull()
    expect(metric.current.availability.state).toBe('unavailable')
  })
  it('retains lineage so a fabricated cross-source paid CPA is rejected', () => {
    const spend = makeReportMetric(base)
    const bookings = makeReportMetric({ ...base, key: 'paid_bookings', label: 'Paid bookings',
      source: 'outcomes', unit: 'count', current: 2 })
    const falseCpa = makeReportMetric({ ...base, key: 'paid_cpa', current: 6,
      measurementKind: 'derived', inputMetrics: [spend, bookings] })
    const claims = Object.fromEntries([spend, bookings, falseCpa].map(m => [m.current.claimId, m.current]))
    expect(() => assertNoCrossPlaneLineage(claims)).toThrow(/evidence planes|derived from/)
  })
})
