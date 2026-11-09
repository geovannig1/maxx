import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OwnerDiagnosticsPanel } from '@/components/diagnostics/OwnerDiagnosticsPanel'
import type { OwnerDiagnostics } from '@/lib/diagnostics/owner-surface'
import { paidCreativeOutcomesFixture } from './diagnostics/owner-paid-outcomes-fixture'

const snapshot: OwnerDiagnostics = {
  action_authority_tier: 'diagnostic_only',
  prescriptions: [],
  window: { from: '2026-07-01', to: '2026-07-30' },
  delivery: {
    available: true,
    data: {
      verdict: 'still_learning',
      headline: 'Learning is still constrained.',
      read: 'The observed ad sets have not exited learning.',
      window_settle: {
        state: 'settled',
        unsettled_days: 0,
        settled_through: '2026-07-30',
        includes_today: false,
        detail: 'The reporting window is settled.',
      },
      adsets_detail: [{
        name: 'Cold',
        learning_phase: 'LEARNING_LIMITED',
        learning_conversions: 3,
        results_to_exit: 47,
        last_sig_edit: '2026-07-29T10:00:00Z',
        narrow_audience: { narrow: false, basis: 'Advantage audience observed.' },
        budget_constrained: { flag: true, max_day_overshoot_pct: 108, median_day_pct: 99 },
        learning_exit_feasibility: {
          cost_per_optimization_event: null,
          events_per_week_at_current_budget: null,
          required_daily_budget_for_exit: null,
          reachable_at_current_budget: null,
          basis: 'Window coverage is incomplete.',
        },
        cause_hints: ['Low optimization-event volume was observed.'],
        delivery_sub_status: {
          read_available: true,
          payload: {
            status: 'warning',
            substatuses: ['budget_limited_learning_fail'],
          },
          synced_at: '2026-08-01T20:00:00.000Z',
        },
      }],
      structure: {
        spend_concentration: {
          total_spend: 120,
          top: { name: 'Cold', spend: 90, share: 0.75 },
          effective_entities: 1.6,
          budget_control: 'campaign',
          detail: 'Spend was concentrated by campaign-budget delivery.',
          action_authority: 'diagnostic_only',
          prescriptions: [],
        },
      },
    },
  },
  creative: {
    available: true,
    data: {
      total: 1,
      prescriptions: [],
      note: 'Descriptive evidence only.',
      observations: [{
        ad_id: 'meta-ad-1',
        ad_name: 'Video A',
        status: 'ACTIVE',
        delivery_sub_status: {
          read_available: true,
          payload: {
            status: 'warning',
            substatuses: ['creative_fatigue'],
          },
          synced_at: '2026-08-01T20:00:00.000Z',
        },
        metrics: {
          spend: 40,
          leads: 2,
          bookings: 1,
          impressions: 1_000,
          reach: 800,
          clicks: 20,
          unique_clicks: 0,
          link_clicks: 0,
          landing_page_views: 0,
          video_views: 100,
          thruplays: 25,
          p25: 50,
          p50: 30,
          p75: 20,
          p100: 10,
          appointment_value: null,
          ctr: 2,
          cpc: 2,
          cpm: 40,
          cpl: 20,
          cpa: 40,
          frequency: 1.25,
          hook_rate: 10,
          hold_rate: null,
          thruplay_rate: 2.5,
          retention_p25_rate: 50,
          retention_p50_rate: 30,
          retention_p75_rate: 20,
          completion_rate: 10,
          retention_denominator: 'video_starts',
          video_start_coverage: 'complete',
          early_view_source: 'video_play_actions',
          derived_metric_warning_count: 0,
          avg_play_time: null,
          roas: null,
        },
        diagnostic: {
          authority: 'diagnostic_only',
          state: 'evidence_available',
          label: 'Delivery evidence',
          reason: 'Meta delivery and attention evidence is available.',
          prescriptions: [],
          signals: [
            { label: 'Frequency', state: 'observed', detail: '1.25 average Meta frequency over 30 day(s).' },
            { label: '25% retention', state: 'observed', detail: '50.0% of measured video starts reached one quarter of video length.' },
          ],
        },
      }],
    },
  },
  creative_paid_outcomes: {
    available: true,
    data: paidCreativeOutcomesFixture,
  },
  creative_paid_attribute_distributions: {
    available: true,
    data: {
      status: 'available',
      evaluation_run_id: '10000000-0000-4000-8000-000000000001',
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      non_additive: true,
      note: 'Descriptive, non-additive governed paid-outcome distributions. Totals across attributes must not be summed.',
      recent_scale: {
        status: 'available',
        generation_id: '20000000-0000-4000-8000-000000000001',
        cohort_kind: 'recent_scale',
        window_start: '2026-07-01',
        window_end: '2026-07-14',
        as_of_date: '2026-07-30',
        contract_version: 1,
        policy_version: 1,
        missing_versioned_vision_count: 0,
        blocker_codes: [],
        groups: [{
          attribute: 'format',
          value: 'video',
          creative_count: 1,
          sparse: true,
          contributing_meta_creative_ids: ['987654322'],
          outcomes: {
            spend: 42.25,
            captured_touches: 7,
            value_bearing_bookings: 3,
            booked_value: 375,
          },
          lineage: {
            generation_id: '20000000-0000-4000-8000-000000000001',
            vision_analysis_version_ids: ['70000000-0000-4000-8000-000000000001'],
            source_asset_fingerprints: [`sha256:${'a'.repeat(64)}`],
          },
        }],
      },
      matured_cut: {
        status: 'blocked',
        generation_id: '20000000-0000-4000-8000-000000000002',
        cohort_kind: 'matured_cut',
        window_start: '2026-06-17',
        window_end: '2026-06-30',
        as_of_date: '2026-07-30',
        contract_version: 1,
        policy_version: 1,
        missing_versioned_vision_count: 0,
        blocker_codes: ['paid_capture_incomplete'],
        groups: [],
      },
    },
  },
}

describe('OwnerDiagnosticsPanel', () => {
  it('renders delivery and creative observations without inventing an action', () => {
    const html = renderToStaticMarkup(<OwnerDiagnosticsPanel diagnostics={snapshot} />)

    expect(html).toContain('Learning is still constrained.')
    expect(html).toContain('47 results to exit')
    expect(html).toContain('Spend was concentrated by campaign-budget delivery.')
    expect(html).toContain('50.0% of measured video starts')
    expect(html).toContain('Meta delivery sub-status: warning')
    expect(html).toContain('budget_limited_learning_fail')
    expect(html).toContain('creative_fatigue')
    expect(html).toContain('Paid creative outcomes')
    expect(html).toContain('Recent paid cohort')
    expect(html).toContain('Matured paid cohort')
    expect(html).toContain('Source: governed last-paid-touch')
    expect(html).toContain('Status: available')
    expect(html).toContain('2026-07-01–2026-07-14')
    expect(html).toContain('Video A')
    expect(html).toContain('Meta creative 987654322')
    expect(html).toContain('2 contributing ads')
    expect(html).toContain('$42.25 spend')
    expect(html).toContain('7 captured touches')
    expect(html).toContain('3 value-bearing bookings')
    expect(html).toContain('$375.00 booked value')
    expect(html).toContain('1 zero-value booking')
    expect(html).toContain('2 canceled links')
    expect(html).toContain('associated via governed last-paid-touch')
    expect(html).toContain('Paid outcomes by versioned vision attribute')
    expect(html).toContain('format: video')
    expect(html).toContain('Non-additive')
    expect(html.indexOf('Paid creative outcomes')).toBeGreaterThan(
      html.indexOf('Creative delivery observations'),
    )
    expect(html).toContain('Diagnostic only')
    expect(html).not.toMatch(/\b(winner|loser|scale|cut|pause|production direction)\b/i)
  })

  it('renders each failed section as unavailable without hiding the other diagnostic shell', () => {
    const diagnostics: OwnerDiagnostics = {
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      window: { from: '2026-07-01', to: '2026-07-30' },
      delivery: { available: false, reason: 'delivery source offline' },
      creative: { available: false, reason: 'creative source offline' },
      creative_paid_outcomes: { available: false, reason: 'paid source offline' },
      creative_paid_attribute_distributions: { available: false, reason: 'vision source offline' },
    }

    const html = renderToStaticMarkup(<OwnerDiagnosticsPanel diagnostics={diagnostics} />)

    expect(html).toContain('Delivery &amp; learning')
    expect(html).toContain('Creative delivery observations')
    expect(html).toContain('Paid creative outcomes')
    expect(html).toContain('Unavailable — delivery source offline')
    expect(html).toContain('Unavailable — creative source offline')
    expect(html).toContain('Read unavailable — paid source offline')
    expect(html).toContain('Read unavailable — vision source offline')
  })

  it('shows blockers without inventing zero outcomes for a blocked direction', () => {
    const diagnostics = structuredClone(snapshot)
    diagnostics.creative_paid_attribute_distributions = {
      available: false,
      reason: 'not in scope',
    }
    if (!diagnostics.creative_paid_outcomes.available) throw new Error('fixture')
    const paid = diagnostics.creative_paid_outcomes.data
    paid.status = 'blocked'
    if (!paid.recent_scale || !paid.matured_cut) throw new Error('fixture')
    paid.recent_scale = {
      ...paid.recent_scale,
      status: 'blocked',
      blocker_codes: ['activation_missing'],
      creatives: [],
    }
    paid.matured_cut = {
      ...paid.matured_cut,
      status: 'blocked',
      blocker_codes: ['assignment_history_missing'],
      creatives: [],
    }

    const html = renderToStaticMarkup(<OwnerDiagnosticsPanel diagnostics={diagnostics} />)

    expect(html).toContain('Blocked — Paid measurement was never switched on')
    expect(html).toContain('Blocked — No record of which creative this ad was running')
    // The internal identifiers must not reach the owner's screen at all.
    expect(html).not.toContain('activation_missing')
    expect(html).not.toContain('assignment_history_missing')
    expect(html).not.toContain('$0.00')
    expect(html).not.toContain('0 captured touches')
    expect(html).not.toContain('0 value-bearing bookings')
    expect(html).not.toMatch(/\b(winner|loser|scale|cut|pause|production direction)\b/i)
  })

  it('labels partial governed evidence beside available attribute totals', () => {
    const diagnostics = structuredClone(snapshot)
    if (!diagnostics.creative_paid_attribute_distributions.available) throw new Error('fixture')
    const recent = diagnostics.creative_paid_attribute_distributions.data.recent_scale
    if (!recent) throw new Error('fixture')
    recent.blocker_codes = ['paid_unit_metric_unavailable']

    const html = renderToStaticMarkup(<OwnerDiagnosticsPanel diagnostics={diagnostics} />)

    expect(html).toContain('Partial governed evidence — A required per-ad figure is unavailable')
    expect(html).not.toContain('paid_unit_metric_unavailable')
    expect(html).toContain('affected creatives are omitted from numeric groups')
    expect(html).toContain('$375.00 booked value')
  })

  it('shows blocked creative identity and ad counts without numeric outcomes or direction', () => {
    const diagnostics = structuredClone(snapshot)
    diagnostics.delivery = { available: false, reason: 'not in scope' }
    diagnostics.creative = { available: false, reason: 'not in scope' }
    diagnostics.creative_paid_attribute_distributions = {
      available: false,
      reason: 'not in scope',
    }
    if (!diagnostics.creative_paid_outcomes.available) throw new Error('fixture')
    const paid = diagnostics.creative_paid_outcomes.data
    paid.status = 'blocked'
    if (!paid.recent_scale) throw new Error('fixture')
    const availableCreative = paid.recent_scale.creatives[0]
    paid.recent_scale = {
      ...paid.recent_scale,
      status: 'blocked',
      blocker_codes: ['activation_missing'],
      creatives: [
        {
          ...availableCreative,
          status: 'blocked',
          complete: false,
          creative_name: 'Blocked Video',
          blocker_codes: ['paid_unit_metric_unavailable'],
          outcomes: null,
        },
        {
          ...availableCreative,
          status: 'blocked',
          complete: false,
          meta_creative_id: '987654399',
          creative_name: null,
          contributing_meta_ad_ids: ['123456799'],
          blocker_codes: ['source_stale'],
          outcomes: null,
        },
      ],
    }
    paid.matured_cut = null

    const html = renderToStaticMarkup(<OwnerDiagnosticsPanel diagnostics={diagnostics} />)

    expect(html).toContain('Blocked — Paid measurement was never switched on; a required per-ad figure is unavailable; source stale')
    expect(html).toContain('Blocked Video')
    expect(html).toContain('Meta creative 987654399')
    expect(html).toContain('2 contributing ads')
    expect(html).toContain('1 contributing ad')
    expect(html).toContain('Blocked — A required per-ad figure is unavailable')
    expect(html).toContain('Blocked — Source stale')
    expect(html).not.toContain('$42.25 spend')
    expect(html).not.toContain('7 captured touches')
    expect(html).not.toContain('3 value-bearing bookings')
    expect(html).not.toContain('$375.00 booked value')
    expect(html).not.toContain('1 zero-value booking')
    expect(html).not.toContain('2 canceled links')
    expect(html).not.toContain('$0.00')
    expect(html).not.toContain('0 captured touches')
    expect(html).not.toContain('0 value-bearing bookings')
    expect(html).not.toMatch(/\b(winner|loser|rank|scale|cut|pause|production direction)\b/i)
  })

  it('distinguishes a not-published artifact from a read-unavailable section', () => {
    const notPublished = structuredClone(snapshot)
    if (!notPublished.creative_paid_outcomes.available) throw new Error('fixture')
    notPublished.creative_paid_outcomes.data = {
      status: 'not_published',
      evaluation_run_id: null,
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      note: paidCreativeOutcomesFixture.note,
      recent_scale: null,
      matured_cut: null,
    }
    const readUnavailable: OwnerDiagnostics = {
      ...snapshot,
      creative_paid_outcomes: { available: false, reason: 'paid cohort source offline' },
    }

    const notPublishedHtml = renderToStaticMarkup(
      <OwnerDiagnosticsPanel diagnostics={notPublished} />,
    )
    const readUnavailableHtml = renderToStaticMarkup(
      <OwnerDiagnosticsPanel diagnostics={readUnavailable} />,
    )

    expect(notPublishedHtml).toContain('Status: not published')
    expect(notPublishedHtml).not.toContain('Read unavailable')
    expect(readUnavailableHtml).toContain('Read unavailable — paid cohort source offline')
    expect(readUnavailableHtml).not.toContain('Status: not published')
  })

  it('renders a successful no-substatus read explicitly at both entity levels', () => {
    const diagnostics = structuredClone(snapshot)
    if (!diagnostics.delivery.available || !diagnostics.creative.available) throw new Error('fixture')
    diagnostics.delivery.data.adsets_detail[0].delivery_sub_status = {
      read_available: true,
      payload: null,
      synced_at: '2026-08-01T20:01:00.000Z',
    }
    diagnostics.creative.data.observations[0].delivery_sub_status = {
      read_available: true,
      payload: null,
      synced_at: '2026-08-01T20:01:00.000Z',
    }

    const html = renderToStaticMarkup(<OwnerDiagnosticsPanel diagnostics={diagnostics} />)

    expect(html.match(/Meta reported no delivery sub-status/g)).toHaveLength(2)
  })

  it('renders unavailable delivery sub-status explicitly at both entity levels', () => {
    const diagnostics = structuredClone(snapshot)
    if (!diagnostics.delivery.available || !diagnostics.creative.available) throw new Error('fixture')
    diagnostics.delivery.data.adsets_detail[0].delivery_sub_status = {
      read_available: false,
      payload: null,
      synced_at: null,
    }
    diagnostics.creative.data.observations[0].delivery_sub_status = {
      read_available: false,
      payload: null,
      synced_at: null,
    }

    const html = renderToStaticMarkup(<OwnerDiagnosticsPanel diagnostics={diagnostics} />)

    expect(html.match(/Meta delivery sub-status unavailable/g)).toHaveLength(2)
  })
})
