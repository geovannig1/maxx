import { describe, expect, it } from 'vitest'
import {
  buildOwnerDiagnostics,
  readOwnerDiagnosticsSnapshot,
  type OwnerCreativeDiagnostics,
  type OwnerDeliveryDiagnostics,
} from '@/lib/diagnostics/owner-surface'
import { paidCreativeOutcomesFixture } from './owner-paid-outcomes-fixture'

const unavailableCoreSections = {
  action_authority_tier: 'diagnostic_only',
  prescriptions: [],
  window: { from: '2026-07-01', to: '2026-07-30' },
  delivery: { available: false, reason: 'not captured' },
  creative: { available: false, reason: 'not captured' },
} as const

const availableCreative: OwnerCreativeDiagnostics = {
  observations: [],
  total: 0,
  note: 'Descriptive Meta delivery evidence only.',
  prescriptions: [],
}

const availableDelivery: OwnerDeliveryDiagnostics = {
  verdict: 'still_learning',
  headline: 'Delivery evidence is available.',
  read: 'The account is still learning.',
  window_settle: null,
  adsets_detail: [],
  structure: {
    spend_concentration: {
      total_spend: 0,
      top: null,
      effective_entities: 0,
      budget_control: 'unknown' as const,
      detail: 'No spend concentration was observed.',
      action_authority: 'diagnostic_only' as const,
      prescriptions: [] as [],
    },
  },
}

describe('buildOwnerDiagnostics', () => {
  it('keeps the existing owner planes when versioned attribute distributions fail', async () => {
    const result = await buildOwnerDiagnostics(
      {
        adAccountDbId: 'account-1',
        window: { from: '2026-07-01', to: '2026-07-30' },
      },
      {
        readDelivery: async () => availableDelivery,
        readCreative: async () => availableCreative,
        readCreativePaidOutcomes: async () => paidCreativeOutcomesFixture,
        readCreativePaidAttributeDistributions: async () => {
          throw new Error('versioned vision read offline')
        },
      },
    )

    expect(result.delivery.available).toBe(true)
    expect(result.creative.available).toBe(true)
    expect(result.creative_paid_outcomes.available).toBe(true)
    expect(result.creative_paid_attribute_distributions).toEqual({
      available: false,
      reason: 'versioned vision read offline',
    })
  })

  it('keeps delivery available when the independent creative read fails', async () => {
    const result = await buildOwnerDiagnostics(
      {
        adAccountDbId: 'account-1',
        window: { from: '2026-07-01', to: '2026-07-30' },
      },
      {
        readDelivery: async () => ({
          verdict: 'still_learning',
          headline: 'Delivery evidence is available.',
          read: 'The account is still learning.',
          window_settle: {
            state: 'settled',
            unsettled_days: 0,
            settled_through: '2026-07-30',
            includes_today: false,
            detail: 'The reporting window is settled.',
          },
          adsets_detail: [],
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
          action_authority: {
            tier: 'diagnostic_only',
            reason_code: 'diagnostic_observations_only',
          },
          prescriptions: [],
        }),
        readCreative: async () => {
          throw new Error('creative read offline')
        },
        readCreativePaidOutcomes: async () => paidCreativeOutcomesFixture,
      },
    )

    expect(result).toMatchObject({
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      window: { from: '2026-07-01', to: '2026-07-30' },
      delivery: {
        available: true,
        data: {
          headline: 'Delivery evidence is available.',
          structure: {
            spend_concentration: {
              budget_control: 'campaign',
            },
          },
        },
      },
      creative: {
        available: false,
        reason: 'creative read offline',
      },
      creative_paid_outcomes: {
        available: true,
        data: paidCreativeOutcomesFixture,
      },
    })
    expect(readOwnerDiagnosticsSnapshot(result)).toEqual(result)
  })

  it('keeps both existing planes available when the paid creative read fails', async () => {
    const result = await buildOwnerDiagnostics(
      {
        adAccountDbId: 'account-1',
        window: { from: '2026-07-01', to: '2026-07-30' },
      },
      {
        readDelivery: async () => availableDelivery,
        readCreative: async () => availableCreative,
        readCreativePaidOutcomes: async () => {
          throw new Error('paid creative read offline')
        },
      },
    )

    expect(result.delivery.available).toBe(true)
    expect(result.creative.available).toBe(true)
    expect(result.creative_paid_outcomes).toEqual({
      available: false,
      reason: 'paid creative read offline',
    })
  })

  it('keeps both creative planes available when the delivery read fails', async () => {
    const result = await buildOwnerDiagnostics(
      {
        adAccountDbId: 'account-1',
        window: { from: '2026-07-01', to: '2026-07-30' },
      },
      {
        readDelivery: async () => {
          throw new Error('delivery read offline')
        },
        readCreative: async () => availableCreative,
        readCreativePaidOutcomes: async () => paidCreativeOutcomesFixture,
      },
    )

    expect(result.delivery).toEqual({ available: false, reason: 'delivery read offline' })
    expect(result.creative.available).toBe(true)
    expect(result.creative_paid_outcomes).toEqual({
      available: true,
      data: paidCreativeOutcomesFixture,
    })
  })

  it.each([
    'delivery',
    'creative',
    'creative_paid_outcomes',
  ] as const)('settles a synchronous %s reader throw without hiding the other sections', async (failed) => {
    const syncThrow = () => {
      throw new Error(`${failed} synchronous failure`)
    }
    const result = await buildOwnerDiagnostics(
      {
        adAccountDbId: 'account-1',
        window: { from: '2026-07-01', to: '2026-07-30' },
      },
      {
        readDelivery: failed === 'delivery' ? syncThrow : async () => availableDelivery,
        readCreative: failed === 'creative' ? syncThrow : async () => availableCreative,
        readCreativePaidOutcomes: failed === 'creative_paid_outcomes'
          ? syncThrow
          : async () => paidCreativeOutcomesFixture,
      },
    )

    expect(result.delivery.available).toBe(failed !== 'delivery')
    expect(result.creative.available).toBe(failed !== 'creative')
    expect(result.creative_paid_outcomes.available).toBe(failed !== 'creative_paid_outcomes')
    expect(result[failed]).toEqual({
      available: false,
      reason: `${failed} synchronous failure`,
    })
  })

  it('keeps reading committed delivery snapshots that predate the verdict field', () => {
    const legacyDelivery: Record<string, unknown> = { ...availableDelivery }
    delete legacyDelivery.verdict
    const legacy = { ...unavailableCoreSections, delivery: { available: true, data: legacyDelivery } }

    expect(readOwnerDiagnosticsSnapshot(legacy)).not.toBeNull()
    expect(readOwnerDiagnosticsSnapshot(legacy)?.delivery).toEqual({ available: true, data: legacyDelivery })
  })

  it('rejects a delivery snapshot carrying a verdict that is not a verdict', () => {
    const bogus = {
      ...unavailableCoreSections,
      delivery: { available: true, data: { ...availableDelivery, verdict: 'vibes' } },
    }

    expect(readOwnerDiagnosticsSnapshot(bogus)).toBeNull()
  })

  it('strictly accepts a complete current paid creative payload', () => {
    const snapshot = {
      ...unavailableCoreSections,
      creative_paid_outcomes: { available: true, data: paidCreativeOutcomesFixture },
      creative_paid_attribute_distributions: {
        available: false,
        reason: 'not captured',
      },
    }
    expect(readOwnerDiagnosticsSnapshot(snapshot)).toEqual(snapshot)
  })

  it.each([
    ['top-level status', (value: Record<string, unknown>) => { value.status = 'read_unavailable' }],
    ['direction status', (value: Record<string, unknown>) => {
      (value.recent_scale as Record<string, unknown>).status = 'not_published'
    }],
    ['non-finite outcome', (value: Record<string, unknown>) => {
      const recent = value.recent_scale as { creatives: Array<{ outcomes: Record<string, unknown> }> }
      recent.creatives[0].outcomes.spend = Number.POSITIVE_INFINITY
    }],
    ['fractional count', (value: Record<string, unknown>) => {
      const recent = value.recent_scale as { creatives: Array<{ outcomes: Record<string, unknown> }> }
      recent.creatives[0].outcomes.captured_touches = 1.5
    }],
    ['fractional-cent booked value', (value: Record<string, unknown>) => {
      const recent = value.recent_scale as { creatives: Array<{ outcomes: Record<string, unknown> }> }
      recent.creatives[0].outcomes.booked_value = 1.001
    }],
    ['invalid window', (value: Record<string, unknown>) => {
      (value.recent_scale as Record<string, unknown>).window_start = '2026-07-99'
    }],
    ['mismatched evaluation lineage', (value: Record<string, unknown>) => {
      const recent = value.recent_scale as { creatives: Array<Record<string, unknown>> }
      recent.creatives[0].evaluation_run_id = '10000000-0000-4000-8000-000000000099'
    }],
    ['mismatched generation lineage', (value: Record<string, unknown>) => {
      const recent = value.recent_scale as { creatives: Array<Record<string, unknown>> }
      recent.creatives[0].generation_id = '20000000-0000-4000-8000-000000000099'
    }],
    ['malformed blocker', (value: Record<string, unknown>) => {
      (value.recent_scale as Record<string, unknown>).blocker_codes = [7]
    }],
    ['unsafe contract version', (value: Record<string, unknown>) => {
      (value.recent_scale as Record<string, unknown>).contract_version = 1.5
    }],
    ['invalid Meta ID', (value: Record<string, unknown>) => {
      const recent = value.recent_scale as { creatives: Array<Record<string, unknown>> }
      recent.creatives[0].meta_creative_id = 'creative-1'
    }],
    ['incomplete assignment lineage', (value: Record<string, unknown>) => {
      const recent = value.recent_scale as { creatives: Array<Record<string, unknown>> }
      recent.creatives[0].assignment_observation_ids = ['40000000-0000-4000-8000-000000000001']
    }],
    ['action authority', (value: Record<string, unknown>) => {
      (value.recent_scale as Record<string, unknown>).action_authority_tier = 'execution_eligible'
    }],
    ['prescriptions', (value: Record<string, unknown>) => { value.prescriptions = ['change spend'] }],
    ['claim note', (value: Record<string, unknown>) => {
      value.note = `${String(value.note)} This is a winner.`
    }],
  ])('rejects a present paid payload with malformed %s', (_label, mutate) => {
    const data = structuredClone(paidCreativeOutcomesFixture) as unknown as Record<string, unknown>
    mutate(data)
    expect(readOwnerDiagnosticsSnapshot({
      ...unavailableCoreSections,
      creative_paid_outcomes: { available: true, data },
    })).toBeNull()
  })

  it('normalizes only an absent legacy paid section', () => {
    expect(readOwnerDiagnosticsSnapshot(unavailableCoreSections)).toEqual({
      ...unavailableCoreSections,
      creative_paid_outcomes: {
        available: false,
        reason: 'not_captured_in_legacy_snapshot',
      },
      creative_paid_attribute_distributions: {
        available: false,
        reason: 'not_captured_in_legacy_snapshot',
      },
    })
    expect(readOwnerDiagnosticsSnapshot({
      ...unavailableCoreSections,
      creative_paid_outcomes: null,
    })).toBeNull()
  })

  it('rejects persisted snapshots that do not prove diagnostic-only authority', () => {
    expect(readOwnerDiagnosticsSnapshot({
      action_authority_tier: 'execution_eligible',
      prescriptions: ['raise budget'],
      window: { from: '2026-07-01', to: '2026-07-30' },
      delivery: { available: false, reason: 'missing' },
      creative: { available: false, reason: 'missing' },
      creative_paid_outcomes: { available: false, reason: 'missing' },
    })).toBeNull()
  })

  it('rejects a malformed available section instead of letting stored JSON crash the report page', () => {
    expect(readOwnerDiagnosticsSnapshot({
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      window: { from: '2026-07-01', to: '2026-07-30' },
      delivery: { available: true, data: { headline: 'Missing required nested fields' } },
      creative: { available: false, reason: 'not captured' },
      creative_paid_outcomes: { available: false, reason: 'not captured' },
    })).toBeNull()
  })

  it('requires a valid delivery sub-status state in every persisted ad-set detail', () => {
    const snapshot = {
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      window: { from: '2026-07-01', to: '2026-07-30' },
      delivery: {
        available: true,
        data: {
          headline: 'Delivery evidence is available.',
          read: 'The account is still learning.',
          window_settle: null,
          adsets_detail: [{
            name: 'Cold',
            learning_phase: 'LEARNING',
            learning_conversions: 2,
            results_to_exit: 48,
            last_sig_edit: null,
            narrow_audience: { narrow: false, basis: 'broad' },
            budget_constrained: {
              flag: false,
              max_day_overshoot_pct: null,
              median_day_pct: null,
            },
            learning_exit_feasibility: {
              cost_per_optimization_event: null,
              events_per_week_at_current_budget: null,
              required_daily_budget_for_exit: null,
              reachable_at_current_budget: null,
              basis: 'unknown',
            },
            cause_hints: [],
            delivery_sub_status: {
              read_available: true,
              payload: null,
              synced_at: '2026-08-01T20:00:00.000Z',
            },
          }],
          structure: {
            spend_concentration: { detail: 'No concentration verdict.' },
          },
        },
      },
      creative: { available: false, reason: 'not captured' },
      creative_paid_outcomes: { available: false, reason: 'not captured' },
      creative_paid_attribute_distributions: { available: false, reason: 'not captured' },
    }

    expect(readOwnerDiagnosticsSnapshot(snapshot)).toEqual(snapshot)
    expect(readOwnerDiagnosticsSnapshot({
      ...snapshot,
      delivery: {
        ...snapshot.delivery,
        data: {
          ...snapshot.delivery.data,
          adsets_detail: [{
            ...snapshot.delivery.data.adsets_detail[0],
            delivery_sub_status: {
              read_available: true,
              payload: { status: 7, substatuses: [] },
              synced_at: '2026-08-01T20:00:00.000Z',
            },
          }],
        },
      },
    })).toBeNull()

    const withoutStatus = structuredClone(snapshot)
    delete (withoutStatus.delivery.data.adsets_detail[0] as Record<string, unknown>).delivery_sub_status
    expect(readOwnerDiagnosticsSnapshot(withoutStatus)).toMatchObject({
      delivery: {
        available: true,
        data: {
          adsets_detail: [{
            delivery_sub_status: {
              read_available: false,
              payload: null,
              synced_at: null,
            },
          }],
        },
      },
    })
  })
})
