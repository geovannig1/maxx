import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { apiErrorResponse } from '@/lib/security/api-error'
import { CsvImportError, csvSourceLabelTaken, planCsvImport } from '@/lib/outcomes/adapters/csv/import'
import { UUID, prepareCsvImport, previewBody, reject, sourceLabel } from '@/lib/outcomes/adapters/csv/owner-route'

export const runtime = 'nodejs'

// POST /api/outcomes/csv-imports/preview?source=<csv source id> | ?label=<new source label>
// Owner only. Body: the CSV file as text/csv (at most 4 MiB). A dry run: validates the whole file and
// classifies every row as new, changed, unchanged or invalid against the chosen source; writes nothing.
// 200 { file: { sha256, bytes }, timezone, counts, errors[], errors_truncated, rows[], rows_truncated }
// 422 { code: 'CSV_FILE_INVALID', file_error } when the file itself cannot be read.
const ROUTE = 'POST /api/outcomes/csv-imports/preview'

export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const query = new URL(req.url).searchParams
  const sourceId = query.get('source')
  const label = query.get('label')
  if ((sourceId !== null && !UUID.test(sourceId)) || (label !== null && sourceLabel(label) === null)) {
    return reject(400, 'INVALID_QUERY', 'Invalid source or label')
  }
  const caller = await prepareCsvImport(req, user, ROUTE, { bucket: 'outcome_csv_preview', perHour: 60 })
  if ('response' in caller) return caller.response

  const db = getAdminClient()
  try {
    if (sourceId === null && label !== null && await csvSourceLabelTaken(db, caller.adAccountId, sourceLabel(label)!)) {
      return reject(409, 'SOURCE_LABEL_TAKEN', 'A CSV source with this name already exists')
    }
    const planned = await planCsvImport(db, {
      adAccountId: caller.adAccountId, sourceId: sourceId?.toLowerCase() ?? null, text: caller.text, locale: caller.locale,
    })
    if (!planned.ok) return reject(422, 'CSV_FILE_INVALID', planned.fileError.message, { file_error: planned.fileError })
    return Response.json(previewBody(planned.plan), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof CsvImportError && error.code === 'SOURCE_NOT_FOUND') {
      return reject(404, 'SOURCE_NOT_FOUND', 'CSV source not found')
    }
    return apiErrorResponse(ROUTE, 'CSV_PREVIEW_FAILED', error, 500)
  }
}
