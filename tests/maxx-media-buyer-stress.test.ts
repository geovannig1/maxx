import { describe, expect, it } from 'vitest'
import {
  buildLaunchPerformance,
  type AdsetDiagnosticInput,
} from '@/lib/diagnostics/launch-performance'

const day = (date: string, spend: number) => ({ date, spend })
const postEditDays = [
  day('2026-03-24', 21.40),
  day('2026-03-25', 21.40),
  day('2026-03-26', 21.40),
  day('2026-03-27', 21.40),
  day('2026-03-28', 21.40),
  day('2026-03-29', 21.40),
  day('2026-03-30', 21.40),
  day('2026-03-31', 21.40),
  day('2026-04-01', 21.40),
  day('2026-04-02', 21.40),
  day('2026-04-03', 21.40),
  day('2026-04-04', 21.40),
]

function adset(overrides: Partial<AdsetDiagnosticInput> = {}): AdsetDiagnosticInput {
  return {
    name: 'Fake Cold Broad | Advantage+ | $26',
    optimizationEvent: 'AppointmentConfirmed',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    learningStage: 'FAIL',
    learningConversions: 2,
    lastSigEditTs: '2026-03-24T00:00:00.000Z',
    targeting: {
      geo_locations: {
        custom_locations: [{ latitude: 39.7392, longitude: -104.9903, radius: 15, distance_unit: 'mile' }],
        location_types: ['home', 'recent'],
      },
      targeting_automation: { advantage_audience: 1, individual_setting: { geo: 0, age: 1, gender: 1 } },
      flexible_spec: [{ interests: [{ id: '6000000000001', name: 'Photographer' }] }],
    },
    targetingSyncedAt: '2026-04-04T10:00:00.000Z',
    targetingRelaxation: null,
    deliverySubStatus: { read_available: false, payload: null, synced_at: null },
    mauBounds: null,
    dailyBudget: 26,
    dataWindowStart: '2026-03-06',
    days: postEditDays,
    spend: 612.30,
    impressions: 26_700,
    reach: 12_900,
    clicks: 731,
    linkClicks: 284,
    bookings: 2,
    ...overrides,
  }
}

describe('Maxx fake media-buyer stress tests', () => {
  it('grades the current two-adset shape as structurally starved, not a wait-it-out setup', () => {
    const cold = adset()
    const warm = adset({
      name: 'Fake Warm Engagers | Retargeting | $31',
      dailyBudget: 31,
      learningConversions: 7,
      spend: 694.80,
      impressions: 30_400,
      reach: 11_700,
      clicks: 655,
      linkClicks: 301,
      bookings: 7,
      days: postEditDays.map((point) => ({ ...point, spend: 26.10 })),
    })

    const diagnosis = buildLaunchPerformance({
      today: '2026-04-05',
      window: { from: '2026-03-06', to: '2026-04-04' },
      budgetControl: 'adset',
      adsets: [cold, warm],
      eventVolume: { available: false, reason: 'rate supplied by GA4', datasetId: null, windowDays: 28, events: [] },
      conversionEventPerWeek: 8.4,
      writeModeEnabled: false,
    })

    expect(diagnosis.verdict).toBe('structurally_starved')
    expect(diagnosis.optimization_signal).toMatchObject({
      available: true,
      event: 'AppointmentConfirmed',
      needPerWeek: 100,
      verdict: 'structurally_starved',
    })
    expect(diagnosis.adsets_detail.map((a) => a.learning_exit_feasibility.reachable_at_current_budget))
      .toEqual([false, false])
    expect(diagnosis.adsets_detail[0]?.learning_exit_feasibility.required_daily_budget_for_exit)
      .toBeGreaterThan(800)
    expect(diagnosis.prescriptions).toEqual([])
    expect(diagnosis.action_authority.tier).toBe('diagnostic_only')
  })

  it('does not grade an optimization event as right or wrong without CampaignPlan authority', () => {
    const diagnosis = buildLaunchPerformance({
      today: '2026-04-05',
      window: { from: '2026-03-06', to: '2026-04-04' },
      budgetControl: 'adset',
      adsets: [adset({ optimizationEvent: null, promotedObject: undefined } as Partial<AdsetDiagnosticInput>)],
      eventVolume: { available: true, reason: null, datasetId: 'pixel-1', windowDays: 28, events: [] },
      writeModeEnabled: false,
    })

    expect(diagnosis.optimization_signal).toMatchObject({
      available: false,
      reason_code: 'optimization_event_unresolved',
    })
    expect(diagnosis.optimization_compatibility).toMatchObject({
      status: 'unknown',
      reason_code: 'optimization_event_unresolved',
    })
    expect(diagnosis.prescriptions).toEqual([])
  })

  it('can recognize a fake setup with enough signal as healthy while still withholding actions', () => {
    const diagnosis = buildLaunchPerformance({
      today: '2026-04-05',
      window: { from: '2026-03-06', to: '2026-04-04' },
      budgetControl: 'campaign',
      adsets: [adset({
        name: 'Fake Consolidated Booking Campaign',
        learningStage: 'SUCCESS',
        learningConversions: 61,
        dailyBudget: 300,
        spend: 1_740,
        impressions: 71_300,
        reach: 42_600,
        clicks: 2_090,
        linkClicks: 1_015,
        bookings: 61,
      })],
      eventVolume: { available: false, reason: 'rate supplied by GA4', datasetId: null, windowDays: 28, events: [] },
      conversionEventPerWeek: 72,
      writeModeEnabled: false,
    })

    expect(diagnosis.verdict).toBe('healthy')
    expect(diagnosis.optimization_signal).toMatchObject({
      available: true,
      actualPerWeek: 72,
      needPerWeek: 50,
    })
    expect(diagnosis.learning.any_exited).toBe(true)
    expect(diagnosis.optimization_compatibility.reason_code).toBe('campaign_plan_not_evaluated')
    expect(diagnosis.prescriptions).toEqual([])
  })
})
