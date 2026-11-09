import 'server-only'
import { META_GRAPH_BASE } from './api-version'
import { isSafeMetaEntityId } from '@/lib/writes/meta-live-state'
import type { GovernedWriteRequest } from '@/lib/writes/write-authority'
import { toMetaMinorUnits } from './currency-offset'
import { budgetParamValue } from '@/lib/writes/budget-param'

// Meta Graph transport for governed writes, moved unchanged from src/lib/writes/executor.ts. The
// executor keeps every gate (WRITE_MODE_ENABLED, approval, expiry, idempotency, ownership,
// budget bounds); this module only reads and writes Meta objects once those gates have passed.

type WriteActionType = GovernedWriteRequest['actionType']

const META_GRAPH_URL = META_GRAPH_BASE

function token(): string {
  return (process.env.META_ACCESS_TOKEN ?? '').trim()
}

function metaAuthHeaders(): Record<string, string> | null {
  const accessToken = token()
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : null
}

/** True when a Meta write credential is configured. Reads no network. */
export function hasMetaWriteCredentials(): boolean {
  return metaAuthHeaders() !== null
}

export async function metaGetEntity(entityId: string, fields: string): Promise<Record<string, unknown> | null> {
  const headers = metaAuthHeaders()
  if (!headers) return null
  const url = new URL(`${META_GRAPH_URL}/${entityId}`)
  url.searchParams.set('fields', fields)
  const res = await fetch(url.toString(), { headers })
  if (!res.ok) return null
  const body = await res.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
}

export interface MetaBudgetRow {
  id?: unknown
  campaign_id?: unknown
  daily_budget?: unknown
  lifetime_budget?: unknown
}

async function metaGetAllBudgetRows(
  url: URL,
): Promise<MetaBudgetRow[] | null> {
  const headers = metaAuthHeaders()
  if (!headers) return null
  const rows: MetaBudgetRow[] = []
  const seen = new Set<string>()
  let next: string | null = url.toString()
  for (let page = 0; next && page < 20; page++) {
    const safe = new URL(next)
    safe.searchParams.delete('access_token')
    const href = safe.toString()
    if (seen.has(href)) return null
    seen.add(href)
    // Paging URLs come from Meta's response body; only ever follow them back to the Graph origin.
    if (safe.origin !== 'https://graph.facebook.com') return null
    const res = await fetch(href, { headers })
    if (!res.ok) return null
    const body = await res.json().catch(() => null) as {
      data?: unknown
      paging?: { next?: unknown }
      error?: unknown
    } | null
    if (!body || body.error || !Array.isArray(body.data)) return null
    rows.push(...body.data.filter((row): row is MetaBudgetRow => !!row && typeof row === 'object'))
    next = typeof body.paging?.next === 'string' && body.paging.next ? body.paging.next : null
  }
  if (next) return null
  return rows
}

/** Meta effective statuses under which a configured budget can spend now or without further owner
 *  action: live, in or awaiting review, pre-approved, awaiting billing, still processing, or delivering
 *  with issues. Paused/archived/deleted/disapproved (and the *_PAUSED parent states) cannot spend. */
export const SPENDING_EFFECTIVE_STATUSES = JSON.stringify([
  'ACTIVE', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES',
])

/** Every page of the account's spend-capable campaign and ad-set budget rows. A list is null when any page
 * could not be read completely; the caller must then treat the account budget as unknown. */
export async function fetchActiveBudgetRows(
  normalizedAccountId: string,
): Promise<{ campaigns: MetaBudgetRow[] | null; adsets: MetaBudgetRow[] | null }> {
  const campaignUrl = new URL(`${META_GRAPH_URL}/act_${normalizedAccountId}/campaigns`)
  campaignUrl.searchParams.set('fields', 'id,daily_budget,lifetime_budget')
  campaignUrl.searchParams.set('effective_status', SPENDING_EFFECTIVE_STATUSES)
  campaignUrl.searchParams.set('limit', '200')
  const adsetUrl = new URL(`${META_GRAPH_URL}/act_${normalizedAccountId}/adsets`)
  adsetUrl.searchParams.set('fields', 'id,campaign_id,daily_budget,lifetime_budget')
  adsetUrl.searchParams.set('effective_status', SPENDING_EFFECTIVE_STATUSES)
  adsetUrl.searchParams.set('limit', '500')

  const [campaigns, adsets] = await Promise.all([
    metaGetAllBudgetRows(campaignUrl),
    metaGetAllBudgetRows(adsetUrl),
  ])
  return { campaigns, adsets }
}

/** Apply one governed change to Meta. The caller has already validated the entity id and the budget
 * bounds; this performs the Meta calls and reports partial success truthfully. */
export async function applyMetaChange(
  actionType: WriteActionType,
  entityId: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; response: unknown; newEntityId?: string }> {
  const authHeaders = metaAuthHeaders()
  if (!authHeaders) {
    return { ok: false, response: { error: 'Meta write credentials are unavailable.' } }
  }
  const post = (body: URLSearchParams): RequestInit => ({
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (actionType === 'duplicate_adset') {
    // Copy the ad set PAUSED, then apply the requested name/budget to the COPY. Meta's /copies endpoint
    // accepts neither, so without this follow-up update the new_name / new_daily_budget the caller
    // asked for were silently dropped (the copy kept the source's name + budget).
    const copyUrl = new URL(`${META_GRAPH_URL}/${entityId}/copies`)
    const copyBody = new URLSearchParams({ deep_copy: 'true', status_option: 'PAUSED' })
    const copyRes = await fetch(copyUrl.toString(), post(copyBody))
    const copyJson = (await copyRes.json().catch(() => ({}))) as Record<string, unknown>
    if (!copyRes.ok) return { ok: false, response: copyJson }
    const returnedId = copyJson.copied_adset_id ?? copyJson.id
    const newId = isSafeMetaEntityId(returnedId) ? returnedId : undefined

    if (returnedId != null && !newId) {
      // The copy endpoint succeeded, so a live object may exist, but an unsafe/unusable id must never
      // be interpolated into a second request. Preserve this as truthful partial success for audit.
      return {
        ok: true,
        response: { copy: copyJson, update_error: { error: 'Meta returned an invalid copied ad set id.' } },
      }
    }

    if (newId && (params.new_name != null || budgetParamValue(params) != null)) {
      const upUrl = new URL(`${META_GRAPH_URL}/${newId}`)
      const updateBody = new URLSearchParams()
      if (params.new_name != null) updateBody.set('name', String(params.new_name))
      if (budgetParamValue(params) != null) updateBody.set('daily_budget', String(toMetaMinorUnits(Number(budgetParamValue(params)))))
      const upRes = await fetch(upUrl.toString(), post(updateBody))
      const upJson = await upRes.json().catch(() => ({}))
      if (!upRes.ok) {
        // PARTIAL SUCCESS: the copy EXISTS in Meta (a live change happened) even though the name/budget
        // update failed. Recording this as "failed" would be an audit lie — return ok:true with the
        // update error attached; verification below fetches the copy, sees the mismatch, and lands the
        // action as applied_unverified with the copied id preserved for manual follow-up/cleanup.
        return { ok: true, response: { copy: copyJson, update_error: upJson }, newEntityId: newId }
      }
    }
    return { ok: true, response: copyJson, newEntityId: newId }
  }

  const url = new URL(`${META_GRAPH_URL}/${entityId}`)
  const body = new URLSearchParams()
  if (actionType === 'pause_ad' || actionType === 'activate_ad') {
    body.set('status', actionType === 'pause_ad' ? 'PAUSED' : 'ACTIVE')
  } else {
    body.set('daily_budget', String(toMetaMinorUnits(Number(budgetParamValue(params)))))
  }
  const res = await fetch(url.toString(), post(body))
  const response = await res.json().catch(() => ({}))
  return { ok: res.ok, response }
}
