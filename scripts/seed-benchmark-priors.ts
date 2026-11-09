/**
 * Seed CROSS-NICHE benchmark priors (memory_entries category='benchmark_prior') — weak, discounted
 * context the learning model may fall back on when the account has no history for a dimension.
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/seed-benchmark-priors.ts
 *
 * RULES (from the approved brain plan):
 * - ONLY researched local-service benchmarks with named sources (docs/research/local-service-booking-2026-07.md, section B5).
 * - The CHAMPION is EXPLICITLY EXCLUDED — it is account history (the strongest prior), lives in
 *   src/lib/economics/champion.ts, and must never be discounted as a cross-niche prior.
 * - The OWNER SIGNS OFF on the numbers before this script is run (list stays empty until then).
 */
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { getAdminClient } from '../src/lib/supabase/admin'

interface BenchmarkSeed {
  key: string // memory_entries key, e.g. 'local_service_meta_cpa'
  niche: string
  cpa: number
  winRate: number // 0..1 — a neutral-ish prior for rec win-rates in this niche
  strength: number // pseudo-count; keep ≤2 (weak by contract)
  source: string // named source + year (required)
}

// ── OWNER-SIGNED numbers only. The researched table lives in docs/research/local-service-booking-2026-07.md (B5)
//    (WordStream/LocaliQ 2025 local-service benchmarks). DELIBERATELY EMPTY pending an owner decision,
//    because of a SEMANTIC MISMATCH: every researched external number is cost-per-LEAD, while this
//    account's economics and the prior model run on cost-per-confirmed-BOOKING — seeding an $18–31 CPL
//    as a "cpa" prior would silently flatter CPA shrinkage. Owner options: (a) skip external CPA priors
//    (champion + margin model suffice — recommended), or (b) seed with an explicit, labeled
//    lead→booking conversion assumption. ──
const BENCHMARKS: BenchmarkSeed[] = []

async function main() {
  if (BENCHMARKS.length === 0) {
    console.log('No benchmark priors to seed (BENCHMARKS is empty — owner signs the researched numbers first).')
    return
  }
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

  for (const b of BENCHMARKS) {
    if (!b.source || b.source.length < 8) throw new Error(`Benchmark ${b.key} is missing a named source — refused.`)
    if (b.strength > 2) throw new Error(`Benchmark ${b.key} strength ${b.strength} > 2 — priors are weak by contract.`)
    const { error } = await db.from('memory_entries').upsert(
      {
        ad_account_id: adAccountDbId,
        category: 'benchmark_prior',
        key: b.key,
        value: JSON.stringify({ niche: b.niche, cpa: b.cpa, winRate: b.winRate, strength: b.strength, source: b.source }),
        source: b.source,
        confidence: 'low',
        is_active: true,
      },
      { onConflict: 'ad_account_id,category,key' },
    )
    if (error) throw new Error(`Upsert ${b.key} failed: ${error.message}`)
    console.log(`Seeded benchmark prior: ${b.key} (${b.niche}, CPA $${b.cpa}, strength ${b.strength})`)
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
