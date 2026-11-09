import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Authenticated deployment identity for release acceptance. This deliberately
 * returns no build configuration, secrets, account data, or Vercel URLs.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim()
  if (!commitSha) {
    return Response.json({ error: 'Deployment commit identity is unavailable.' }, {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  return Response.json({
    commit_sha: commitSha,
    build_id: process.env.VERCEL_DEPLOYMENT_ID?.trim() || null,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
