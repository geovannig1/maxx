import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  accountId: 'account-1' as string | null,
  accountError: null as string | null,
  readResult: {
    health: 'healthy',
    recommendations: [],
    visibleCount: 0,
    quarantinedCount: 0,
    reasons: [],
  } as Record<string, unknown>,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            then: (
              resolve: (value: { data: Array<{ id: string; account_id: string; account_name: null }> | null; error: { message: string } | null }) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => Promise.resolve({
              data: state.accountId
                ? [{ id: state.accountId, account_id: 'act_100000000000051', account_name: null }]
                : [],
              error: state.accountError ? { message: state.accountError } : null,
            }).then(resolve, reject),
            maybeSingle: async () => ({
              data: state.accountId
                ? { id: state.accountId, account_id: 'act_100000000000051' }
                : null,
              error: state.accountError ? { message: state.accountError } : null,
            }),
          }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/recommendations/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/recommendations/store')>()
  return {
    ...original,
    readOpenRecommendations: vi.fn(async () => state.readResult),
  }
})

import { getOpenRecommendationsTool } from '@/mcp/tools/open-recommendations'

describe('getOpenRecommendationsTool read health', () => {
  beforeEach(() => {
    state.accountId = 'account-1'
    state.accountError = null
    state.readResult = {
      health: 'healthy',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: 0,
      reasons: [],
    }
  })

  it('distinguishes a healthy empty current snapshot from an unavailable read', async () => {
    const result = await getOpenRecommendationsTool({}) as Record<string, unknown>

    expect(result).toMatchObject({
      read_health: 'healthy',
      visible_count: 0,
      quarantined_count: 0,
      count: 0,
    })
    expect(result.note).toMatch(/healthy empty snapshot/i)
  })

  it('surfaces quarantined rows as degraded rather than saying the engine proposes nothing', async () => {
    state.readResult = {
      health: 'degraded',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: 2,
      reasons: [{
        code: 'target_not_current',
        affectedCount: 2,
        message: '2 open recommendations were quarantined.',
      }],
    }

    const result = await getOpenRecommendationsTool({}) as Record<string, unknown>
    expect(result).toMatchObject({
      read_health: 'degraded',
      visible_count: 0,
      quarantined_count: 2,
      count: 0,
    })
    expect(result.note).toMatch(/must not infer.*nothing/i)
    expect(result.note).not.toMatch(/engine currently proposes nothing/i)
  })

  it('never renders an unverified MetricClaim recommendation through MCP even if an adapter returns one', async () => {
    state.readResult = {
      health: 'degraded',
      recommendations: [{
        id: 'unverified-rec',
        metric_claim_lineage_verified: false,
        recommendation_type: 'pause',
        target_entity_type: 'ad',
        target_entity_id: 'ad-1',
        target_entity_name: 'Unsafe ad',
        observed_fact: 'Unverified claim.',
        reason_for_action: 'Do not expose.',
        action_authority_tier: 'execution_eligible',
        action_authority_legacy: false,
        confidence_label: 'high',
        confidence_score: 1,
        risk_level: 'high',
        gate_decision: 'ready',
        approval_required: true,
        action_allowed_now: true,
        generated_at: '2026-08-21T00:00:00.000Z',
      }],
      visibleCount: 1,
      quarantinedCount: 0,
      reasons: [],
    }

    const result = await getOpenRecommendationsTool({}) as Record<string, unknown>
    expect(result).toMatchObject({
      count: 0,
      recommendations: [],
      mcp_lineage_quarantined_count: 1,
    })
    expect(JSON.stringify(result)).not.toContain('execution_eligible')
  })

  it('surfaces account lookup errors as unavailable without leaking the database error', async () => {
    state.accountError = 'sensitive database failure detail'

    const result = await getOpenRecommendationsTool({}) as Record<string, unknown>
    expect(result).toMatchObject({
      read_health: 'unavailable',
      visible_count: 0,
      quarantined_count: null,
      count: 0,
    })
    expect(JSON.stringify(result)).not.toContain('sensitive database failure detail')
    expect(result.note).toMatch(/unavailable/i)
    expect(result.note).not.toMatch(/engine currently proposes nothing/i)
  })
})
