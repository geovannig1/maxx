// Client-side state and requests for webhook source management on /settings/outcomes. The signing
// secret comes back exactly once (create or rotate) from the owner-only routes, which answer with
// Cache-Control: no-store. Here it lives only inside the `revealed` dialog state: closing the dialog
// replaces that state, so nothing keeps the secret afterwards. It is never logged or stored.

/** The header the verifier reads (src/lib/outcomes/adapters/webhook/signature.ts; a test pins them equal). */
export const WEBHOOK_SIGNATURE_HEADER = 'x-maxx-signature'
export const WEBHOOK_SIGNATURE_FORMAT = 't=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>'

export const webhookPath = (sourceId: string) => `/api/outcomes/webhook/${sourceId}`

const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECRET = /^[0-9a-f]{64}$/

export interface SecretReveal {
  sourceId: string
  label: string
  secret: string
  path: string
  action: 'created' | 'rotated'
}

export type WebhookDialogState =
  | { kind: 'closed' }
  | { kind: 'confirm-rotate' }
  | { kind: 'revealed'; reveal: SecretReveal }

export type WebhookDialogAction =
  | { type: 'ask-rotate' }
  | { type: 'reveal'; reveal: SecretReveal }
  | { type: 'close' }

export function webhookDialogReducer(_state: WebhookDialogState, action: WebhookDialogAction): WebhookDialogState {
  switch (action.type) {
    case 'ask-rotate': return { kind: 'confirm-rotate' }
    case 'reveal': return { kind: 'revealed', reveal: action.reveal }
    case 'close': return { kind: 'closed' }
  }
}

export type WebhookRequestResult = { ok: true; reveal: SecretReveal } | { ok: false; message: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

async function postForSecret(
  url: string,
  body: unknown,
  fetchImpl: FetchLike,
  fallback: string,
): Promise<{ ok: true; sourceId: string; secret: string } | { ok: false; message: string }> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    return { ok: false, message: fallback }
  }
  const json = await response.json().catch(() => null) as { source_id?: unknown; secret?: unknown; error?: unknown } | null
  if (!response.ok) {
    return { ok: false, message: typeof json?.error === 'string' && json.error.length <= 200 ? json.error : fallback }
  }
  if (typeof json?.source_id !== 'string' || !SOURCE_ID.test(json.source_id)
      || typeof json.secret !== 'string' || !SECRET.test(json.secret)) {
    return { ok: false, message: fallback }
  }
  return { ok: true, sourceId: json.source_id.toLowerCase(), secret: json.secret }
}

export async function requestCreateWebhookSource(
  input: { label: string; enabled: boolean },
  fetchImpl: FetchLike = fetch,
): Promise<WebhookRequestResult> {
  const label = input.label.trim()
  if (!label) return { ok: false, message: 'Enter a name for the source.' }
  const result = await postForSecret('/api/outcomes/webhook-sources', { label, enabled: input.enabled }, fetchImpl,
    'The source was not created. Try again.')
  if (!result.ok) return result
  return { ok: true, reveal: { sourceId: result.sourceId, label, secret: result.secret, path: webhookPath(result.sourceId), action: 'created' } }
}

export async function requestRotateWebhookSecret(
  source: { id: string; label: string },
  fetchImpl: FetchLike = fetch,
): Promise<WebhookRequestResult> {
  const result = await postForSecret(`/api/outcomes/webhook-sources/${encodeURIComponent(source.id)}/rotate`, {}, fetchImpl,
    'The secret was not rotated. Try again.')
  if (!result.ok) return result
  return { ok: true, reveal: { sourceId: result.sourceId, label: source.label, secret: result.secret, path: webhookPath(result.sourceId), action: 'rotated' } }
}
