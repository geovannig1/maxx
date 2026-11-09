/**
 * Typed outcomes a caller can branch on. Every message here is composed in this file: provider
 * error bodies, request URLs and credentials never reach a message, a log line or a user.
 */

export type AiErrorCode =
  | 'ai_off'
  | 'ai_misconfigured'
  | 'refusal'
  | 'max_tokens'
  | 'incomplete'
  | 'invalid_output'
  | 'timeout'
  | 'provider_error'

export class AiError extends Error {
  readonly code: AiErrorCode
  constructor(code: AiErrorCode, message: string) {
    super(message)
    this.name = 'AiError'
    this.code = code
  }
}

/** AI is switched off (`AI_PROVIDER=none` or nothing configured), or the configuration is invalid. */
export class AiDisabledError extends AiError {
  constructor(readonly reason: 'off' | 'misconfigured') {
    super(
      reason === 'off' ? 'ai_off' : 'ai_misconfigured',
      reason === 'off'
        ? 'AI is off (AI_PROVIDER=none or no AI provider configured).'
        : 'AI is not configured correctly; see the server log or npm run doctor.',
    )
    this.name = 'AiDisabledError'
  }
}

/** The model or a safety classifier declined. Never an answer, even when partial text exists. */
export class AiRefusalError extends AiError {
  constructor(readonly category: string | null) {
    super('refusal', `The model declined the request${category ? ` (${category})` : ''}.`)
    this.name = 'AiRefusalError'
  }
}

/** Output hit the max-token limit. The text is truncated and must not be used. */
export class AiMaxTokensError extends AiError {
  constructor() {
    super('max_tokens', 'The model stopped at the output token limit; the answer is incomplete.')
    this.name = 'AiMaxTokensError'
  }
}

/** Any other non-final stop (pause, compaction, an unknown value). */
export class AiIncompleteError extends AiError {
  constructor(readonly providerStop: string | null) {
    super('incomplete', 'The model did not complete an answer.')
    this.name = 'AiIncompleteError'
  }
}

/** Structured output was requested and the text is not JSON. */
export class AiInvalidOutputError extends AiError {
  constructor() {
    super('invalid_output', 'The model output was not valid JSON.')
    this.name = 'AiInvalidOutputError'
  }
}

export class AiTimeoutError extends AiError {
  constructor() {
    super('timeout', 'The AI provider did not answer in time.')
    this.name = 'AiTimeoutError'
  }
}

export type AiProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'not_found'
  | 'server'
  | 'network'
  | 'invalid_response'

/** A transport or HTTP failure. Carries the status and a kind, never the provider's message. */
export class AiProviderError extends AiError {
  constructor(readonly kind: AiProviderErrorKind, readonly status: number | null) {
    super('provider_error', `The AI provider request failed (${kind}${status ? ` ${status}` : ''}).`)
    this.name = 'AiProviderError'
  }
}

export function providerErrorKind(status: number): AiProviderErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  return 'bad_request'
}
