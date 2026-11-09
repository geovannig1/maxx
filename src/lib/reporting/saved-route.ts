import type { NextRequest } from 'next/server'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { ownerGate } from '@/lib/auth/owner'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readReportingUser } from './session'
import { withReportingDeadline, REPORTING_IDENTITY_TIMEOUT_MS } from './deadline'
import { SavedReportError } from './saved-contract'
import { SavedRequestError, readSavedReportCommand } from './saved-request'
import { saveReportingReport, listSavedReportingReports, openSavedReportingReport } from './saved-service'
import { compactReportingData } from './packet-format'
import type { ReportingData } from './contracts'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Accept-Encoding' }
const compress = promisify(gzip)
function failure(error: string, status: number, code?: string) {
  return Response.json({ error, ...(code ? { code } : {}) }, {
    status,
    headers: code ? { ...headers, 'x-reporting-error-code': code } : headers,
  })
}
async function response(request: NextRequest, body: unknown, status = 200) {
  const json = JSON.stringify(body)
  if (json.length > 16_384 && request.headers.get('accept-encoding')?.split(',').some(value => value.trim() === 'gzip')) {
    return new Response(new Uint8Array(await compress(json)), { status,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })
  }
  return Response.json(body, { status, headers })
}
export async function savedReportingRoute(request: NextRequest, operation: 'save' | 'list' | 'open', id?: string): Promise<Response> {
  try {
    const user = await readReportingUser(async () => (await createClient()).auth.getUser(), request.signal)
    if (!user) return failure('Sign in to view saved reports.', 401)
    if (!ownerGate(user).allowed) return failure('Owner access is required to view saved reports.', 403)
    if (operation === 'save' && request.headers.get('origin') !== request.nextUrl.origin) return failure('Save reports from this application.', 403)
    const params = request.nextUrl.searchParams
    if ([...params.keys()].some(key => operation !== 'list' || key !== 'cursor')
      || params.getAll('cursor').length > 1 || (params.get('cursor')?.length ?? 0) > 256) return failure('Use a supported saved report request.', 400)
    const input = operation === 'save' ? await readSavedReportCommand(request) : null
    const active = await withReportingDeadline(() => resolveOnlyActiveAccount(), REPORTING_IDENTITY_TIMEOUT_MS, request.signal)
    if (!active.ok) return failure('Reporting account ownership could not be resolved.',
      active.reason === 'ambiguous' ? 409 : active.reason === 'not_found' ? 404 : 503,
      activeAccountErrorCode(active.reason))
    const account = { id: active.account.id, metaAccountId: active.account.accountId, name: active.account.accountName }
    const db = getAdminClient()
    const body = operation === 'save' ? await saveReportingReport(db, account, user.id, input)
      : operation === 'open' ? await openSavedReportingReport(db, account, id ?? '')
      : await listSavedReportingReports(db, account.id, params.get('cursor'))
    // Opened report data travels as dataVersion 2; the browser checks its identity on the expansion.
    const transported = 'data' in body && body.data ? { ...body, data: compactReportingData(body.data as ReportingData) } : body
    return response(request, transported, operation === 'save' ? 201 : 200)
  } catch (error) {
    if (error instanceof SavedRequestError) return failure(error.message, error.status)
    if (error instanceof SavedReportError) return failure(error.message,
      { invalid: 400, unavailable: 503, not_found: 404, incompatible: 422, changed: 409 }[error.code], error.code)
    return failure('Saved reports are temporarily unavailable. Please retry.', 503, 'unavailable')
  }
}
