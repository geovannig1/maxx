import './_support/outcome-noun-booking'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StoredRecommendation } from '@/lib/recommendations/store'
import type { Adr056LaunchComparison } from '@/lib/launch/adr056-launch-comparison'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('owner-facing metric presentation', () => {
  it('renders source, date, scope, and availability on KPI cards without fabricating zero', async () => {
    const { KpiCard } = await import('@/components/dashboard/KpiCard')
    const html = renderToStaticMarkup(
      <KpiCard
        label="Exact paid CPA"
        value="Unavailable"
        subtitle="No exact appointment-id join yet"
        evidence={{
          source: 'ADR-056 paid cohort',
          date: 'Apr 4–Aug 20, 2026',
          scope: 'Meta paid interaction cohort',
          availability: 'Unavailable',
        }}
      />,
    )

    expect(html).toMatch(/Exact paid CPA/)
    expect(html).toMatch(/Unavailable/)
    expect(html).toMatch(/Source: ADR-056 paid cohort/)
    expect(html).toMatch(/Date: Apr 4–Aug 20, 2026/)
    expect(html).toMatch(/Scope: Meta paid interaction cohort/)
    expect(html).toMatch(/Availability: Unavailable/)
    expect(html).not.toMatch(/\$0\.00|>0</)
  })

  it('keeps recommendations decision-first and shows exact paid money metrics as unavailable', async () => {
    const { RecCard } = await import('@/components/recommendations/RecCard')
    const html = renderToStaticMarkup(
      <RecCard
        rec={{
          id: 'rec_1',
          recommendation_type: 'scale',
          target_entity_type: 'campaign',
          target_entity_id: 'cmp_1',
          target_entity_name: 'Prospecting',
          target_status: 'ACTIVE',
          target_language: null,
          observed_fact: 'Spend is delivering, but paid-outcome authority is not complete.',
          reason_for_action: 'Review the diagnostic pattern before deciding.',
          expected_upside: 'Potentially more qualified traffic.',
          possible_downside: 'Could waste spend if cohort evidence is incomplete.',
          low_data_warning: null,
          estimate_warning: 'Meta outcomes are modelled.',
          attribution_warning: 'Exact appointment-id join is unavailable.',
          what_could_make_this_wrong: ['Acuity/paid cohort linkage may be incomplete.'],
          confidence_score: 0.71,
          confidence_label: 'medium',
          risk_level: 'medium',
          action_authority_tier: 'diagnostic_only',
          evidence_summary: 'Spend and delivery observed; exact paid CPA unavailable.',
          data_sources: ['Meta daily warehouse', 'Acuity ledger', 'ADR-056 cohort pending'],
          date_range_start: '2026-04-04',
          date_range_end: '2026-04-23',
          attribution_confidence: null,
          prior_learning_used: null,
          external_knowledge_used: [],
          minimum_data_needed: 'Complete exact paid cohort and appointment-id join.',
          learning_eligibility: false,
          approval_required: true,
          recommended_next_check_date: '2026-04-25',
          generated_at: '2026-04-24T12:00:00.000Z',
          gate_decision: 'hold',
        } as unknown as StoredRecommendation}
        decision={null}
        history={[]}
      />,
    )

    expect(html).toMatch(/Decision needed/)
    expect(html).toMatch(/Exact paid CPA/)
    expect(html).toMatch(/Exact paid ROAS/)
    expect(html).toMatch(/Unavailable until the exact paid booking join is complete/)
    expect(html).toMatch(/Source: Meta daily warehouse, Acuity ledger, ADR-056 cohort pending/)
    expect(html).toMatch(/Date: 2026-04-04 → 2026-04-23/)
    expect(html).toMatch(/Availability: Diagnostic only/)
    expect(html).not.toMatch(/Exact paid CPA<\/[^>]+><[^>]+>\$0/)
  })
})

describe('performance overview presentation', () => {
  it('fails the overview source read closed instead of returning an empty fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'CAMPAIGNS_READ_UNAVAILABLE',
      error: 'Campaign performance is unavailable.',
    }), { status: 503 })))
    const { readPerformanceJson } = await import('@/components/performance/PerformanceOverview')

    await expect(readPerformanceJson('/api/campaigns?from=2026-04-04&to=2026-04-23'))
      .rejects.toThrow('CAMPAIGNS_READ_UNAVAILABLE')
  })

  it('summarizes drilldown availability without turning missing metrics into zero', async () => {
    const { buildPerformanceOverviewSummary } = await import('@/components/performance/PerformanceOverview')
    const summary = buildPerformanceOverviewSummary({
      campaigns: [
        { campaign_id: 'c1', campaign_name: 'A', status: 'ACTIVE', metrics: { spend: 120, leads: 3, bookings: null } },
        { campaign_id: 'c2', campaign_name: 'B', status: 'PAUSED', metrics: null },
      ],
      adsets: [{ adset_id: 'a1', adset_name: 'A1', status: 'ACTIVE', metrics: { spend: 80, leads: 1, bookings: 0 } }],
      ads: [{ ad_id: 'ad1', ad_name: 'Creative', status: 'ACTIVE', metrics: null }],
      segments: [],
      flags: [{ id: 'f1', flag_type: 'too_early' }],
      tests: { readHealth: 'unavailable', errorCode: 'LEGACY_TEST_HISTORY_UNAVAILABLE' },
    })

    expect(summary.spend.value).toBe(120)
    expect(summary.spend.unmeasured).toBe(1)
    expect(summary).not.toHaveProperty('exactPaidCpa')
    expect(summary).not.toHaveProperty('exactPaidRoas')
    expect(summary.drilldowns.map((d) => d.href)).toEqual([
      '/performance/campaigns',
      '/performance/adsets',
      '/performance/ads',
      '/performance/segments',
      '/performance/flags',
      '/performance/tests',
    ])
  })

  it('does not double-count spend across campaign and ad-set grains', async () => {
    const { buildPerformanceOverviewSummary } = await import('@/components/performance/PerformanceOverview')
    const summary = buildPerformanceOverviewSummary({
      campaigns: [{ campaign_id: 'c1', campaign_name: 'Campaign', status: 'ACTIVE', metrics: { spend: 1300.31 } }],
      adsets: [{ adset_id: 'a1', adset_name: 'Ad set', status: 'ACTIVE', metrics: { spend: 1300.31 } }],
      ads: [],
      segments: [],
      flags: [],
      tests: { readHealth: 'healthy', count: 0 },
    })

    expect(summary.spend.value).toBe(1300.31)
    expect(summary.spend.sourceGrain).toBe('campaign')
  })

  it('renders ADR-056 launch comparison loading and error states without placeholder copy', async () => {
    const { LaunchComparisonSection } = await import('@/components/performance/PerformanceOverview')

    const loadingHtml = renderToStaticMarkup(<LaunchComparisonSection state={{ status: 'loading' }} />)
    expect(loadingHtml).toMatch(/Fresh launch comparison/)
    expect(loadingHtml).toMatch(/Loading ADR-056 comparison/)
    expect(loadingHtml).not.toMatch(/Read service needed|Required props/)

    const errorHtml = renderToStaticMarkup(
      <LaunchComparisonSection state={{ status: 'error', message: 'ADR056_LAUNCH_COMPARISON_UNAVAILABLE' }} />,
    )
    expect(errorHtml).toMatch(/ADR-056 launch comparison unavailable/)
    expect(errorHtml).toMatch(/ADR056_LAUNCH_COMPARISON_UNAVAILABLE/)
    expect(errorHtml).not.toMatch(/\$0\.00/)
  })

  it('does not render zero-valued comparison cards when the governed cohort is unavailable', async () => {
    const { LaunchComparisonSection } = await import('@/components/performance/PerformanceOverview')
    const html = renderToStaticMarkup(
      <LaunchComparisonSection state={{
        status: 'loaded',
        comparison: {
          status: 'unavailable',
          blockers: ['tagged_cohort_count_mismatch'],
          source: {
            system: 'Meta daily warehouse',
            role: 'delivery_and_modelled_attribution',
            lastSyncedAt: null,
          },
        } as Adr056LaunchComparison,
      }} />,
    )

    expect(html).toMatch(/Availability: Unavailable/)
    expect(html).toMatch(/tagged_cohort_count_mismatch/)
    expect(html).toMatch(/No comparison numbers are shown/)
    expect(html).not.toMatch(/\$0|Meta Results<\/p>/)
  })

  it('renders available ADR-056 launch comparison as prior vs tagged with mixed launch day separate', async () => {
    const { LaunchComparisonSection } = await import('@/components/performance/PerformanceOverview')
    const comparison = {
      status: 'available',
      blockers: [],
      missingAccountInsightDates: [],
      source: {
        system: 'Meta daily warehouse',
        role: 'delivery_and_modelled_attribution',
        lastSyncedAt: '2026-04-18T10:00:00.000Z',
      },
      provenance: {
        treatment: {
          basis: 'immutable_meta_ad_ids',
          cohortVersion: 'adr-056-v1',
          metaAdIds: ['meta-new-cold', 'meta-new-warm'],
        },
        audience: { warm: 'ad_name_derived', cold: 'ad_name_derived' },
        window: {
          mode: 'canonical_launch_as_of',
          requested: { from: '2026-04-04', to: '2026-04-17' },
          selectedFromApplied: false,
          selectedToAppliedAsOfDate: true,
        },
      },
      boundary: {
        launchDate: '2026-04-16',
        firstCleanTaggedDate: '2026-04-17',
        launchDateIsMixed: true,
      },
      windows: {
        previous: { from: '2026-04-04', to: '2026-04-15' },
        launchDay: { from: '2026-04-16', to: '2026-04-16' },
        tagged: { from: '2026-04-17', to: '2026-04-17' },
      },
      taggedAds: [
        { databaseId: 'new-cold', metaAdId: 'meta-new-cold', name: 'Cold | Tour (ADR-056 tagged)', creativeId: 'creative-cold', audience: 'cold', effectiveStatus: 'ACTIVE', createdAt: '2026-04-16T09:17:03-04:00', updatedAt: '2026-04-16T10:02:18-04:00' },
        { databaseId: 'new-warm', metaAdId: 'meta-new-warm', name: 'Warm | Tour (ADR-056 tagged)', creativeId: 'creative-warm', audience: 'warm_mixed', effectiveStatus: 'ACTIVE', createdAt: '2026-04-16T09:17:11-04:00', updatedAt: '2026-04-16T10:02:22-04:00' },
      ],
      predecessorAds: [
        { databaseId: 'old-cold', metaAdId: 'meta-old-cold', name: 'Cold | Tour', creativeId: 'creative-cold', audience: 'cold', effectiveStatus: 'PAUSED', createdAt: '2026-03-04T12:00:00-04:00', updatedAt: '2026-04-16T10:02:31-04:00' },
        { databaseId: 'old-warm', metaAdId: 'meta-old-warm', name: 'Warm | Tour', creativeId: 'creative-warm', audience: 'warm_mixed', effectiveStatus: 'PAUSED', createdAt: '2026-02-02T12:00:00-04:00', updatedAt: '2026-04-16T10:02:36-04:00' },
      ],
      previous: {
        warm: { label: 'Warm / mixed audience', metrics: { spend: 22, impressions: 1000, clicks: 20, linkClicks: 10, landingPageViews: 8, metaResults: 2, clickResults: 1, viewResults: 1, attributionSplitAvailable: true, metaCostPerResult: 11, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
        cold: { label: 'Cold audience', metrics: { spend: 25, impressions: 1000, clicks: 30, linkClicks: 12, landingPageViews: 10, metaResults: 0, clickResults: 0, viewResults: 0, attributionSplitAvailable: true, metaCostPerResult: null, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
        combined: { label: 'Combined', metrics: { spend: 47, impressions: 2000, clicks: 50, linkClicks: 22, landingPageViews: 18, metaResults: 2, clickResults: 1, viewResults: 1, attributionSplitAvailable: true, metaCostPerResult: 23.5, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
      },
      tagged: {
        warm: { label: 'Warm / mixed audience', metrics: { spend: 26, impressions: 1200, clicks: 24, linkClicks: 12, landingPageViews: 10, metaResults: 3, clickResults: 1, viewResults: 2, attributionSplitAvailable: true, metaCostPerResult: 8.67, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
        cold: { label: 'Cold audience', metrics: { spend: 23, impressions: 1100, clicks: 32, linkClicks: 14, landingPageViews: 12, metaResults: 0, clickResults: 0, viewResults: 0, attributionSplitAvailable: true, metaCostPerResult: null, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
        combined: { label: 'Combined', metrics: { spend: 49, impressions: 2300, clicks: 56, linkClicks: 26, landingPageViews: 22, metaResults: 3, clickResults: 1, viewResults: 2, attributionSplitAvailable: true, metaCostPerResult: 16.33, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
      },
      launchDay: {
        previous: { label: 'Previous ads on mixed launch day', metrics: { spend: 10, impressions: 300, clicks: 6, linkClicks: 3, landingPageViews: 2, metaResults: 1, clickResults: 0, viewResults: 1, attributionSplitAvailable: true, metaCostPerResult: 10, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
        tagged: { label: 'Tagged ads on mixed launch day', metrics: { spend: 1, impressions: 20, clicks: 1, linkClicks: 1, landingPageViews: 1, metaResults: 0, clickResults: 0, viewResults: 0, attributionSplitAvailable: true, metaCostPerResult: null, nativePeriodReach: null, nativePeriodFrequency: null, appointmentValue: null, exactPaidCpa: null, exactPaidRoas: null } },
      },
    } as Adr056LaunchComparison

    const html = renderToStaticMarkup(<LaunchComparisonSection state={{ status: 'loaded', comparison }} />)

    expect(html).toMatch(/Warm-named \(name-derived; targeting snapshot unavailable\)/)
    expect(html).toMatch(/Cold/)
    expect(html).toMatch(/Prior paused/)
    expect(html).toMatch(/Tagged clean/)
    expect(html).toMatch(/Apr 16 mixed/)
    expect(html).toMatch(/Apr 17 first clean/)
    expect(html).toMatch(/Meta Results/)
    expect(html).toMatch(/modelled 7dc\/1dv/)
    expect(html).toMatch(/Source: Meta daily warehouse/)
    expect(html).toMatch(/Freshness: 2026-04-18T10:00:00.000Z/)
    expect(html).toMatch(/Availability: Available/)
    expect(html).toMatch(/No uplift claim/)
    expect(html).toMatch(/Treatment is the immutable ADR-056 Meta-ID cohort/)
    expect(html).toMatch(/selected start Apr 4 is validated but does not redefine these canonical launch windows/)
    expect(html).not.toMatch(/booking value|ROAS|selected-period reach|frequency/i)
  })
})
