import 'server-only'
import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { EnabledAiConfig } from './config'
import { AiProviderError, AiTimeoutError, providerErrorKind } from './errors'
import type { AiAdapter, AiMessage, AiRequest, AiResponse, AiStop, AiToolCall } from './types'

/**
 * Adapter 1: the official Anthropic SDK family. The Claude API, Amazon Bedrock (Mantle), Google
 * Vertex and Microsoft Foundry clients share the Messages API, so one request builder serves all
 * four and Claude-specific controls (effort, adaptive thinking, prompt caching, refusal stop
 * details, fallbacks) keep working on every platform.
 *
 * Requests go through `client.beta.messages` because refusal fallbacks are a beta surface.
 * Never sent: `temperature`/`top_p`/`top_k` (400 under API version 2026-10-21), `thinking`
 * (Opus 5.5 is adaptive-only; disabled or a budget is a 400), and forced `tool_choice` (400).
 */

type AnthropicFamilyConfig = Extract<EnabledAiConfig, { family: 'anthropic' }>
type Env = Record<string, string | undefined>

/** Bounded wall clock: one retry, never the SDK's default two. */
const MAX_RETRIES = 1
const FALLBACK_DEFAULT_BETA = 'server-side-fallback-2026-07-01'
const FALLBACK_LIST_BETA = 'server-side-fallback-2026-06-01'

interface MessagesClient {
  beta: { messages: { create(params: MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }): Promise<BetaMessage> } }
}

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim()
  return raw ? raw : undefined
}

/** Client-side fallback chain, for platforms without server-side fallbacks. */
function platformMiddleware(config: AnthropicFamilyConfig) {
  return Array.isArray(config.fallbacks)
    ? { middleware: [betaRefusalFallbackMiddleware(config.fallbacks.map((model) => ({ model })))] }
    : {}
}

async function createClient(config: AnthropicFamilyConfig, env: Env): Promise<MessagesClient> {
  switch (config.provider) {
    case 'anthropic': {
      // A 1.x client holds exactly one credential; the other is nulled so the SDK cannot pick it
      // up from the environment as well.
      const apiKey = value(env, 'ANTHROPIC_API_KEY')
      return new Anthropic(apiKey
        ? { apiKey, authToken: null, maxRetries: MAX_RETRIES }
        : { authToken: value(env, 'ANTHROPIC_AUTH_TOKEN'), apiKey: null, maxRetries: MAX_RETRIES })
    }
    case 'bedrock': {
      // Loaded only when selected: the AWS SDK is large and most installs never need it.
      const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk')
      return new AnthropicBedrockMantle({ awsRegion: config.region, maxRetries: MAX_RETRIES, ...platformMiddleware(config) })
    }
    case 'vertex': {
      const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk')
      return new AnthropicVertex({
        region: config.region,
        ...(config.projectId ? { projectId: config.projectId } : {}),
        maxRetries: MAX_RETRIES,
        ...platformMiddleware(config),
      })
    }
    case 'foundry': {
      const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
      return new AnthropicFoundry({
        apiKey: value(env, 'ANTHROPIC_FOUNDRY_API_KEY'),
        ...(config.baseUrl ? { baseURL: config.baseUrl } : { resource: config.resource }),
        maxRetries: MAX_RETRIES,
        ...platformMiddleware(config),
      })
    }
  }
}

function toContent(message: AiMessage): BetaMessageParam {
  switch (message.role) {
    case 'user':
      if (!message.images?.length) return { role: 'user', content: message.text }
      return {
        role: 'user',
        content: [
          ...message.images.map((image): BetaContentBlockParam => ({
            type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
          })),
          { type: 'text', text: message.text },
        ],
      }
    case 'assistant':
      if (Array.isArray(message.native)) return { role: 'assistant', content: message.native as BetaContentBlockParam[] }
      return {
        role: 'assistant',
        content: [
          ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
          ...message.toolCalls.map((call): BetaContentBlockParam => ({
            type: 'tool_use', id: call.id, name: call.name, input: (call.input ?? {}) as Record<string, unknown>,
          })),
        ],
      }
    case 'tool_results':
      return {
        role: 'user',
        content: message.results.map((result): BetaContentBlockParam => ({
          type: 'tool_result', tool_use_id: result.callId, content: result.content,
        })),
      }
  }
}

export function buildAnthropicParams(config: AnthropicFamilyConfig, request: AiRequest): MessageCreateParamsNonStreaming {
  // AI_EFFORT=none means the model takes no effort parameter at all; a per-request hint cannot
  // override that, or a cheap classifier call would 400 on such a model.
  const effort = config.effort === null ? null : request.effort ?? config.effort
  const outputConfig = {
    ...(effort ? { effort } : {}),
    ...(request.outputFormat ? { format: { type: 'json_schema' as const, schema: request.outputFormat.schema } } : {}),
  }
  const betas: string[] = []
  let fallbacks: MessageCreateParamsNonStreaming['fallbacks'] | undefined
  if (config.provider === 'anthropic' && config.fallbacks === 'default') {
    betas.push(FALLBACK_DEFAULT_BETA)
    fallbacks = 'default'
  } else if (config.provider === 'anthropic' && Array.isArray(config.fallbacks)) {
    betas.push(FALLBACK_LIST_BETA)
    fallbacks = config.fallbacks.map((model) => ({ model }))
  }
  return {
    model: config.model,
    max_tokens: request.maxTokens,
    system: [{
      type: 'text', text: request.system,
      ...(request.cacheSystemPrompt ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }],
    messages: request.messages.map(toContent),
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.strict ? { strict: true } : {}),
        input_schema: tool.input_schema as { type: 'object' },
      })),
      tool_choice: request.toolChoice === 'none'
        ? { type: 'none' as const }
        : { type: 'auto' as const, disable_parallel_tool_use: true },
    } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    ...(fallbacks ? { fallbacks } : {}),
    ...(betas.length > 0 ? { betas } : {}),
  }
}

function stopOf(reason: string | null | undefined): AiStop {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

export function parseAnthropicMessage(
  message: BetaMessage, config: AnthropicFamilyConfig,
): AiResponse {
  const content = Array.isArray(message.content) ? message.content : []
  const toolCalls: AiToolCall[] = []
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input })
  }
  const stop = stopOf(message.stop_reason)
  const details = (message as { stop_details?: { category?: unknown } | null }).stop_details
  return {
    stop,
    providerStop: message.stop_reason ?? null,
    text: texts.join('\n'),
    toolCalls,
    assistant: { role: 'assistant', text: texts.join('\n'), toolCalls, native: content },
    provider: config.provider,
    family: 'anthropic',
    model: config.model,
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    },
    ...(stop === 'refusal'
      ? { refusalCategory: typeof details?.category === 'string' ? details.category : null }
      : {}),
  }
}

/** Duck-typed so a test double of the SDK module needs no error classes. Never reads the message. */
function toAiError(error: unknown): Error {
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? ''
  if (name.includes('Timeout') || (error as Error)?.name === 'AbortError') return new AiTimeoutError()
  const status = (error as { status?: unknown })?.status
  if (typeof status === 'number') return new AiProviderError(providerErrorKind(status), status)
  return new AiProviderError('network', null)
}

export function createAnthropicAdapter(config: AnthropicFamilyConfig, env: Env): AiAdapter {
  return {
    provider: config.provider,
    family: 'anthropic',
    model: config.model,
    async complete(request) {
      const client = await createClient(config, env)
      let message: BetaMessage
      try {
        message = await client.beta.messages.create(
          buildAnthropicParams(config, request),
          { timeout: request.timeoutMs, maxRetries: MAX_RETRIES },
        )
      } catch (error) {
        throw toAiError(error)
      }
      return parseAnthropicMessage(message, config)
    },
  }
}
