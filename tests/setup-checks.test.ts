import { describe, expect, it, vi } from 'vitest'
import { runChecks, type CheckResult } from '@/lib/setup/checks'
import { META_API_VERSION } from '@/lib/platforms/meta/api-version'
import { OWNER_ID, fakeFetch, fakeState, type FakeCall } from './helpers/fake-services'

// the one checks module behind setup, doctor and the in-app checklist. All network goes through
// an injected fetch (offline fakes here). Each bad case is paired with its good control.

const META_CREDENTIAL = 'EAAG-planted-meta-credential-0123456789'
const SERVICE = 'service-role-planted-0123456789abcdef'
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  OWNER_EMAIL: 'owner@example.test',
  OWNER_USER_ID: OWNER_ID,
  CRON_SECRET: 'c'.repeat(64),
  META_ACCESS_TOKEN: META_CREDENTIAL,
  META_AD_ACCOUNT_ID: 'act_123',
  META_APPSECRET_PROOF_ENABLED: 'true',
  META_APP_SECRET: 'app-secret-planted-0123456789',
  AI_PROVIDER: 'none',
}

async function run(state = fakeState(), env: Record<string, string> = ENV, options = {}) {
  const calls: FakeCall[] = []
  const summary = await runChecks(env, { fetch: fakeFetch(state, calls), nodeVersion: '24.1.0' }, options)
  const byId = (id: string): CheckResult | undefined => summary.checks.find((c) => c.id === id)
  return { summary, calls, byId }
}

describe('Supabase auth settings check', () => {
  it('warns with exact dashboard steps when sign-ups are open or emails auto-confirm', async () => {
    const { byId } = await run(fakeState({ disableSignup: false, autoconfirm: true }))
    expect(byId('supabase.signup_disabled')).toMatchObject({ level: 'warn', fix: expect.stringContaining('Allow new users to sign up') })
    expect(byId('supabase.email_confirmation')).toMatchObject({ level: 'warn', fix: expect.stringContaining('Confirm email') })
  })

  it('control: disable_signup true and mailer_autoconfirm false pass, read with the anon key', async () => {
    const { byId, calls } = await run()
    expect(byId('supabase.signup_disabled')?.level).toBe('ok')
    expect(byId('supabase.email_confirmation')?.level).toBe('ok')
    const settings = calls.find((c) => c.url.endsWith('/auth/v1/settings'))
    expect(settings?.headers.apikey).toBe(ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  })
})

describe('owner email', () => {
  // The owner gate denies everyone when OWNER_EMAIL is unset, in development too
  // (src/lib/auth/owner.ts), so the owner check must not pass without it in any environment.
  it('fails when OWNER_EMAIL is unset outside production', async () => {
    const env: Record<string, string> = { ...ENV, NODE_ENV: 'development' }
    delete env.OWNER_EMAIL
    const { summary } = await run(fakeState(), env, { offline: true })
    const owner = summary.checks.filter((c) => c.integration === 'owner')
    expect(owner.some((c) => c.level === 'fail' && c.title === 'OWNER_EMAIL')).toBe(true)
    expect(owner.some((c) => c.level === 'ok')).toBe(false)
  })

  it('control: a set OWNER_EMAIL passes the owner configuration check and names it', async () => {
    const { byId } = await run(fakeState(), { ...ENV, NODE_ENV: 'development' }, { offline: true })
    expect(byId('owner.env')).toMatchObject({ level: 'ok', detail: expect.stringContaining('OWNER_EMAIL') })
    expect(byId('supabase.env')?.detail).toContain('NEXT_PUBLIC_SUPABASE_URL')
  })
})

describe('database schema and owner', () => {
  it('names the first missing marker table', async () => {
    const { byId } = await run(fakeState({ openApiTables: ['ad_accounts', 'outcome_sources'] }))
    expect(byId('supabase.schema')).toMatchObject({ level: 'fail', detail: expect.stringContaining('table outcome_source_secrets is missing') })
    expect((await run()).byId('supabase.schema')?.level).toBe('ok')
  })

  it('a rejected service-role key fails and stops the schema check', async () => {
    const { byId } = await run(fakeState({ restStatus: 401 }))
    expect(byId('supabase.reachable')).toMatchObject({ level: 'fail', fix: expect.stringContaining('SUPABASE_SERVICE_ROLE_KEY') })
    expect(byId('supabase.schema')).toBeUndefined()
  })

  it('fails a missing owner, an unconfirmed owner and a mismatched pin; passes the pinned owner', async () => {
    expect((await run(fakeState({ users: [] }))).byId('owner.user')?.level).toBe('fail')
    expect((await run(fakeState({ users: [{ id: OWNER_ID, email: 'owner@example.test', email_confirmed_at: null }] }))).byId('owner.user')?.level).toBe('fail')
    const mismatch = await run(fakeState(), { ...ENV, OWNER_USER_ID: '99999999-2222-4333-8444-555555555555' })
    expect(mismatch.byId('owner.pin_match')).toMatchObject({ level: 'fail', fix: `Set OWNER_USER_ID=${OWNER_ID}.` })
    const ok = await run()
    expect(ok.byId('owner.user')?.level).toBe('ok')
    expect(ok.byId('owner.pin_match')).toBeUndefined()
  })
})

describe('Meta check', () => {
  it("uses the app's pinned Graph version, header auth and appsecret_proof, never the token in a URL", async () => {
    const { calls, byId } = await run()
    const meta = calls.filter((c) => c.url.includes('graph.facebook.com'))
    expect(meta.length).toBe(2)
    for (const call of meta) {
      expect(call.url).toContain(`/${META_API_VERSION}/`)
      expect(call.url).not.toContain('/v23.0/')
      expect(call.url).not.toContain(META_CREDENTIAL)
      expect(call.url).toContain('appsecret_proof=')
      expect(call.headers.authorization).toBe(`Bearer ${META_CREDENTIAL}`)
    }
    expect(byId('meta.token')?.level).toBe('ok')
    expect(byId('meta.account')?.level).toBe('ok')
  })

  it('fails without ads_read, and warns on ads_management with writes off', async () => {
    expect((await run(fakeState({ metaScopes: ['pages_show_list'] }))).byId('meta.token')?.level).toBe('fail')
    expect((await run(fakeState({ metaScopes: ['ads_management', 'ads_read'] }))).byId('meta.least_privilege')?.level).toBe('warn')
  })

  it('refuses an ad account whose timezone or currency differs from configuration, naming the variable', async () => {
    const { byId } = await run(fakeState({ metaAccount: { name: 'X', currency: 'EUR', timezone_name: 'Europe/Berlin', account_status: 1 } }))
    expect(byId('meta.timezone')).toMatchObject({ level: 'fail', fix: 'Set NEXT_PUBLIC_ACCOUNT_TIMEZONE=Europe/Berlin and rebuild.' })
    expect(byId('meta.currency')).toMatchObject({ level: 'fail', fix: 'Set NEXT_PUBLIC_ACCOUNT_CURRENCY=EUR and rebuild.' })
    const matching = await run(fakeState({ metaAccount: { name: 'X', currency: 'EUR', timezone_name: 'Europe/Berlin', account_status: 1 } }),
      { ...ENV, NEXT_PUBLIC_ACCOUNT_TIMEZONE: 'Europe/Berlin', NEXT_PUBLIC_ACCOUNT_CURRENCY: 'EUR' })
    expect(matching.byId('meta.timezone')).toBeUndefined()
    expect(matching.byId('meta.currency')).toBeUndefined()
  })
})

describe('outcome sources, AI and output safety', () => {
  it('warns when no outcome source is enabled; passes with one', async () => {
    expect((await run(fakeState({ outcomeSources: [{ kind: 'csv', enabled: false }] }))).byId('outcomes.sources')?.level).toBe('warn')
    expect((await run()).byId('outcomes.sources')?.level).toBe('ok')
  })

  it('without Meta, the outcome-source fix says the ad account comes first', async () => {
    const none = fakeState({ outcomeSources: [] })
    const noMeta: Record<string, string> = { ...ENV }
    delete noMeta.META_ACCESS_TOKEN
    expect((await run(none, noMeta)).byId('outcomes.sources')?.fix).toMatch(/^Connect Meta first/)
    expect((await run(none)).byId('outcomes.sources')?.fix).toMatch(/^Enable a source/)
  })

  it("asks each enabled source's own adapter whether its values are set", async () => {
    const missing = await run(fakeState({ outcomeSources: [{ kind: 'acuity', enabled: true }] }))
    expect(missing.byId('outcomes.adapter.acuity')).toMatchObject({ level: 'fail', detail: expect.stringContaining('credentials not set') })
    const set = await run(fakeState({ outcomeSources: [{ kind: 'acuity', enabled: true }] }), { ...ENV, ACUITY_USER_ID: '123', ACUITY_API_KEY: 'acuity-fixture-key' })
    expect(set.byId('outcomes.adapter.acuity')).toBeUndefined()
    expect((await run(fakeState({ outcomeSources: [{ kind: 'mystery', enabled: true }] }))).byId('outcomes.adapter.mystery')?.level).toBe('fail')
  })

  it('offline mode makes no request at all', async () => {
    const { calls, summary } = await run(fakeState(), ENV, { offline: true })
    expect(calls).toEqual([])
    expect(summary.checks.find((c) => c.id === 'network.skipped')?.level).toBe('skip')
  })

  it('the live AI probe runs only when asked', async () => {
    const aiProbe = vi.fn(async () => 'anthropic/claude-opus-5-5 answered (stop: end_turn).')
    const deps = { fetch: fakeFetch(fakeState()), nodeVersion: '24.1.0', aiProbe }
    await runChecks(ENV, deps, {})
    expect(aiProbe).not.toHaveBeenCalled()
    const live = await runChecks(ENV, deps, { live: true })
    expect(aiProbe).toHaveBeenCalledTimes(1)
    expect(live.checks.find((c) => c.id === 'ai.live')?.level).toBe('ok')
  })

  it('never returns a secret, even when a provider echoes one back', async () => {
    const { summary } = await run(fakeState({ metaError: `Invalid OAuth access token ${META_CREDENTIAL} (${SERVICE})` }), { ...ENV, GA4_PROPERTY_ID: '1', GA4_SERVICE_ACCOUNT_JSON: 'not json' })
    const text = JSON.stringify(summary)
    expect(text).toContain('[redacted]')
    for (const secret of [META_CREDENTIAL, SERVICE, ENV.META_APP_SECRET, 'not json']) expect(text).not.toContain(secret)
  })

  it('reports configuration problems by variable and limits to the requested integration', async () => {
    const { summary } = await run(fakeState(), { ...ENV, META_AD_ACCOUNT_ID: '123' }, { only: ['meta'] })
    expect(summary.checks.every((c) => c.integration === 'meta' || c.integration === 'business')).toBe(true)
    expect(summary.checks.find((c) => c.id === 'meta.env.META_AD_ACCOUNT_ID')).toMatchObject({ level: 'fail', fix: expect.stringContaining('act_') })
    expect(summary.ok).toBe(false)
  })
})
