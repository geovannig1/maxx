import 'server-only'
import { z } from 'zod'
import type { AiEffort, AiFamily, AiProviderName } from './types'

/**
 * AI gateway configuration, read from the environment and validated with zod.
 *
 * Provider selection (`AI_PROVIDER`):
 *   anthropic | bedrock | vertex | foundry | openai-compatible | none
 * Unset means: `anthropic` when ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is present, else `none`.
 *
 * A configuration error never stops the app: it switches AI off with a message naming the variable.
 * Credential VALUES are never stored here, never put in a message and never logged: only whether a
 * credential is present. The adapters read the credential themselves at request time.
 */

export const AI_PROVIDERS = ['anthropic', 'bedrock', 'vertex', 'foundry', 'openai-compatible', 'none'] as const
export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const DEFAULT_MODEL = 'claude-opus-5-5'
/** Bedrock model ids carry an `anthropic.` prefix. */
export const DEFAULT_BEDROCK_MODEL = 'anthropic.claude-opus-5-5'
export const DEFAULT_EFFORT: AiEffort = 'medium'
export const DEFAULT_VERTEX_REGION = 'global'

/** `default`: Anthropic picks the fallback model by refusal category (Claude API only). */
export type AiFallbacks = 'default' | 'off' | string[]

interface AnthropicFamilyBase {
  family: Extract<AiFamily, 'anthropic'>
  model: string
  /** null = do not send `output_config.effort` (AI_EFFORT=none, for models without effort). */
  effort: AiEffort | null
  fallbacks: AiFallbacks
  inferred: boolean
}

export type AiConfig =
  | { provider: 'none'; inferred: boolean }
  | (AnthropicFamilyBase & { provider: 'anthropic' })
  | (AnthropicFamilyBase & { provider: 'bedrock'; region: string })
  | (AnthropicFamilyBase & { provider: 'vertex'; region: string; projectId: string | null })
  | (AnthropicFamilyBase & { provider: 'foundry'; resource: string | null; baseUrl: string | null })
  | {
    provider: 'openai-compatible'
    family: Extract<AiFamily, 'openai'>
    model: string
    baseUrl: string
    hasApiKey: boolean
    maxTokensField: 'max_tokens' | 'max_completion_tokens'
    inferred: boolean
  }

export type EnabledAiConfig = Exclude<AiConfig, { provider: 'none' }>

export type AiConfigResult = { ok: true; config: AiConfig } | { ok: false; errors: string[] }

export type AiStatus =
  | { state: 'on'; provider: AiProviderName; family: AiFamily; model: string }
  | { state: 'off'; inferred: boolean }
  | { state: 'misconfigured'; errors: string[] }

type Env = Record<string, string | undefined>

function present(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/)
const effortSchema = z.enum([...AI_EFFORTS, 'none'])
const providerSchema = z.enum(AI_PROVIDERS)
const httpUrlSchema = z.url({ protocol: /^https?$/ })
const maxTokensFieldSchema = z.enum(['max_tokens', 'max_completion_tokens'])

function readModel(env: Env, fallback: string | null, errors: string[]): string {
  const raw = present(env.AI_MODEL)
  if (raw === null) {
    if (fallback === null) errors.push('AI_MODEL is required for this provider (the model name your server serves).')
    return fallback ?? ''
  }
  if (!modelSchema.safeParse(raw).success) {
    errors.push('AI_MODEL must be a model id of 1-128 characters with no spaces (letters, digits and . _ : @ / -).')
  }
  return raw
}

function readEffort(env: Env, errors: string[]): AiEffort | null {
  const raw = present(env.AI_EFFORT)
  if (raw === null) return DEFAULT_EFFORT
  const parsed = effortSchema.safeParse(raw)
  if (!parsed.success) {
    errors.push(`AI_EFFORT must be one of ${[...AI_EFFORTS, 'none'].join(', ')}.`)
    return DEFAULT_EFFORT
  }
  return parsed.data === 'none' ? null : parsed.data
}

function readFallbacks(env: Env, provider: AiProviderName, errors: string[]): AiFallbacks {
  const raw = present(env.AI_FALLBACKS)
  const serverSide = provider === 'anthropic'
  if (raw === null) return serverSide ? 'default' : 'off'
  if (raw === 'off') return 'off'
  if (raw === 'default') {
    if (!serverSide) {
      errors.push(`AI_FALLBACKS=default needs server-side fallbacks, which ${provider} does not offer. `
        + 'Set AI_FALLBACKS to a comma-separated list of fallback model ids, or to off.')
    }
    return 'default'
  }
  const models = raw.split(',').map((item) => item.trim()).filter(Boolean)
  if (models.length === 0 || models.length > 3 || models.some((model) => !modelSchema.safeParse(model).success)) {
    errors.push('AI_FALLBACKS must be default, off, or 1-3 comma-separated model ids.')
    return 'off'
  }
  return models
}

function readProvider(env: Env, errors: string[]): { provider: AiProviderName | 'none'; inferred: boolean } {
  const raw = present(env.AI_PROVIDER)
  if (raw === null) {
    const hasClaudeCredential = present(env.ANTHROPIC_API_KEY) !== null || present(env.ANTHROPIC_AUTH_TOKEN) !== null
    return { provider: hasClaudeCredential ? 'anthropic' : 'none', inferred: true }
  }
  const parsed = providerSchema.safeParse(raw)
  if (!parsed.success) {
    errors.push(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(', ')}.`)
    return { provider: 'none', inferred: false }
  }
  return { provider: parsed.data, inferred: false }
}

function readAnthropicFamily(
  env: Env, provider: Exclude<AiProviderName, 'openai-compatible'>, inferred: boolean, errors: string[],
): EnabledAiConfig {
  const base: AnthropicFamilyBase = {
    family: 'anthropic',
    model: readModel(env, provider === 'bedrock' ? DEFAULT_BEDROCK_MODEL : DEFAULT_MODEL, errors),
    effort: readEffort(env, errors),
    fallbacks: readFallbacks(env, provider, errors),
    inferred,
  }
  switch (provider) {
    case 'anthropic':
      if (present(env.ANTHROPIC_API_KEY) === null && present(env.ANTHROPIC_AUTH_TOKEN) === null) {
        errors.push('AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN).')
      }
      return { ...base, provider }
    case 'bedrock': {
      const region = present(env.AWS_REGION) ?? present(env.AWS_DEFAULT_REGION)
      if (region === null) {
        errors.push('AI_PROVIDER=bedrock needs AWS_REGION (or AWS_DEFAULT_REGION); credentials come from the AWS credential chain.')
      }
      return { ...base, provider, region: region ?? '' }
    }
    case 'vertex':
      return {
        ...base,
        provider,
        region: present(env.CLOUD_ML_REGION) ?? DEFAULT_VERTEX_REGION,
        projectId: present(env.ANTHROPIC_VERTEX_PROJECT_ID),
      }
    case 'foundry': {
      const resource = present(env.ANTHROPIC_FOUNDRY_RESOURCE)
      const baseUrl = present(env.ANTHROPIC_FOUNDRY_BASE_URL)
      if (present(env.ANTHROPIC_FOUNDRY_API_KEY) === null) {
        errors.push('AI_PROVIDER=foundry needs ANTHROPIC_FOUNDRY_API_KEY.')
      }
      if (resource === null && baseUrl === null) {
        errors.push('AI_PROVIDER=foundry needs ANTHROPIC_FOUNDRY_RESOURCE (or ANTHROPIC_FOUNDRY_BASE_URL).')
      } else if (baseUrl !== null && !httpUrlSchema.safeParse(baseUrl).success) {
        errors.push('ANTHROPIC_FOUNDRY_BASE_URL must be an https URL.')
      }
      return { ...base, provider, resource, baseUrl }
    }
  }
}

function readOpenAiCompatible(env: Env, inferred: boolean, errors: string[]): EnabledAiConfig {
  const baseUrl = present(env.OPENAI_COMPATIBLE_BASE_URL)
  if (baseUrl === null) {
    errors.push('AI_PROVIDER=openai-compatible needs OPENAI_COMPATIBLE_BASE_URL (for example http://localhost:11434/v1).')
  } else if (!httpUrlSchema.safeParse(baseUrl).success) {
    errors.push('OPENAI_COMPATIBLE_BASE_URL must be an http or https URL.')
  }
  const fieldRaw = present(env.OPENAI_COMPATIBLE_MAX_TOKENS_FIELD) ?? 'max_tokens'
  const field = maxTokensFieldSchema.safeParse(fieldRaw)
  if (!field.success) errors.push('OPENAI_COMPATIBLE_MAX_TOKENS_FIELD must be max_tokens or max_completion_tokens.')
  if (present(env.AI_FALLBACKS) !== null && present(env.AI_FALLBACKS) !== 'off') {
    errors.push('AI_FALLBACKS applies to Claude providers only; unset it for openai-compatible.')
  }
  return {
    provider: 'openai-compatible',
    family: 'openai',
    model: readModel(env, null, errors),
    baseUrl: (baseUrl ?? '').replace(/\/+$/, ''),
    hasApiKey: present(env.OPENAI_COMPATIBLE_API_KEY) !== null,
    maxTokensField: field.success ? field.data : 'max_tokens',
    inferred,
  }
}

/** Pure: reads only the given record. */
export function readAiConfig(env: Env = process.env): AiConfigResult {
  const errors: string[] = []
  const { provider, inferred } = readProvider(env, errors)
  if (errors.length > 0) return { ok: false, errors }
  if (provider === 'none') return { ok: true, config: { provider: 'none', inferred } }
  const config = provider === 'openai-compatible'
    ? readOpenAiCompatible(env, inferred, errors)
    : readAnthropicFamily(env, provider, inferred, errors)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config }
}

export function aiStatus(env: Env = process.env): AiStatus {
  const result = readAiConfig(env)
  if (!result.ok) return { state: 'misconfigured', errors: result.errors }
  const { config } = result
  if (config.provider === 'none') return { state: 'off', inferred: config.inferred }
  return { state: 'on', provider: config.provider, family: config.family, model: config.model }
}

export function isAiEnabled(env: Env = process.env): boolean {
  return aiStatus(env).state === 'on'
}

/** One line per startup, for the server log: what is configured, never a credential. */
export function describeAiStatus(status: AiStatus): string {
  if (status.state === 'on') return `[AI] provider=${status.provider} model=${status.model}`
  if (status.state === 'off') {
    return status.inferred
      ? '[AI] off: no AI provider configured (set AI_PROVIDER, or AI_PROVIDER=none to silence this). Every AI feature is disabled; the rest of Maxx works.'
      : '[AI] off: AI_PROVIDER=none. Every AI feature is disabled; the rest of Maxx works.'
  }
  return `[AI] configuration invalid, AI is disabled until fixed:\n${status.errors.map((error) => `  - ${error}`).join('\n')}`
}
