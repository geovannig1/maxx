/**
 * Seed the VERTICAL-BENCHMARK rows as PENDING expert_insights (the owner approves each on /signals).
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/seed-vertical-benchmarks.ts
 *
 * Governance (owner decision 2026-07-09 + the recorded seed-benchmark-priors decision):
 * - Benchmarks become citable ONLY after approval on /signals (filterUsableInsights fail-closed) —
 *   src/lib/targets/vertical-benchmarks.ts matches approved rows by this exact title.
 * - CONTEXT ONLY: they never re-band a metric; account targets + the champion baseline always win.
 * - No booking-CPA benchmark: researched cost rows are cost-per-LEAD and the entries say so.
 * - Numbers/sources come from docs/research/local-service-booking-2026-07.md (section B5) — no invented sources.
 * Re-runnable: dedupes by title.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { getAdminClient } from '../src/lib/supabase/admin'
import { VERTICAL_BENCHMARKS } from '../src/lib/targets/vertical-benchmarks'

async function main() {
  const db = getAdminClient()
  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!accountId) throw new Error('META_AD_ACCOUNT_ID not set in .env.local')
  const cleanId = accountId.replace('act_', '')
  const { data: account } = await db
    .from('ad_accounts')
    .select('id')
    .or(`account_id.eq.${accountId},account_id.eq.act_${cleanId}`)
    .maybeSingle()
  if (!account) throw new Error('Run a sync first to create the ad_account record.')
  const adAccountDbId = account.id as string

  // Dedupe by title (the same title the runtime gate matches on).
  const { data: existing } = await db.from('expert_insights').select('title').eq('ad_account_id', adAccountDbId)
  const have = new Set((existing ?? []).map((r) => (r.title as string) ?? ''))
  const fresh = VERTICAL_BENCHMARKS.filter((b) => !have.has(b.insight_title))
  if (fresh.length === 0) {
    console.log(`All ${VERTICAL_BENCHMARKS.length} benchmark entries already present — nothing to seed.`)
    return
  }

  const now = new Date()
  const expires = new Date(now.getTime() + 365 * 86_400_000).toISOString() // annual benchmark reports: 365d TTL

  const rows = fresh.map((b) => {
    const fmt = (n: number) => (b.unit === '$' ? `$${n}` : `${n}%`)
    const range = b.range_low === b.range_high ? `~${fmt(b.range_low)} median` : `${fmt(b.range_low)}–${fmt(b.range_high)}`
    const leadCaveat = b.basis === 'cost_per_lead' ? ' SEMANTIC WARNING: this is cost per LEAD — never comparable to this account\'s cost per confirmed BOOKING.' : ''
    return {
      ad_account_id: adAccountDbId,
      source_id: null, // research-pass provenance carried in summary/raw_content, not an RSS source row
      published_at: now.toISOString(),
      title: b.insight_title,
      summary: `${b.metric.toUpperCase()} vertical benchmark ${range} — ${b.vertical}. CONTEXT ONLY (external_heuristic): never re-bands a metric; account targets and the champion baseline win.${leadCaveat} [source: ${b.source_name}${b.source_url ? ` — ${b.source_url}` : ''}]`,
      raw_content: JSON.stringify({ origin: 'vertical-benchmark', metric: b.metric, basis: b.basis, range_low: b.range_low, range_high: b.range_high, unit: b.unit, source_name: b.source_name, source_url: b.source_url ?? null }),
      applies_to_account: true,
      why_it_applies: 'Lets Maxx narrate benchmark-relative context (the sentence class Meta\'s chat uses) with a cited, owner-approved number instead of training-data guesses.',
      suggested_action: null,
      applicable_area: 'measurement' as const,
      confidence: 'medium' as const,
      expires_at: expires,
      // review_status deliberately UNSET → defaults 'pending' (the owner's Signals gate).
    }
  })

  const { data, error } = await db.from('expert_insights').insert(rows).select('id, title')
  if (error) throw new Error(`Insert failed: ${error.message}`)
  console.log(`Seeded ${data?.length ?? 0} PENDING benchmark entries (owner reviews on /signals):`)
  for (const r of data ?? []) console.log(`  - ${r.title}`)
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
