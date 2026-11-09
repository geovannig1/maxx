import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { COMPETITOR_SEED, COMPETITOR_SEED_OBSERVATIONS } from '@/config/competitor-seed'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// The starter list lives in src/config/competitor-seed.ts and ships empty. See that file.

export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  // Seeding is a one-time, idempotent setup write; 5 an hour only absorbs double-clicks and retries.
  const limited = await enforceApiRateLimit({
    bucket: 'competitor_seed', actorKey: user.id, limit: 5, windowSeconds: 3600,
  })
  if (limited) return limited

  const db = getAdminClient()

  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: `Active account ownership is ${activeAccount.reason}.` },
      { status: activeAccount.reason === 'unavailable' ? 500 : 409 },
    )
  }

  const adAccountDbId = activeAccount.account.id

  // Check if already seeded
  const { count } = await db
    .from('competitor_sources')
    .select('*', { count: 'exact', head: true })
    .eq('ad_account_id', adAccountDbId)

  if ((count ?? 0) > 0) {
    return Response.json({ message: `Already seeded — ${count} competitors exist.`, seeded: false })
  }

  // Insert competitor sources
  if (COMPETITOR_SEED.length === 0) {
    return Response.json({
      message: 'No seed list configured. Add competitors in the form, or edit src/config/competitor-seed.ts.',
      seeded: false,
    })
  }

  const sourceRows = COMPETITOR_SEED.map((c) => ({ ...c, ad_account_id: adAccountDbId, is_active: true }))
  const { data: inserted, error: srcErr } = await db
    .from('competitor_sources')
    .insert(sourceRows)
    .select('id, name')

  if (srcErr) return apiErrorResponse('POST /api/competitors/seed', 'COMPETITOR_SEED_FAILED', srcErr, 500)

  // Seed initial observations on the first source (market-level)
  if (inserted && inserted.length > 0) {
    const firstId = inserted[0].id as string
    await db.from('competitor_observations').insert(
      COMPETITOR_SEED_OBSERVATIONS.map((o) => ({
        ...o,
        competitor_id: firstId,
        ad_account_id: adAccountDbId,
        observed_at: new Date().toISOString().slice(0, 10),
      }))
    )
  }

  return Response.json({
    message: `Seeded ${inserted?.length ?? 0} Springfield competitors.`,
    seeded: true,
    competitors: inserted?.map((c) => c.name),
  })
}
