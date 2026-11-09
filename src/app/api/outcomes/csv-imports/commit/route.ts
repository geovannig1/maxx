import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { apiErrorResponse } from '@/lib/security/api-error'
import { CsvImportError, commitCsvImport, planCsvImport, type CsvImportTarget } from '@/lib/outcomes/adapters/csv/import'
import { UUID, counts, prepareCsvImport, reject, sourceLabel } from '@/lib/outcomes/adapters/csv/owner-route'

export const runtime = 'nodejs'

// POST /api/outcomes/csv-imports/commit?sha256=<previewed hash>&source=<csv source id>
//   or ?sha256=<previewed hash>&label=<new source label>&enabled=true|false
// Owner only. Body: the same CSV file as text/csv. The server validates the file again (a client's
// preview is never trusted), refuses it unless its SHA-256 equals the previewed one and every row is
// valid, then writes new and changed rows and the audit record in one transaction.
// 200 { ok, source_id, import_id, counts: { total, new, changed, unchanged, invalid } }
const ROUTE = 'POST /api/outcomes/csv-imports/commit'
const SHA256 = /^[0-9a-f]{64}$/

const ERRORS: Record<CsvImportError['code'], [number, string]> = {
  SOURCE_NOT_FOUND: [404, 'CSV source not found'],
  SOURCE_LABEL_TAKEN: [409, 'A CSV source with this name already exists'],
  ROWS_INVALID: [422, 'The file has invalid rows; fix them and preview again'],
}

function target(query: URLSearchParams): CsvImportTarget | null {
  const sourceId = query.get('source')
  const label = query.get('label')
  const enabled = query.get('enabled')
  if (sourceId !== null) return UUID.test(sourceId) && label === null && enabled === null ? { sourceId: sourceId.toLowerCase() } : null
  const name = sourceLabel(label)
  if (name === null || (enabled !== 'true' && enabled !== 'false')) return null
  return { label: name, enabled: enabled === 'true' }
}

export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const query = new URL(req.url).searchParams
  const sha256 = query.get('sha256')
  const destination = target(query)
  if (!sha256 || !SHA256.test(sha256) || !destination) return reject(400, 'INVALID_QUERY', 'Invalid file hash, source or label')
  const caller = await prepareCsvImport(req, user, ROUTE, { bucket: 'outcome_csv_commit', perHour: 30 })
  if ('response' in caller) return caller.response

  const db = getAdminClient()
  try {
    const planned = await planCsvImport(db, {
      adAccountId: caller.adAccountId,
      sourceId: 'sourceId' in destination ? destination.sourceId : null,
      text: caller.text,
      locale: caller.locale,
    })
    if (!planned.ok) return reject(422, 'CSV_FILE_INVALID', planned.fileError.message, { file_error: planned.fileError })
    if (planned.plan.fileSha256 !== sha256) {
      return reject(409, 'FILE_CHANGED', 'The file differs from the one you previewed; preview it again')
    }
    const result = await commitCsvImport(db, {
      adAccountId: caller.adAccountId, target: destination, actorUserId: caller.userId, plan: planned.plan,
    })
    return Response.json({
      ok: true,
      source_id: result.sourceId,
      import_id: result.importId,
      counts: { ...counts(planned.plan), new: result.inserted, changed: result.updated, unchanged: result.unchanged },
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof CsvImportError) {
      const [status, message] = ERRORS[error.code]
      return reject(status, error.code, message)
    }
    return apiErrorResponse(ROUTE, 'CSV_IMPORT_FAILED', error, 500)
  }
}
