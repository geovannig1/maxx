import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A recent date: the MCP date validator rejects windows older than 90 days, so a literal date here
// would turn this suite into a time bomb.
const RECENT_DATE = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  resolution: { ok: true, account: { id: 'account-a', accountName: 'Studio A' } } as
    | { ok: true; account: { id: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  rows: {
    daily_insights: [] as Row[],
    creatives: [] as Row[],
  },
  calls: [] as Array<{ table: string; op: string; column: string; value: unknown }>,
  missingDeliveryColumns: false,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.resolution),
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))

vi.mock('@/mcp/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }))

vi.mock('@/mcp/lib/supabase', () => ({
  getSupabaseClient: () => ({
    from: (table: keyof typeof state.rows) => {
      let rows = [...state.rows[table]]
      let error: { message: string } | null = null
      const response = () => ({ data: error ? null : rows, error })
      const builder = {
        select: (clause?: string) => {
          error = state.missingDeliveryColumns && String(clause).includes('delivery_sub_status')
            ? { message: 'column ads_1.delivery_sub_status does not exist' }
            : null
          return builder
        },
        eq: (column: string, value: unknown) => {
          state.calls.push({ table, op: 'eq', column, value })
          rows = rows.filter((row) => {
            if (column === 'ads.ad_account_id') {
              const ad = row.ads as Row | undefined
              return ad?.ad_account_id === value
            }
            return row[column] === value
          })
          return builder
        },
        gte: (column: string, value: unknown) => {
          state.calls.push({ table, op: 'gte', column, value })
          return builder
        },
        lte: (column: string, value: unknown) => {
          state.calls.push({ table, op: 'lte', column, value })
          return builder
        },
        not: (column: string) => {
          state.calls.push({ table, op: 'not', column, value: null })
          rows = rows.filter((row) => row[column] !== null)
          return builder
        },
        in: (column: string, values: unknown[]) => {
          state.calls.push({ table, op: 'in', column, value: values })
          rows = rows.filter((row) => values.includes(row[column]))
          return builder
        },
        then: (
          resolve: (value: ReturnType<typeof response>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(response()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('creative-performance MCP authority and account scope', () => {
  beforeEach(() => {
    state.resolution = { ok: true, account: { id: 'account-a', accountName: 'Studio A' } }
    state.calls = []
    state.missingDeliveryColumns = false
    state.rows.daily_insights = [
      {
        ad_account_id: 'account-a', entity_level: 'ad', ad_id: 'ad-good', date_start: RECENT_DATE,
        spend: 100, impressions: 1_000, clicks: 20, leads: 10, frequency: 1.5,
        ads: {
          ad_account_id: 'account-a', ad_name: 'Good Meta CPL', creative_id: 'creative-a',
          delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] },
          delivery_sub_status_read_available: true,
          delivery_sub_status_synced_at: '2026-08-01T20:00:00.000Z',
        },
      },
      {
        ad_account_id: 'account-a', entity_level: 'ad', ad_id: 'ad-bad', date_start: RECENT_DATE,
        spend: 500, impressions: 1_000, clicks: 20, leads: 1, frequency: 1.5,
        ads: {
          ad_account_id: 'account-a', ad_name: 'Bad Meta CPL', creative_id: 'creative-a',
          delivery_sub_status: null,
          delivery_sub_status_read_available: true,
          delivery_sub_status_synced_at: '2026-08-01T20:01:00.000Z',
        },
      },
      {
        ad_account_id: 'account-b', entity_level: 'ad', ad_id: 'ad-other', date_start: RECENT_DATE,
        spend: 9_999, impressions: 99_999, clicks: 1, leads: 0, frequency: 9,
        ads: {
          ad_account_id: 'account-b', ad_name: 'Other account', creative_id: 'creative-b',
          delivery_sub_status: null,
          delivery_sub_status_read_available: false,
          delivery_sub_status_synced_at: null,
        },
      },
    ]
    state.rows.creatives = [
      { id: 'creative-a', ad_account_id: 'account-a', asset_type: 'video' },
      { id: 'creative-b', ad_account_id: 'account-b', asset_type: 'image' },
    ]
  })

  it('scopes delivery and creative reads to one active account and returns diagnostic-only evidence', async () => {
    const { getCreativeFatigue } = await import('@/mcp/tools/creative-fatigue')
    const result = await getCreativeFatigue({ start_date: RECENT_DATE, end_date: RECENT_DATE }) as {
      status: string
      action_authority_tier: string
      prescriptions: unknown[]
      ads: Array<Record<string, unknown>>
    }

    expect(result.status).toBe('available')
    expect(result.action_authority_tier).toBe('diagnostic_only')
    expect(result.prescriptions).toEqual([])
    expect(result.ads.map((ad) => ad.ad_id)).toEqual(['ad-bad', 'ad-good'])
    expect(result.ads.every((ad) => ad.action_authority_tier === 'diagnostic_only')).toBe(true)
    expect(result.ads.every((ad) => Array.isArray(ad.prescriptions) && ad.prescriptions.length === 0)).toBe(true)
    expect(result.ads.some((ad) => ad.ad_id === 'ad-other')).toBe(false)
    expect(result.ads.find((ad) => ad.ad_id === 'ad-good')?.delivery_sub_status).toEqual({
      read_available: true,
      payload: { status: 'warning', substatuses: ['creative_fatigue'] },
      synced_at: '2026-08-01T20:00:00.000Z',
    })
    expect(result.ads.find((ad) => ad.ad_id === 'ad-bad')?.delivery_sub_status).toEqual({
      read_available: true,
      payload: null,
      synced_at: '2026-08-01T20:01:00.000Z',
    })
    expect(state.calls).toEqual(expect.arrayContaining([
      { table: 'daily_insights', op: 'eq', column: 'ad_account_id', value: 'account-a' },
      { table: 'daily_insights', op: 'eq', column: 'ads.ad_account_id', value: 'account-a' },
      { table: 'creatives', op: 'eq', column: 'ad_account_id', value: 'account-a' },
    ]))
  })

  it('does not translate a 50x Meta-CPL difference into different authority or direction', async () => {
    const { getCreativeFatigue } = await import('@/mcp/tools/creative-fatigue')
    const result = await getCreativeFatigue({ start_date: RECENT_DATE, end_date: RECENT_DATE }) as {
      ads: Array<Record<string, unknown>>
    }
    const bad = result.ads.find((ad) => ad.ad_id === 'ad-bad')
    const good = result.ads.find((ad) => ad.ad_id === 'ad-good')

    expect(bad?.meta_cpl_estimate).toBe(500)
    expect(good?.meta_cpl_estimate).toBe(10)
    for (const key of ['action_authority_tier', 'evidence_state', 'observation', 'prescriptions']) {
      expect(bad?.[key], key).toEqual(good?.[key])
    }
    expect(JSON.stringify([bad, good])).not.toMatch(/\b(pause|refresh|scale|kill|retire|increase budget|decrease budget)\b/i)
  })

  it('falls back to delivery evidence unavailable when production lacks optional delivery columns', async () => {
    state.missingDeliveryColumns = true

    const { getCreativeFatigue } = await import('@/mcp/tools/creative-fatigue')
    const result = await getCreativeFatigue({ start_date: RECENT_DATE, end_date: RECENT_DATE }) as {
      status: string
      ads: Array<Record<string, unknown>>
    }

    expect(result.status).toBe('available')
    expect(result.ads.map((ad) => ad.ad_id)).toEqual(['ad-bad', 'ad-good'])
    expect(result.ads.find((ad) => ad.ad_id === 'ad-good')?.delivery_sub_status).toEqual({
      read_available: false,
      payload: null,
      synced_at: null,
    })
    expect(result.ads.find((ad) => ad.ad_id === 'ad-bad')?.delivery_sub_status).toEqual({
      read_available: false,
      payload: null,
      synced_at: null,
    })
  })

  it('fails explicitly without querying delivery when active-account ownership is ambiguous', async () => {
    state.resolution = { ok: false, reason: 'ambiguous' }
    const { getCreativeFatigue } = await import('@/mcp/tools/creative-fatigue')
    const result = await getCreativeFatigue({ start_date: RECENT_DATE, end_date: RECENT_DATE }) as Record<string, unknown>

    expect(result).toMatchObject({
      status: 'unavailable',
      error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      ads: [],
    })
    expect(state.calls).toEqual([])
  })

  it('structurally removes the hard-coded alternate fatigue decision path', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/mcp/tools/creative-fatigue.ts'), 'utf8')
    const definition = fs.readFileSync(
      path.join(process.cwd(), 'src/mcp/tools/tool-definitions-primary.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/fatigueGuidance|decideActionAuthority|ActionCandidate|fatigue_score|fatigue_level/)
    expect(source).not.toMatch(/cpl\s*>\s*50|recommendation\s*:|approval_required|action_allowed_now/)
    expect(source).not.toMatch(/kind:\s*['"](?:pause|creative_refresh|scale|kill)['"]/)
    expect(source).toMatch(/\.eq\('ad_account_id', adAccountId\)/)
    expect(source).toMatch(/\.eq\('ads\.ad_account_id', adAccountId\)/)
    expect(definition).toMatch(/get_creative_performance[\s\S]{0,700}?prescriptions is always empty/i)
  })
})
