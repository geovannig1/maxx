import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// POST /api/signals/manual — the owner pastes an insight directly (brain-audit hole 6: ingestion was
// Monday-RSS-only; 14/30 sources have no feed — YouTube/newsletters/podcasts had no path in).
// Owner authorship IS the review: rows enter review_status='approved' with provenance recorded
// (reviewed_note='manual owner entry'), unlike fetcher rows which always start pending.

const manualInsightSchema = z.object({
  title: z.string().min(8).max(300),
  summary: z.string().min(20).max(2000),
  source_name: z.string().min(3).max(200), // named source — no invented sources
  source_url: z.string().url().max(500).optional(),
  applicable_area: z.enum(['creative', 'budget', 'bidding', 'measurement', 'structure', 'audience', 'landing']).nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  /** TTL in days (default 365 for owner-curated; the Monday fetcher uses 90). */
  ttl_days: z.number().int().min(7).max(730).default(365),
})

export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  let body: z.infer<typeof manualInsightSchema>
  try {
    body = manualInsightSchema.parse(await req.json())
  } catch (e) {
    return Response.json({ error: 'Invalid request body', details: e instanceof z.ZodError ? e.issues : undefined }, { status: 400 })
  }

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: 'The expert insight cannot be stored because one active account could not be resolved.',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status })
  }

  const now = new Date()
  const { data, error } = await db
    .from('expert_insights')
    .insert({
      ad_account_id: activeAccount.account.id,
      source_id: null,
      published_at: now.toISOString(),
      title: body.title,
      summary: `${body.summary} [source: ${body.source_name}${body.source_url ? ` — ${body.source_url}` : ''}]`,
      raw_content: JSON.stringify({ origin: 'manual_owner_entry', source_name: body.source_name, source_url: body.source_url ?? null }),
      applies_to_account: true,
      why_it_applies: 'Owner-curated evidence for review; it does not itself authorise an action.',
      suggested_action: null,
      applicable_area: body.applicable_area,
      confidence: body.confidence,
      expires_at: new Date(now.getTime() + body.ttl_days * 86_400_000).toISOString(),
      review_status: 'approved', // owner authorship IS the review (provenance below)
      reviewed_at: now.toISOString(),
      reviewed_note: 'manual owner entry',
    })
    .select('id, title, review_status, expires_at')
    .single()

  if (error) return apiErrorResponse('POST /api/signals/manual', 'SIGNAL_WRITE_FAILED', error, 500)
  return Response.json({ data, note: 'Approved immediately (owner authorship is the review); citable via get_expert_knowledge and the rec engine.' })
}
