import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { readBoundedBody } from '@/lib/security/bounded-body'
import { apiErrorResponse } from '@/lib/security/api-error'
import { activeAccountOrResponse } from '@/lib/outcomes/adapters/webhook/owner-route'
import { businessLocaleFromAccount } from '@/config/business-config'
import { MAX_CSV_BYTES } from './contract'
import type { CsvLocale } from './read'
import type { CsvImportPlan } from './import'

// Shared steps of the owner-only CSV import routes, run AFTER each route's own same-origin, session and
// ownerOnly() checks: per-owner rate limit, active account and its locale, then a size-bounded CSV body. Every failure returns a
// fixed message and code; database text goes to the server log only (api-error.ts), and nothing here
// ever logs a cell value.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CSV_TYPES = new Set(['text/csv', 'text/plain', 'application/csv'])

export const reject = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, code, ...extra }, { status, headers: { 'Cache-Control': 'private, no-store' } })

export interface CsvImportCaller {
  userId: string
  adAccountId: string
  locale: CsvLocale
  text: string
}

export async function prepareCsvImport(
  req: Request,
  user: { id?: unknown },
  route: string,
  limit: { bucket: string; perHour: number },
): Promise<CsvImportCaller | { response: Response }> {
  if (typeof user.id !== 'string' || !UUID.test(user.id)) return { response: reject(401, 'UNAUTHORIZED', 'Unauthorized') }

  const limited = await enforceApiRateLimit({ bucket: limit.bucket, actorKey: user.id, limit: limit.perHour, windowSeconds: 3600 })
  if (limited) return { response: limited }

  const owner = await activeAccountOrResponse()
  if ('response' in owner) return owner
  let locale: CsvLocale
  try {
    const { data, error } = await getAdminClient().from('ad_accounts')
      .select('timezone_name, currency').eq('id', owner.adAccountId).maybeSingle()
    if (error) throw new Error(error.message)
    const resolved = businessLocaleFromAccount(data as { timezone_name?: unknown; currency?: unknown } | null)
    locale = { timezone: resolved.timezone, currency: resolved.currency }
  } catch (error) {
    return { response: apiErrorResponse(route, 'BUSINESS_LOCALE_UNAVAILABLE', error, 409) }
  }

  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!CSV_TYPES.has(type)) return { response: reject(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file as text/csv') }
  const body = await readBoundedBody(req, MAX_CSV_BYTES)
  if (!body.ok) {
    return { response: body.error === 'too_large'
      ? reject(413, 'FILE_TOO_LARGE', `The file is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB`)
      : reject(400, 'FILE_UNREADABLE', 'The file could not be read as UTF-8 text') }
  }
  return { userId: user.id, adAccountId: owner.adAccountId, locale, text: body.rawBody }
}

/** A new source's label from the query: trimmed, 1-128 characters. */
export function sourceLabel(raw: string | null): string | null {
  if (raw === null) return null
  const label = raw.trim()
  return label.length >= 1 && label.length <= 128 ? label : null
}

const MAX_ERRORS_RETURNED = 500
const MAX_ROWS_RETURNED = 200

export function counts(plan: CsvImportPlan) {
  return {
    total: plan.totalRows, new: plan.newRows, changed: plan.changedRows,
    unchanged: plan.unchangedRows, invalid: plan.invalidRows,
  }
}

/** The preview body: counts, row errors (capped) and the first rows for the preview table. */
export function previewBody(plan: CsvImportPlan) {
  return {
    ok: true,
    file: { sha256: plan.fileSha256, bytes: plan.fileBytes },
    timezone: plan.timezone,
    counts: counts(plan),
    errors: plan.errors.slice(0, MAX_ERRORS_RETURNED),
    errors_truncated: plan.errors.length > MAX_ERRORS_RETURNED,
    rows: plan.rows.slice(0, MAX_ROWS_RETURNED).map(({ row, status, outcome: o }) => ({
      row, status, external_id: o.externalId, outcome_type: o.outcomeType, outcome_status: o.status,
      occurred_at: o.occurredAt, currency: o.currency, gross_value: o.grossValue,
      collected_value: o.collectedValue, origin: o.origin, outcome_label: o.outcomeLabel,
    })),
    rows_truncated: plan.rows.length > MAX_ROWS_RETURNED,
  }
}
