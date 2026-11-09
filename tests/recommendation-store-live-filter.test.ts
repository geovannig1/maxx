import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  tables: new Map<string, Array<Record<string, unknown>>>(),
  errors: new Map<string, string>(),
  throws: new Map<string, string>(),
  readSequences: new Map<string, Array<Array<Record<string, unknown>>>>(),
  readCounts: new Map<string, number>(),
  authorityReadFails: false,
}))

vi.mock('@/lib/authority/action-decision-store', () => ({
  readActionDecisionsBySource: vi.fn(async () => {
    if (state.authorityReadFails) throw new Error('action decision read failed')
    return new Map()
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = []
      const chain: Record<string, unknown> = {}
      let selectedCount = false
      let headOnly = false
      let orderBy: { column: string; ascending: boolean } | null = null
      let rowLimit: number | null = null
      chain.select = (_columns?: string, options?: { count?: string; head?: boolean }) => {
        selectedCount = options?.count === 'exact'
        headOnly = options?.head === true
        return chain
      }
      chain.eq = (column: string, value: unknown) => {
        filters.push((row) => row[column] === value)
        return chain
      }
      chain.in = (column: string, values: unknown[]) => {
        const accepted = new Set(values)
        filters.push((row) => accepted.has(row[column]))
        return chain
      }
      chain.order = (column: string, options?: { ascending?: boolean }) => {
        orderBy = { column, ascending: options?.ascending !== false }
        return chain
      }
      chain.limit = (limit: number) => {
        rowLimit = limit
        return chain
      }
      chain.then = (
        resolve: (value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null; count?: number | null }) => unknown,
        reject?: (error: Error) => unknown,
      ) => {
        const thrown = state.throws.get(table)
        if (thrown) return Promise.resolve(reject?.(new Error(thrown)))
        const error = state.errors.get(table)
        if (error) return Promise.resolve(resolve({ data: null, error: { message: error } }))
        const sequence = state.readSequences.get(table)
        const readIndex = state.readCounts.get(table) ?? 0
        state.readCounts.set(table, readIndex + 1)
        const sourceRows = sequence
          ? sequence[Math.min(readIndex, sequence.length - 1)] ?? []
          : state.tables.get(table) ?? []
        let data = sourceRows.filter((row) => filters.every((filter) => filter(row)))
        const count = data.length
        if (orderBy) {
          const { column, ascending } = orderBy
          data = [...data].sort((a, b) => {
            const left = String(a[column] ?? '')
            const right = String(b[column] ?? '')
            return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1)
          })
        }
        if (rowLimit !== null) data = data.slice(0, rowLimit)
        return Promise.resolve(resolve({ data: headOnly ? null : data, error: null, count: selectedCount ? count : null }))
      }
      return chain
    },
  }),
}))

const baseRecommendation = {
  recommendation_type: 'keep',
  target_entity_type: 'ad',
  target_entity_name: 'Ad',
  observed_fact: 'Observed delivery.',
  reason_for_action: 'Historical recommendation prose.',
  date_range_start: '2026-07-23',
  date_range_end: '2026-07-29',
  data_sources: ['meta_api'],
  evidence_summary: null,
  what_could_make_this_wrong: null,
  confidence_label: 'low',
  confidence_score: 0.3,
  risk_level: 'low',
  gate_decision: 'hold',
  approval_required: false,
  action_allowed_now: false,
  low_data_warning: null,
  estimate_warning: null,
  attribution_warning: null,
  recommended_next_check_date: null,
  target_metric: null,
  target_status: null,
  target_confidence: null,
  target_language: null,
  attribution_confidence: null,
  external_knowledge_used: null,
  prior_learning_used: null,
  expected_upside: null,
  possible_downside: null,
  minimum_data_needed: null,
  learning_eligibility: false,
  metric_claim_ids: ['claim-default'],
  status: 'open',
  generated_at: new Date(Date.now() + 60_000).toISOString(),
  ad_account_id: 'account-1',
  generation_id: 'generation-1',
}

describe('recommendation store current-feed lifecycle boundary', () => {
  beforeEach(() => {
    state.errors = new Map()
    state.throws = new Map()
    state.readSequences = new Map()
    state.readCounts = new Map()
    state.authorityReadFails = false
    state.tables = new Map<string, Array<Record<string, unknown>>>([
      ['decision_generations', [{
        id: 'generation-1', ad_account_id: 'account-1', kind: 'recommendation', is_current: true,
      }]],
      ['recommendations', [
        { ...baseRecommendation, id: 'rec-paused', target_entity_id: 'ad-paused' },
        { ...baseRecommendation, id: 'rec-active', target_entity_id: 'ad-active' },
        {
          ...baseRecommendation,
          id: 'rec-account',
          recommendation_type: 'investigate',
          target_entity_type: 'account',
          target_entity_id: null,
        },
      ]],
      ['recommendation_metric_claim_bindings', [
        'rec-paused',
        'rec-active',
        'rec-account',
      ].map((recommendation_id) => ({
        recommendation_id,
        claim_id: 'claim-default',
        ad_account_id: 'account-1',
        source_flag_id: null,
        source_flag_generation_id: null,
        metric_claim: {
          claim_id: 'claim-default',
          ad_account_id: 'account-1',
          source_flag_id: null,
          source_flag_generation_id: null,
        },
      }))],
      ['campaigns', [{
        id: 'campaign-1', ad_account_id: 'account-1', status: 'ACTIVE', effective_status: 'ACTIVE',
        last_synced_at: new Date().toISOString(),
        meta_updated_time: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      }]],
      ['adsets', [{
        id: 'adset-1', ad_account_id: 'account-1', campaign_id: 'campaign-1', status: 'ACTIVE',
        effective_status: 'ACTIVE', last_synced_at: new Date().toISOString(),
        meta_updated_time: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        last_sig_edit_ts: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      }]],
      ['ads', [
        {
          id: 'ad-paused', ad_account_id: 'account-1', campaign_id: 'campaign-1', adset_id: 'adset-1',
          status: 'PAUSED', effective_status: 'PAUSED', last_synced_at: new Date().toISOString(),
          meta_updated_time: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        },
        {
          id: 'ad-active', ad_account_id: 'account-1', campaign_id: 'campaign-1', adset_id: 'adset-1',
          status: 'ACTIVE', effective_status: 'ACTIVE', last_synced_at: new Date().toISOString(),
          meta_updated_time: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        },
      ]],
    ])
  })

  it('filters paused targets before applying the caller limit', async () => {
    const { getOpenRecommendations } = await import('@/lib/recommendations/store')
    const rows = await getOpenRecommendations('account-1', 2)

    expect(rows.map((row) => row.id)).toEqual(['rec-active', 'rec-account'])
  })

  it('selects the current generation before the bounded database read', async () => {
    const recommendations = state.tables.get('recommendations')!
    const newer = new Date(Date.now() + 120_000).toISOString()
    for (let i = 0; i < 1_000; i += 1) {
      recommendations.push({
        ...baseRecommendation,
        id: `old-${i}`,
        generation_id: 'generation-old',
        target_entity_id: 'ad-paused',
        generated_at: newer,
      })
    }

    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.recommendations.map((row) => row.id)).toEqual(['rec-active', 'rec-account'])
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'not_current_generation', affectedCount: 1_000 }),
    ]))
  })

  it('withholds a snapshot when the current generation rotates during the read', async () => {
    state.readSequences.set('decision_generations', [
      [{ id: 'generation-1', ad_account_id: 'account-1', kind: 'recommendation', is_current: true }],
      [{ id: 'generation-2', ad_account_id: 'account-1', kind: 'recommendation', is_current: true }],
    ])

    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result).toMatchObject({
      health: 'unavailable',
      recommendations: [],
      visibleCount: 0,
    })
    expect(result.reasons).toEqual([
      expect.objectContaining({ code: 'current_generation_changed', affectedCount: 3 }),
    ])
  })

  it('reports a degraded current feed when rows are quarantined instead of calling it empty', async () => {
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 2)

    expect(result.health).toBe('degraded')
    expect(result.visibleCount).toBe(2)
    expect(result.quarantinedCount).toBe(1)
    expect(result.recommendations.map((row) => row.id)).toEqual(['rec-active', 'rec-account'])
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'target_not_current', affectedCount: 1 }),
    ]))
  })

  it('reports unavailable when the recommendation snapshot cannot be read', async () => {
    state.errors.set('recommendations', 'relation unavailable')
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result).toMatchObject({
      health: 'unavailable',
      visibleCount: 0,
      quarantinedCount: null,
      recommendations: [],
    })
    expect(result.reasons).toEqual([
      expect.objectContaining({ code: 'recommendations_read_failed', affectedCount: null }),
    ])
  })

  it('reports entity metadata failure as degraded and quarantines affected targets', async () => {
    state.errors.set('ads', 'ads metadata unavailable')
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.health).toBe('degraded')
    expect(result.visibleCount).toBe(1)
    expect(result.quarantinedCount).toBe(2)
    expect(result.recommendations.map((row) => row.id)).toEqual(['rec-account'])
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'entity_metadata_read_failed', affectedCount: 2 }),
      expect.objectContaining({ code: 'target_not_current', affectedCount: 2 }),
    ]))
  })

  it('fails closed without throwing when an entity metadata request rejects', async () => {
    state.throws.set('ads', 'network rejected')
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.health).toBe('degraded')
    expect(result.recommendations.map((row) => row.id)).toEqual(['rec-account'])
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'entity_metadata_read_failed', affectedCount: 2 }),
    ]))
  })

  it('keeps rows diagnostic but reports degraded when action authority cannot be read', async () => {
    state.authorityReadFails = true
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.health).toBe('degraded')
    expect(result.visibleCount).toBe(2)
    expect(result.recommendations).toHaveLength(2)
    expect(result.recommendations.every((row) => row.action_authority_tier === 'diagnostic_only')).toBe(true)
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'action_authority_read_failed', affectedCount: 2 }),
    ]))
  })

  it('quarantines recommendations whose persisted MetricClaim IDs lack exact immutable bindings', async () => {
    const rec = state.tables.get('recommendations')!.find((row) => row.id === 'rec-active')!
    rec.metric_claim_ids = ['claim:delivery-state']
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.health).toBe('degraded')
    expect(result.recommendations.map((row) => row.id)).not.toContain('rec-active')
    expect(result.quarantinedCount).toBe(2)
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'metric_claim_lineage_invalid', affectedCount: 1 }),
    ]))
  })

  it('fails closed when immutable MetricClaim bindings cannot be read', async () => {
    state.errors.set('recommendation_metric_claim_bindings', 'lineage relation unavailable')
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.health).toBe('degraded')
    expect(result.recommendations).toEqual([])
    expect(result.visibleCount).toBe(0)
    expect(result.quarantinedCount).toBe(3)
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'metric_claim_lineage_read_failed', affectedCount: 2 }),
    ]))
  })

  it('quarantines open rows outside the current recommendation generation', async () => {
    state.tables.get('recommendations')!.push({
      ...baseRecommendation,
      id: 'rec-old-generation',
      target_entity_id: 'ad-active',
      generation_id: 'generation-old',
    })
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.recommendations.map((row) => row.id)).not.toContain('rec-old-generation')
    expect(result.quarantinedCount).toBe(2)
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'not_current_generation', affectedCount: 1 }),
    ]))
  })

  it('quarantines Meta-target advice generated before the latest target or parent CHANGE', () => {
    // The guard's real question: has the entity been EDITED since the advice was written?
    return (async () => {
      const rec = state.tables.get('recommendations')!.find((row) => row.id === 'rec-active')!
      rec.generated_at = new Date(Date.now() - 2 * 3_600_000).toISOString()
      const ad = state.tables.get('ads')!.find((row) => row.id === 'ad-active')!
      ad.meta_updated_time = new Date(Date.now() - 3_600_000).toISOString()

      const { readOpenRecommendations } = await import('@/lib/recommendations/store')
      const result = await readOpenRecommendations('account-1', 20)

      expect(result.recommendations.map((row) => row.id)).toEqual(['rec-account'])
      expect(result.reasons).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'predates_entity_sync', affectedCount: 1 }),
      ]))
    })()
  })

  // Regression: every open recommendation was withheld when the guard compared against
  // `last_synced_at`, which the daily sync re-stamps whether or not
  // anything changed. Recommendations only regenerate when the whole fail-stop chain completes, so a
  // single `partial` sync re-stamped every entity, invalidated the entire feed, and left the owner with
  // an empty page and no explanation until a fully successful sync ran.
  it('keeps advice that predates a later SYNC but postdates every real change', async () => {
    const rec = state.tables.get('recommendations')!.find((row) => row.id === 'rec-active')!
    rec.generated_at = new Date(Date.now() - 24 * 3_600_000).toISOString()
    // Re-synced one minute ago; unchanged for 30 days (the fixture default).
    for (const table of ['ads', 'adsets', 'campaigns']) {
      for (const row of state.tables.get(table)!) {
        row.last_synced_at = new Date(Date.now() - 60_000).toISOString()
      }
    }

    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.recommendations.map((row) => row.id)).toContain('rec-active')
    expect(result.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'predates_entity_sync' }),
    ]))
  })

  it('marks the feed unavailable when the current generation head cannot be read', async () => {
    state.errors.set('decision_generations', 'generation head unavailable')
    const { readOpenRecommendations } = await import('@/lib/recommendations/store')
    const result = await readOpenRecommendations('account-1', 20)

    expect(result.health).toBe('unavailable')
    expect(result.recommendations).toEqual([])
    expect(result.reasons).toEqual([
      expect.objectContaining({ code: 'current_generation_read_failed' }),
    ])
  })

  it('preserves paused rows in exact-generation audit reads', async () => {
    const { getRecommendationsByGeneration } = await import('@/lib/recommendations/store')
    const rows = await getRecommendationsByGeneration('account-1', 'generation-1', 20)

    expect(rows.map((row) => row.id)).toContain('rec-paused')
  })

  it('fails closed for an exact-generation report with an unverified MetricClaim binding', async () => {
    const rec = state.tables.get('recommendations')!.find((row) => row.id === 'rec-active')!
    rec.metric_claim_ids = ['claim:delivery-state']

    const { getRecommendationsByGeneration } = await import('@/lib/recommendations/store')
    await expect(getRecommendationsByGeneration('account-1', 'generation-1', 20))
      .rejects.toThrow(/MetricClaim lineage is incomplete/i)
  })
})
