import { createHmac } from 'node:crypto'
import { META_API_VERSION, META_GRAPH_BASE } from './api-version'
import type { PlatformConnectionInput, PlatformConnectionResult } from '../types'

// Setup and doctor check for Meta: is the token valid, which permissions does it
// hold, and can it read the configured ad account. It takes the token explicitly (setup validates a
// value before writing it) and an injected fetch (tests run offline). It uses the app's pinned Graph
// version, never its own. The token travels in the Authorization header, never in a URL.

interface GraphError { error?: { message?: string } }

async function graphGet(input: PlatformConnectionInput, path: string): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${META_GRAPH_BASE}/${path}`)
  if (input.appSecretProof && input.appSecret) {
    url.searchParams.set('appsecret_proof', createHmac('sha256', input.appSecret).update(input.accessToken).digest('hex'))
  }
  const response = await input.fetch(url.toString(), {
    headers: { Authorization: `Bearer ${input.accessToken}` },
    signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
  })
  let body: unknown = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

const graphMessage = (body: unknown, status: number) =>
  (body as GraphError | null)?.error?.message?.slice(0, 300) ?? `HTTP ${status}`

export async function checkMetaConnection(input: PlatformConnectionInput): Promise<PlatformConnectionResult> {
  const base: PlatformConnectionResult = { reachable: false, tokenValid: false, scopes: null, account: null, error: null, apiVersion: META_API_VERSION }
  let permissions
  try {
    permissions = await graphGet(input, 'me/permissions')
  } catch (error) {
    return { ...base, error: error instanceof Error && error.name === 'TimeoutError' ? 'Meta did not answer in time.' : 'Meta could not be reached.' }
  }
  if (permissions.status !== 200) return { ...base, reachable: true, error: graphMessage(permissions.body, permissions.status) }
  const data = (permissions.body as { data?: Array<{ permission?: unknown; status?: unknown }> } | null)?.data ?? []
  const scopes = data.filter((p) => p.status === 'granted' && typeof p.permission === 'string').map((p) => p.permission as string).sort()
  let account
  try {
    account = await graphGet(input, `${encodeURIComponent(input.accountId)}?fields=name,currency,timezone_name,account_status`)
  } catch {
    return { ...base, reachable: true, tokenValid: true, scopes, error: 'Meta could not be reached for the ad account.' }
  }
  if (account.status !== 200) return { ...base, reachable: true, tokenValid: true, scopes, error: graphMessage(account.body, account.status) }
  const row = account.body as { name?: unknown; currency?: unknown; timezone_name?: unknown; account_status?: unknown }
  return {
    ...base, reachable: true, tokenValid: true, scopes,
    account: {
      name: typeof row.name === 'string' ? row.name : null,
      currency: typeof row.currency === 'string' ? row.currency : null,
      timezone: typeof row.timezone_name === 'string' ? row.timezone_name : null,
      status: typeof row.account_status === 'number' ? row.account_status : null,
    },
  }
}
