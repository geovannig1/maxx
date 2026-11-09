import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'

import {
  buildWeeklyExecutiveDigest,
  isWeeklyExecutiveDigestV1,
  readWeeklyExecutiveDigest,
} from '@/lib/report/weekly-executive'
import {
  WEEKLY_REPORT_ID,
  WEEK_END,
  WEEK_START,
  weeklyExecutiveEvidenceFixture,
} from './fixtures/weekly-executive'

describe('weekly executive digest', () => {
  it('deterministically renders week, prior-week, and 8-week context from one committed snapshot', () => {
    const first = buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })
    const second = buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })

    expect(second).toEqual(first)
    expect(first.subject).toBe(`Maxx weekly executive read — ${WEEK_START}–${WEEK_END}`)
    expect(first.context.current_week).toContain('18')
    expect(first.context.current_week).toContain('$5,400.00')
    expect(first.context.current_week).toContain('amount paid on currently active bookings')
    expect(first.context.current_week).not.toMatch(/refund|cancell/i)
    expect(first.context.prior_week).toContain('15')
    expect(first.context.eight_week).toContain('8 observed week')
    expect(first.text).toContain('Outcome business totals')
    expect(first.text).toContain('Meta modelled attribution')
    expect(first.text).toContain('They are different populations')
  })

  it('includes every required setup and measurement section without minting action authority', () => {
    const digest = buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })

    expect(Object.keys(digest.sections)).toEqual([
      'setup', 'audiences', 'placements', 'creative', 'tracking', 'material_changes',
    ])
    expect(digest.sections.setup.join(' ')).toContain('OUTCOME_SALES')
    expect(digest.sections.audiences.join(' ')).toContain('Website visitors 180d')
    expect(digest.sections.audiences.join(' ')).toContain('Springfield lookalike 1%')
    expect(digest.sections.audiences.join(' ')).toContain('Cold/Warm Meta source')
    expect(digest.sections.audiences.join(' ')).toContain('click/view/unknown')
    expect(digest.sections.placements.join(' ')).toContain('Advantage+ placements')
    expect(digest.sections.placements.join(' ')).toContain('instagram_reels')
    expect(digest.sections.creative.join(' ')).toContain('Warm proof carousel')
    expect(digest.sections.tracking.join(' ')).toContain('maturity_lag_not_met')
    expect(digest.sections.material_changes.join(' ')).toContain('Cold daily budget changed')
    expect(digest.action_authority_tier).toBe('diagnostic_only')
    expect(digest.prescriptions).toEqual([])
    expect(digest.text).toContain('Diagnostic only — this email creates no action authority')
    expect(digest.text).not.toMatch(/\b(?:increase|decrease|move|pause|launch)\s+(?:the\s+)?budget\b/i)
  })

  it('fails closed when the committed snapshot does not cover the exact completed week', () => {
    expect(() => buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: '2026-08-04',
      weekEnd: WEEK_END,
    })).toThrow(/exact completed week/i)
  })

  it('renders unavailable evidence explicitly instead of converting source failure into zero', () => {
    const unavailable = structuredClone(weeklyExecutiveEvidenceFixture)
    unavailable.outcomes = null
    unavailable.meta = null
    unavailable.metaColdWarm = null
    unavailable.metaPlacements = null
    unavailable.setupChanges = null
    unavailable.sources.outcomes = {
      availability: 'unavailable', head: null, blockerCodes: ['outcome_read_failed'],
    }
    unavailable.sources.meta = {
      availability: 'unavailable', head: null, blockerCodes: ['meta_read_failed'],
    }
    unavailable.sources.metaColdWarm = {
      availability: 'unavailable', head: null, blockerCodes: ['cold_warm_read_failed'],
    }
    unavailable.sources.metaPlacements = {
      availability: 'unavailable', head: null, blockerCodes: ['placement_read_failed'],
    }
    unavailable.sources.setupChanges = {
      availability: 'unavailable', head: null, blockerCodes: ['setup_read_failed'],
    }

    const digest = buildWeeklyExecutiveDigest(unavailable, {
      weeklyReportId: WEEKLY_REPORT_ID, weekStart: WEEK_START, weekEnd: WEEK_END,
    })

    expect(digest.context.current_week).toContain('unavailable')
    expect(digest.context.current_week).not.toContain('$0.00')
    expect(digest.context.eight_week).toContain('8-week context unavailable')
    expect(digest.context.eight_week).not.toContain('$0.00')
    expect(digest.sections.audiences.join(' ')).toContain('no segment-performance zero')
    expect(digest.sections.placements.join(' ')).toContain('no placement-performance zero')
    expect(digest.action_authority_tier).toBe('diagnostic_only')
  })

  it('retains Meta delivery while rendering incomplete outcome-plane facts as unavailable', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    const incompletePlane = {
      status: 'incomplete' as const,
      blockerCodes: ['campaign_adset_outcome_reconciliation_failed'],
      sourceNotBefore: '2026-08-16T14:30:00.000Z',
      checkedLevels: ['campaign' as const, 'adset' as const, 'ad' as const],
    }
    const nullOutcomes = <T extends {
      leads: number | null
      modeledBookings: number | null
      modeledBookingValue?: number | null
      modeledClickBookings?: number | null
      modeledViewBookings?: number | null
      modeledUnknownBookings?: number | null
    }>(item: T) => ({
      ...item,
      leads: null,
      modeledBookings: null,
      modeledBookingValue: null,
      modeledClickBookings: null,
      modeledViewBookings: null,
      modeledUnknownBookings: null,
      outcomePlane: incompletePlane,
    })

    evidence.sources.meta = {
      availability: 'partial',
      head: '2026-08-16T14:31:00.000Z',
      blockerCodes: ['meta_outcome_plane_incomplete:trailing7'],
    }
    evidence.sources.metaColdWarm = {
      availability: 'partial',
      head: '2026-08-16T14:31:00.000Z',
      blockerCodes: ['meta_outcome_plane_incomplete:cold_warm'],
    }
    evidence.sources.metaPlacements = {
      availability: 'partial',
      head: '2026-08-16T14:31:00.000Z',
      blockerCodes: ['meta_outcome_plane_incomplete:placements'],
    }
    evidence.meta!.byWindow.trailing7 = nullOutcomes(evidence.meta!.byWindow.trailing7!)
    evidence.meta!.byWindow.prior7 = nullOutcomes(evidence.meta!.byWindow.prior7!)
    evidence.metaColdWarm!.comparisonStatus = 'blocked'
    evidence.metaColdWarm!.blockerCodes = ['meta_outcome_plane_incomplete:cold_warm']
    evidence.metaColdWarm!.units = evidence.metaColdWarm!.units.map((unit) => nullOutcomes(unit))
    evidence.metaPlacements!.blockerCodes = ['meta_outcome_plane_incomplete:placements']
    evidence.metaPlacements!.rows = evidence.metaPlacements!.rows.map((row) => ({
      ...row,
      leads: null,
      modeledBookings: null,
      outcomePlane: incompletePlane,
    }))

    const digest = buildWeeklyExecutiveDigest(evidence, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })

    expect(digest.context.current_week).toContain('$371.00 spend')
    expect(digest.context.current_week).toContain('modelled outcomes unavailable')
    expect(digest.sections.audiences.join(' ')).toContain('outcomes unavailable')
    expect(digest.sections.placements.join(' ')).toContain('outcomes unavailable')
    expect(digest.text).not.toContain('0 Meta-modelled bookings')
    expect(digest.text).not.toContain('0 leads')
  })

  it('withholds the 8-week total when either source has partial week coverage', () => {
    const partial = structuredClone(weeklyExecutiveEvidenceFixture)
    partial.meta!.weeklyTrend8 = partial.meta!.weeklyTrend8.slice(1)

    const digest = buildWeeklyExecutiveDigest(partial, {
      weeklyReportId: WEEKLY_REPORT_ID, weekStart: WEEK_START, weekEnd: WEEK_END,
    })

    expect(digest.context.eight_week).toContain('Meta coverage 7/8 weeks')
    expect(digest.context.eight_week).toContain('no missing period is converted to zero')
    expect(digest.context.eight_week).not.toMatch(/Meta spend: \$0\.00/)
  })

  it('withholds the 8-week total when source week boundaries do not align', () => {
    const misaligned = structuredClone(weeklyExecutiveEvidenceFixture)
    misaligned.meta!.weeklyTrend8[0].windowStart = '2026-06-17'

    const digest = buildWeeklyExecutiveDigest(misaligned, {
      weeklyReportId: WEEKLY_REPORT_ID, weekStart: WEEK_START, weekEnd: WEEK_END,
    })

    expect(digest.context.eight_week).toContain('week boundaries do not align')
    expect(digest.context.eight_week).not.toContain('8 observed weeks')
  })

  it('never presents a preserved destination or its UTM state as current after the read failed', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    const wrapper = evidence.setupChanges!.active_ad_wrappers[0]
    wrapper.landing_destination = {
      url: 'https://stale.example/old?utm_campaign=stale',
      source: 'ad_destination_url',
      url_tags: 'utm_campaign=stale',
      utm_status: 'present',
      ad_level_read_available: false,
      ad_level_synced_at: null,
    }

    const digest = buildWeeklyExecutiveDigest(evidence, {
      weeklyReportId: WEEKLY_REPORT_ID, weekStart: WEEK_START, weekEnd: WEEK_END,
    })
    const creative = digest.sections.creative.join(' ')
    const affectedWrapper = digest.sections.creative.find((line) => line.includes('Cold studio reel')) ?? ''

    expect(creative).toContain('current destination and UTM unavailable')
    expect(affectedWrapper).not.toContain('destination UTM present')
    expect(creative).not.toContain('stale.example')
  })

  it('reports media diversity as unavailable when creative identity is incomplete', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    evidence.setupChanges!.creative_reuse.distinct_active_media = null

    const digest = buildWeeklyExecutiveDigest(evidence, {
      weeklyReportId: WEEKLY_REPORT_ID, weekStart: WEEK_START, weekEnd: WEEK_END,
    })

    expect(digest.sections.creative.join(' ')).toContain('distinct media unavailable')
    expect(digest.sections.creative.join(' ')).not.toMatch(/\b\d+ distinct media\b/)
  })

  it('round-trips only the strict v1 diagnostic contract', () => {
    const digest = buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })
    const stored = JSON.parse(JSON.stringify(digest)) as Record<string, unknown>

    expect(isWeeklyExecutiveDigestV1(digest)).toBe(true)
    expect(readWeeklyExecutiveDigest(stored)).toEqual(digest)
    expect(readWeeklyExecutiveDigest({ ...stored, action_authority_tier: 'owner_review' })).toBeNull()
    expect(readWeeklyExecutiveDigest({ ...stored, prescriptions: ['raise spend'] })).toBeNull()
    expect(readWeeklyExecutiveDigest({ ...stored, contract_version: 2 })).toBeNull()
  })
})
