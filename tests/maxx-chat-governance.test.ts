import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import {
  MAXX_CHAT_MEASUREMENT_GOVERNANCE,
  buildGovernedToolEvidence,
  governMaxxAnswer,
  serializeGovernedToolResult,
} from '@/lib/maxx/chat'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'
import { PRIMARY_TOOL_DEFINITIONS } from '@/mcp/tools/tool-definitions-primary'

describe('Maxx chat measurement governance', () => {
  it('pins the four source roles and the paid-outcome boundary in the runtime prompt', () => {
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/Meta[\s\S]*platform delivery[\s\S]*modelled[\s\S]*AppointmentConfirmed Results/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/Outcomes[\s\S]*real outcomes[\s\S]*booked value[\s\S]*amount paid/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/GA4[\s\S]*browser[\s\S]*session[\s\S]*telemetry/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/GA4 event value[\s\S]*not revenue/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/CAPI[\s\S]*delivery[\s\S]*dedup/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/complete booking-ID paid-touch join/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/generic custom[\s\S]*purchase aliases[\s\S]*AppointmentConfirmed/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/daily-summed reach[\s\S]*native selected-period reach/i)
    expect(MAXX_CHAT_MEASUREMENT_GOVERNANCE).toMatch(/averaged[\s\S]*frequency[\s\S]*native selected-period frequency/i)
  })

  it('keeps shared Maxx instructions honest about native Meta period metrics and creative causality', () => {
    expect(MAXX_INSTRUCTIONS).toMatch(/selected-period reach\/frequency[\s\S]*native Meta all-days rollup/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/never sum daily reach[\s\S]*average\/recompute daily frequency/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/Generic custom-conversion and purchase aliases[\s\S]*never[\s\S]*AppointmentConfirmed/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/all-click CTR decline[\s\S]*descriptive delivery correlations[\s\S]*do not identify a cause/i)
    expect(MAXX_INSTRUCTIONS).not.toMatch(/the fatigue trend \(frequency and any decay\)/i)
    expect(MAXX_INSTRUCTIONS).not.toMatch(/strong early retention with weak later retention is a CREATIVE problem/i)
  })

  it('describes account, campaign, creative, and alert tools without fabricated period metrics or fatigue', () => {
    const definitions = Object.fromEntries(PRIMARY_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.description]))
    expect(definitions.get_account_summary).toMatch(/native Meta all-days rollup[\s\S]*peak_daily_reach[\s\S]*daily observation/i)
    expect(definitions.get_campaign_performance).toMatch(/Multi-day reach\/frequency are unavailable/i)
    expect(definitions.get_creative_performance).toMatch(/all-click CTR[\s\S]*observations only[\s\S]*not[\s\S]*causal fatigue/i)
    expect(definitions.get_alerts).toMatch(/cannot prove fatigue[\s\S]*creative cause/i)
  })

  it('wraps every tool response with source, date, scope, freshness and availability', () => {
    const evidence = buildGovernedToolEvidence({
      tool: 'get_reconciliation',
      args: { start_date: '2026-08-01', end_date: '2026-08-20', campaign_id: '1200' },
      result: { status: 'partial', blockers: ['paid_touch_incomplete'] },
      observedAt: '2026-08-21T07:15:00.000Z',
    })

    expect(evidence).toMatchObject({
      tool: 'get_reconciliation',
      sources: ['Meta', 'Outcomes', 'GA4', 'CAPI'],
      // "requested": dateArg proves the string is a date, not that the lookup covered it —
      // resolveClosedDateRange clamps rather than throwing, so stating a bare range was a false
      // provenance claim on the success path.
      dateWindow: 'requested 2026-08-01 to 2026-08-20; actual coverage must come from tool lineage',
      scope: 'campaign 1200',
      observedAt: '2026-08-21T07:15:00.000Z',
      availability: 'partial',
    })
  })

  it('marks nested unavailable or stale evidence partial instead of treating the tool as fully returned', () => {
    const nested = buildGovernedToolEvidence({
      tool: 'get_account_summary',
      args: { start_date: '2026-08-01', end_date: '2026-08-20' },
      result: {
        status: 'available',
        paidReturn: { availability: 'unavailable', blockerCodes: ['paid_manifest_missing'] },
        sourceHealth: { status: 'stale' },
      },
      observedAt: '2026-08-21T07:15:00.000Z',
    })

    expect(nested.availability).toBe('partial')
  })

  it('keeps a truncated tool payload valid JSON and marks it partial', () => {
    const serialized = serializeGovernedToolResult({
      tool: 'get_account_summary',
      args: { start_date: '2026-08-01', end_date: '2026-08-20' },
      result: { rows: ['x'.repeat(1_000)] },
      observedAt: '2026-08-21T07:15:00.000Z',
    }, 500)
    const parsed = JSON.parse(serialized) as Record<string, unknown>

    expect(serialized.length).toBeLessThanOrEqual(500)
    expect(parsed).toMatchObject({
      evidence: { availability: 'partial' },
      data: { truncated: true },
    })
  })

  it('withholds unsupported money and Meta-period claims instead of polishing them', () => {
    const evidence = [buildGovernedToolEvidence({
      tool: 'get_ga4_by_campaign',
      args: { start_date: '2026-08-01', end_date: '2026-08-20' },
      result: { available: true },
      observedAt: '2026-08-21T07:15:00.000Z',
    })]

    for (const unsafe of [
      'GA4 revenue was $8,415 for the selected period.',
      'Exact paid ROAS is 3.2x.',
      'The generic custom conversion alias produced 38 AppointmentConfirmed bookings.',
      'Selected-period reach was 34,852 after summing the daily rows.',
      'Selected-period frequency was 1.58 from the averaged daily frequency.',
      'Reach was 34,852 for August 1 through August 20.',
      'Frequency was 1.58 for the reporting window.',
      'CPA was $56.23 for paid ads.',
    ]) {
      const answer = governMaxxAnswer(unsafe, evidence)
      expect(answer).toMatch(/withheld.*measurement boundary/i)
      expect(answer).not.toContain(unsafe)
    }
  })

  it('adds a deterministic source/date/scope/availability disclosure to safe prose', () => {
    const evidence = [buildGovernedToolEvidence({
      tool: 'get_account_summary',
      args: { start_date: '2026-08-01', end_date: '2026-08-20' },
      result: { status: 'available' },
      observedAt: '2026-08-21T07:15:00.000Z',
    })]
    const answer = governMaxxAnswer(
      'Meta reported 24 modelled AppointmentConfirmed Results for that window.',
      evidence,
    )

    expect(answer).toContain('Source roles')
    expect(answer).toContain('Meta = platform delivery + modelled AppointmentConfirmed Results')
    expect(answer).toContain('Outcomes = real outcome/value truth')
    expect(answer).toContain('GA4 = browser/session telemetry')
    expect(answer).toContain('CAPI = delivery/dedup health')
    expect(answer).toContain('2026-08-01 to 2026-08-20')
    expect(answer).toContain('availability: returned')
    expect(answer).toMatch(/Exact paid CPA\/ROAS: unavailable/i)
  })

  it('keeps correctly qualified daily and unavailable metric statements', () => {
    const evidence = [buildGovernedToolEvidence({
      tool: 'get_account_summary',
      args: { start_date: '2026-08-01', end_date: '2026-08-20' },
      result: { status: 'available' },
      observedAt: '2026-08-21T07:15:00.000Z',
    })]
    const safe = 'Peak daily reach was 2,100; native selected-period reach is unavailable. GA4 event value is not revenue.'
    const answer = governMaxxAnswer(safe, evidence)

    expect(answer).toContain(safe)
    expect(answer).not.toMatch(/withheld.*measurement boundary/i)
  })

  it('withholds an ungrounded numeric answer when no evidence tool returned', () => {
    const answer = governMaxxAnswer('Spend was $1,300.31.', [])
    expect(answer).toMatch(/not enough governed account evidence/i)
    expect(answer).not.toContain('$1,300.31')
  })
})
