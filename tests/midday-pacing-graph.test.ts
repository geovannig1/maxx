import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Characterization of GET /api/sync/midday's Meta reads (the v1 release moved them into the Meta
// platform module). Pins the exact request URLs, the header-only credential, paging, and the partial-
// read rules: a campaign-budget failure keeps earlier pages, an ad-set transport failure discards the
// ad-set read, an ad-set Graph error keeps earlier pages, and an insights Graph error is a 502.

const state = vi.hoisted(() => ({ alerts: [] as unknown[] }))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'order', 'limit']) builder[m] = () => builder
      builder.maybeSingle = async () => (table === 'ad_accounts'
        ? { data: { id: 'db-account-1' }, error: null }
        : { data: { completed_at: new Date().toISOString() }, error: null })
      return builder
    },
  }),
}))
vi.mock('@/lib/alerts/insert', () => ({
  insertAlertsDeduped: vi.fn(async (_db: unknown, rows: unknown[]) => {
    state.alerts.push(...rows)
    return { inserted: rows.length, skipped: 0, error: null }
  }),
}))
vi.mock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))

const CRON_SECRET_VALUE = 'test-only-secret-that-is-long-enough-for-hmac'
const META_TOKEN_VALUE = 'EAA-midday-secret'
type Page = { data?: unknown[]; paging?: { next?: string }; error?: { message: string; code: number } }
type Reply = Page | Error

function graphFetch(routes: Record<string, Reply>) {
  const calls: Array<{ url: string; authorization: string | null }> = []
  const spy = vi.fn(async (input: string, init: RequestInit) => {
    calls.push({ url: input, authorization: new Headers(init.headers).get('authorization') })
    const u = new URL(input)
    const key = `${u.pathname.split('/').pop()}:${u.searchParams.get('after') ?? '1'}`
    const reply = routes[key]
    if (!reply) throw new Error(`unexpected Graph request ${key}`)
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', spy)
  return calls
}

const next = (edge: string) => `https://graph.facebook.com/v25.0/act_123/${edge}?after=2&access_token=leaked-copy`

async function runMidday() {
  const { GET } = await import('@/app/api/sync/midday/route')
  const res = await GET(new Request('https://maxx.example/api/sync/midday', {
    headers: { authorization: `Bearer ${CRON_SECRET_VALUE}` },
  }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('midday pacing Meta reads', () => {
  beforeEach(() => {
    vi.resetModules()
    state.alerts = []
    vi.stubEnv('CRON_SECRET', CRON_SECRET_VALUE)
    vi.stubEnv('META_ACCESS_TOKEN', META_TOKEN_VALUE)
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    vi.stubEnv('META_API_VERSION', 'v25.0')
    vi.stubEnv('META_APPSECRET_PROOF_ENABLED', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reads every page with header auth; keeps campaign budgets read before a failure; merges ad-set budgets read before a Graph error', async () => {
    const calls = graphFetch({
      'insights:1': { data: [{ campaign_id: 'c1', campaign_name: 'One', spend: '10.00' }], paging: { next: next('insights') } },
      'insights:2': { data: [{ campaign_id: 'c2', spend: '5' }] },
      'campaigns:1': { data: [{ id: 'c1', name: 'One', daily_budget: '4000' }], paging: { next: next('campaigns') } },
      'campaigns:2': new TypeError('network down'),
      'adsets:1': { data: [{ id: 's1', campaign_id: 'c2', daily_budget: '1000' }], paging: { next: next('adsets') } },
      'adsets:2': { error: { message: 'rate limited', code: 17 } },
    })

    const { status, body } = await runMidday()

    expect(status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([
      'https://graph.facebook.com/v25.0/act_123/insights?date_preset=today&level=campaign&fields=campaign_id%2Ccampaign_name%2Cspend&limit=200',
      'https://graph.facebook.com/v25.0/act_123/insights?after=2',
      'https://graph.facebook.com/v25.0/act_123/campaigns?fields=id%2Cname%2Cdaily_budget&effective_status=%5B%22ACTIVE%22%5D&limit=100',
      'https://graph.facebook.com/v25.0/act_123/campaigns?after=2',
      'https://graph.facebook.com/v25.0/act_123/adsets?fields=id%2Ccampaign_id%2Cdaily_budget&effective_status=%5B%22ACTIVE%22%5D&limit=200',
      'https://graph.facebook.com/v25.0/act_123/adsets?after=2',
    ])
    for (const call of calls) {
      expect(call.url).not.toContain(META_TOKEN_VALUE)
      expect(call.authorization).toBe(`Bearer ${META_TOKEN_VALUE}`)
    }
    const campaigns = body.campaigns as Array<Record<string, unknown>>
    expect(campaigns.map(({ campaign_id, campaign_name, spend_today, pacing_pct }) => (
      { campaign_id, campaign_name, spend_today, pacing_pct }
    ))).toEqual([
      { campaign_id: 'c1', campaign_name: 'One', spend_today: 10, pacing_pct: 25 },
      { campaign_id: 'c2', campaign_name: null, spend_today: 5, pacing_pct: 50 },
    ])
  })

  it('discards the ad-set read when a page fails in transport; a campaign Graph error keeps earlier pages', async () => {
    graphFetch({
      'insights:1': { data: [{ campaign_id: 'c1', spend: '10' }, { campaign_id: 'c2', spend: '5' }] },
      'campaigns:1': { data: [{ id: 'c1', daily_budget: '2000' }], paging: { next: next('campaigns') } },
      'campaigns:2': { error: { message: 'bad cursor', code: 100 } },
      'adsets:1': { data: [{ id: 's1', campaign_id: 'c2', daily_budget: '1000' }], paging: { next: next('adsets') } },
      'adsets:2': new TypeError('socket hang up'),
    })

    const { status, body } = await runMidday()

    expect(status).toBe(200)
    const pacing = Object.fromEntries((body.campaigns as Array<Record<string, unknown>>)
      .map((c) => [c.campaign_id, c.pacing_pct]))
    expect(pacing).toEqual({ c1: 50, c2: null })
  })

  it('returns 502 when an insights page carries a Graph error, without reading budgets', async () => {
    const calls = graphFetch({
      'insights:1': { data: [{ campaign_id: 'c1', spend: '10' }], paging: { next: next('insights') } },
      'insights:2': { error: { message: 'Invalid OAuth access token', code: 190 } },
    })

    const { status, body } = await runMidday()

    expect(status).toBe(502)
    expect(body.code).toBe('META_INSIGHTS_FAILED')
    expect(calls).toHaveLength(2)
    expect(state.alerts).toEqual([])
  })
})
