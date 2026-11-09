import 'server-only'
import { createAnthropicAdapter } from './anthropic'
import { readAiConfig } from './config'
import {
  AiDisabledError, AiIncompleteError, AiInvalidOutputError, AiMaxTokensError, AiRefusalError,
} from './errors'
import { createOpenAiCompatibleAdapter } from './openai-compatible'
import type {
  AiAdapter, AiEffort, AiFamily, AiFeature, AiImage, AiOutputFormat, AiProviderName, AiRequest,
  AiResponse, AiUsage,
} from './types'

/**
 * The AI gateway: the only path from Maxx to a language model.
 *
 * Callers use `generateText` / `generateStructured` (one answer) or `completeTurn` (one round of a
 * tool loop). With AI off, every entry point throws `AiDisabledError` before an adapter exists, so
 * no client is constructed and no request is attempted. `tests/ai-off.test.ts` asserts that at the
 * fetch level and pins that nothing outside `src/lib/ai` imports a model SDK.
 */

export * from './errors'
export type * from './types'
export { aiStatus, describeAiStatus, isAiEnabled, type AiStatus } from './config'

/** The largest output any Maxx feature may request (the Opus 5.5 non-streaming ceiling we allow). */
export const MAX_OUTPUT_TOKENS_CEILING = 32_000
export const MAX_TIMEOUT_MS = 300_000

function resolveAdapter(env: Record<string, string | undefined> = process.env): AiAdapter {
  const result = readAiConfig(env)
  if (!result.ok) throw new AiDisabledError('misconfigured')
  const { config } = result
  if (config.provider === 'none') throw new AiDisabledError('off')
  return config.family === 'openai'
    ? createOpenAiCompatibleAdapter(config, env)
    : createAnthropicAdapter(config, env)
}

function assertBounds(request: Pick<AiRequest, 'maxTokens' | 'timeoutMs'>): void {
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > MAX_OUTPUT_TOKENS_CEILING) {
    throw new RangeError(`maxTokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS_CEILING}`)
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
  }
}

function logStop(feature: AiFeature, response: AiResponse): void {
  if (response.stop === 'end_turn' || response.stop === 'tool_use') return
  console.warn(`[AI] ${feature}: ${response.provider}/${response.model} stopped with ${response.providerStop ?? 'unknown'}`
    + (response.stop === 'refusal' ? ` (category ${response.refusalCategory ?? 'none'})` : ''))
}

/**
 * One round with the configured provider. Refusal and max-token stops are RETURNED as `stop`, not
 * thrown, because a tool loop must decide what they mean for its turn; `text` is never an answer
 * unless `stop` is `end_turn`.
 */
export async function completeTurn(request: AiRequest): Promise<AiResponse> {
  assertBounds(request)
  const response = await resolveAdapter().complete(request)
  logStop(request.feature, response)
  return response
}

export interface AiSingleInput {
  feature: AiFeature
  system: string
  user: string
  image?: AiImage
  maxTokens: number
  timeoutMs: number
  effort?: AiEffort
  cacheSystemPrompt?: boolean
}

export interface AiTextResult {
  text: string
  provider: AiProviderName
  family: AiFamily
  model: string
  usage: AiUsage
}

/** Anything but a natural end is an error: refusal, truncation and unknown stops are never text. */
function requireAnswer(response: AiResponse): AiTextResult {
  switch (response.stop) {
    case 'end_turn':
      return { text: response.text, provider: response.provider, family: response.family, model: response.model, usage: response.usage }
    case 'refusal':
      throw new AiRefusalError(response.refusalCategory ?? null)
    case 'max_tokens':
      throw new AiMaxTokensError()
    default:
      throw new AiIncompleteError(response.providerStop)
  }
}

function singleRequest(input: AiSingleInput, outputFormat?: AiOutputFormat): AiRequest {
  return {
    feature: input.feature,
    system: input.system,
    messages: [{ role: 'user', text: input.user, ...(input.image ? { images: [input.image] } : {}) }],
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.cacheSystemPrompt ? { cacheSystemPrompt: true } : {}),
    ...(outputFormat ? { outputFormat } : {}),
  }
}

export async function generateText(input: AiSingleInput): Promise<AiTextResult> {
  return requireAnswer(await completeTurn(singleRequest(input)))
}

/**
 * Structured output is plain JSON. A server that ignores `response_format` may wrap it in a fenced
 * block or a sentence, so (as every caller's own extractor did before the gateway) the fenced block
 * or the outermost `{...}` is tried next. Anything else is invalid output.
 */
export function parseJsonAnswer(text: string): unknown {
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], text.match(/\{[\s\S]*\}/)?.[0]]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    try { return JSON.parse(candidate.trim()) } catch { /* try the next shape */ }
  }
  throw new AiInvalidOutputError()
}

/**
 * One answer constrained to a JSON schema. The value is parsed JSON and still UNTRUSTED: every
 * caller validates it with its own schema before storing or showing anything.
 */
export async function generateStructured(
  input: AiSingleInput & { format: AiOutputFormat },
): Promise<AiTextResult & { value: unknown }> {
  const answer = requireAnswer(await completeTurn(singleRequest(input, input.format)))
  return { ...answer, value: parseJsonAnswer(answer.text) }
}
