// Offline stand-ins for Supabase (REST, Auth, Auth admin) and the Meta Graph API, for the setup and
// doctor checks. Every request is recorded; anything unrouted answers 599 so a test sees it.

export interface FakeState {
  disableSignup: boolean
  autoconfirm: boolean
  openApiTables: string[]
  restStatus: number
  users: Array<{ id: string; email: string; email_confirmed_at: string | null }>
  outcomeSources: Array<{ kind: string; enabled: boolean }>
  metaScopes: string[]
  metaAccount: { name: string; currency: string; timezone_name: string; account_status: number } | null
  metaError: string | null
  createdUsers: Array<Record<string, unknown>>
}

export const OWNER_ID = '11111111-2222-4333-8444-555555555555'

export function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    disableSignup: true,
    autoconfirm: false,
    openApiTables: ['ad_accounts', 'outcome_sources', 'outcome_source_secrets', 'expert_insight_judge_attempts', 'outcome_csv_imports'],
    restStatus: 200,
    users: [{ id: OWNER_ID, email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }],
    outcomeSources: [{ kind: 'webhook', enabled: true }],
    metaScopes: ['ads_read'],
    metaAccount: { name: 'Example Ads', currency: 'USD', timezone_name: 'America/New_York', account_status: 1 },
    metaError: null,
    createdUsers: [],
    ...overrides,
  }
}

export interface FakeCall { method: string; url: string; headers: Record<string, string> }

export function fakeFetch(state: FakeState, calls: FakeCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const method = init.method ?? 'GET'
    calls.push({ method, url: url.toString(), headers })
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    if (url.hostname === 'graph.facebook.com') {
      if (state.metaError) return json({ error: { message: state.metaError } }, 400)
      if (url.pathname.endsWith('/me/permissions')) return json({ data: state.metaScopes.map((permission) => ({ permission, status: 'granted' })) })
      return state.metaAccount ? json(state.metaAccount) : json({ error: { message: 'Unsupported get request.' } }, 400)
    }
    if (url.pathname === '/auth/v1/settings') return json({ disable_signup: state.disableSignup, mailer_autoconfirm: state.autoconfirm })
    if (url.pathname === '/auth/v1/admin/users' && method === 'GET') return json({ users: state.users })
    if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      state.createdUsers.push(body)
      if (state.users.some((u) => u.email === body.email)) return json({ code: 422, error_code: 'email_exists', msg: 'exists' }, 422)
      const user = { id: '22222222-2222-4333-8444-555555555555', email: String(body.email), email_confirmed_at: '2026-11-07T00:00:00Z' }
      state.users.push(user)
      return json(user)
    }
    if (url.pathname === '/rest/v1/') {
      if (state.restStatus !== 200) return json({ message: 'denied' }, state.restStatus)
      return json({ paths: Object.fromEntries(state.openApiTables.map((t) => [`/${t}`, {}])) })
    }
    if (url.pathname === '/rest/v1/outcome_sources') return json(state.outcomeSources)
    return json({ message: 'unrouted' }, 599)
  }) as typeof fetch
}
