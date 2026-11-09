import { describe, expect, it } from 'vitest'
import { aiStatus, readAiConfig } from '@/lib/ai/config'

/**
 * Provider selection and validation for the AI gateway. Every case passes an explicit env record,
 * so nothing here depends on the shell. Fake credential values are short on purpose.
 */

const MARKER = 'zz-marker-9'

function errorsOf(env: Record<string, string | undefined>): string[] {
  const result = readAiConfig(env)
  if (result.ok) throw new Error(`expected a configuration error, got provider ${result.config.provider}`)
  return result.errors
}

describe('AI provider selection', () => {
  it('is OFF when nothing is configured (no provider, no key)', () => {
    const result = readAiConfig({})
    expect(result).toEqual({ ok: true, config: { provider: 'none', inferred: true } })
    expect(aiStatus({})).toEqual({ state: 'off', inferred: true })
  })

  it('infers the Claude API from a present ANTHROPIC_API_KEY, with the documented defaults', () => {
    const result = readAiConfig({ ANTHROPIC_API_KEY: 'k-test-1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config).toMatchObject({
      provider: 'anthropic', family: 'anthropic', model: 'claude-opus-5-5',
      effort: 'medium', fallbacks: 'default', inferred: true,
    })
    expect(aiStatus({ ANTHROPIC_API_KEY: 'k-test-1' })).toEqual({
      state: 'on', provider: 'anthropic', family: 'anthropic', model: 'claude-opus-5-5',
    })
  })

  it('honours AI_PROVIDER=none even when a key is present', () => {
    const env = { AI_PROVIDER: 'none', ANTHROPIC_API_KEY: 'k-test-1' }
    expect(readAiConfig(env)).toEqual({ ok: true, config: { provider: 'none', inferred: false } })
    expect(aiStatus(env).state).toBe('off')
  })

  it('rejects an unknown provider and names the allowed values', () => {
    const [error] = errorsOf({ AI_PROVIDER: 'gpt' })
    expect(error).toMatch(/AI_PROVIDER/)
    for (const name of ['anthropic', 'bedrock', 'vertex', 'foundry', 'openai-compatible', 'none']) {
      expect(error).toContain(name)
    }
    expect(aiStatus({ AI_PROVIDER: 'gpt' }).state).toBe('misconfigured')
  })

  it('requires a Claude credential for AI_PROVIDER=anthropic', () => {
    expect(errorsOf({ AI_PROVIDER: 'anthropic' }).join('\n')).toMatch(/ANTHROPIC_API_KEY/)
    expect(readAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_AUTH_TOKEN: 't-test-1' }).ok).toBe(true)
  })

  it('treats a whitespace-only key as absent', () => {
    expect(readAiConfig({ ANTHROPIC_API_KEY: '   ' })).toEqual({ ok: true, config: { provider: 'none', inferred: true } })
  })
})

describe('Anthropic platform providers', () => {
  it('bedrock needs a region, defaults to the Bedrock model id and has no default fallback', () => {
    expect(errorsOf({ AI_PROVIDER: 'bedrock' }).join('\n')).toMatch(/AWS_REGION/)
    const result = readAiConfig({ AI_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' })
    expect(result.ok && result.config).toMatchObject({
      provider: 'bedrock', family: 'anthropic', model: 'anthropic.claude-opus-5-5',
      fallbacks: 'off', region: 'us-east-1',
    })
    expect(readAiConfig({ AI_PROVIDER: 'bedrock', AWS_DEFAULT_REGION: 'eu-west-1' }).ok).toBe(true)
  })

  it('refuses server-side default fallbacks where the platform has none', () => {
    for (const provider of ['bedrock', 'vertex', 'foundry']) {
      const env = {
        AI_PROVIDER: provider, AI_FALLBACKS: 'default', AWS_REGION: 'us-east-1',
        ANTHROPIC_FOUNDRY_API_KEY: 'k-test-1', ANTHROPIC_FOUNDRY_RESOURCE: 'res',
      }
      expect(errorsOf(env).join('\n')).toMatch(/AI_FALLBACKS/)
    }
  })

  it('accepts an explicit fallback model list on a platform', () => {
    const result = readAiConfig({
      AI_PROVIDER: 'vertex', AI_FALLBACKS: 'claude-opus-5, claude-opus-4-8',
    })
    expect(result.ok && result.config).toMatchObject({
      provider: 'vertex', model: 'claude-opus-5-5', region: 'global',
      fallbacks: ['claude-opus-5', 'claude-opus-4-8'],
    })
  })

  it('vertex passes an explicit project and region through', () => {
    const result = readAiConfig({
      AI_PROVIDER: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'proj-1', CLOUD_ML_REGION: 'us-east5',
    })
    expect(result.ok && result.config).toMatchObject({ projectId: 'proj-1', region: 'us-east5' })
  })

  it('foundry needs a key and a resource (or base URL)', () => {
    const errors = errorsOf({ AI_PROVIDER: 'foundry' }).join('\n')
    expect(errors).toMatch(/ANTHROPIC_FOUNDRY_API_KEY/)
    expect(errors).toMatch(/ANTHROPIC_FOUNDRY_RESOURCE/)
    expect(readAiConfig({
      AI_PROVIDER: 'foundry', ANTHROPIC_FOUNDRY_API_KEY: 'k-test-1', ANTHROPIC_FOUNDRY_RESOURCE: 'res',
    }).ok).toBe(true)
    expect(readAiConfig({
      AI_PROVIDER: 'foundry', ANTHROPIC_FOUNDRY_API_KEY: 'k-test-1',
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://res.services.ai.azure.com/anthropic/',
    }).ok).toBe(true)
  })
})

describe('OpenAI-compatible provider', () => {
  const base = { AI_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1', AI_MODEL: 'llama-3.3' }

  it('needs a base URL and a model, and the key is optional', () => {
    const errors = errorsOf({ AI_PROVIDER: 'openai-compatible' }).join('\n')
    expect(errors).toMatch(/OPENAI_COMPATIBLE_BASE_URL/)
    expect(errors).toMatch(/AI_MODEL/)
    const result = readAiConfig(base)
    expect(result.ok && result.config).toMatchObject({
      provider: 'openai-compatible', family: 'openai', model: 'llama-3.3',
      baseUrl: 'http://localhost:11434/v1', maxTokensField: 'max_tokens', hasApiKey: false,
    })
    const keyed = readAiConfig({ ...base, OPENAI_COMPATIBLE_API_KEY: 'k-test-1' })
    expect(keyed.ok && keyed.config).toMatchObject({ hasApiKey: true })
  })

  it('rejects a base URL that is not http(s), and a non-http scheme in particular', () => {
    expect(errorsOf({ ...base, OPENAI_COMPATIBLE_BASE_URL: 'ftp://host/v1' }).join('\n')).toMatch(/OPENAI_COMPATIBLE_BASE_URL/)
    expect(errorsOf({ ...base, OPENAI_COMPATIBLE_BASE_URL: 'not a url' }).join('\n')).toMatch(/OPENAI_COMPATIBLE_BASE_URL/)
  })

  it('accepts max_completion_tokens for servers that require it', () => {
    const result = readAiConfig({ ...base, OPENAI_COMPATIBLE_MAX_TOKENS_FIELD: 'max_completion_tokens' })
    expect(result.ok && result.config).toMatchObject({ maxTokensField: 'max_completion_tokens' })
    expect(errorsOf({ ...base, OPENAI_COMPATIBLE_MAX_TOKENS_FIELD: 'tokens' }).join('\n')).toMatch(/OPENAI_COMPATIBLE_MAX_TOKENS_FIELD/)
  })

  it('has no Claude-only settings: fallbacks are refused', () => {
    expect(errorsOf({ ...base, AI_FALLBACKS: 'default' }).join('\n')).toMatch(/AI_FALLBACKS/)
  })
})

describe('model and effort', () => {
  it('lets AI_MODEL override the default', () => {
    const result = readAiConfig({ ANTHROPIC_API_KEY: 'k-test-1', AI_MODEL: 'claude-sonnet-5-5' })
    expect(result.ok && result.config).toMatchObject({ model: 'claude-sonnet-5-5' })
  })

  it('rejects a model id with whitespace or over 128 characters (the vision ledger column bound)', () => {
    expect(errorsOf({ ANTHROPIC_API_KEY: 'k-test-1', AI_MODEL: 'claude opus' }).join('\n')).toMatch(/AI_MODEL/)
    expect(errorsOf({ ANTHROPIC_API_KEY: 'k-test-1', AI_MODEL: 'm'.repeat(129) }).join('\n')).toMatch(/AI_MODEL/)
  })

  it('accepts every documented effort, and none to omit it', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const result = readAiConfig({ ANTHROPIC_API_KEY: 'k-test-1', AI_EFFORT: effort })
      expect(result.ok && result.config).toMatchObject({ effort })
    }
    const none = readAiConfig({ ANTHROPIC_API_KEY: 'k-test-1', AI_EFFORT: 'none' })
    expect(none.ok && none.config).toMatchObject({ effort: null })
    expect(errorsOf({ ANTHROPIC_API_KEY: 'k-test-1', AI_EFFORT: 'extreme' }).join('\n')).toMatch(/AI_EFFORT/)
  })

  it('turns fallbacks off on request', () => {
    const result = readAiConfig({ ANTHROPIC_API_KEY: 'k-test-1', AI_FALLBACKS: 'off' })
    expect(result.ok && result.config).toMatchObject({ fallbacks: 'off' })
  })
})

describe('errors never carry a credential', () => {
  it('reports every problem by variable NAME while the values stay out of the text', () => {
    const env = {
      AI_PROVIDER: 'foundry', ANTHROPIC_FOUNDRY_API_KEY: MARKER, AI_MODEL: `bad model ${MARKER}`,
      AI_EFFORT: MARKER, OPENAI_COMPATIBLE_API_KEY: MARKER, ANTHROPIC_API_KEY: MARKER,
    }
    const errors = errorsOf(env)
    // Control: there really are several errors to inspect, not zero.
    expect(errors.length).toBeGreaterThanOrEqual(3)
    expect(errors.join('\n')).not.toContain(MARKER)
    expect(JSON.stringify(aiStatus(env))).not.toContain(MARKER)
  })

  it('a valid status carries no key either', () => {
    expect(JSON.stringify(aiStatus({ ANTHROPIC_API_KEY: MARKER }))).not.toContain(MARKER)
  })
})
