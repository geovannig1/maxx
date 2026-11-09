import { describe, it, expect } from 'vitest'
import {
  buildLaunchPerformance,
  resolveObservedOptimizationEvent,
  type AdsetDiagnosticInput,
  type LaunchPerformanceBuildInput,
} from '@/lib/diagnostics/launch-performance'
import type { DatasetStatsResult } from '@/lib/platforms/meta/fetch-dataset-stats'
import { containsUngovernedActionLanguage } from '@/lib/authority/diagnostic-surface'

const days = (spends: [string, number][]) => spends.map(([date, spend]) => ({ date, spend }))

// Example Studio launch: 2 conversion ad sets, first spend Mar 9, "today" Mar 12 → 4 days in.
function exampleAdsets(stage: string): AdsetDiagnosticInput[] {
  const base = {
    optimizationEvent: 'AppointmentConfirmed',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    learningStage: stage,
    learningConversions: null as number | null,
    lastSigEditTs: null as string | null,
    targeting: null as Record<string, unknown> | null,
    dailyBudget: 33,
    days: days([['2026-03-09', 11], ['2026-03-10', 29], ['2026-03-11', 34], ['2026-03-12', 19]]),
    spend: 93, impressions: 3810, reach: 2960, clicks: 118, linkClicks: 47, bookings: 0,
  }
  return [
    {
      ...base,
      id: 'cold-meta-id',
      name: 'Cold Broad | Advantage+ | $33 (7-day)',
      learningConversions: 0,
      targeting: { geo_locations: { custom_locations: [{ radius: 18 }] }, targeting_automation: { advantage_audience: 1 } },
    },
    {
      ...base,
      id: 'warm-meta-id',
      name: 'Warm Engagers | Retargeting | $57 (7-day)',
      dailyBudget: 57, spend: 251, impressions: 12380, reach: 8870, clicks: 291, linkClicks: 118, bookings: 1,
      learningConversions: 2,
      lastSigEditTs: '2026-03-09T00:00:00Z',
      targeting: { custom_audiences: [{ id: '238' }] },
      mauBounds: { lower: 171_000, upper: 204_000 },
    },
  ]
}

const volume = (events: { event: string; perWeek: number }[]): DatasetStatsResult => ({
  available: true, reason: null, datasetId: '179', windowDays: 28,
  events: events.map((e) => ({ event: e.event, count: Math.round(e.perWeek * 4), perWeek: e.perWeek })),
})

function actionShapedStrings(value: unknown): string[] {
  const strings: string[] = []
  const visit = (item: unknown): void => {
    if (typeof item === 'string') strings.push(item)
    else if (Array.isArray(item)) item.forEach(visit)
    else if (item && typeof item === 'object') Object.values(item).forEach(visit)
  }
  visit(value)
  return strings.filter(containsUngovernedActionLanguage)
}

// AppointmentConfirmed ~6/wk (structurally starved); a site-specific custom click event ~31/wk.
// Schedule + Purchase fire at parity with the custom outcome event (standard-event parity).
const exampleVolume = volume([
  { event: 'PageView', perWeek: 700 },
  { event: 'Quote Request_Click', perWeek: 31 },
  { event: 'InitiateCheckout', perWeek: 15 },
  { event: 'Schedule', perWeek: 6 },
  { event: 'Purchase', perWeek: 6 },
  { event: 'AppointmentConfirmed', perWeek: 6 },
])

describe('buildLaunchPerformance — Example Studio structural case', () => {
  // conversionEventPerWeek is the VERIFIED GA4 rate (~6/wk) — the authoritative source, preferred over pixel stats.
  const input: LaunchPerformanceBuildInput = {
    today: '2026-03-12',
    window: { from: '2026-03-06', to: '2026-03-12' },
    budgetControl: 'adset',
    adsets: exampleAdsets('LEARNING'),
    eventVolume: exampleVolume,
    conversionEventPerWeek: 6,
    writeModeEnabled: false,
  }
  const d = buildLaunchPerformance(input)

  it('verdict is structurally_starved (event too rare to ever exit learning), rate from GA4', () => {
    expect(d.verdict).toBe('structurally_starved')
    expect(d.optimization_signal.available).toBe(true)
    if (d.optimization_signal.available) {
      expect(d.optimization_signal.source).toBe('ga4')
      expect(d.optimization_signal.verdict).toBe('structurally_starved')
      expect(Math.round(d.optimization_signal.actualPerWeek)).toBe(6)
      expect(d.optimization_signal.needPerWeek).toBe(100) // 50 × 2 ad sets
    }
  })

  it('reports the TRUE launch (4 days from first spend Mar 9) and that results are not yet judgeable', () => {
    expect(d.launch.first_spend_date).toBe('2026-03-09')
    expect(d.launch.days_delivering).toBe(4)
    expect(d.launch.in_learning_window).toBe(true)
    expect(d.launch.results_judgeable).toBe(false)
  })

  it('labels the requested reporting window as provisional', () => {
    expect(d.window_settle).toMatchObject({
      state: 'settling',
      includes_today: true,
      unsettled_days: 7,
    })
    expect(d.window_settle?.detail).toMatch(/provisional/i)
  })

  it('bands front-end delivery as healthy (CTR ~3%, CPC efficient) — the problem is not the creative', () => {
    expect(d.delivery_health.healthy).toBe(true)
    const ctr = d.delivery_health.metrics.find((m) => m.key === 'ctr')
    expect(ctr?.status === 'excellent' || ctr?.status === 'healthy').toBe(true)
  })

  it('emits diagnostic observations only — no objective/event/budget/page prescription bypasses authority', () => {
    expect(d.prescriptions).toEqual([])
    expect(d.action_authority).toEqual({
      tier: 'diagnostic_only',
      reason_code: 'diagnostic_observations_only',
    })
    expect(d.observations.length).toBeGreaterThan(0)
    expect(d.observations.every((o) => o.action_authority_tier === 'diagnostic_only')).toBe(true)

    expect(actionShapedStrings(d)).toEqual([])
    expect(d.conversions).toEqual({
      meta_modelled_bookings: 1,
      meta_modelled_cost_per_result: 344,
      evidence_plane: 'meta_modelled',
    })
    expect(d.conversions).not.toHaveProperty('bookings')
    expect(d.funnel).not.toHaveProperty('bookings')
  })

  it('read separates DATA from INFERENCE and says it is too early on results', () => {
    expect(d.read).toMatch(/too early/i)
    expect(d.read).toMatch(/INFERENCE/)
  })

  // ── champion + profit-first + structure (steelman fixes) ──
  it('keeps the modelled champion comparison diagnostic instead of turning it into a hold/scale disposition', () => {
    expect(d.champion_comparison.verdict).toBe('unproven') // 1 booking — never a confident verdict
    expect(d.champion_comparison.detail).toMatch(/historical platform-modelled comparison/i)
    expect(d).not.toHaveProperty('learning_limited_acceptable')
    expect(d.read).toMatch(/diagnostic observation/i)
  })

  it('does not infer business compatibility from the observed event without an approved CampaignPlan', () => {
    expect(d.optimization_compatibility).toEqual({
      status: 'unknown',
      reason_code: 'campaign_plan_not_evaluated',
      observed_goals: ['OFFSITE_CONVERSIONS'],
      observed_events: ['AppointmentConfirmed'],
      reason: expect.stringMatching(/CampaignPlan/i),
    })
  })

  it('Purchase appears in the site-wide event ladder (parity visibility)', () => {
    expect(d.funnel.site_wide_event_ladder.some((e) => e.event === 'Purchase')).toBe(true)
  })

  it('the ladder carries standard events and the optimized event, never a site-specific custom event', () => {
    const ladder = d.funnel.site_wide_event_ladder.map((e) => e.event)
    expect(ladder).toEqual(['PageView', 'InitiateCheckout', 'Schedule', 'Purchase', 'AppointmentConfirmed'])
    expect(ladder).not.toContain('Quote Request_Click')
  })

  // With no targeting snapshot timestamp in this fixture, composition resolves to UNKNOWN
  // (frozen), so a retargeting SHARE cannot be asserted. Previously the ad set NAME alone produced a
  // confident "73% warm" — a claim about inventory that had never been established.
  it('structure checks: an unresolved audience composition refuses to assert a warm share', () => {
    expect(d.structure.retargeting_share.band).toBe('no_data')
    expect(d.structure.retargeting_share.share).toBeNull()
    expect(d.structure.retargeting_share.detail).toMatch(/mixed or unresolved/)
    expect(d.structure.auction_overlap.risk).toBe('possible')
    expect(d.structure.auction_overlap.label).toBe('ASSUMPTION')
    expect(d.structure.spend_concentration).toMatchObject({
      budget_control: 'adset',
      total_spend: 344,
      effective_entities: 1.65,
    })
    expect(d.structure.spend_concentration.top?.name).toMatch(/Warm/)
  })

  it('freezes material conclusions when selected lookalike health is failed', () => {
    const adsets = exampleAdsets('LEARNING').map((adset) => ({
      ...adset,
      targetingSyncedAt: '2026-03-12T12:00:00Z',
      targeting: /Warm/.test(adset.name)
        ? {
            custom_audiences: [{ id: 'website-180' }, { id: 'lal-1' }],
            targeting_automation: { advantage_audience: 1 },
          }
        : adset.targeting,
    }))
    const result = buildLaunchPerformance({
      ...input,
      metaAccountId: '100000000000777',
      audiencesById: {
        'website-180': {
          id: 'website-180', name: 'Website Visitors 180 Days', subtype: 'WEBSITE',
          accountId: '100000000000777', retentionDays: 180,
          operationStatus: { code: 200 }, deliveryStatus: { code: 200 },
          lastSyncedAt: '2026-03-12T12:00:00Z',
        },
        'lal-1': {
          id: 'lal-1', name: 'Website 1% Lookalike', subtype: 'LOOKALIKE',
          accountId: '100000000000777', sourceAudienceId: 'website-180',
          approximateCountLowerBound: -1, approximateCountUpperBound: -1,
          operationStatus: { code: 433, description: 'Could not create lookalike' },
          deliveryStatus: { code: 300 }, lastSyncedAt: '2026-03-12T12:00:00Z',
        },
      },
      adsets,
    })

    const warm = result.audiences.find((row) => /Warm/.test(row.adset_name))!
    // A lookalike Meta could not build is a HEALTH finding about a known configuration, not an
    // unknown configuration. Composition resolves; the failure is named.
    expect(warm.resolution).toMatchObject({ composition: 'mixed', frozen: false })
    expect(warm.resolution.unhealthyIncludedAudienceIds).toEqual(['lal-1'])
    expect(warm.resolution.audienceHealthFindings.join(' ')).toMatch(/operation status 433/i)
    expect(warm.resolution.evidence.join(' ')).toMatch(/operation status 433/i)
    // Share stays unavailable: MIXED inventory cannot be split into a retargeting share either.
    expect(result.structure.retargeting_share.share).toBeNull()
  })

  // ── Diagnosis-parity: the per-ad-set narration layer Meta's chat leads with ──
  it('adsets_detail narrates the Warm learning counter: 2 counted, 48 to exit, with reset context', () => {
    expect(d.adsets_detail).toHaveLength(2)
    const warm = d.adsets_detail.find((s) => /Warm/.test(s.name))!
    expect(warm.learning_conversions).toBe(2)
    expect(warm.results_to_exit).toBe(48)
    expect(warm.last_sig_edit).toBe('2026-03-09T00:00:00Z')
    expect(warm.narrow_audience.narrow).toBe(true) // custom-audience retargeting pool (inference)
    expect(warm.narrow_audience.mau_bounds?.label).toMatch(/NOT Ads Manager/)
  })

  it('adsets_detail keeps the audiences separate: Cold is broad/expanded, not averaged with Warm', () => {
    const cold = d.adsets_detail.find((s) => /Cold/.test(s.name))!
    expect(cold.narrow_audience.narrow).toBe(false)
    expect(cold.learning_conversions).toBe(0)
    expect(cold.results_to_exit).toBe(50)
  })

  it('preserves exact Meta ad-set ids through delivery and audience diagnosis', () => {
    expect(d.adsets_detail.map((adset) => adset.id)).toEqual(['cold-meta-id', 'warm-meta-id'])
    expect(d.audiences.map((audience) => audience.adset_id)).toEqual(['cold-meta-id', 'warm-meta-id'])
  })
})

describe('buildLaunchPerformance — other branches', () => {
  it('healthy when signal is sufficient and an ad set has exited learning', () => {
    const richVolume = volume([{ event: 'AppointmentConfirmed', perWeek: 120 }])
    const d = buildLaunchPerformance({ today: '2026-03-12', adsets: exampleAdsets('SUCCESS'), eventVolume: richVolume, writeModeEnabled: false })
    expect(d.verdict).toBe('healthy')
    expect(d.learning.any_exited).toBe(true)
    expect(d.prescriptions).toEqual([])
  })

  it('falls back to the pixel-stats rate (labeled a floor) when GA4 rate is absent', () => {
    const d = buildLaunchPerformance({ today: '2026-03-12', adsets: exampleAdsets('LEARNING'), eventVolume: exampleVolume, writeModeEnabled: false })
    expect(d.optimization_signal.available).toBe(true)
    if (d.optimization_signal.available) expect(d.optimization_signal.source).toBe('pixel_stats')
    expect(d.verdict).toBe('structurally_starved') // robust to source
    expect(d.caveats.some((c) => /floor/i.test(c))).toBe(true)
  })

  it('too_early with no delivery', () => {
    const d = buildLaunchPerformance({ today: '2026-03-12', adsets: [], eventVolume: exampleVolume, writeModeEnabled: false })
    expect(d.verdict).toBe('too_early')
    expect(d.launch.first_spend_date).toBeNull()
  })

  it('falls back to still_learning + a caveat when site-wide volume is UNVERIFIED', () => {
    const noVolume: DatasetStatsResult = { available: false, reason: 'pixel unreachable', datasetId: null, windowDays: 28, events: [] }
    const d = buildLaunchPerformance({ today: '2026-03-12', adsets: exampleAdsets('LEARNING'), eventVolume: noVolume, writeModeEnabled: false })
    expect(d.optimization_signal.available).toBe(false)
    expect(d.verdict).toBe('still_learning')
    expect(d.caveats.some((c) => /UNVERIFIED/.test(c))).toBe(true)
  })

  it('does not translate OFFSITE_CONVERSIONS into AppointmentConfirmed when the promoted event is unresolved', () => {
    const adsets = exampleAdsets('LEARNING').map((a) => ({ ...a, optimizationEvent: null }))
    const d = buildLaunchPerformance({
      today: '2026-03-12',
      adsets,
      eventVolume: exampleVolume,
      conversionEventPerWeek: 6,
      writeModeEnabled: false,
    })

    expect(d.optimization_compatibility.status).toBe('unknown')
    expect(d.optimization_compatibility.reason_code).toBe('optimization_event_unresolved')
    expect(d.optimization_compatibility.observed_events).toEqual([])
    expect(d.optimization_signal.available).toBe(false)
    expect(d.optimization_signal.event).toBeNull()
    if (!d.optimization_signal.available) {
      expect(d.optimization_signal.reason_code).toBe('optimization_event_unresolved')
    }
    expect(JSON.stringify(d)).not.toMatch(/\"event\":\"AppointmentConfirmed\"/)
  })

  it('keeps every verdict branch free of ungoverned action language', () => {
    const unavailable: DatasetStatsResult = {
      available: false,
      reason: 'unavailable',
      datasetId: null,
      windowDays: 28,
      events: [],
    }
    const cases = [
      buildLaunchPerformance({ today: '2026-03-12', adsets: [], eventVolume: unavailable, writeModeEnabled: false }),
      buildLaunchPerformance({ today: '2026-03-12', adsets: exampleAdsets('LEARNING'), eventVolume: unavailable, writeModeEnabled: false }),
      buildLaunchPerformance({ today: '2026-03-12', adsets: exampleAdsets('SUCCESS'), eventVolume: volume([{ event: 'AppointmentConfirmed', perWeek: 120 }]), writeModeEnabled: false }),
      buildLaunchPerformance({
        today: '2026-03-12',
        adsets: exampleAdsets('LEARNING').map((a, i) => ({
          ...a,
          optimizationEvent: i === 0 ? 'AppointmentConfirmed' : 'Purchase',
        })),
        eventVolume: exampleVolume,
        writeModeEnabled: false,
      }),
    ]

    for (const diagnosis of cases) {
      expect(diagnosis.prescriptions).toEqual([])
      expect(actionShapedStrings(diagnosis), diagnosis.verdict).toEqual([])
    }
  })
})

describe('resolveObservedOptimizationEvent', () => {
  it('requires promoted_object evidence for an offsite-conversion goal', () => {
    expect(resolveObservedOptimizationEvent('OFFSITE_CONVERSIONS', null)).toBeNull()
    expect(resolveObservedOptimizationEvent('OFFSITE_CONVERSIONS', { custom_event_type: 'OTHER' })).toBeNull()
    expect(resolveObservedOptimizationEvent(
      'OFFSITE_CONVERSIONS',
      { custom_event_type: 'OTHER', custom_event_str: 'AppointmentConfirmed' },
    )).toBe('AppointmentConfirmed')
  })

  it('reports a directly observed non-conversion goal without converting it to a booking event', () => {
    expect(resolveObservedOptimizationEvent('LANDING_PAGE_VIEWS', null)).toBe('LANDING_PAGE_VIEWS')
  })
})

// money in the launch diagnostic is rounded at the account currency's minor unit (KWD: fils).
describe('buildLaunchPerformance — money at the account currency scale', () => {
  const adsets = () => exampleAdsets('LEARNING').map((a, i) => ({ ...a, spend: a.spend + (i === 0 ? 0.0004 : 0.0012) }))
  const run = (currency: string) => {
    const saved = process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
    process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = currency
    try {
      return buildLaunchPerformance({ today: '2026-03-12', adsets: adsets(), eventVolume: exampleVolume, writeModeEnabled: false })
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
      else process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = saved
    }
  }

  it('KWD keeps fils in spend; USD control rounds to cents', () => {
    expect(run('KWD').delivery_health.spend).toBe(344.002)
    expect(run('USD').delivery_health.spend).toBe(344)
  })
})
