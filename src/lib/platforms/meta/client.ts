import 'server-only'
import crypto from 'crypto'
import type { MetaApiResponse } from '@/types/meta-api'
import { META_GRAPH_BASE } from '@/lib/platforms/meta/api-version'

const META_BASE_URL = META_GRAPH_BASE

// ============================================================
// Custom error class
// ============================================================
export class MetaApiError extends Error {
  code: number
  subcode?: number
  fbtrace_id?: string
  httpStatus?: number
  retryAfterMs?: number

  constructor(error: {
    message: string
    code: number
    error_subcode?: number
    fbtrace_id?: string
    httpStatus?: number
    retryAfterMs?: number
  }) {
    super(error.message)
    this.name = 'MetaApiError'
    this.code = error.code
    this.subcode = error.error_subcode
    this.fbtrace_id = error.fbtrace_id
    this.httpStatus = error.httpStatus
    this.retryAfterMs = error.retryAfterMs
  }

  /** OAuth / token expiry codes */
  isTokenError(): boolean {
    return [102, 190].includes(this.code)
  }

  /** Rate-limit codes */
  isRateLimit(): boolean {
    return [4, 17, 613, 80000, 80004].includes(this.code)
  }

  /** Transient server/network errors worth retrying (HTTP 5xx or Meta transient code 2). */
  isTransient(): boolean {
    return this.code === 2 || (this.httpStatus !== undefined && this.httpStatus >= 500)
  }
}

/** The optional field named by a Graph "unsupported field" error (code 100), or null.
 * Moved unchanged from delivery-sub-status.ts so that module stays free of the client. */
export function unsupportedOptionalMetaField(
  error: unknown,
  includedFields: Iterable<string>,
): string | null {
  if (!(error instanceof MetaApiError) || error.code !== 100) return null
  for (const field of includedFields) {
    if (error.message.includes(field)) return field
  }
  return null
}

// ============================================================
// HMAC-SHA256 app secret proof
// ============================================================
export function appSecretProof(accessToken: string): string {
  const appSecret = process.env.META_APP_SECRET ?? ''
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex')
}

/** Resolve the server-side Meta token without ever placing it in a URL. */
export function requireMetaAccessToken(explicitToken?: string): string {
  const accessToken = (explicitToken ?? process.env.META_ACCESS_TOKEN ?? '').trim()
  if (!accessToken) {
    throw new MetaApiError({
      message: 'META_ACCESS_TOKEN is not configured',
      code: 190,
    })
  }
  return accessToken
}

/**
 * Fetch a Meta Graph URL using header authentication.
 *
 * Meta includes `access_token` (and sometimes `appsecret_proof`) in signed paging URLs. Treat those
 * URLs as untrusted input: accept only the configured Graph origin, discard supplied credentials,
 * and recompute the opt-in proof locally before sending the bearer header.
 */
export async function fetchMetaGraph(
  input: string | URL,
  init: RequestInit = {},
  explicitToken?: string,
): Promise<Response> {
  const accessToken = requireMetaAccessToken(explicitToken)
  const url = new URL(input.toString(), `${META_BASE_URL}/`)
  const expectedOrigin = new URL(META_BASE_URL).origin

  if (url.protocol !== 'https:' || url.origin !== expectedOrigin) {
    throw new MetaApiError({
      message: 'Refusing non-Meta Graph URL',
      code: 0,
    })
  }

  url.searchParams.delete('access_token')
  url.searchParams.delete('appsecret_proof')
  // appsecret_proof hardens the call against a stolen token. It remains opt-in because the secret
  // must match the app that minted the token; a mismatched secret makes every Graph call fail.
  if (process.env.META_APPSECRET_PROOF_ENABLED === 'true' && process.env.META_APP_SECRET) {
    url.searchParams.set('appsecret_proof', appSecretProof(accessToken))
  }

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)

  return fetch(url.toString(), { ...init, headers })
}

// ============================================================
// Core GET helper
// ============================================================
function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined
  const header = value.trim()
  // RFC 9110 §10.2.3: nonnegative integer seconds or HTTP-date. Do not parse a negative
  // number as a date (Date.parse('-2') is permissive in some runtimes).
  const milliseconds = /^\d+$/.test(header) ? Number(header) * 1_000
    : /^[A-Za-z]{3,9}[, ]/.test(header) ? Date.parse(header) - Date.now() : NaN
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined
}

export async function metaGet<T>(
  path: string,
  params: Record<string, string> = {},
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const accessToken = requireMetaAccessToken()

  const url = new URL(`${META_BASE_URL}${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const response = await fetchMetaGraph(url, options, accessToken)

  // Check rate-limit usage header
  const usageHeader = response.headers.get('X-Business-Use-Case-Usage')
  if (usageHeader) {
    try {
      const usage = JSON.parse(usageHeader) as Record<string, Array<{ call_count: number; total_time: number; total_cputime: number }>>
      for (const [, entries] of Object.entries(usage)) {
        for (const entry of entries) {
          if (entry.call_count > 80 || entry.total_time > 80 || entry.total_cputime > 80) {
            console.warn('[MetaApi] Rate limit usage > 80%:', entry)
          }
        }
      }
    } catch {
      // Non-JSON header — ignore
    }
  }

  const json = (await response.json().catch(() => null)) as MetaApiResponse<T> | null

  if (!response.ok || json?.error) {
    const e = json?.error ?? { message: `Meta API HTTP ${response.status} ${response.statusText}`, code: response.status }
    throw new MetaApiError({ ...e, httpStatus: response.status,
      retryAfterMs: retryAfterMilliseconds(response.headers.get('Retry-After')) })
  }
  if (json === null) {
    throw new MetaApiError({ message: 'Meta API returned a non-JSON/empty response', code: 0, httpStatus: response.status })
  }

  return json as T
}

// ============================================================
// Paginated GET — follows paging.next until exhausted
// ============================================================
export async function metaGetPaginated<T>(
  path: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  const accessToken = requireMetaAccessToken()
  const allItems: T[] = []

  // Build first URL
  const firstUrl = new URL(`${META_BASE_URL}${path}`)
  for (const [key, value] of Object.entries(params)) {
    firstUrl.searchParams.set(key, value)
  }

  let nextUrl: string | undefined = firstUrl.toString()

  while (nextUrl) {
    const response = await fetchMetaGraph(nextUrl, {}, accessToken)

    const usageHeader = response.headers.get('X-Business-Use-Case-Usage')
    if (usageHeader) {
      try {
        const usage = JSON.parse(usageHeader) as Record<string, Array<{ call_count: number; total_time: number; total_cputime: number }>>
        for (const [, entries] of Object.entries(usage)) {
          for (const entry of entries) {
            if (entry.call_count > 80 || entry.total_time > 80 || entry.total_cputime > 80) {
              console.warn('[MetaApi] Rate limit usage > 80%:', entry)
            }
          }
        }
      } catch {
        // Non-JSON header — ignore
      }
    }

    const json = (await response.json().catch(() => null)) as MetaApiResponse<T[]> | null

    if (!response.ok || json?.error) {
      const e = json?.error ?? { message: `Meta API HTTP ${response.status} ${response.statusText}`, code: response.status }
      throw new MetaApiError({ ...e, httpStatus: response.status })
    }
    if (json === null) {
      throw new MetaApiError({ message: 'Meta API returned a non-JSON/empty response', code: 0, httpStatus: response.status })
    }

    if (Array.isArray(json.data)) {
      allItems.push(...json.data)
    }

    nextUrl = json.paging?.next
  }

  return allItems
}
