import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAiEnv } from './helpers/ai-stub'

vi.mock('@sentry/nextjs', () => ({ captureRequestError: () => undefined }))
vi.mock('@/sentry.server.config', () => ({}))

/** Startup validation: a bad AI configuration is reported by NAME, and the app still starts. */
describe('AI configuration at startup', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('logs each invalid variable, never a value, and does not throw', async () => {
    useAiEnv({ AI_PROVIDER: 'foundry', ANTHROPIC_FOUNDRY_API_KEY: 'zz-marker-9' })
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { register } = await import('@/instrumentation')

    await expect(register()).resolves.toBeUndefined()

    const logged = error.mock.calls.flat().join('\n')
    expect(logged).toMatch(/ANTHROPIC_FOUNDRY_RESOURCE/)
    expect(logged).toMatch(/AI is disabled/)
    expect(logged).not.toContain('zz-marker-9')
  })

  it('announces the provider and model when configured', async () => {
    useAiEnv({ ANTHROPIC_API_KEY: 'k-test-1' })
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { register } = await import('@/instrumentation')
    await register()
    expect(info.mock.calls.flat().join('\n')).toContain('[AI] provider=anthropic model=claude-opus-5-5')
  })
})
