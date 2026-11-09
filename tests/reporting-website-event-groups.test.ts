import { describe, expect, it } from 'vitest'
import { validateEnv } from '@/config/env'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'
import { makeReportMetric } from '@/lib/reporting/claims'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { buildWebsiteReport, type BuildWebsiteReportInput } from '@/lib/reporting/website-metrics'
import { websiteEventGroups, websiteEventQueryNames } from '@/lib/reporting/website-event-groups'

// The website report's three event cards are configured per install (GA4_INTENT_EVENTS,
// GA4_LEAD_EVENTS, and the existing GA4_BOOKING_EVENT for confirmations). Each test plants the
// configuration it depends on, including the bad cases: an invalid name and a legacy saved packet.

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}
const totals = { sessions: 10, engagedSessions: 4, engagementRate: 0.4, users: 8, pageViews: 16 }
const event = (name: string, eventCount: number) => ({ name, device: 'mobile', channel: 'Paid Social', eventCount })
const base = (events: BuildWebsiteReportInput['events']): BuildWebsiteReportInput => ({
  currentTotals: totals, previousTotals: null, rows: [], events, eventAbsenceProven: true,
  eventCoverage: { state: 'complete', numerator: 1, denominator: 1 },
  metadata: { timezone: context.timezone, currency: context.currency, subjectToThresholding: null,
    dataLossFromOtherRow: false, sampled: false, returnedRows: events.length, totalRows: events.length },
})

describe('website event group configuration', () => {
  it('defaults to GA4 recommended events and the configured booking event', () => {
    const groups = websiteEventGroups({})
    expect(groups.map(group => [group.key, group.variable, group.names])).toEqual([
      ['intent_events', 'GA4_INTENT_EVENTS', ['begin_checkout']],
      ['lead_events', 'GA4_LEAD_EVENTS', ['generate_lead']],
      ['confirmation_events', 'GA4_BOOKING_EVENT', ['appointment_confirmed']],
    ])
    expect(websiteEventQueryNames(groups)).toEqual(['begin_checkout', 'generate_lead', 'appointment_confirmed'])
  })

  it('reads comma lists, trims and de-duplicates, and reuses GA4_BOOKING_EVENT for confirmations', () => {
    const groups = websiteEventGroups({
      GA4_INTENT_EVENTS: ' quote_request_click , begin_checkout,quote_request_click ',
      GA4_LEAD_EVENTS: 'generate_lead,form_submit', GA4_BOOKING_EVENT: 'purchase',
    })
    expect(groups.map(group => group.names)).toEqual([
      ['quote_request_click', 'begin_checkout'], ['generate_lead', 'form_submit'], ['purchase'],
    ])
    expect(groups.every(group => group.invalid === false)).toBe(true)
  })

  it.each([
    ['a name starting with a digit', '1_click'],
    ['a hyphen', 'quote-request'],
    ['a name longer than 40 characters', `a${'b'.repeat(40)}`],
    ['an empty list', ' , '],
  ])('marks %s invalid and queries none of its names', (_label, raw) => {
    const groups = websiteEventGroups({ GA4_INTENT_EVENTS: raw })
    expect(groups[0]).toMatchObject({ key: 'intent_events', invalid: true, names: [] })
    expect(websiteEventQueryNames(groups)).toEqual(['generate_lead', 'appointment_confirmed'])
  })

  it('accepts a 40-character name (the GA4 limit) — the control for the length rule', () => {
    const name = `a${'b'.repeat(39)}`
    expect(websiteEventGroups({ GA4_INTENT_EVENTS: name })[0]).toMatchObject({ invalid: false, names: [name] })
  })

  it('reports an invalid list to setup and the doctor, and accepts a valid one', () => {
    const invalid = validateEnv({ GA4_INTENT_EVENTS: 'quote-request', GA4_LEAD_EVENTS: 'generate_lead' })
    expect(invalid.filter(issue => issue.name.startsWith('GA4_'))).toEqual([
      expect.objectContaining({ name: 'GA4_INTENT_EVENTS', code: 'invalid', blocks: 'feature' }),
    ])
    const valid = validateEnv({ GA4_INTENT_EVENTS: 'quote_request_click,begin_checkout', GA4_LEAD_EVENTS: 'generate_lead' })
    expect(valid.filter(issue => issue.name.startsWith('GA4_'))).toEqual([])
  })
})

describe('configured website event cards', () => {
  it('counts a configured custom intent event and builds no card for any other install-specific name', () => {
    const eventGroups = websiteEventGroups({ GA4_INTENT_EVENTS: 'quote_request_click' })
    const { report, issues } = buildWebsiteReport(context, { ...base([
      event('quote_request_click', 7), event('generate_lead', 2), event('appointment_confirmed', 1),
    ]), eventGroups })

    expect(Object.keys(report.metrics).filter(key => key.endsWith('_events')).sort())
      .toEqual(['confirmation_events', 'intent_events', 'lead_events'])
    expect(report.metrics.intent_events).toMatchObject({ label: 'Intent events', event: 'quote_request_click' })
    expect(report.metrics.intent_events.definition).toContain('quote_request_click')
    expect(report.metrics.intent_events.current.value).toBe(7)
    expect(report.metrics.lead_events.current.value).toBe(2)
    expect(report.metrics.confirmation_events.current.value).toBe(1)
    expect(issues).toEqual([])
  })

  it('sums every configured name in a group', () => {
    const eventGroups = websiteEventGroups({ GA4_LEAD_EVENTS: 'generate_lead,form_submit' })
    const { report } = buildWebsiteReport(context, { ...base([event('generate_lead', 2), event('form_submit', 5)]), eventGroups })
    expect(report.metrics.lead_events).toMatchObject({ event: 'generate_lead + form_submit' })
    expect(report.metrics.lead_events.current.value).toBe(7)
  })

  it('makes a card with an invalid configuration unavailable with a reason, without failing the report', () => {
    const eventGroups = websiteEventGroups({ GA4_INTENT_EVENTS: 'quote-request' })
    const { report, issues } = buildWebsiteReport(context, { ...base([event('generate_lead', 2)]), eventGroups })

    expect(report.metrics.intent_events.current.value).toBeNull()
    expect(report.metrics.intent_events.current.availability.state).toBe('unavailable')
    expect(report.metrics.intent_events.current.availability.blockerCodes.join(' ')).toMatch(/GA4_INTENT_EVENTS/)
    expect(report.metrics.lead_events.current.value).toBe(2)
    expect(issues).toContain('ga4_event_config_invalid:GA4_INTENT_EVENTS')
  })

  it('names the configured events in the card definitions and fixes the confirmation grammar', () => {
    const { report } = buildWebsiteReport(context, base([]))
    expect(report.metrics.intent_events.definition).toContain('begin_checkout')
    expect(report.metrics.lead_events.definition).toContain('generate_lead')
    expect(report.metrics.confirmation_events.definition).toContain('appointment_confirmed')
    expect(report.metrics.confirmation_events.definition).not.toMatch(/\ban recorded\b/)
  })
})

describe('saved packets written with the original card keys', () => {
  function legacyWebsitePacket() {
    const { report } = buildWebsiteReport(context, base([]))
    const metric = (key: string, label: string, name: string) => makeReportMetric({
      context, source: 'ga4', unit: 'count', key, label, event: name,
      definition: `GA4 eventCount for ${name}.`, current: 3,
      coverage: { state: 'complete', numerator: 1, denominator: 1 },
    })
    // The metric map exactly as the earlier writer keyed it: two cards under their old keys.
    const rest = Object.fromEntries(Object.entries(report.metrics).filter(([key]) => key !== 'intent_events' && key !== 'lead_events'))
    const metrics = { ...rest, book_now_events: metric('book_now_events', 'Book now events', 'legacy_click'),
      contact_events: metric('contact_events', 'Contact events', 'legacy_form') }
    return JSON.parse(JSON.stringify({ section: 'website', context, notes: [],
      result: { state: 'available', asOf: context.asOf, notes: [], data: { ...report, metrics } } }))
  }

  it('still validates as stored and upgrades to the generic keys when read', () => {
    const legacy = legacyWebsitePacket()
    expect(validateReportingPacket(legacy).section).toBe('website')

    const upgraded = upgradeLegacyVocabulary(legacy)
    const metrics = upgraded.result.data.metrics
    expect(Object.keys(metrics)).toEqual(expect.arrayContaining(['intent_events', 'lead_events', 'confirmation_events']))
    expect(metrics).not.toHaveProperty('book_now_events')
    expect(metrics).not.toHaveProperty('contact_events')
    expect(metrics.intent_events).toMatchObject({ key: 'intent_events', event: 'legacy_click' })
    expect(metrics.intent_events.current.metricKey).toBe('ga4.intent_events')
    expect(metrics.lead_events.current.metricKey).toBe('ga4.lead_events')
    expect(metrics.intent_events.current.value).toBe(3)
    // Historical descriptions and claim ids are kept as stored, so references to them stay intact.
    expect(metrics.intent_events.label).toBe('Book now events')
    expect(metrics.intent_events.current.claimId).toBe(legacy.result.data.metrics.book_now_events.current.claimId)
    expect(validateReportingPacket(upgraded).section).toBe('website')
    expect(upgradeLegacyVocabulary(upgraded)).toEqual(upgraded)
  })
})
