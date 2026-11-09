import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseState = vi.hoisted(() => ({
  table: '',
  activeAccounts: [{ id: 'account-1', account_id: 'act_100000000000041', account_name: 'Account One' }],
  errorTable: null as string | null,
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
  breakdownRows: [
    {
      breakdown_value: '25-34',
      spend: 100,
      impressions: 2_000,
      clicks: 60,
      leads: 4,
      bookings: 2,
      ctr: 3,
      cpa: 50,
      meta_entity_id: 'campaign-1',
    },
    {
      breakdown_value: '35-44',
      spend: 200,
      impressions: 4_000,
      clicks: 80,
      leads: 5,
      bookings: 1,
      ctr: 2,
      cpa: 200,
      meta_entity_id: 'campaign-1',
    },
  ] as Array<Record<string, unknown>>,
  creativeRows: [
    {
      id: 'creative-1',
      vision_analysis: { format: 'video', shows_price: false },
    },
  ],
  creativeInsightRows: [
    {
      ad_id: 'ad-1',
      spend: 100,
      bookings: 2,
      clicks: 60,
      impressions: 2_000,
      ctr: 3,
      ads: {
        ad_id: 'meta-ad-1',
        ad_name: 'Ad One',
        creative_id: 'creative-1',
        ad_account_id: 'account-1',
        delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] },
        delivery_sub_status_read_available: true,
        delivery_sub_status_synced_at: '2026-08-01T20:00:00.000Z',
        creatives: {
          id: 'creative-1',
          creative_name: 'Creative One',
          thumbnail_url: null,
          vision_analysis: { format: 'video', shows_price: false },
          asset_type: 'video',
          video_id: 'video-1',
        },
      },
    },
  ] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      databaseState.table = table
      const response = () => databaseState.errorTable === table
        ? { data: null, error: { message: `${table} read failed` } }
        : table === 'ad_accounts'
          ? { data: databaseState.activeAccounts, error: null }
          : table === 'insight_breakdowns'
            ? { data: databaseState.breakdownRows, error: null }
        : table === 'creatives'
          ? { data: databaseState.creativeRows, error: null }
          : table === 'daily_insights'
            ? { data: databaseState.creativeInsightRows, error: null }
        : { data: null, error: null }
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'gte', 'lte', 'not', 'in', 'order', 'limit']) {
        chain[method] = () => chain
      }
      chain.eq = (column: string, value: unknown) => {
        databaseState.filters.push({ table, column, value })
        return chain
      }
      chain.maybeSingle = async () => table === 'ad_accounts'
        ? { data: databaseState.activeAccounts[0] ?? null, error: null }
        : response()
      chain.single = async () => table === 'ad_accounts'
        ? { data: databaseState.activeAccounts[0] ?? null, error: null }
        : response()
      chain.then = (
        resolve: (value: ReturnType<typeof response>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(response()).then(resolve, reject)
      return chain
    },
  }),
}))

import { assembleExpertKnowledge, getExpertKnowledge } from '@/mcp/tools/expert-knowledge'
import { getAudienceBreakdown } from '@/mcp/tools/audience-breakdown'
import { getTrajectoryForecast } from '@/mcp/tools/trajectory'
import { getCreativeHealthScores } from '@/mcp/tools/health-score'
import { getCreativeInsights } from '@/mcp/tools/creative-insights'
import { TOOL_DEFINITIONS } from '@/mcp/tools'

describe('model-facing alternate strategy tools', () => {
  beforeEach(() => {
    databaseState.table = ''
    databaseState.activeAccounts = [{ id: 'account-1', account_id: 'act_100000000000041', account_name: 'Account One' }]
    databaseState.errorTable = null
    databaseState.filters = []
    databaseState.breakdownRows = [
      {
        breakdown_value: '25-34', spend: 100, impressions: 2_000, clicks: 60,
        leads: 4, bookings: 2, ctr: 3, cpa: 50, meta_entity_id: 'campaign-1',
      },
      {
        breakdown_value: '35-44', spend: 200, impressions: 4_000, clicks: 80,
        leads: 5, bookings: 1, ctr: 2, cpa: 200, meta_entity_id: 'campaign-1',
      },
    ]
    databaseState.creativeRows = [{ id: 'creative-1', vision_analysis: { format: 'video', shows_price: false } }]
    databaseState.creativeInsightRows = [
      {
        ad_id: 'ad-1', spend: 100, bookings: 2, clicks: 60, impressions: 2_000, ctr: 3,
        ads: {
          ad_id: 'meta-ad-1', ad_name: 'Ad One', creative_id: 'creative-1', ad_account_id: 'account-1',
          delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] },
          delivery_sub_status_read_available: true,
          delivery_sub_status_synced_at: '2026-08-01T20:00:00.000Z',
          creatives: {
            id: 'creative-1', creative_name: 'Creative One', thumbnail_url: null,
            vision_analysis: { format: 'video', shows_price: false }, asset_type: 'video', video_id: 'video-1',
          },
        },
      },
    ]
  })

  it('withholds account-fit prose and fixed account settings from expert knowledge', () => {
    const result = assembleExpertKnowledge({
      corpus: [
        {
          key: 'generic',
          domain: 'learning_phase',
          claim: 'Learning needs enough optimization events.',
          source: 'Meta',
          tier: 'meta_official',
          account_relevance: 'Use the current 15-mile radius and $45/day budget.',
        },
        {
          key: 'fixed-setting',
          domain: 'bidding',
          claim: 'At $45/day, a $40 cost goal means stay on Highest Volume.',
          source: 'Meta',
          tier: 'meta_official',
          account_relevance: 'Current account prescription.',
        },
      ],
      insights: [],
      limit: 10,
    }) as Record<string, unknown>

    expect(result).toMatchObject({
      action_authority_tier: 'diagnostic_only',
      setup_guidance_status: 'withheld',
      prescriptions: [],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('account_relevance')
    expect(serialized).not.toMatch(/\$45|\$40|15-mile|Highest Volume/i)
    expect(serialized).toContain('Learning needs enough optimization events.')
  })

  it('projects only the current allowlisted corpus without historical account-fit settings', async () => {
    const result = await getExpertKnowledge({ limit: 25 })
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('account_relevance')
    // No concrete budget, no radius, no account-specific framing: a generic corpus never names a
    // dollar amount or distance for THIS account.
    expect(serialized).not.toMatch(/\$\s?\d|\b\d+(?:\.\d+)?\s?-?\s?(?:mi|miles?)\b|current structure|this account/i)
    expect(result.action_authority_tier).toBe('diagnostic_only')
    expect(result.prescriptions).toEqual([])
    expect(result.withheld_account_context_count).toBe(0)
    expect(serialized).toContain('objective-outcome-alignment-current')
    expect(serialized).not.toContain('retargeting-share-norm')
  })

  it('returns audience delivery observations without target, winner or budget direction', async () => {
    const result = await getAudienceBreakdown({ breakdown_type: 'age', days: 30 }) as Record<string, unknown>

    expect(result).toMatchObject({
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/vs_target|best|worst|below target|above target|focus budget|\$\s?\d/i)
    expect(serialized).toContain('meta_bookings_estimate')
    expect(serialized).toContain('meta_cpa_estimate')
  })

  it('does not turn missing breakdown outcomes into model-facing zero leads or bookings', async () => {
    databaseState.breakdownRows = [{
      breakdown_value: '25-34', spend: 100, impressions: 2_000, clicks: 60,
      leads: null, bookings: null, ctr: 3, cpa: null, meta_entity_id: 'campaign-1',
    }]

    const result = await getAudienceBreakdown({ breakdown_type: 'age', days: 30 }) as {
      segments: Array<Record<string, unknown>>
    }
    expect(result.segments[0]).toMatchObject({
      spend: 100,
      leads: null,
      meta_bookings_estimate: null,
      cpl: null,
      meta_cpa_estimate: null,
      outcome_status: 'unavailable',
    })
  })

  it('scopes audience and creative evidence to the only active account', async () => {
    await getAudienceBreakdown({ breakdown_type: 'age', days: 30 })
    await getCreativeInsights({ days: 30 })

    expect(databaseState.filters).toContainEqual({ table: 'insight_breakdowns', column: 'ad_account_id', value: 'account-1' })
    expect(databaseState.filters).toContainEqual({ table: 'creatives', column: 'ad_account_id', value: 'account-1' })
    expect(databaseState.filters).toContainEqual({ table: 'daily_insights', column: 'ad_account_id', value: 'account-1' })
    expect(databaseState.filters).toContainEqual({ table: 'daily_insights', column: 'ads.ad_account_id', value: 'account-1' })
  })

  it('fails account-scoped evidence closed when active ownership is ambiguous', async () => {
    databaseState.activeAccounts = [
      { id: 'account-1', account_id: 'act_100000000000041', account_name: 'One' },
      { id: 'account-2', account_id: 'act_100000000000042', account_name: 'Two' },
    ]

    const audience = await getAudienceBreakdown({}) as Record<string, unknown>
    const creative = await getCreativeInsights({}) as Record<string, unknown>

    expect(audience).toMatchObject({ status: 'unavailable', error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS', prescriptions: [] })
    expect(creative).toMatchObject({ status: 'unavailable', error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS', prescriptions: [] })
    expect(databaseState.filters.some((filter) => filter.table === 'insight_breakdowns')).toBe(false)
    expect(databaseState.filters.some((filter) => filter.table === 'daily_insights')).toBe(false)
  })

  it('distinguishes read failure from a healthy empty audience result', async () => {
    databaseState.errorTable = 'insight_breakdowns'
    const failed = await getAudienceBreakdown({}) as Record<string, unknown>
    expect(failed).toMatchObject({ status: 'unavailable', prescriptions: [] })

    databaseState.errorTable = null
    databaseState.breakdownRows = []
    const empty = await getAudienceBreakdown({}) as Record<string, unknown>
    expect(empty).toMatchObject({ status: 'available', segments: [], prescriptions: [] })
  })

  it('distinguishes creative read failure from a healthy empty observation set', async () => {
    databaseState.errorTable = 'daily_insights'
    const failed = await getCreativeInsights({}) as Record<string, unknown>
    expect(failed).toMatchObject({ status: 'unavailable', prescriptions: [] })

    databaseState.errorTable = null
    databaseState.creativeRows = []
    databaseState.creativeInsightRows = []
    const empty = await getCreativeInsights({}) as Record<string, unknown>
    expect(empty).toMatchObject({
      status: 'available',
      correlations: [],
      creative_delivery_observations: [],
      ad_delivery_sub_statuses: [],
      prescriptions: [],
    })
  })

  it.each([
    ['trajectory', () => getTrajectoryForecast({})],
    ['health score', () => getCreativeHealthScores({})],
  ])('fails the %s contract closed instead of returning action or money authority', async (_name, run) => {
    const result = await run() as Record<string, unknown>

    expect(result).toMatchObject({
      status: 'unavailable',
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
    })
    expect(JSON.stringify(result)).toMatch(/modelled|exact paid|not action/i)
  })

  it('projects creative correlations as descriptive evidence, never a ranked production brief', async () => {
    const result = await getCreativeInsights({ days: 30 }) as Record<string, unknown>
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      action_authority_tier: 'diagnostic_only',
      setup_guidance_status: 'withheld',
      prescriptions: [],
      period: {
        start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        end: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    })
    expect(serialized).toContain('creative_delivery_observations')
    expect(serialized).toContain('meta_bookings_estimate')
    expect(serialized).toContain('single_format_observation')
    expect(serialized).not.toContain('single_format_warning')
    expect(serialized).not.toMatch(/top_creatives|total_bookings|"signal"|avg_cpa|winner|loser|production brief/i)
  })

  it('keeps delivery sub-status per ad when two ads reuse one creative', async () => {
    databaseState.creativeInsightRows = [
      databaseState.creativeInsightRows[0],
      {
        ad_id: 'ad-2', spend: 30, bookings: 0, clicks: 10, impressions: 1_000, ctr: 1,
        ads: {
          ad_id: 'meta-ad-2', ad_name: 'Ad Two', creative_id: 'creative-1', ad_account_id: 'account-1',
          delivery_sub_status: null,
          delivery_sub_status_read_available: true,
          delivery_sub_status_synced_at: '2026-08-01T20:01:00.000Z',
          creatives: {
            id: 'creative-1', creative_name: 'Creative One', thumbnail_url: null,
            vision_analysis: { format: 'video', shows_price: false }, asset_type: 'video', video_id: 'video-1',
          },
        },
      },
      {
        ad_id: 'ad-3', spend: 10, bookings: 0, clicks: 2, impressions: 500, ctr: 0.4,
        ads: {
          ad_id: 'meta-ad-3', ad_name: 'Ad Three', creative_id: 'creative-1', ad_account_id: 'account-1',
          delivery_sub_status: null,
          delivery_sub_status_read_available: false,
          delivery_sub_status_synced_at: null,
          creatives: {
            id: 'creative-1', creative_name: 'Creative One', thumbnail_url: null,
            vision_analysis: { format: 'video', shows_price: false }, asset_type: 'video', video_id: 'video-1',
          },
        },
      },
    ]

    const result = await getCreativeInsights({ days: 30 }) as {
      creative_delivery_observations: unknown[]
      ad_delivery_sub_statuses: unknown[]
      action_authority_tier: string
      prescriptions: unknown[]
    }

    expect(result.creative_delivery_observations).toHaveLength(1)
    expect(result.ad_delivery_sub_statuses).toEqual([
      {
        ad_id: 'meta-ad-1',
        ad_name: 'Ad One',
        creative_id: 'creative-1',
        delivery_sub_status: {
          read_available: true,
          payload: { status: 'warning', substatuses: ['creative_fatigue'] },
          synced_at: '2026-08-01T20:00:00.000Z',
        },
      },
      {
        ad_id: 'meta-ad-2',
        ad_name: 'Ad Two',
        creative_id: 'creative-1',
        delivery_sub_status: {
          read_available: true,
          payload: null,
          synced_at: '2026-08-01T20:01:00.000Z',
        },
      },
      {
        ad_id: 'meta-ad-3',
        ad_name: 'Ad Three',
        creative_id: 'creative-1',
        delivery_sub_status: {
          read_available: false,
          payload: null,
          synced_at: null,
        },
      },
    ])
    expect(result.action_authority_tier).toBe('diagnostic_only')
    expect(result.prescriptions).toEqual([])
  })

  it('describes all four tools as diagnostic-only and non-prescriptive', () => {
    const descriptions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool.description]))
    for (const tool of [
      'get_expert_knowledge',
      'get_audience_breakdown',
      'get_trajectory_forecast',
      'get_creative_health_scores',
      'get_creative_insights',
    ]) {
      expect(descriptions.get(tool)).toMatch(/diagnostic.only/i)
      expect(descriptions.get(tool)).toMatch(/no (?:action|prescription)|prescriptions.*empty|unavailable/i)
    }
    expect(descriptions.get('get_audience_breakdown')).not.toMatch(/sorted by CPA|\$\s?\d|performing below/i)
    expect(descriptions.get('get_creative_health_scores')).not.toMatch(/immediate action/i)
    expect(descriptions.get('get_creative_insights')).not.toMatch(/top 10|lower CPA|brief new creative/i)
    expect(descriptions.get('get_creative_insights')).toMatch(/per-ad.*delivery sub-status/i)
    expect(descriptions.get('get_diagnosis_bundle')).toMatch(/delivery sub-status/i)
  })
})
