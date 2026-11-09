import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiMaxTokensError, AiProviderError, AiRefusalError, AiTimeoutError,
  completeTurn, generateStructured, generateText,
} from '@/lib/ai'
import { OPENAI_COMPATIBLE_ENV, jsonResponse, openAiCompletion, stubFetch, useAiEnv } from './helpers/ai-stub'

/** The OpenAI-compatible adapter against a stub chat-completions server. */

const BASE = { feature: 'signals_judge' as const, system: 'Judge.', user: 'Title: x', maxTokens: 500, timeoutMs: 5000 }

beforeEach(() => useAiEnv({ ...OPENAI_COMPATIBLE_ENV }))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('request shape', () => {
  it('posts to {base}/chat/completions with the configured model and no Claude-only fields', async () => {
    const { requests } = stubFetch(() => jsonResponse(openAiCompletion({ content: 'OK', finish_reason: 'stop' })))
    const result = await generateText(BASE)
    expect(result).toMatchObject({ text: 'OK', provider: 'openai-compatible', family: 'openai', model: 'stub-model' })
    expect(requests[0].url).toBe('http://stub.local/v1/chat/completions')
    expect(requests[0].method).toBe('POST')
    expect(requests[0].body).toEqual({
      model: 'stub-model',
      messages: [{ role: 'system', content: 'Judge.' }, { role: 'user', content: 'Title: x' }],
      max_tokens: 500,
    })
    // No key configured: no Authorization header at all.
    expect(requests[0].headers.authorization).toBeUndefined()
  })

  it('sends the key as a bearer header only when configured, and the configured max-tokens field', async () => {
    useAiEnv({ ...OPENAI_COMPATIBLE_ENV, OPENAI_COMPATIBLE_API_KEY: 'k-test-3', OPENAI_COMPATIBLE_MAX_TOKENS_FIELD: 'max_completion_tokens' })
    const { requests } = stubFetch(() => jsonResponse(openAiCompletion({ content: 'OK', finish_reason: 'stop' })))
    await generateText(BASE)
    expect(requests[0].headers.authorization).toBe('Bearer k-test-3')
    expect(requests[0].body).toMatchObject({ max_completion_tokens: 500 })
    expect(requests[0].body).not.toHaveProperty('max_tokens')
    expect(JSON.stringify(requests[0].body)).not.toContain('k-test-3')
  })

  it('encodes an image as a data URL part and a schema as response_format', async () => {
    const { requests } = stubFetch(() => jsonResponse(openAiCompletion({ content: '{"a":1}', finish_reason: 'stop' })))
    const schema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false }
    const result = await generateStructured({
      ...BASE, image: { mediaType: 'image/jpeg', base64: 'aW1n' }, format: { name: 'creative', schema },
    })
    expect(result.value).toEqual({ a: 1 })
    expect(requests[0].body!.messages).toEqual([
      { role: 'system', content: 'Judge.' },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aW1n' } },
        { type: 'text', text: 'Title: x' },
      ] },
    ])
    expect(requests[0].body!.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'creative', schema, strict: true } })
  })

  it('accepts a fenced JSON answer from a server that ignores response_format', async () => {
    stubFetch(() => jsonResponse(openAiCompletion({ content: '```json\n{"a":2}\n```', finish_reason: 'stop' })))
    const result = await generateStructured({ ...BASE, format: { name: 'x', schema: { type: 'object' } } })
    expect(result.value).toEqual({ a: 2 })
  })
})

describe('stops', () => {
  it('maps finish_reason length to a max-token error, never the truncated text', async () => {
    stubFetch(() => jsonResponse(openAiCompletion({ content: '{"a":', finish_reason: 'length' })))
    await expect(generateText(BASE)).rejects.toBeInstanceOf(AiMaxTokensError)
  })

  it('maps a refusal field and a content filter to a refusal error', async () => {
    stubFetch((_request, index) => jsonResponse(index === 0
      ? openAiCompletion({ content: null, refusal: 'I cannot help with that.', finish_reason: 'stop' })
      : openAiCompletion({ content: 'partial', finish_reason: 'content_filter' })))
    await expect(generateText(BASE)).rejects.toBeInstanceOf(AiRefusalError)
    await expect(generateText(BASE)).rejects.toBeInstanceOf(AiRefusalError)
  })
})

describe('tool turns', () => {
  const tools = [{ name: 'lookup', description: 'Read.', input_schema: { type: 'object', properties: {} } }]

  it('offers function tools without parallel calls, parses calls and replays the turn', async () => {
    const { requests } = stubFetch((_request, index) => jsonResponse(index === 0
      ? openAiCompletion({ finish_reason: 'tool_calls', tool_calls: [{ id: 'c1', name: 'lookup', arguments: '{"days":7}' }] })
      : openAiCompletion({ content: 'done', finish_reason: 'stop' })))
    const first = await completeTurn({
      feature: 'maxx_chat', system: 's', messages: [{ role: 'user', text: 'q' }], maxTokens: 100, timeoutMs: 5000, tools,
    })
    expect(first.stop).toBe('tool_use')
    expect(first.toolCalls).toEqual([{ id: 'c1', name: 'lookup', input: { days: 7 } }])
    expect(requests[0].body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Read.', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    })

    await completeTurn({
      feature: 'maxx_chat', system: 's', maxTokens: 100, timeoutMs: 5000, tools, toolChoice: 'none',
      messages: [
        { role: 'user', text: 'q' }, first.assistant,
        { role: 'tool_results', results: [{ callId: 'c1', content: '{"ok":true}' }] },
      ],
    })
    expect(requests[1].body!.tool_choice).toBe('none')
    expect(requests[1].body!.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"days":7}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ])
  })

  it('marks unparseable tool arguments as null rather than guessing', async () => {
    stubFetch(() => jsonResponse(openAiCompletion({ finish_reason: 'tool_calls', tool_calls: [{ id: 'c1', name: 'lookup', arguments: '{not json' }] })))
    const turn = await completeTurn({
      feature: 'maxx_chat', system: 's', messages: [{ role: 'user', text: 'q' }], maxTokens: 100, timeoutMs: 5000, tools,
    })
    expect(turn.toolCalls[0].input).toBeNull()
  })
})

describe('failures', () => {
  it('maps HTTP errors to a typed error without the server body', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'bad key ECHO-ME' } }, 401))
    const error = await generateText(BASE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiProviderError)
    expect(error).toMatchObject({ kind: 'auth', status: 401 })
    expect(String((error as Error).message)).not.toContain('ECHO-ME')
  })

  it('times out with a typed error', async () => {
    stubFetch(() => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 5)
    }))
    await expect(generateText({ ...BASE, timeoutMs: 1 })).rejects.toBeInstanceOf(AiTimeoutError)
  })

  it('rejects a body that is not a completion', async () => {
    stubFetch(() => jsonResponse({ unexpected: true }))
    await expect(generateText(BASE)).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})
