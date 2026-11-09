import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getRanCopyPerformance } from '@/lib/creative/copy-performance'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { NextRequest } from 'next/server'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

async function resolveAdAccountId(db: ReturnType<typeof getAdminClient>): Promise<string | null> {
  const metaAccountId = process.env.META_AD_ACCOUNT_ID
  if (!metaAccountId) return null
  const accountRef = metaAccountId.replace('act_', '')
  const { data } = await db
    .from('ad_accounts')
    .select('id')
    .or(`account_id.eq.${metaAccountId},account_id.eq.act_${accountRef}`)
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const copy_type = sp.get('copy_type')
  const audience_type = sp.get('audience_type')
  const is_approved = sp.get('is_approved')

  const db = getAdminClient()
  const adAccountId = await resolveAdAccountId(db)

  let query = db
    .from('copy_variations')
    .select('id, ad_account_id, copy_type, audience_type, copy_text, angle, char_count, is_approved, is_used, performance_notes, created_at')
    .order('is_approved', { ascending: false })
    .order('is_used', { ascending: false })
    .order('created_at', { ascending: false })

  if (adAccountId) query = query.eq('ad_account_id', adAccountId)
  if (copy_type) query = query.eq('copy_type', copy_type)
  if (audience_type) query = query.eq('audience_type', audience_type)
  if (is_approved !== null) query = query.eq('is_approved', is_approved === 'true')

  const { data, error } = await query

  if (error) return apiErrorResponse('GET /api/hooks', 'COPY_LIBRARY_READ_FAILED', error, 500)

  // What actually RAN — the real performance behind the honest "Approved" label. Grouped by hook,
  // scored on Meta delivery (CTR/CPC facts; bookings = pixel ESTIMATE) + Claude-vision hook strength.
  const ranStart = nyDaysAgo(30)
  const ranEnd = nyDaysAgo(1)
  let ran_groups: Awaited<ReturnType<typeof getRanCopyPerformance>> = []
  if (adAccountId) {
    try {
      ran_groups = await getRanCopyPerformance(adAccountId, ranStart, ranEnd)
    } catch { /* non-fatal — the drafted library still answers */ }
  }

  return Response.json({
    copy: data ?? [],
    total: (data ?? []).length,
    ran_copy_performance: { window: { start: ranStart, end: ranEnd }, groups: ran_groups },
  })
}

export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  // Copy entries are typed by the owner; 60 an hour is one a minute, far above manual entry.
  const limited = await enforceApiRateLimit({
    bucket: 'hooks_create', actorKey: user.id, limit: 60, windowSeconds: 3600,
  })
  if (limited) return limited

  const body = await req.json() as {
    copy_text: string
    copy_type: string
    audience_type?: string
    angle?: string
    performance_notes?: string
  }

  if (!body.copy_text || !body.copy_type) {
    return Response.json({ error: 'copy_text and copy_type are required' }, { status: 400 })
  }

  const db = getAdminClient()
  const adAccountId = await resolveAdAccountId(db)

  if (!adAccountId) {
    return Response.json({ error: 'No ad account found. Set META_AD_ACCOUNT_ID in env.' }, { status: 400 })
  }

  const char_count = body.copy_text.length

  const { data, error } = await db
    .from('copy_variations')
    .insert({
      ad_account_id: adAccountId,
      copy_type: body.copy_type,
      audience_type: body.audience_type ?? 'unknown',
      copy_text: body.copy_text,
      char_count,
      angle: body.angle ?? null,
      performance_notes: body.performance_notes ?? null,
      is_approved: false,
      is_used: false,
    })
    .select()
    .single()

  if (error) return apiErrorResponse('POST /api/hooks', 'COPY_WRITE_FAILED', error, 500)

  return Response.json({ copy: data }, { status: 201 })
}
