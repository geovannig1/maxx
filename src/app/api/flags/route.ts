import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { projectFlagSurface } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

const dateOnly = /^\d{4}-\d{2}-\d{2}$/

function validDate(value: string): boolean {
  if (!dateOnly.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { searchParams } = new URL(req.url)
  const flagType = searchParams.get('flag_type')
  const windowDays = searchParams.get('window_days')
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100)

  if ((from === null) !== (to === null) || (from !== null && to !== null
      && (!validDate(from) || !validDate(to) || from > to))) {
    return Response.json({ error: 'from and to must be valid inclusive ET dates.' }, { status: 400 })
  }

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account found'
          : 'The active ad account could not be resolved',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status })
  }

  let query = db
    .from('flags')
    .select('*')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)
    .order('flag_date', { ascending: false })
    .limit(limit)

  if (flagType) query = query.eq('flag_type', flagType)
  if (windowDays) query = query.eq('window_days', parseInt(windowDays, 10))
  if (from && to) query = query.gte('flag_date', from).lte('flag_date', to)

  const { data, error } = await query
  if (error) return apiErrorResponse('GET /api/flags', 'FLAGS_READ_FAILED', error, 500)

  const flags = (data ?? []).map((row) => projectFlagSurface(row as Record<string, unknown>))
  return Response.json({
    range: from && to ? { from, to, basis: 'flag_date_et' } : null,
    total: flags.length,
    summary: {
      winners: flags.filter((f) => f.flag_type === 'winner').length,
      losers: flags.filter((f) => f.flag_type === 'loser').length,
      scale_candidates: flags.filter((f) => f.flag_type === 'scale_candidate').length,
      watchlist: flags.filter((f) => f.flag_type === 'watchlist').length,
      creative_refresh: flags.filter((f) => f.flag_type === 'creative_refresh').length,
      too_early: flags.filter((f) => f.flag_type === 'too_early').length,
    },
    flags,
  })
}
