import 'server-only'
import type { EnabledAiConfig } from './config'
import { AiProviderError, AiTimeoutError, providerErrorKind } from './errors'
import type { AiAdapter, AiMessage, AiRequest, AiResponse, AiStop, AiToolCall } from './types'

/**
 * Adapter 2: any server that speaks OpenAI chat completions (vLLM, llama.cpp, Ollama, LM Studio,
 * hosted gateways). Plain `fetch` to `{OPENAI_COMPATIBLE_BASE_URL}/chat/completions`, so there is no
 * vendor SDK to keep in step. Claude-only controls (effort, caching, fallbacks) do not apply here.
 */

type OpenAiConfig = Extract<EnabledAiConfig, { provider: 'openai-compatible' }>
type Env = Record<string, string | undefined>

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type ChatMessage =
  | { role: 'system' | 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

interface ChatCompletion {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
      refusal?: string | null
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function toMessages(message: AiMessage): ChatMessage[] {
  switch (message.role) {
    case 'user':
      if (!message.images?.length) return [{ role: 'user', content: message.text }]
      return [{
        role: 'user',
        content: [
          ...message.images.map((image): ChatContentPart => ({
            type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
          })),
          { type: 'text', text: message.text },
        ],
      }]
    case 'assistant':
      return [{
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length > 0 ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id, type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          })),
        } : {}),
      }]
    case 'tool_results':
      return message.results.map((result) => ({ role: 'tool' as const, tool_call_id: result.callId, content: result.content }))
  }
}

export function buildOpenAiBody(config: OpenAiConfig, request: AiRequest): Record<string, unknown> {
  return {
    model: config.model,
    messages: [{ role: 'system', content: request.system }, ...request.messages.flatMap(toMessages)],
    [config.maxTokensField]: request.maxTokens,
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name, description: tool.description, parameters: tool.input_schema,
          ...(tool.strict ? { strict: true } : {}),
        },
      })),
      tool_choice: request.toolChoice === 'none' ? 'none' : 'auto',
      parallel_tool_calls: false,
    } : {}),
    ...(request.outputFormat ? {
      response_format: {
        type: 'json_schema',
        json_schema: { name: request.outputFormat.name, schema: request.outputFormat.schema, strict: true },
      },
    } : {}),
  }
}

function parseArguments(raw: string | undefined): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try { return JSON.parse(raw) } catch { return null }
}

function stopOf(finishReason: string | null | undefined, refusal: boolean, toolCalls: number): AiStop {
  if (refusal || finishReason === 'content_filter') return 'refusal'
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'tool_calls' || (toolCalls > 0 && finishReason !== 'stop')) return 'tool_use'
  if (finishReason === 'stop') return toolCalls > 0 ? 'tool_use' : 'end_turn'
  return 'other'
}

export function parseOpenAiCompletion(body: ChatCompletion, config: OpenAiConfig): AiResponse {
  const choice = body.choices?.[0]
  if (!choice?.message) throw new AiProviderError('invalid_response', null)
  const toolCalls: AiToolCall[] = (choice.message.tool_calls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? '',
    input: parseArguments(call.function?.arguments),
  }))
  const refusal = typeof choice.message.refusal === 'string' && choice.message.refusal.length > 0
  const stop = stopOf(choice.finish_reason, refusal, toolCalls.length)
  const text = typeof choice.message.content === 'string' ? choice.message.content : ''
  return {
    stop,
    providerStop: choice.finish_reason ?? null,
    text,
    toolCalls,
    assistant: { role: 'assistant', text, toolCalls },
    provider: 'openai-compatible',
    family: 'openai',
    model: config.model,
    usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
    ...(stop === 'refusal' ? { refusalCategory: refusal ? 'model_refusal' : 'content_filter' } : {}),
  }
}

export function createOpenAiCompatibleAdapter(config: OpenAiConfig, env: Env): AiAdapter {
  return {
    provider: 'openai-compatible',
    family: 'openai',
    model: config.model,
    async complete(request) {
      const apiKey = env.OPENAI_COMPATIBLE_API_KEY?.trim()
      let response: Response
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(buildOpenAiBody(config, request)),
          signal: AbortSignal.timeout(request.timeoutMs),
          // A provider redirect must not carry the key to another host.
          redirect: 'error',
        })
      } catch (error) {
        const name = (error as Error)?.name
        throw name === 'TimeoutError' || name === 'AbortError' ? new AiTimeoutError() : new AiProviderError('network', null)
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new AiProviderError(providerErrorKind(response.status), response.status)
      }
      let body: ChatCompletion
      try {
        body = await response.json() as ChatCompletion
      } catch {
        throw new AiProviderError('invalid_response', response.status)
      }
      return parseOpenAiCompletion(body, config)
    },
  }
}
