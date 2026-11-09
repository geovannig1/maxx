import { vi } from 'vitest'

/**
 * A STUB AI provider at the transport level: `fetch` is replaced, so the real gateway, the real
 * configuration and the real adapter (Anthropic SDK client or OpenAI-compatible fetch) all run, and
 * only the HTTP exchange is fake. Nothing here can reach the network.
 *
 * Fake credentials are short so they cannot match the repository's secret-shaped pre-commit check.
 */

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

export type StubHandler = (request: RecordedRequest, index: number) => Response | Promise<Response>

function headersOf(init: RequestInit | undefined, input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined)
  new Headers(source as HeadersInit | undefined).forEach((value, key) => { out[key.toLowerCase()] = value })
  return out
}

async function bodyOf(init: RequestInit | undefined, input: unknown): Promise<Record<string, unknown> | null> {
  let raw: unknown = init?.body
  if (raw === undefined && input instanceof Request) raw = await input.clone().text()
  if (typeof raw !== 'string' || raw.length === 0) return null
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
}

/** Replace global fetch. Every request is recorded; the handler decides the response. */
export function stubFetch(handler: StubHandler): { requests: RecordedRequest[]; fetch: ReturnType<typeof vi.fn> } {
  const requests: RecordedRequest[] = []
  const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const request: RecordedRequest = {
      url,
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      headers: headersOf(init, input),
      body: await bodyOf(init, input),
    }
    requests.push(request)
    return handler(request, requests.length - 1)
  })
  vi.stubGlobal('fetch', fetchStub)
  return { requests, fetch: fetchStub }
}

/** A fetch that records and refuses everything: proves that no request was attempted. */
export function trapFetch(): { requests: RecordedRequest[]; fetch: ReturnType<typeof vi.fn> } {
  return stubFetch((request) => {
    throw new Error(`network access attempted in a no-network test: ${request.method} ${request.url}`)
  })
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A Messages API response body. */
export function anthropicMessage(input: {
  content: unknown[]
  stop_reason: string
  stop_details?: unknown
  model?: string
}): Record<string, unknown> {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: input.model ?? 'claude-opus-5-5',
    content: input.content,
    stop_reason: input.stop_reason,
    stop_sequence: null,
    stop_details: input.stop_details ?? null,
    usage: { input_tokens: 11, output_tokens: 7 },
  }
}

export function anthropicText(text: string, stopReason = 'end_turn'): Record<string, unknown> {
  return anthropicMessage({ content: [{ type: 'text', text }], stop_reason: stopReason })
}

/** A chat-completions response body. */
export function openAiCompletion(input: {
  content?: string | null
  finish_reason: string
  tool_calls?: Array<{ id: string; name: string; arguments: string }>
  refusal?: string | null
}): Record<string, unknown> {
  return {
    id: 'chatcmpl_stub',
    object: 'chat.completion',
    model: 'stub-model',
    choices: [{
      index: 0,
      finish_reason: input.finish_reason,
      message: {
        role: 'assistant',
        content: input.content ?? null,
        refusal: input.refusal ?? null,
        ...(input.tool_calls ? {
          tool_calls: input.tool_calls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      },
    }],
    usage: { prompt_tokens: 13, completion_tokens: 5 },
  }
}

/** Environment for the direct Claude API with every default. */
export const CLAUDE_API_ENV = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k-test-1' } as const

/** Environment for a local OpenAI-compatible server. */
export const OPENAI_COMPATIBLE_ENV = {
  AI_PROVIDER: 'openai-compatible',
  OPENAI_COMPATIBLE_BASE_URL: 'http://stub.local/v1',
  AI_MODEL: 'stub-model',
} as const

/** Every AI variable the gateway reads, cleared so a developer's shell cannot leak in. */
export const AI_ENV_NAMES = [
  'AI_PROVIDER', 'AI_MODEL', 'AI_EFFORT', 'AI_FALLBACKS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_MAX_TOKENS_FIELD',
] as const

export function useAiEnv(env: Record<string, string>): void {
  for (const name of AI_ENV_NAMES) vi.stubEnv(name, '')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}
