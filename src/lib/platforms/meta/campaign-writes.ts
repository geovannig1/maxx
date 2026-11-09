import 'server-only'
import { META_GRAPH_BASE } from './api-version'
import { metaGetEntity } from './writes'
import { assertPaused, type GraphBody } from './campaign-payloads'
import { redactSecretText } from '@/lib/security/redact-secrets'

// ADR-062: Meta Graph transport for creating a plan's objects. Called only by the campaign-plan
// executor after its gates (write mode, approval, expiry, account lock, re-validation) have passed.
// It can create objects PAUSED, find one by its marker, read one back, and set PAUSED or ARCHIVED.
// There is no code path here that sets ACTIVE.

export interface MetaCallError { code: string; meta_code?: number; meta_subcode?: number; message?: string }
export type MetaCreateResult = { ok: true; id: string } | { ok: false; error: MetaCallError }

const SAFE_ID = /^\d{1,32}$/
const SAFE_EDGE = /^(?:act_\d{1,32}|\d{1,32})\/(?:campaigns|adsets|ads|adcreatives)$/

function authHeaders(): Record<string, string> | null {
  const token = (process.env.META_ACCESS_TOKEN ?? '').trim()
  return token ? { Authorization: `Bearer ${token}` } : null
}

/** Meta's own rejection reason, without anything else from the response. */
function metaError(body: unknown, fallback: string): MetaCallError {
  const error = (body as { error?: Record<string, unknown> } | null)?.error
  if (!error || typeof error !== 'object') return { code: fallback }
  const text = typeof error.error_user_msg === 'string' ? error.error_user_msg : typeof error.message === 'string' ? error.message : undefined
  return {
    code: fallback,
    meta_code: typeof error.code === 'number' ? error.code : undefined,
    meta_subcode: typeof error.error_subcode === 'number' ? error.error_subcode : undefined,
    message: text === undefined ? undefined : redactSecretText(text, 300),
  }
}

/** POST one object, PAUSED, under an edge such as act_123/campaigns. */
export async function metaCreateObject(edge: string, body: GraphBody): Promise<MetaCreateResult> {
  const headers = authHeaders()
  if (!headers) return { ok: false, error: { code: 'META_CREDENTIALS_MISSING' } }
  if (!SAFE_EDGE.test(edge)) return { ok: false, error: { code: 'META_EDGE_INVALID' } }
  assertPaused(body)
  let res: Response
  try {
    res = await fetch(`${META_GRAPH_BASE}/${edge}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
    })
  } catch {
    return { ok: false, error: { code: 'META_UNREACHABLE' } }
  }
  const json = await res.json().catch(() => null) as { id?: unknown } | null
  if (!res.ok) return { ok: false, error: metaError(json, 'META_REJECTED') }
  const id = typeof json?.id === 'string' ? json.id : null
  return id && SAFE_ID.test(id) ? { ok: true, id } : { ok: false, error: { code: 'META_ID_INVALID' } }
}

/** An object under an edge whose name carries the marker: its id, null when none, or a failed read. */
export async function metaFindMarked(edge: string, marker: string): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const headers = authHeaders()
  if (!headers || !SAFE_EDGE.test(edge) || !/^[a-z0-9-]{1,40}$/.test(marker)) return { ok: false }
  const url = new URL(`${META_GRAPH_BASE}/${edge}`)
  url.searchParams.set('fields', 'id,name')
  url.searchParams.set('limit', '50')
  url.searchParams.set('filtering', JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: marker }]))
  try {
    const res = await fetch(url.toString(), { headers })
    if (!res.ok) return { ok: false }
    const json = await res.json().catch(() => null) as { data?: Array<{ id?: unknown; name?: unknown }> } | null
    if (!json || !Array.isArray(json.data)) return { ok: false }
    const hits = json.data.filter((row) => typeof row.name === 'string' && row.name.includes(`[${marker}]`) && typeof row.id === 'string' && SAFE_ID.test(row.id))
    // Two objects with one marker would mean a duplicate already exists: refuse to guess.
    if (hits.length > 1) return { ok: false }
    return { ok: true, id: hits.length === 1 ? String(hits[0].id) : null }
  } catch {
    return { ok: false }
  }
}

/** Read an object back for verification. */
export function metaReadObject(id: string, fields: string): Promise<Record<string, unknown> | null> {
  if (!SAFE_ID.test(id)) return Promise.resolve(null)
  return metaGetEntity(id, fields)
}

/** Set an object PAUSED (a verification repair) or ARCHIVED (an approved rollback). Never ACTIVE. */
export async function metaSetStatus(id: string, status: 'PAUSED' | 'ARCHIVED'): Promise<{ ok: boolean; error?: MetaCallError }> {
  const headers = authHeaders()
  if (!headers) return { ok: false, error: { code: 'META_CREDENTIALS_MISSING' } }
  if (!SAFE_ID.test(id) || (status !== 'PAUSED' && status !== 'ARCHIVED')) return { ok: false, error: { code: 'META_REQUEST_INVALID' } }
  try {
    const res = await fetch(`${META_GRAPH_BASE}/${id}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ status }),
    })
    if (res.ok) return { ok: true }
    return { ok: false, error: metaError(await res.json().catch(() => null), 'META_REJECTED') }
  } catch {
    return { ok: false, error: { code: 'META_UNREACHABLE' } }
  }
}
