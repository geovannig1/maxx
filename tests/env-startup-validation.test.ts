import { describe, expect, it, vi } from 'vitest'
import { reportStartupConfiguration } from '@/config/startup'
import { dashboardBlockers, validateEnv } from '@/config/env'
import { demoState } from '@/config/demo'

// the server validates its environment at startup and names every problem by variable, never by
// value, without stopping (the setup checklist needs a running app). Demo mode in production is the
// one fatal case.

const PLANTED_VALUE = 'sk-planted-value-0123456789abcdef'
const COMPLETE = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture-0123456789',
  OWNER_EMAIL: 'owner@example.test',
  CRON_SECRET: 'c'.repeat(64),
  META_ACCESS_TOKEN: PLANTED_VALUE,
  META_AD_ACCOUNT_ID: 'act_123',
  APP_URL: 'https://maxx.example.test',
}

function capture(env: Record<string, string | undefined>) {
  const log = { error: vi.fn(), info: vi.fn() }
  reportStartupConfiguration(env, log)
  return { log, text: [...log.error.mock.calls, ...log.info.mock.calls].flat().join('\n') }
}

describe('startup configuration report', () => {
  it('names a missing and an invalid variable, never a value, and does not throw', () => {
    const { log, text } = capture({ ...COMPLETE, NODE_ENV: 'production', OWNER_EMAIL: '', META_AD_ACCOUNT_ID: '123', SUPABASE_SERVICE_ROLE_KEY: 'short' })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(text).toContain('OWNER_EMAIL is not set')
    expect(text).toContain('META_AD_ACCOUNT_ID must be act_ followed by digits')
    expect(text).toContain('SUPABASE_SERVICE_ROLE_KEY must be a key of at least 20 characters')
    expect(text).not.toContain('short')
    expect(text).not.toContain(PLANTED_VALUE)
  })

  it('control: a complete environment logs no error', () => {
    const { log } = capture({ ...COMPLETE, NODE_ENV: 'production' })
    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('[config] environment valid.')
  })

  it('production-only requirements apply only in production', () => {
    const env = { ...COMPLETE, CRON_SECRET: '' }
    expect(validateEnv({ ...env, NODE_ENV: 'development' }).map((i) => i.name)).toEqual([])
    expect(validateEnv({ ...env, VERCEL_ENV: 'production' }).map((i) => i.name)).toEqual(['CRON_SECRET'])
  })

  it('OWNER_EMAIL is required in every environment: unset, the owner gate denies everyone', () => {
    const env = { ...COMPLETE, OWNER_EMAIL: '' }
    expect(validateEnv({ ...env, NODE_ENV: 'development' }).map((i) => i.name)).toEqual(['OWNER_EMAIL'])
    expect(validateEnv({ ...env, VERCEL_ENV: 'production' }).map((i) => i.name)).toEqual(['OWNER_EMAIL'])
    expect(validateEnv({ ...COMPLETE, NODE_ENV: 'development' })).toEqual([])
  })

  it('APP_URL is required in production off Vercel only (next start sees localhost)', () => {
    const env = { ...COMPLETE, APP_URL: '' }
    expect(validateEnv({ ...env, NODE_ENV: 'production' }).map((i) => i.name)).toEqual(['APP_URL'])
    expect(validateEnv({ ...env, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production' })).toEqual([])
    expect(validateEnv({ ...env, NODE_ENV: 'development' })).toEqual([])
  })

  it('an all-or-nothing group is required once started, and Meta blocks only the dashboard', () => {
    const issues = validateEnv({ ...COMPLETE, META_ACCESS_TOKEN: '', PAID_TOUCH_ALLOWED_ORIGINS: 'https://www.example.com' })
    expect(issues.find((i) => i.name === 'META_ACCESS_TOKEN')?.blocks).toBe('dashboard')
    expect(issues.filter((i) => i.blocks === 'feature').map((i) => i.name).sort())
      .toEqual(['ACUITY_PAID_TOUCH_FIELD_ID', 'PAID_TOUCH_ALLOWED_LANDING_HOSTS', 'PAID_TOUCH_TOKEN_SECRET'])
    expect(dashboardBlockers({ ...COMPLETE, META_ACCESS_TOKEN: '' }).map((i) => i.name)).toEqual(['META_ACCESS_TOKEN'])
    expect(dashboardBlockers(COMPLETE)).toEqual([])
    // A missing cron secret in production is a checklist item, not a reason to hide the dashboard.
    expect(dashboardBlockers({ ...COMPLETE, CRON_SECRET: '', NODE_ENV: 'production' })).toEqual([])
    expect(dashboardBlockers({ ...COMPLETE, OWNER_EMAIL: '', NODE_ENV: 'production' }).map((i) => i.name)).toEqual(['OWNER_EMAIL'])
  })

  it('refuses demo mode in production and on Vercel (fatal), and allows it locally', () => {
    expect(() => capture({ MAXX_DEMO: '1', NODE_ENV: 'production' })).toThrow(/MAXX_DEMO=1 is refused/)
    expect(() => capture({ MAXX_DEMO: '1', NODE_ENV: 'development', VERCEL: '1' })).toThrow(/MAXX_DEMO=1 is refused/)
    expect(demoState({ MAXX_DEMO: '1', NODE_ENV: 'development' })).toBe('on')
    expect(demoState({ MAXX_DEMO: '0', NODE_ENV: 'production' })).toBe('off')
    const { log } = capture({ MAXX_DEMO: '1', NODE_ENV: 'development' })
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('demo mode'))
  })
})

describe('demo mode is refused where the app is built or started for production', () => {
  it('next.config.ts refuses MAXX_DEMO=1 under NODE_ENV=production, and loads without it (control)', async () => {
    vi.resetModules()
    vi.stubEnv('MAXX_DEMO', '1')
    vi.stubEnv('NODE_ENV', 'production')
    await expect(import('../next.config')).rejects.toThrow(/MAXX_DEMO=1 is refused/)
    vi.resetModules()
    vi.stubEnv('MAXX_DEMO', '')
    await expect(import('../next.config')).resolves.toBeTruthy()
    vi.unstubAllEnvs()
  })

  it('the instrumentation hook runs the startup report in the Node.js runtime', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('MAXX_DEMO', '1')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.doMock('@/sentry.server.config', () => ({}))
    const { register } = await import('@/instrumentation')
    await expect(register()).rejects.toThrow(/MAXX_DEMO=1 is refused/)
    vi.doUnmock('@/sentry.server.config')
    vi.unstubAllEnvs()
  })
})
