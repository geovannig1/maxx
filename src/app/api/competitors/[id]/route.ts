import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { parseStoredHttpUrl } from '@/lib/security/http-url'
import { NextRequest } from 'next/server'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const websiteUrl = parseStoredHttpUrl(body.website_url)
  if (!websiteUrl.ok) {
    return Response.json({ error: 'website_url must be an http(s) URL or a hostname, of at most 2048 characters.', code: 'INVALID_WEBSITE_URL' }, { status: 400 })
  }
  const instagramUrl = parseStoredHttpUrl(body.instagram_url)
  if (!instagramUrl.ok) {
    return Response.json({ error: 'instagram_url must be an http(s) URL or a hostname, of at most 2048 characters.', code: 'INVALID_INSTAGRAM_URL' }, { status: 400 })
  }

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: `Active account ownership is ${activeAccount.reason}.` },
      { status: activeAccount.reason === 'unavailable' ? 500 : 409 },
    )
  }

  // Verify the competitor exists
  const { data: existing, error: fetchErr } = await db
    .from('competitor_sources')
    .select('id')
    .eq('id', id)
    .eq('ad_account_id', activeAccount.account.id)
    .maybeSingle()

  if (fetchErr) return apiErrorResponse('PATCH /api/competitors/[id]', 'COMPETITOR_READ_FAILED', fetchErr, 500)
  if (!existing) return Response.json({ error: 'Competitor not found' }, { status: 404 })

  // Build update payload — only include fields that were provided
  const allowed = [
    'name',
    'location',
    'website_url',
    'instagram_url',
    'hourly_rate_low',
    'hourly_rate_high',
    'size_sqft',
    'notes',
    'facebook_page_id',
  ] as const

  const updates: Record<string, unknown> = {}
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updates[field] = body[field] ?? null
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'website_url')) updates.website_url = websiteUrl.value
  if (Object.prototype.hasOwnProperty.call(updates, 'instagram_url')) updates.instagram_url = instagramUrl.value

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  updates.updated_at = new Date().toISOString()

  const { data: source, error } = await db
    .from('competitor_sources')
    .update(updates)
    .eq('id', id)
    .eq('ad_account_id', activeAccount.account.id)
    .select()
    .single()

  if (error) return apiErrorResponse('PATCH /api/competitors/[id]', 'COMPETITOR_WRITE_FAILED', error, 500)

  return Response.json({ source })
}
