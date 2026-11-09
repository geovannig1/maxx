import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { COMPETITOR_DIAGNOSTIC_NOTE, projectCompetitorObservationRecord } from '@/lib/competitors/diagnostic-projection'
import { parseStoredHttpUrl } from '@/lib/security/http-url'
import { NextRequest } from 'next/server'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return Response.json({ error: 'name is required' }, { status: 400 })
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

  const row = {
    ad_account_id: activeAccount.account.id,
    name: (body.name as string).trim(),
    location: body.location ?? null,
    website_url: websiteUrl.value,
    instagram_url: instagramUrl.value,
    hourly_rate_low: body.hourly_rate_low ?? null,
    hourly_rate_high: body.hourly_rate_high ?? null,
    size_sqft: body.size_sqft ?? null,
    notes: body.notes ?? null,
    facebook_page_id: body.facebook_page_id ?? null,
    is_active: true,
  }

  const { data: source, error } = await db
    .from('competitor_sources')
    .insert(row)
    .select()
    .single()

  if (error) return apiErrorResponse('POST /api/competitors', 'COMPETITOR_WRITE_FAILED', error, 500)

  return Response.json({ source })
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: `Active account ownership is ${activeAccount.reason}.`, status: 'unavailable', sources: [], observations: [] },
      { status: activeAccount.reason === 'unavailable' ? 500 : 409 },
    )
  }

  const { data: sources, error: srcErr } = await db
    .from('competitor_sources')
    .select('*')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)
    .order('hourly_rate_low', { ascending: true })

  if (srcErr) return apiErrorResponse('GET /api/competitors', 'COMPETITOR_READ_FAILED', srcErr, 500)

  const sourceIds = (sources ?? []).map((s) => s.id as string)

  const { data: observations, error: observationError } = await db
    .from('competitor_observations')
    .select('*')
    .eq('ad_account_id', activeAccount.account.id)
    .in('competitor_id', sourceIds.length > 0 ? sourceIds : ['00000000-0000-0000-0000-000000000000'])
    .order('observed_at', { ascending: false })
    .limit(50)

  if (observationError) return apiErrorResponse('GET /api/competitors', 'COMPETITOR_OBSERVATION_READ_FAILED', observationError, 500)

  return Response.json({
    status: 'available', action_authority_tier: 'diagnostic_only', prescriptions: [],
    sources: sources ?? [],
    observations: ((observations ?? []) as Array<Record<string, unknown>>).map(projectCompetitorObservationRecord),
    note: COMPETITOR_DIAGNOSTIC_NOTE,
  })
}
