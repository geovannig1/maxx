/**
 * Manual full sync script — run with: npx tsx --tsconfig tsconfig.scripts.json scripts/manual-sync.ts
 *
 * Syncs the last 30 days of Meta data into Supabase.
 * Runs alert detection and flag engine after each sync window.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// Must load env before importing any lib that reads it
import { runDailySync } from '../src/lib/sync/orchestrator'

const accountId = process.env.META_AD_ACCOUNT_ID
if (!accountId) {
  console.error('ERROR: META_AD_ACCOUNT_ID not set in .env.local')
  process.exit(1)
}

if (!process.env.META_ACCESS_TOKEN) {
  console.error('ERROR: META_ACCESS_TOKEN not set in .env.local')
  process.exit(1)
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Supabase credentials not set in .env.local')
  process.exit(1)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function runFullSync() {
  console.log('\n══════════════════════════════════════════════')
  console.log('  Maxx — Full Sync')
  console.log('  Account:', accountId)
  console.log('  Time:', new Date().toISOString())
  console.log('══════════════════════════════════════════════\n')

  const windows = [
    { label: 'Last 30 days', since: daysAgo(30), until: daysAgo(1) },
  ]

  let totalSuccess = 0
  let totalFailed = 0

  for (const window of windows) {
    console.log(`\n► Syncing: ${window.label} (${window.since} → ${window.until})`)
    const start = Date.now()

    try {
      const result = await runDailySync({
        adAccountId: accountId!,
        triggeredBy: 'manual-script',
        dateRangeStart: window.since,
        dateRangeEnd: window.until,
      })

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)

      if (result.success) {
        console.log(`  ✓ Success in ${elapsed}s — log ID: ${result.logId}`)
        totalSuccess++
      } else {
        console.log(`  ✗ Failed in ${elapsed}s — log ID: ${result.logId}`)
        totalFailed++
      }
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ✗ Error after ${elapsed}s:`, msg)
      totalFailed++
    }
  }

  console.log('\n══════════════════════════════════════════════')
  console.log(`  Done — ${totalSuccess} succeeded, ${totalFailed} failed`)
  console.log('══════════════════════════════════════════════\n')

  if (totalFailed > 0) process.exit(1)
}

runFullSync().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
