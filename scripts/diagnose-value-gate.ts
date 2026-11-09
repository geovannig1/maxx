/**
 * Meta outcome-plane diagnostic — npx tsx --tsconfig tsconfig.scripts.json scripts/diagnose-value-gate.ts [--refresh]
 *
 * Fetches exactly what the sync fetches (same window, same levels, same fields), caches the raw
 * response, and runs the REAL reconcileMetaOutcomeHierarchy and normalizeOutcome over it, so every
 * number printed here is the number the pipeline computes.
 *
 * It attributes each blocker to the specific rows that raise it, and prints the per-level value
 * arithmetic behind every mismatch — so the mechanism is read off the whole population rather than
 * inferred from one date.
 *
 * Kept, not scratch: the four consecutive misdiagnoses that preceded this fix were all made without
 * ever reading the whole payload the gate evaluates. This is the tool that reads it.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { fetchInsights } from '../src/lib/platforms/meta/fetch-insights'
import { reconcileMetaOutcomeHierarchy, normalizeOutcome } from '../src/lib/sync/upsert-insights'
import { nyDaysAgo, yesterday } from '../src/lib/utils/date-utils'
import { INSIGHT_RESTATEMENT_LOOKBACK_DAYS } from '../src/lib/sync/orchestrator'
import type { MetaInsightRow } from '../src/types/meta-api'

const CACHE = path.resolve(process.cwd(), '.diagnose-value-gate-cache.json')
const LEVELS = ['campaign', 'adset', 'ad'] as const
type Level = (typeof LEVELS)[number]

async function load(): Promise<{ since: string; until: string; rows: Record<Level, MetaInsightRow[]> }> {
  if (fs.existsSync(CACHE) && !process.argv.includes('--refresh')) {
    console.log('[diag] using cached payload (pass --refresh to re-fetch)')
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'))
  }
  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!accountId) throw new Error('META_AD_ACCOUNT_ID not set')
  const since = nyDaysAgo(INSIGHT_RESTATEMENT_LOOKBACK_DAYS)
  const until = yesterday()
  console.log(`[diag] fetching ${since} → ${until}`)
  const rows = {} as Record<Level, MetaInsightRow[]>
  for (const level of LEVELS) {
    rows[level] = await fetchInsights({ accountId, level, since, until })
    console.log(`[diag]   ${level}: ${rows[level].length} rows`)
  }
  const payload = { since, until, rows }
  fs.writeFileSync(CACHE, JSON.stringify(payload))
  return payload
}

const idOf = (r: MetaInsightRow) => r.ad_id ?? r.adset_id ?? r.campaign_id ?? '?'
const av = (r: MetaInsightRow) =>
  Array.isArray(r.action_values)
    ? r.action_values.map((a) => `${a.action_type}=${a.value}`).join(' ')
    : 'NO action_values ARRAY'

async function main() {
  const { since, until, rows } = await load()
  const plane = reconcileMetaOutcomeHierarchy({ ...rows, since, until })

  console.log('\n===== GATE OUTPUT (real function, real payload) =====')
  console.log(`complete: ${plane.complete}   policy v${plane.policyVersion}`)
  console.log(`  INTEGRITY blockers (these freeze decisions): ${plane.blockerCodes.length}`)
  for (const c of plane.blockerCodes) console.log(`    ${c}`)
  console.log(`  COVERAGE gaps (recorded, never freeze): ${plane.coverageBlockerCodes.length}`)
  for (const c of plane.coverageBlockerCodes) console.log(`    ${c}`)

  // ---- Attribute every value_unavailable to the exact rows that raise it -------------------------
  console.log('\n===== value_unavailable: THE ROWS THAT RAISE IT =====')
  for (const level of LEVELS) {
    for (const row of rows[level]) {
      const o = normalizeOutcome(row)
      if (!(o.bookings > 0 && !o.valuePresent)) continue
      console.log(
        `  [${level.padEnd(8)}] ${row.date_start} ${idOf(row)}  bookings=${o.bookings}  ${av(row)}`,
      )
    }
  }

  // ---- Show the full per-level value arithmetic for EVERY date ----------------------------------
  console.log('\n===== PER-DATE VALUE ARITHMETIC (campaign vs adset vs ad) =====')
  const dates = new Set<string>()
  for (const level of LEVELS) for (const r of rows[level]) dates.add(r.date_start)
  for (const date of [...dates].sort()) {
    const tot: Record<Level, { value: number; bookings: number }> = {
      campaign: { value: 0, bookings: 0 },
      adset: { value: 0, bookings: 0 },
      ad: { value: 0, bookings: 0 },
    }
    const detail: string[] = []
    for (const level of LEVELS) {
      for (const row of rows[level].filter((r) => r.date_start === date)) {
        const o = normalizeOutcome(row)
        tot[level].value += o.value
        tot[level].bookings += o.bookings
        if (o.value !== 0 || o.bookings !== 0) {
          detail.push(
            `      [${level.padEnd(8)}] ${idOf(row)} bookings=${o.bookings} value=${o.value}  ${av(row)}`,
          )
        }
      }
    }
    const mismatch =
      Math.abs(tot.adset.value - tot.campaign.value) > 0.01 ||
      Math.abs(tot.ad.value - tot.campaign.value) > 0.01
    if (tot.campaign.value === 0 && tot.adset.value === 0 && tot.ad.value === 0 &&
        tot.campaign.bookings === 0) continue
    console.log(
      `\n  ${date}  campaign(v=${tot.campaign.value},b=${tot.campaign.bookings})` +
        ` adset(v=${tot.adset.value},b=${tot.adset.bookings})` +
        ` ad(v=${tot.ad.value},b=${tot.ad.bookings})` +
        (mismatch ? '   <<< VALUE MISMATCH' : ''),
    )
    for (const d of detail) console.log(d)
  }

  // ---- Does the fb_pixel_custom aggregate ever disagree with the purchase family? ---------------
  console.log('\n===== AGGREGATE vs PURCHASE FAMILY, PER ROW =====')
  console.log('  (if these differ, the aggregate is NOT a stand-in for booking value)')
  for (const level of LEVELS) {
    for (const row of rows[level]) {
      if (!Array.isArray(row.action_values)) continue
      let agg: number | null = null
      let pur = 0
      let sawPurchase = false
      for (const a of row.action_values) {
        const t = a.action_type ?? ''
        const v = parseFloat(a.value ?? '0') || 0
        if (t === 'offsite_conversion.fb_pixel_custom') agg = (agg ?? 0) + v
        else if (t.includes('purchase')) { sawPurchase = true; if (v > pur) pur = v }
      }
      if (agg === null || !sawPurchase) continue
      if (Math.abs(agg - pur) > 0.01) {
        console.log(
          `  [${level.padEnd(8)}] ${row.date_start} ${idOf(row)}  aggregate=${agg}  purchaseMax=${pur}  DIFF=${(agg - pur).toFixed(2)}`,
        )
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
