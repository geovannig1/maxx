import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { activeAccountErrorStatus } from '@/lib/accounts/active-account'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { saveRequestSchema } from '@/lib/creative/copy-brief'
import { saveCopyVariant } from '@/lib/creative/copy-studio'
import { parseCopyBody, privateJson } from '@/lib/creative/copy-route'

export const runtime = 'nodejs'

// POST /api/creative/copy/bank: save one variant to the copy bank (copy_variations) of the active
// account. The server re-scores it and refuses copy that is not publishable. Saving is a library entry:
// it never approves, launches or changes anything in Meta.
const MAX_BODY_BYTES = 16_000

export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return privateJson({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  // Same budget as manual copy entry (hooks_create): one a minute is far above real use.
  const limited = await enforceApiRateLimit({ bucket: 'copy_bank_save', actorKey: user.id, limit: 60, windowSeconds: 3600 })
  if (limited) return limited

  const body = await parseCopyBody(req, MAX_BODY_BYTES, saveRequestSchema)
  if (!body.ok) return body.response
  const result = await saveCopyVariant(body.data)
  switch (result.status) {
    case 'saved': return privateJson(result, { status: 201 })
    case 'blocked': return privateJson({ ...result, code: 'COPY_NOT_PUBLISHABLE', error: 'This copy has a blocker (unverified claim, policy risk or hard limit). Fix it before saving.' }, { status: 422 })
    case 'account_unavailable': return privateJson({ status: result.status, code: result.code, error: 'The active ad account is unavailable.' }, { status: activeAccountErrorStatus(result.reason) })
    default: return privateJson({ error: 'The copy could not be saved. The details were logged on the server.', code: 'COPY_BANK_WRITE_FAILED' }, { status: 500 })
  }
}
