import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildUserMessage, SYSTEM_PROMPT, type ReportInputData } from '@/lib/report/prompt-builder'

const reportInput: ReportInputData = {
  date: '2026-07-30',
  accountName: 'Example Studio',
  currency: 'USD',
  accountInsights: {
    spend: 80,
    leads: 0,
    bookings: 1,
    impressions: 1_000,
    reach: 800,
    clicks: 20,
    ctr: 2,
    cpm: 80,
    cpl: null,
    cpb: 80,
    appointmentValue: null,
    roas: null,
  },
  prevDayInsights: null,
  prev7dayInsights: null,
  topCampaigns: [],
  alerts: [],
}

describe('report context governance', () => {
  it('states that CampaignPlan and business/page context are unavailable instead of inventing them', () => {
    expect(SYSTEM_PROMPT).toMatch(/CampaignPlan.*UNAVAILABLE/i)
    expect(SYSTEM_PROMPT).toMatch(/business\/page context.*UNAVAILABLE/i)
    expect(SYSTEM_PROMPT).toMatch(/live configuration.*observation.*not.*approval/i)
  })

  it('does not prescribe fixed economics, conversion settings, geography, or audience funnels', () => {
    // The labels of a hardcoded business profile, whatever values they would carry.
    expect(SYSTEM_PROMPT).not.toMatch(/Location:\*\*|Average booking value:\*\*|Primary conversion event:\*\*|Target CPA:\*\*|Monthly revenue goal:\*\*/i)
    expect(SYSTEM_PROMPT).not.toMatch(/\b\d+\s?(?:km|mi|miles?)\s+radius/i)
    expect(SYSTEM_PROMPT).not.toMatch(/## Two Audiences|Audience 1: Professionals|Audience 2: Consumers/)
    expect(SYSTEM_PROMPT).not.toMatch(/Funnel: cold (?:interest|broad\/lookalike)/)
    expect(SYSTEM_PROMPT).not.toMatch(/## Professional Audience Performance|## Consumer Audience Performance/)
    expect(SYSTEM_PROMPT).not.toMatch(/Frequency thresholds:\*\*/i)
    expect(SYSTEM_PROMPT).not.toMatch(/Low CTR \(<0\.5%\).*is a creative problem/i)
    expect(SYSTEM_PROMPT).toMatch(/frequency is a raw delivery observation/i)
    expect(SYSTEM_PROMPT).toMatch(/CTR is an auction and delivery observation/i)
  })

  it('keeps the assembled user message observational rather than classifying campaigns from names', () => {
    const message = buildUserMessage(reportInput)
    expect(message).not.toMatch(/^TARGET CPA:/m)
    expect(message).not.toMatch(/^AVERAGE BOOKING VALUE:/m)
    expect(message).not.toMatch(/Classify each campaign.*professional-audience.*consumer-audience/i)
    expect(message).not.toMatch(/no consumer campaigns.*setup gap/i)
    expect(message).not.toMatch(/AppointmentConfirmed \(bookings\)/)
    expect(message).not.toMatch(/set conversion value/i)
    expect(message).toMatch(/CampaignPlan.*not provided/i)
  })
})

describe('dashboard pre-launch checks', () => {
  it('blocks context-free setup choices until an approved CampaignPlan exists', () => {
    const source = readFileSync(
      new URL('../src/components/dashboard/dashboard-data.ts', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('const nextChecks: string[]')
    const end = source.indexOf('// Trust in the displayed PAID figure', start)
    const nextChecks = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(nextChecks).toMatch(/approved CampaignPlan/i)
    expect(nextChecks).toMatch(/business\/page context/i)
    expect(nextChecks).not.toMatch(/Launch with the proven event/)
    expect(nextChecks).not.toMatch(/AppointmentConfirmed/)
    expect(nextChecks).not.toMatch(/Landing Page Views/)
    expect(nextChecks).not.toMatch(/corrected UTM string/)
  })
})
