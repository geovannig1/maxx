import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedOutcome } from '@/lib/outcomes/adapter'
import { toNormalizedOutcomeRow } from '@/lib/outcomes/store'
import { businessDateOf } from '@/config/business-config'

// Plan section 7.2 (time): business dates are computed in the configured account timezone from the
// conversion instant (`occurred_at`), never from UTC, the server clock or the fulfilment time. Fixtures
// at 23:30 local, across a DST boundary, and with fulfilment a week later.

afterEach(() => vi.unstubAllEnvs())

const NOW = '2026-11-01T00:00:00.000Z'

function outcome(externalId: string, occurredAt: string, fulfilmentAt: string | null = null): NormalizedOutcome {
  return {
    externalId, outcomeType: 'sale', outcomeLabel: null, status: 'confirmed', currency: 'EUR',
    grossValue: '10.00', collectedValue: '10.00', occurredAt, fulfilmentAt, fulfilmentStatus: fulfilmentAt ? 'scheduled' : null,
    origin: 'website',
    attribution: { fbclid: null, fbc: null, fbp: null, gclid: null, utmSource: null, utmMedium: null, utmCampaign: null,
      utmContent: null, utmTerm: null, landingPage: null, referrer: null },
    customer: { email: null, phone: null, firstName: null, lastName: null },
  }
}

const rowsIn = (timezone: string, outcomes: NormalizedOutcome[]) =>
  outcomes.map((o) => toNormalizedOutcomeRow(o, { adAccountId: 'a', sourceId: 's', timezone, observationSource: 'webhook' }, NOW))

const countByBusinessDate = (rows: Array<Record<string, unknown>>) =>
  rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [String(r.business_date)]: (acc[String(r.business_date)] ?? 0) + 1 }), {})

describe('business date in the account timezone', () => {
  it('23:30 local stays on the local day although it is the next day in UTC', () => {
    // 2026-03-07 23:30 PST (UTC-8) = 2026-03-08T07:30Z.
    const [row] = rowsIn('America/Los_Angeles', [outcome('late', '2026-03-07T23:30:00-08:00')])
    expect(row.business_date).toBe('2026-03-07')
    expect(new Date(String(row.occurred_at)).toISOString().slice(0, 10)).toBe('2026-03-08')
  })

  it('counts by local business date across a DST boundary (US spring forward, EU fall back)', () => {
    const la = rowsIn('America/Los_Angeles', [
      outcome('before-dst', '2026-03-07T23:30:00-08:00'), // PST
      outcome('dst-day', '2026-03-08T23:30:00-07:00'), // PDT, the day clocks moved
      outcome('after-dst', '2026-03-09T00:30:00-07:00'),
    ])
    expect(countByBusinessDate(la)).toEqual({ '2026-03-07': 1, '2026-03-08': 1, '2026-03-09': 1 })

    const berlin = rowsIn('Europe/Berlin', [
      outcome('fall-back-day-late', '2026-10-25T23:30:00+01:00'), // CET after the change = 22:30Z
      outcome('next-day-early', '2026-10-26T00:30:00+01:00'), // 23:30Z on the 25th in UTC
      outcome('before-change', '2026-10-25T01:30:00+02:00'), // CEST, before 03:00 local
    ])
    expect(countByBusinessDate(berlin)).toEqual({ '2026-10-25': 2, '2026-10-26': 1 })
  })

  it('uses the occurred_at instant as the window basis, not a fulfilment a week later', () => {
    const [row] = rowsIn('Europe/Berlin', [outcome('later-fulfilment', '2026-06-01T23:30:00+02:00', '2026-06-08T10:00:00+02:00')])
    expect(row.business_date).toBe('2026-06-01')
    expect(row.fulfilment_at).toBe('2026-06-08T10:00:00+02:00')
  })

  it('the same instant lands on different business dates in different configured zones', () => {
    const instant = '2026-07-01T23:30:00-04:00' // 03:30Z on 07-02
    expect(rowsIn('America/New_York', [outcome('x', instant)])[0].business_date).toBe('2026-07-01')
    expect(rowsIn('Asia/Tokyo', [outcome('x', instant)])[0].business_date).toBe('2026-07-02')
  })

  it('the shared helper follows the configured zone', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'America/Los_Angeles')
    expect(businessDateOf('2026-03-07T23:30:00-08:00')).toBe('2026-03-07')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'UTC')
    expect(businessDateOf('2026-03-07T23:30:00-08:00')).toBe('2026-03-08')
  })

  it('refuses an invalid zone instead of guessing a date', () => {
    expect(() => rowsIn('', [outcome('x', '2026-03-07T23:30:00-08:00')])).toThrow()
  })
})
