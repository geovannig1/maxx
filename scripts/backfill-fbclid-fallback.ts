/**
 * Backfill fbclid fallback attribution for existing Acuity appointments.
 *
 * Prerequisites:
 *   - The baseline schema (with the fbclid-fallback RPC and its cursor pagination) is applied.
 *   - The appointment has utm_source = meta/paid_social and a non-empty fbclid.
 *   - The appointment is client-booked (not staff-created) with a known origin.
 *   - An identity-complete paid touch with the same fbclid exists at or before booking creation.
 *
 * Important: this is a forward-looking mechanism, not a historical recovery tool.
 * If a booking's fbclid was never observed as a paid touch, there is nothing to
 * link. Run the overlap diagnostic first to set expectations.
 *
 * This script is idempotent: appointments already linked are skipped.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/backfill-fbclid-fallback.ts
 */

import { getAdminClient } from '../src/lib/supabase/admin'

const POLICY_VERSION = 1
const BATCH_SIZE = 50

interface Candidate {
  outcome_id: string
  fbclid: string
  occurred_at: string
}

async function resolveActiveAdAccountId(db: ReturnType<typeof getAdminClient>): Promise<string> {
  const { data, error } = await db
    .from('ad_accounts')
    .select('id')
    .eq('is_active', true)
    .limit(2)
  if (error) throw new Error(`ad_accounts read failed: ${error.message}`)
  const rows = data ?? []
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one active ad account, found ${rows.length}`)
  }
  return rows[0].id as string
}

async function fetchCandidates(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  cursorOccurredAt: string | null,
  cursorOutcomeId: string | null,
): Promise<Candidate[]> {
  const { data, error } = await db.rpc('get_fbclid_fallback_candidates', {
    p_ad_account_id: adAccountId,
    p_limit: BATCH_SIZE,
    p_cursor_occurred_at: cursorOccurredAt,
    p_cursor_outcome_id: cursorOutcomeId,
  })
  if (error) throw new Error(`candidate fetch failed: ${error.message}`)
  return (data ?? []) as Candidate[]
}

async function linkCandidate(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  candidate: Candidate,
): Promise<{ success: boolean; skipped: boolean; error?: string }> {
  const { error } = await db.rpc('link_outcome_paid_touch_fbclid_fallback', {
    p_ad_account_id: adAccountId,
    p_outcome_id: candidate.outcome_id,
    p_fbclid: candidate.fbclid,
    p_policy_version: POLICY_VERSION,
  })
  if (error) {
    const message = error.message ?? String(error)
    const alreadyLinked = message.includes('appointment not found') === false &&
      (message.includes('duplicate key') || message.includes('already exists'))
    if (alreadyLinked) return { success: false, skipped: true }
    return { success: false, skipped: false, error: message }
  }
  return { success: true, skipped: false }
}

async function runOverlapDiagnostic(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
): Promise<{
  outcome_fbclids: number
  touch_fbclids: number
  exact_matches: number
  earliest_touch: string | null
  latest_touch: string | null
}> {
  const { data, error } = await db.rpc('get_fbclid_fallback_overlap', {
    p_ad_account_id: adAccountId,
  })
  if (error) {
    console.warn(`Overlap diagnostic unavailable: ${error.message}`)
    return {
      outcome_fbclids: 0,
      touch_fbclids: 0,
      exact_matches: 0,
      earliest_touch: null,
      latest_touch: null,
    }
  }
  const row = (data ?? [{}])[0] as {
    outcome_fbclids?: number
    touch_fbclids?: number
    exact_matches?: number
    earliest_touch?: string
    latest_touch?: string
  }
  return {
    outcome_fbclids: row.outcome_fbclids ?? 0,
    touch_fbclids: row.touch_fbclids ?? 0,
    exact_matches: row.exact_matches ?? 0,
    earliest_touch: row.earliest_touch ?? null,
    latest_touch: row.latest_touch ?? null,
  }
}

async function main() {
  const db = getAdminClient()
  const adAccountId = await resolveActiveAdAccountId(db)

  const overlap = await runOverlapDiagnostic(db, adAccountId)
  console.log(JSON.stringify({ overlap }, null, 2))

  if (overlap.exact_matches === 0) {
    console.log(JSON.stringify({
      ad_account_id: adAccountId,
      total_candidates: 0,
      linked: 0,
      skipped: 0,
      errors: 0,
      error_samples: [],
      note: 'No overlapping fbclids between appointments and paid touches. Backfill would link nothing; skipping.',
    }, null, 2))
    return
  }

  let cursorOccurredAt: string | null = null
  let cursorOutcomeId: string | null = null
  let totalCandidates = 0
  let linked = 0
  let skipped = 0
  let errors = 0
  const errorSamples: string[] = []

  for (;;) {
    const candidates = await fetchCandidates(db, adAccountId, cursorOccurredAt, cursorOutcomeId)
    if (candidates.length === 0) break
    totalCandidates += candidates.length

    for (const candidate of candidates) {
      const result = await linkCandidate(db, adAccountId, candidate)
      if (result.success) linked++
      else if (result.skipped) skipped++
      else {
        errors++
        if (errorSamples.length < 5 && result.error) errorSamples.push(result.error)
      }
    }

    const last = candidates[candidates.length - 1]
    cursorOccurredAt = last.occurred_at
    cursorOutcomeId = last.outcome_id
  }

  console.log(JSON.stringify({
    ad_account_id: adAccountId,
    total_candidates: totalCandidates,
    linked,
    skipped,
    errors,
    error_samples: errorSamples,
  }, null, 2))

  if (errors > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Backfill failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
