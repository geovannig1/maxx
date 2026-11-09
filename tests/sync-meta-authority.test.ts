import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { MetaInsightRow } from '@/types/meta-api'
import {
  LIFECYCLE_MIN_INSIGHT_DAYS,
  lifecycleWindowIsComplete,
  prepareAccountInsightRows,
} from '@/lib/sync/orchestrator'
import {
  META_OUTCOME_PLANE_POLICY,
  reconcileMetaOutcomeHierarchy,
  validateMetaInsightDeliveryRows,
} from '@/lib/sync/upsert-insights'

/** A plane with nothing wrong with it, under the current policy version. */
const COMPLETE_PLANE = {
  complete: true,
  blockerCodes: [],
  coverageBlockerCodes: [],
  policyVersion: META_OUTCOME_PLANE_POLICY.version,
}

function row(
  date: string,
  overrides: Partial<MetaInsightRow> = {},
): MetaInsightRow {
  return {
    date_start: date,
    date_stop: date,
    spend: '10.25',
    impressions: '100',
    reach: '80',
    clicks: '5',
    actions: [
      { action_type: 'lead', value: '2' },
      { action_type: 'link_click', value: '5' },
      { action_type: 'landing_page_view', value: '4' },
    ],
    results: [{
      indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
      values: [
        { value: '1', attribution_windows: ['default'] },
        { value: '1', attribution_windows: ['7d_click'] },
        { value: '0', attribution_windows: ['1d_view'] },
      ],
    }],
    // The appointment-named measure. This fixture used to carry the bare
    // `offsite_conversion.fb_pixel_custom` aggregate instead, on the belief that the aggregate IS the
    // booking value. Real payloads refute that — see the aggregate test below — so the aggregate
    // is no longer a value source and a fixture built on it would assert a defect.
    action_values: [{
      action_type: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
      value: '300',
    }],
    ...overrides,
  }
}

describe('Meta lifecycle window authority', () => {
  it('requires at least 30 complete days ending on the canonical last-complete day', () => {
    expect(LIFECYCLE_MIN_INSIGHT_DAYS).toBe(30)
    expect(lifecycleWindowIsComplete('2026-07-17', '2026-08-15', '2026-08-15')).toBe(true)
    expect(lifecycleWindowIsComplete('2026-07-19', '2026-08-15', '2026-08-15')).toBe(false)
    expect(lifecycleWindowIsComplete('2026-07-16', '2026-08-14', '2026-08-15')).toBe(false)
  })
})

describe('Meta delivery ingestion authority', () => {
  it('does not reinterpret a wholly empty account response as zero delivery', () => {
    expect(() => prepareAccountInsightRows([], '2026-08-13', '2026-08-15'))
      .toThrow(/no authoritative account-level row/i)
  })

  it('synthesizes explicit current-response zero rows for sparse account dates', () => {
    const prepared = prepareAccountInsightRows(
      [row('2026-08-13'), row('2026-08-15')],
      '2026-08-13',
      '2026-08-15',
    )

    expect(prepared).toHaveLength(3)
    expect(prepared[1]).toMatchObject({
      date_start: '2026-08-14',
      date_stop: '2026-08-14',
      spend: '0',
      impressions: '0',
      reach: '0',
      clicks: '0',
    })
    expect(prepared[1].actions).toBeUndefined()
    expect(prepared[1].results).toBeUndefined()
    expect(prepared[1].action_values).toBeUndefined()
  })

  it.each([
    ['missing spend', { spend: undefined }],
    ['malformed spend', { spend: 'not-a-number' }],
    ['negative impressions', { impressions: '-1' }],
    ['fractional clicks', { clicks: '1.5' }],
    ['missing reach', { reach: undefined }],
  ])('rejects %s instead of coercing it to zero', (_label, malformed) => {
    expect(() => validateMetaInsightDeliveryRows(
      'account',
      [row('2026-08-15', malformed)],
      '2026-08-15',
      '2026-08-15',
    )).toThrow(/required delivery/i)
  })
})

describe('Meta outcome hierarchy authority', () => {
  const withIds = (
    level: 'campaign' | 'adset' | 'ad',
    overrides: Partial<MetaInsightRow> = {},
  ) => row('2026-08-15', {
    campaign_id: 'campaign-1',
    ...(level === 'adset' || level === 'ad' ? { adset_id: 'adset-1' } : {}),
    ...(level === 'ad' ? { ad_id: 'ad-1' } : {}),
    ...overrides,
  })

  it('accepts a complete campaign-authoritative plane reconciled through ad set and ad', () => {
    expect(reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign')],
      adset: [withIds('adset')],
      ad: [withIds('ad')],
      since: '2026-08-15',
      until: '2026-08-15',
    })).toEqual(COMPLETE_PLANE)
  })

  // Regression: `valueMatched` tested `specificValue.value > 0`, using "positive" as a stand-in for
  // "Meta supplied this measure". A booking Meta priced at 0.00 — a comped session, a package
  // redemption, a gift certificate, a meaningful share of appointments — was therefore recorded as
  // meta_outcome_*_value_unavailable, which made the outcome plane incomplete, which froze flags and
  // recommendations for the entire account. Zero is a reported value.
  it('accepts a booking Meta reports with a value of exactly zero', () => {
    const zeroValued = {
      action_values: [{
        action_type: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
        value: '0',
      }],
    }
    expect(reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', zeroValued)],
      adset: [withIds('adset', zeroValued)],
      ad: [withIds('ad', zeroValued)],
      since: '2026-08-15',
      until: '2026-08-15',
    })).toEqual(COMPLETE_PLANE)
  })

  // Purchase is a different Meta outcome family. Even if AppointmentConfirmed was triggered near a
  // purchase, purchase action_value is not an AppointmentConfirmed result value and cannot back booking ROAS.
  // Synthetic alias family: four aliases carrying the same amount plus one near-zero straggler.
  const PURCHASE_ALIASES_218 = [
    { action_type: 'purchase', value: '218.75' },
    { action_type: 'omni_purchase', value: '218.75' },
    { action_type: 'web_in_store_purchase', value: '0.12' },
    { action_type: 'onsite_web_purchase', value: '218.75' },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '218.75' },
  ]

  it('records purchase-only value as unavailable AppointmentConfirmed value', () => {
    const purchaseOnly = { action_values: PURCHASE_ALIASES_218 }
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', purchaseOnly)],
      adset: [withIds('adset', purchaseOnly)],
      ad: [withIds('ad', purchaseOnly)],
      since: '2026-08-15',
      until: '2026-08-15',
    })
    expect(result.complete).toBe(true)
    expect(result.coverageBlockerCodes).toEqual(expect.arrayContaining([
      'meta_outcome_campaign_value_unavailable:2026-08-15',
      'meta_outcome_adset_value_unavailable:2026-08-15',
      'meta_outcome_ad_value_unavailable:2026-08-15',
    ]))
  })

  it('does not create cross-level AppointmentConfirmed value mismatches from purchase aliases', () => {
    const campaignRow = withIds('campaign', { action_values: PURCHASE_ALIASES_218 })
    const summed = withIds('adset', {
      action_values: [{ action_type: 'purchase', value: '875.12' }],
    })
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [campaignRow],
      adset: [summed],
      ad: [withIds('ad', { action_values: PURCHASE_ALIASES_218 })],
      since: '2026-08-15',
      until: '2026-08-15',
    })
    expect(result.complete).toBe(true)
    expect(result.blockerCodes.some((c) => c.includes('value_mismatch'))).toBe(false)
    expect(result.coverageBlockerCodes.some((c) => c.includes('value_unavailable'))).toBe(true)
  })

  // POLICY v1 (ADR: meta-value-does-not-gate-decisions, accepted 2026-08-19). This test previously
  // asserted that an omitted value measure makes the plane incomplete, which froze flags and
  // recommendations account-wide. Meta-reported value carries no money authority anywhere in this
  // system — the grounding gate scores leaning on it a hard `fail` — so its ABSENCE cannot be a
  // precondition for making a count-based decision. It is still raised, still recorded, still rendered.
  it('records an omitted value measure as coverage, and does NOT freeze decisions on it', () => {
    const noValueArray = { action_values: undefined }
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', noValueArray)],
      adset: [withIds('adset', noValueArray)],
      ad: [withIds('ad', noValueArray)],
      since: '2026-08-15',
      until: '2026-08-15',
    })
    expect(result.complete).toBe(true)
    expect(result.blockerCodes).toEqual([])
    expect(result.coverageBlockerCodes.some((c) => c.includes('value_unavailable'))).toBe(true)
    expect(result.policyVersion).toBe(META_OUTCOME_PLANE_POLICY.version)
  })

  // The other half of the split, and the reason it is a split rather than a downgrade: a broken or
  // self-inconsistent response still freezes everything, because it taints the counts too.
  it('still freezes on integrity blockers — absence is downgraded, incoherence is not', () => {
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign')],
      adset: [withIds('adset', {
        action_values: [{
          action_type: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          value: '500',
        }],
      })],
      ad: [withIds('ad')],
      since: '2026-08-15',
      until: '2026-08-15',
    })
    expect(result.complete).toBe(false)
    expect(result.blockerCodes).toContain('meta_outcome_adset_value_mismatch:2026-08-15')
    expect(result.coverageBlockerCodes).toEqual([])
  })

  it('derives click-through bookings when Meta supplies total plus only the view window', () => {
    const values = [
      { value: '1', attribution_windows: ['default'] },
      { value: '0', attribution_windows: ['1d_view'] },
    ]
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', { results: [{ indicator: 'AppointmentConfirmed', values }] })],
      adset: [withIds('adset', { results: [{ indicator: 'AppointmentConfirmed', values }] })],
      ad: [withIds('ad', { results: [{ indicator: 'AppointmentConfirmed', values }] })],
      since: '2026-08-15',
      until: '2026-08-15',
    })

    expect(result).toEqual(COMPLETE_PLANE)
  })

  it('keeps the outcome-dependent alert detector behind the current-run outcome gate', () => {
    const source = fs.readFileSync('src/lib/sync/orchestrator.ts', 'utf8')
    expect(source).toMatch(
      /if \(lifecycleRun && insightLevelsComplete && metaOutcomePlane\.complete\) \{[\s\S]{0,300}runAlertDetection\(/,
    )
  })

  // PAYLOAD SHAPE (as Meta returns it, reduced):
  // on a day with no AppointmentConfirmed results Meta returns the indicator with the `values` key
  // OMITTED — [{"indicator":"conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed"}].
  // That is a supplied outcome plane reporting zero, and it is what findAppointmentConfirmedResults
  // (`r?.values ?? []`) has always read it as. Treating it as a malformed payload fired
  // meta_outcome_<level>_payload_invalid on every zero-booking date.
  const ZERO_RESULT_INDICATOR = {
    indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
  }

  it('reads Meta zero-result indicators with no values key as an explicit zero', () => {
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', { results: [ZERO_RESULT_INDICATOR] })],
      adset: [withIds('adset', { results: [ZERO_RESULT_INDICATOR] })],
      ad: [withIds('ad', { results: [ZERO_RESULT_INDICATOR] })],
      since: '2026-08-15',
      until: '2026-08-15',
    })

    expect(result).toEqual(COMPLETE_PLANE)
  })

  it('still fail-stops when Meta supplies a results values field that is not a list', () => {
    const malformed = {
      indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
      values: 'not-a-list',
    } as unknown as NonNullable<MetaInsightRow['results']>[number]
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', { results: [malformed] })],
      adset: [withIds('adset', { results: [malformed] })],
      ad: [withIds('ad', { results: [malformed] })],
      since: '2026-08-15',
      until: '2026-08-15',
    })

    expect(result.complete).toBe(false)
    expect(result.blockerCodes).toContain('meta_outcome_campaign_payload_invalid:2026-08-15')
  })

  it('marks missing campaign AppointmentConfirmed results unavailable rather than zero', () => {
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', { results: undefined })],
      adset: [withIds('adset')],
      ad: [withIds('ad')],
      since: '2026-08-15',
      until: '2026-08-15',
    })

    expect(result.complete).toBe(false)
    expect(result.blockerCodes).toContain('meta_outcome_campaign_appointment_results_unavailable')
  })

  it('marks result omission unavailable independently at campaign, ad set, and ad levels', () => {
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', { results: undefined })],
      adset: [withIds('adset', { results: undefined })],
      ad: [withIds('ad', { results: undefined })],
      since: '2026-08-15',
      until: '2026-08-15',
    })

    expect(result.complete).toBe(false)
    expect(result.blockerCodes).toEqual(expect.arrayContaining([
      'meta_outcome_campaign_appointment_results_unavailable:2026-08-15',
      'meta_outcome_adset_appointment_results_unavailable:2026-08-15',
      'meta_outcome_ad_appointment_results_unavailable:2026-08-15',
    ]))
  })

  it('blocks every mismatched normalized outcome plane below campaign authority', () => {
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign')],
      adset: [withIds('adset', {
        actions: [{ action_type: 'lead', value: '1' }],
        results: [{
          indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          values: [
            { value: '2', attribution_windows: ['default'] },
            { value: '0', attribution_windows: ['7d_click'] },
            { value: '2', attribution_windows: ['1d_view'] },
          ],
        }],
        action_values: [{
          action_type: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
          value: '500',
        }],
      })],
      ad: [withIds('ad')],
      since: '2026-08-15',
      until: '2026-08-15',
    })

    expect(result.complete).toBe(false)
    expect(result.blockerCodes).toEqual(expect.arrayContaining([
      'meta_outcome_adset_leads_mismatch:2026-08-15',
      'meta_outcome_adset_bookings_mismatch:2026-08-15',
      'meta_outcome_adset_value_mismatch:2026-08-15',
      'meta_outcome_adset_click_bookings_mismatch:2026-08-15',
      'meta_outcome_adset_view_bookings_mismatch:2026-08-15',
    ]))
  })

  // THE FREEZE, at the gate. An ad that carried only the bare `offsite_conversion.fb_pixel_custom`
  // aggregate, read as booking value, pushed the ad-level total above its campaign's and raised
  // meta_outcome_ad_value_mismatch, which froze flags and recommendations account-wide.
  //
  // The aggregate is not the booking value. Rows that carry BOTH the aggregate and the purchase
  // family routinely disagree on the figure. The aggregate sums
  // every custom pixel event on a different attribution basis.
  it('does not read the fb_pixel_custom aggregate as booking value', () => {
    const aggregateOnly = {
      action_values: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '145' }],
    }
    const result = reconcileMetaOutcomeHierarchy({
      campaign: [withIds('campaign', aggregateOnly)],
      adset: [withIds('adset', aggregateOnly)],
      ad: [withIds('ad', aggregateOnly)],
      since: '2026-08-15',
      until: '2026-08-15',
    })

    // Recorded as an absent measure, never as $145 of booking value — and never as a mismatch.
    expect(result.coverageBlockerCodes).toContain('meta_outcome_campaign_value_unavailable:2026-08-15')
    expect(result.blockerCodes.some((c) => c.includes('value_mismatch'))).toBe(false)
  })
})
