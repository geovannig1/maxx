import { redactSecretText } from '@/lib/security/redact-secrets'

// What of a provider's answer to a governed write is kept (security review L3): the scalar ids and
// flags the audit needs, and for an error the provider's code, subcode and its message, trimmed and
// redacted. Everything else (debug URLs, trace ids, anything echoing a credential) is dropped before
// the answer is stored on action_log / change_requests or returned to the browser. PURE.

const SAFE_SCALARS = new Set(['success', 'id', 'copied_adset_id'])
const NESTED = new Set(['copy', 'update_error'])
const MESSAGE_LIMIT = 300

function safeError(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value, MESSAGE_LIMIT)
  if (!value || typeof value !== 'object') return { code: 'PROVIDER_REJECTED' }
  const error = value as Record<string, unknown>
  const text = typeof error.error_user_msg === 'string' ? error.error_user_msg : typeof error.message === 'string' ? error.message : null
  return {
    code: 'PROVIDER_REJECTED',
    ...(typeof error.code === 'number' ? { meta_code: error.code } : {}),
    ...(typeof error.error_subcode === 'number' ? { meta_subcode: error.error_subcode } : {}),
    ...(text ? { message: redactSecretText(text, MESSAGE_LIMIT) } : {}),
  }
}

const safeScalar = (value: unknown): boolean =>
  typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^\d{1,32}$/.test(value))

/** The provider answer reduced to what may be stored and shown. */
export function safeWriteResponse(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(response as Record<string, unknown>)) {
    if (key === 'error') out.error = safeError(value)
    else if (NESTED.has(key)) out[key] = safeWriteResponse(value)
    else if (SAFE_SCALARS.has(key) && safeScalar(value)) out[key] = value
  }
  return out
}
