import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  completeTurn, generateStructured, generateText,
  AiIncompleteError, AiInvalidOutputError, AiMaxTokensError, AiProviderError, AiRefusalError,
} from '@/lib/ai'
import {
  CLAUDE_API_ENV, anthropicMessage, anthropicText, jsonResponse, stubFetch, useAiEnv,
} from './helpers/ai-stub'

/**
 * The Anthropic SDK family adapter, exercised through the real SDK client with only `fetch` stubbed.
 * Request bodies are asserted on the wire, so a parameter the API rejects (sampling, a thinking
 * budget, forced tool choice) cannot slip through a type cast.
 */

const BASE = { feature: 'eval_judge' as const, system: 'You are terse.', user: 'Say OK.', maxTokens: 1000, timeoutMs: 5000 }

beforeEach(() => useAiEnv({ ...CLAUDE_API_ENV }))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('request shape on the Claude API', () => {
  it('sends the default model, explicit effort and server-side fallbacks, and nothing the API rejects', async () => {
    const { requests } = stubFetch(() => jsonResponse(anthropicText('OK')))

    const result = await generateText(BASE)

    expect(result).toMatchObject({ text: 'OK', provider: 'anthropic', family: 'anthropic', model: 'claude-opus-5-5' })
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(new URL(request.url).host).toBe('api.anthropic.com')
    expect(new URL(request.url).pathname).toBe('/v1/messages')
    const body = request.body!
    expect(body.model).toBe('claude-opus-5-5')
    expect(body.max_tokens).toBe(1000)
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body.fallbacks).toBe('default')
    expect(request.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    // Rejected on current models: never sent.
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) expect(body).not.toHaveProperty(key)
    expect(body.messages).toEqual([{ role: 'user', content: 'Say OK.' }])
    expect(body.system).toEqual([{ type: 'text', text: 'You are terse.' }])
    // The key travels in a header, never in the body or URL.
    expect(JSON.stringify(body)).not.toContain('k-test-1')
    expect(request.url).not.toContain('k-test-1')
  })

  it('honours AI_MODEL, AI_EFFORT=none, AI_FALLBACKS=off and a per-request effort', async () => {
    useAiEnv({ ...CLAUDE_API_ENV, AI_MODEL: 'claude-sonnet-5-5', AI_EFFORT: 'none', AI_FALLBACKS: 'off' })
    const { requests } = stubFetch(() => jsonResponse(anthropicText('OK')))
    await generateText(BASE)
    await generateText({ ...BASE, effort: 'low' })

    expect(requests[0].body!.model).toBe('claude-sonnet-5-5')
    expect(requests[0].body).not.toHaveProperty('output_config')
    expect(requests[0].body).not.toHaveProperty('fallbacks')
    expect(requests[0].headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback')
    // AI_EFFORT=none means "this model takes no effort": a per-request hint must not override it.
    expect(requests[1].body).not.toHaveProperty('output_config')
  })

  it('applies a per-request effort over the configured default', async () => {
    const { requests } = stubFetch(() => jsonResponse(anthropicText('OK')))
    await generateText({ ...BASE, effort: 'low' })
    expect(requests[0].body!.output_config).toEqual({ effort: 'low' })
  })

  it('sends a named fallback list in the array form under its own beta', async () => {
    useAiEnv({ ...CLAUDE_API_ENV, AI_FALLBACKS: 'claude-opus-5' })
    const { requests } = stubFetch(() => jsonResponse(anthropicText('OK')))
    await generateText(BASE)
    expect(requests[0].body!.fallbacks).toEqual([{ model: 'claude-opus-5' }])
    expect(requests[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-06-01')
    expect(requests[0].headers['anthropic-beta']).not.toContain('server-side-fallback-2026-07-01')
  })

  it('places an image before the text and marks the system prompt cacheable on request', async () => {
    const { requests } = stubFetch(() => jsonResponse(anthropicText('{}')))
    await generateText({ ...BASE, image: { mediaType: 'image/png', base64: 'aW1n' }, cacheSystemPrompt: true })
    const body = requests[0].body!
    expect(body.system).toEqual([{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }])
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
        { type: 'text', text: 'Say OK.' },
      ],
    }])
  })
})

describe('stops that are never an answer', () => {
  it('surfaces a refusal as a typed error carrying the category, never the partial text', async () => {
    stubFetch(() => jsonResponse(anthropicMessage({
      content: [{ type: 'text', text: 'PARTIAL OUTPUT' }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
    })))
    const error = await generateText(BASE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiRefusalError)
    expect((error as AiRefusalError).category).toBe('cyber')
    expect(String((error as Error).message)).not.toContain('PARTIAL OUTPUT')
  })

  it('a refusal with no stop_details is still a refusal (category null)', async () => {
    stubFetch(() => jsonResponse(anthropicMessage({ content: [], stop_reason: 'refusal' })))
    await expect(generateText(BASE)).rejects.toMatchObject({ name: 'AiRefusalError', category: null })
  })

  it('surfaces max_tokens as a typed error, never the truncated text', async () => {
    stubFetch(() => jsonResponse(anthropicText('{"angle": "truncat', 'max_tokens')))
    await expect(generateText(BASE)).rejects.toBeInstanceOf(AiMaxTokensError)
    await expect(generateStructured({ ...BASE, format: { name: 'x', schema: { type: 'object' } } }))
      .rejects.toBeInstanceOf(AiMaxTokensError)
  })

  it('treats a context-window stop like max_tokens and an unknown stop as incomplete', async () => {
    stubFetch((_request, index) => jsonResponse(index === 0
      ? anthropicText('x', 'model_context_window_exceeded')
      : anthropicText('x', 'pause_turn')))
    await expect(generateText(BASE)).rejects.toBeInstanceOf(AiMaxTokensError)
    await expect(generateText(BASE)).rejects.toBeInstanceOf(AiIncompleteError)
  })

  it('returns refusal and max_tokens as stops from completeTurn, with no answer text to misuse', async () => {
    stubFetch((_request, index) => jsonResponse(index === 0
      ? anthropicMessage({ content: [{ type: 'text', text: 'leak' }], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: null } })
      : anthropicText('half', 'max_tokens')))
    const request = { feature: 'maxx_chat' as const, system: 's', messages: [{ role: 'user' as const, text: 'q' }], maxTokens: 100, timeoutMs: 5000 }
    const refused = await completeTurn(request)
    expect(refused).toMatchObject({ stop: 'refusal', refusalCategory: 'bio', providerStop: 'refusal' })
    const truncated = await completeTurn(request)
    expect(truncated).toMatchObject({ stop: 'max_tokens', providerStop: 'max_tokens' })
  })
})

describe('structured output', () => {
  it('sends the schema as output_config.format and parses the JSON answer', async () => {
    const { requests } = stubFetch(() => jsonResponse(anthropicText('{"applies": true}')))
    const schema = { type: 'object', properties: { applies: { type: 'boolean' } }, required: ['applies'], additionalProperties: false }
    const result = await generateStructured({ ...BASE, format: { name: 'judge', schema } })
    expect(result.value).toEqual({ applies: true })
    expect(requests[0].body!.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema } })
  })

  it('rejects text that is not JSON with a typed error', async () => {
    stubFetch(() => jsonResponse(anthropicText('Sure! Here it is.')))
    await expect(generateStructured({ ...BASE, format: { name: 'x', schema: { type: 'object' } } }))
      .rejects.toBeInstanceOf(AiInvalidOutputError)
  })
})

describe('tool turns', () => {
  const tools = [
    { name: 'lookup', description: 'Read.', input_schema: { type: 'object', properties: {} } },
    { name: 'submit', description: 'Submit.', strict: true, input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  ]

  it('offers tools with auto choice and no parallel calls, and replays the assistant turn verbatim', async () => {
    const assistantContent = [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'tool_use', id: 'call-1', name: 'lookup', input: { a: 1 } },
    ]
    const { requests } = stubFetch((_request, index) => jsonResponse(index === 0
      ? anthropicMessage({ content: assistantContent, stop_reason: 'tool_use' })
      : anthropicText('done')))
    const first = await completeTurn({
      feature: 'maxx_chat', system: 's', messages: [{ role: 'user', text: 'q' }],
      maxTokens: 100, timeoutMs: 5000, tools,
    })
    expect(first.stop).toBe('tool_use')
    expect(first.toolCalls).toEqual([{ id: 'call-1', name: 'lookup', input: { a: 1 } }])
    expect(requests[0].body!.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(requests[0].body!.tools).toEqual([
      { name: 'lookup', description: 'Read.', input_schema: { type: 'object', properties: {} } },
      { name: 'submit', description: 'Submit.', strict: true, input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    ])

    await completeTurn({
      feature: 'maxx_chat', system: 's', maxTokens: 100, timeoutMs: 5000, tools, toolChoice: 'none',
      outputFormat: { name: 'brief', schema: { type: 'object' } },
      messages: [
        { role: 'user', text: 'q' },
        first.assistant,
        { role: 'tool_results', results: [{ callId: 'call-1', content: '{"ok":true}' }] },
      ],
    })
    const second = requests[1].body!
    // The thinking block goes back unmodified: a re-encoded turn would drop it.
    expect(second.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"ok":true}' }] },
    ])
    expect(second.tool_choice).toEqual({ type: 'none' })
    expect(second.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: { type: 'object' } } })
  })
})

describe('provider failures', () => {
  it('maps HTTP errors to a typed error that carries no provider text and no key', async () => {
    stubFetch(() => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'bad key k-test-1 SECRET-ECHO' } }, 401))
    const error = await generateText(BASE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiProviderError)
    expect(error).toMatchObject({ kind: 'auth', status: 401 })
    expect(String((error as Error).message)).not.toMatch(/SECRET-ECHO|k-test-1/)
  })

  it('does not retry a rate limit more than once (cost safety)', async () => {
    const { requests } = stubFetch(() => jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, 429))
    await expect(generateText(BASE)).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(requests.length).toBeLessThanOrEqual(2)
  })
})

describe('Anthropic platforms through the documented client classes', () => {
  it('Microsoft Foundry: the Foundry client, the configured resource and no server-side fallback', async () => {
    useAiEnv({ AI_PROVIDER: 'foundry', ANTHROPIC_FOUNDRY_API_KEY: 'k-test-2', ANTHROPIC_FOUNDRY_RESOURCE: 'res-1' })
    const { requests } = stubFetch(() => jsonResponse(anthropicText('OK')))
    const result = await generateText(BASE)
    expect(result).toMatchObject({ provider: 'foundry', model: 'claude-opus-5-5' })
    expect(new URL(requests[0].url).host).toBe('res-1.services.ai.azure.com')
    expect(requests[0].body!.model).toBe('claude-opus-5-5')
    expect(requests[0].body).not.toHaveProperty('fallbacks')
  })

  it('Amazon Bedrock: the Mantle client, the region host and the anthropic.-prefixed model', async () => {
    useAiEnv({ AI_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' })
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDSTUB')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'stub-secret')
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '')
    const { requests } = stubFetch(() => jsonResponse(anthropicText('OK', 'end_turn')))
    const result = await generateText(BASE)
    expect(result).toMatchObject({ provider: 'bedrock', model: 'anthropic.claude-opus-5-5', text: 'OK' })
    expect(new URL(requests[0].url).host).toBe('bedrock-mantle.us-east-1.api.aws')
    expect(requests[0].body!.model).toBe('anthropic.claude-opus-5-5')
    expect(requests[0].body).not.toHaveProperty('fallbacks')
  })
})
