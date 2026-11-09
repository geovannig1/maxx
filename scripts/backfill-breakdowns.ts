/**
 * Backfill/heal insight_breakdowns — run with: npx tsx --tsconfig tsconfig.scripts.json scripts/backfill-breakdowns.ts [days]
 *
 * Re-fetches adset-level breakdowns (the same six dimensions the daily cron syncs) for the trailing
 * N days (default 30) and upserts them with the CURRENT parser. Purpose: heal the alias double-count
 * (segment bookings ran ~2x before the 2026-07-20 fix) — the daily cron only writes yesterday, so
 * historical rows stay inflated until re-written. Idempotent: upsert on the natural key.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// Must load env before importing any lib that reads it
import { fetchBreakdowns, upsertBreakdowns, type BreakdownType } from '../src/lib/platforms/meta/fetch-breakdowns'
import { getAdminClient } from '../src/lib/supabase/admin'

const accountId = process.env.META_AD_ACCOUNT_ID
if (!accountId || !process.env.META_ACCESS_TOKEN) {
  console.error('ERROR: META_AD_ACCOUNT_ID / META_ACCESS_TOKEN not set in .env.local')
  process.exit(1)
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Supabase credentials not set in .env.local')
  process.exit(1)
}

// Same dimension set as the daily cron (Step 3 in /api/cron/daily-sync).
const DIMENSIONS: BreakdownType[] = ['age', 'gender', 'publisher_platform', 'device_platform', 'region', 'platform_position']

function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function main() {
  const days = Math.min(90, Math.max(1, parseInt(process.argv[2] ?? '30', 10) || 30))

  const db = getAdminClient()
  const cleanId = accountId!.replace('act_', '')
  const { data: account } = await db
    .from('ad_accounts')
    .select('id')
    .or(`account_id.eq.${accountId},account_id.eq.act_${cleanId}`)
    .maybeSingle()
  if (!account) {
    console.error('ERROR: ad account not found in DB — run a sync first')
    process.exit(1)
  }
  const adAccountDbId = (account as { id: string }).id

  console.log(`Backfilling adset breakdowns for the last ${days} days (${DIMENSIONS.length} dimensions)…`)

  let totalUpserted = 0
  for (let n = days; n >= 1; n--) {
    const date = isoDaysAgo(n)
    try {
      const rows = await fetchBreakdowns({
        accountId: cleanId,
        level: 'adset',
        since: date,
        until: date,
        breakdowns: DIMENSIONS,
      })
      const upserted = await upsertBreakdowns(adAccountDbId, date, rows)
      totalUpserted += upserted
      console.log(`  ${date}: ${upserted} rows`)
    } catch (err) {
      console.error(`  ${date}: FAILED —`, err instanceof Error ? err.message : err)
    }
  }

  console.log(`Done — ${totalUpserted} rows upserted.`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
