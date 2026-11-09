import './_support/outcome-noun-booking'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectWrongOptimizationEvent } from '@/lib/alerts/detector'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'
import { SYSTEM_PROMPT } from '@/lib/report/prompt-builder'

// Until an immutable, account-scoped CampaignPlan repository exists, Maxx cannot classify a synced
// performance goal as correct or wrong for the business outcome. This pins the interim fail-closed
// behavior and prevents the former booking-only doctrine from returning through owner-facing alerts.

describe('optimization compatibility requires an approved CampaignPlan', () => {
  it('does not manufacture wrong-event alerts without plan lineage', async () => {
    await expect(detectWrongOptimizationEvent('account-1', '2026-07-30')).resolves.toBe(0)
  })

  it('removes the universal booking classifier and imperative switch copy', () => {
    const manifest = readFileSync('src/lib/recommendations/manifest.ts', 'utf8')
    const detector = readFileSync('src/lib/alerts/detector.ts', 'utf8')
    const production = `${manifest}\n${detector}`

    expect(production).not.toContain('PROXY_OPTIMIZATION_GOALS')
    expect(production).not.toContain('classifyOptimizationGoal')
    expect(production).not.toContain("Switch the ad set's optimization event")
    expect(production).not.toContain('The proven event is AppointmentConfirmed')
  })

  it('keeps legacy alerts diagnostic instead of issuing pause or budget-allocation commands', () => {
    const detector = readFileSync('src/lib/alerts/detector.ts', 'utf8')
    for (const forbidden of [
      'Pause the fatigued ad immediately',
      'pause and test a new angle',
      'pause and replace',
      'Pause it now',
      'Pause this ad immediately',
      'pause it',
      'Pause or Replace Creative',
      'shifting budget',
    ]) {
      expect(detector, forbidden).not.toContain(forbidden)
    }
  })
})

describe('owner growth objective', () => {
  it('optimizes paid bookings and amount paid on active appointments without a capacity ceiling', () => {
    for (const contract of [MAXX_INSTRUCTIONS, SYSTEM_PROMPT]) {
      expect(contract).toMatch(/maximize monthly.*booking.*amount paid on active bookings/i)
      expect(contract).toMatch(/amountPaid|amount_paid/i)
      expect(contract).toMatch(/no capacity ceiling|capacity.*not.*ceiling/i)
      expect(contract).toMatch(/variable costs.*profit.*not.*growth/i)
    }
  })

  it('separates existing-customer reporting without assuming acquisition exclusion', () => {
    expect(MAXX_INSTRUCTIONS).toMatch(/existing customers.*separate.*reporting/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/exclude.*only.*CampaignPlan/i)
  })

  it('never promises that every ad will win', () => {
    expect(MAXX_INSTRUCTIONS).toMatch(/cannot guarantee.*every ad/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/controlled test/i)
  })
})
