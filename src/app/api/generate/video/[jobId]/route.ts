import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { checkVideoStatus } from '@/lib/creative/video-generator'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { jobId } = await params
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }

  // Provider job identifiers are caller-controlled. Bind the job to the active account before the
  // metered provider lookup so a guessed cross-account id is indistinguishable from a missing job.
  const { data: creative, error: lookupError } = await db
    .from('generated_creatives')
    .select('id')
    .eq('meta_ad_id', jobId)
    .eq('ad_account_id', activeAccount.account.id)
    .maybeSingle()
  if (lookupError) return apiErrorResponse('GET /api/generate/video/[jobId]', 'VIDEO_JOB_READ_FAILED', lookupError, 500)
  if (!creative) return Response.json({ error: 'Video job not found' }, { status: 404 })

  try {
    const status = await checkVideoStatus(jobId)

    if (status.status === 'completed' && status.video_url) {
      const { data: updated, error: updateError } = await db
        .from('generated_creatives')
        .update({ asset_url: status.video_url })
        .eq('id', creative.id as string)
        .eq('ad_account_id', activeAccount.account.id)
        .select('id')
        .maybeSingle()
      if (updateError) throw new Error(updateError.message)
      if (!updated) return Response.json({ error: 'Video job not found' }, { status: 404 })
    }

    return Response.json(status)
  } catch (error) {
    return apiErrorResponse('GET /api/generate/video/[jobId]', 'VIDEO_JOB_STATUS_FAILED', error, 500)
  }
}
