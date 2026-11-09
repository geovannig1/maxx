/**
 * The provider-neutral surface of the AI gateway: exactly what Maxx's callers need, nothing more.
 *
 * - one completion turn (text, optional image, optional read-only tools, optional JSON schema), and
 * - typed outcomes for the stops a caller must never mistake for an answer (refusal, max tokens).
 *
 * Streaming is deliberately absent: no caller streams. Forced tool choice is absent too: Claude Opus
 * 5.5 rejects it with a 400, so the only choices offered are `auto` and `none`.
 */

export type AiProviderName = 'anthropic' | 'bedrock' | 'vertex' | 'foundry' | 'openai-compatible'

/**
 * The API family behind a provider. Stored as the `provider` of immutable vision-analysis versions,
 * whose database check accepts exactly 'anthropic' and 'openai'.
 */
export type AiFamily = 'anthropic' | 'openai'

export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The features that may call a model. Used for logs and as the label on every request. */
export type AiFeature =
  | 'maxx_chat'
  | 'creative_vision'
  | 'competitor_analysis'
  | 'signals_judge'
  | 'report_narrative'
  | 'eval_judge'
  | 'setup_check'
  | 'copy_generation'
  | 'campaign_planning'

export interface AiImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  base64: string
}

export type JsonSchemaObject = Record<string, unknown>

/** Same field names as the Anthropic tool shape, so a definition reads identically in both places. */
export interface AiToolDefinition {
  name: string
  description: string
  input_schema: JsonSchemaObject
  /** Ask the provider to validate arguments against `input_schema` (Anthropic strict tool use). */
  strict?: boolean
}

export interface AiToolCall {
  id: string
  name: string
  /** Parsed arguments. `null` when the provider returned arguments that are not JSON. */
  input: unknown
}

export interface AiToolResult {
  callId: string
  content: string
}

export type AiMessage =
  | { role: 'user'; text: string; images?: AiImage[] }
  | {
    role: 'assistant'
    text: string
    toolCalls: AiToolCall[]
    /**
     * The provider's own content for this turn, replayed verbatim on the next request. Claude's
     * thinking blocks must go back unmodified in a tool loop; a neutral re-encoding would drop them.
     * Only the adapter that produced it reads it.
     */
    native?: unknown
  }
  | { role: 'tool_results'; results: AiToolResult[] }

export type AiAssistantMessage = Extract<AiMessage, { role: 'assistant' }>

export interface AiOutputFormat {
  /** A short identifier for the schema (required by OpenAI-compatible servers). */
  name: string
  schema: JsonSchemaObject
}

export interface AiRequest {
  feature: AiFeature
  system: string
  messages: AiMessage[]
  maxTokens: number
  timeoutMs: number
  /** Overrides the configured effort for this request (Anthropic family only). */
  effort?: AiEffort
  tools?: AiToolDefinition[]
  /** Never forced. `none` keeps the tool list (and the prompt cache) while forbidding a call. */
  toolChoice?: 'auto' | 'none'
  /** Constrain the final text to this JSON schema (structured output). */
  outputFormat?: AiOutputFormat
  /** Mark the system prompt cacheable (Anthropic prompt caching). */
  cacheSystemPrompt?: boolean
}

/**
 * Why the model stopped. Only `end_turn` carries an answer; `tool_use` carries calls. `refusal` and
 * `max_tokens` are never text, and `other` (pause, compaction, anything unknown) is not either.
 */
export type AiStop = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'

export interface AiUsage {
  inputTokens: number
  outputTokens: number
}

export interface AiResponse {
  stop: AiStop
  /** The provider's own stop value, for logs. */
  providerStop: string | null
  /** Concatenated text blocks. Meaningful only when `stop` is `end_turn`. */
  text: string
  toolCalls: AiToolCall[]
  assistant: AiAssistantMessage
  provider: AiProviderName
  family: AiFamily
  model: string
  usage: AiUsage
  /** Present when `stop` is `refusal`: the provider's category, or null when it gave none. */
  refusalCategory?: string | null
}

export interface AiAdapter {
  readonly provider: AiProviderName
  readonly family: AiFamily
  readonly model: string
  complete(request: AiRequest): Promise<AiResponse>
}
