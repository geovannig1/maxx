import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText } from '@/lib/ai'
import { anthropicText, useAiEnv } from './helpers/ai-stub'

/**
 * Google Vertex authenticates through Google Application Default Credentials, which cannot run
 * offline, so the documented client class is replaced here and its constructor arguments and the
 * Messages call it receives are asserted instead of the HTTP exchange.
 */

const vertex = vi.hoisted(() => ({ options: [] as unknown[], create: vi.fn() }))

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    beta = { messages: { create: vertex.create } }
    constructor(options: unknown) { vertex.options.push(options) }
  },
}))

afterEach(() => { vi.unstubAllEnvs(); vertex.options.length = 0; vertex.create.mockReset() })

describe('Google Vertex through AnthropicVertex', () => {
  it('passes region and project, uses the bare model id and sends no server-side fallback', async () => {
    useAiEnv({ AI_PROVIDER: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'proj-1', CLOUD_ML_REGION: 'us-east5' })
    vertex.create.mockResolvedValue(anthropicText('OK'))

    const result = await generateText({ feature: 'eval_judge', system: 's', user: 'u', maxTokens: 100, timeoutMs: 1000 })

    expect(result).toMatchObject({ text: 'OK', provider: 'vertex', model: 'claude-opus-5-5' })
    expect(vertex.options).toEqual([expect.objectContaining({ region: 'us-east5', projectId: 'proj-1', maxRetries: 1 })])
    const [params, options] = vertex.create.mock.calls[0]
    expect(params).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 100, output_config: { effort: 'medium' } })
    expect(params).not.toHaveProperty('fallbacks')
    expect(options).toEqual({ timeout: 1000, maxRetries: 1 })
  })

  it('defaults to the global region and leaves the project to ADC when unset', async () => {
    useAiEnv({ AI_PROVIDER: 'vertex' })
    vertex.create.mockResolvedValue(anthropicText('OK'))
    await generateText({ feature: 'eval_judge', system: 's', user: 'u', maxTokens: 100, timeoutMs: 1000 })
    expect(vertex.options[0]).toMatchObject({ region: 'global' })
    expect(vertex.options[0]).not.toHaveProperty('projectId')
  })

  it('wires the client-side refusal fallback chain when a fallback list is configured', async () => {
    useAiEnv({ AI_PROVIDER: 'vertex', AI_FALLBACKS: 'claude-opus-5' })
    vertex.create.mockResolvedValue(anthropicText('OK'))
    await generateText({ feature: 'eval_judge', system: 's', user: 'u', maxTokens: 100, timeoutMs: 1000 })
    const options = vertex.options[0] as { middleware?: unknown[] }
    expect(options.middleware).toHaveLength(1)
    expect(vertex.create.mock.calls[0][0]).not.toHaveProperty('fallbacks')
  })
})
