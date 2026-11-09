/**
 * Backfill the Acuity ledger (the account's Acuity `outcomes`) from full account history.
 * Run: npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/backfill-acuity.ts
 *
 * The Acuity API filters /appointments by APPOINTMENT date (no offset/page param), so we page by
 * monthly appointment-date windows across the full range and dedup by id. `showall=true` includes
 * canceled rows. Idempotent: safe to re-run (upsert on account, Acuity source and Acuity id). Prints a reconciliation summary so the
 * backfill can be checked against Ads Manager / GA4 before anything reads the ledger.
 */
import { getAppointments, isAcuityConfigured, type AcuityAppointmentRaw } from '../src/lib/outcomes/adapters/acuity/client'
import { toLedgerRow, upsertAppointments } from '../src/lib/outcomes/adapters/acuity/ledger'
import { getAdminClient } from '../src/lib/supabase/admin'
import { etDateOf } from '../src/lib/utils/date-utils'

// Appointment dates span from account history to ~18 months out. Windows are monthly (a studio books
// far fewer than the API cap per month, so no window truncates).
// Earliest appointment date to backfill: ACUITY_BACKFILL_START (YYYY-MM-DD), default two years ago.
const WINDOW_START = /^\d{4}-\d{2}-\d{2}$/.test(process.env.ACUITY_BACKFILL_START ?? '')
  ? process.env.ACUITY_BACKFILL_START!
  : new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10)
const WINDOW_END_DAYS_AHEAD = 550

function addMonths(ymd: string, n: number): string {
  const [y, m] = ymd.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 10)
}
function todayPlus(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function main() {
  if (!isAcuityConfigured()) {
    console.error('ERROR: ACUITY_USER_ID / ACUITY_API_KEY not set (use --env-file=.env.local)')
    process.exit(1)
  }
  const db = getAdminClient()
  const { data: acct } = await db.from('ad_accounts').select('id').eq('is_active', true).limit(1).maybeSingle()
  const adAccountId = (acct?.id as string | undefined) ?? null
  if (!adAccountId) {
    // outcomes.ad_account_id is NOT NULL: an unowned backfill cannot be written.
    console.error('ERROR: no active ad account — outcomes require an ad account; nothing written.')
    process.exit(1)
  }
  console.log(`ad_account_id: ${adAccountId}`)

  const end = todayPlus(WINDOW_END_DAYS_AHEAD)
  const byId = new Map<number, AcuityAppointmentRaw>()
  let windows = 0
  for (let start = WINDOW_START; start < end; start = addMonths(start, 1)) {
    const stop = addMonths(start, 1)
    const rows = await getAppointments({ minDate: start, maxDate: stop, showall: true, max: 1000, direction: 'ASC' })
    windows++
    if (rows.length >= 1000) console.warn(`  ⚠ window ${start}..${stop} returned ${rows.length} (possible truncation — narrow the window)`)
    for (const r of rows) {
      const id = Number(r.id)
      if (Number.isFinite(id)) byId.set(id, r)
    }
    if (rows.length) console.log(`  ${start}..${stop}: ${rows.length} appts (running unique: ${byId.size})`)
  }

  const raws = [...byId.values()]
  const rows = raws.map((r) => toLedgerRow(r, adAccountId, 'backfill'))
  const written = await upsertAppointments(rows)
  console.log(`\nScanned ${windows} windows → ${raws.length} unique appointments → upserted ${written}.`)

  // ── Reconciliation summary ──
  const active = rows.filter((r) => !r.canceled)
  const canceled = rows.filter((r) => r.canceled)
  const revenue = active.reduce((s, r) => s + (r.price ?? 0), 0)
  const zeroPrice = active.filter((r) => (r.price ?? 0) === 0).length
  console.log(`\nActive (non-canceled): ${active.length} | canceled: ${canceled.length}`)
  console.log(`Revenue (sum price, active): $${revenue.toFixed(2)} | $0-price active bookings (comps/blocks): ${zeroPrice}`)

  // Bookings by ET booking date (created), last 12 ET days — reconcile vs Ads Manager Results / GA4.
  const recentCut = etDateOf(todayPlus(-12))
  const byDay = new Map<string, { n: number; rev: number }>()
  for (const r of active) {
    if (!r.booking_date_et || r.booking_date_et < recentCut) continue
    const a = byDay.get(r.booking_date_et) ?? { n: 0, rev: 0 }
    a.n++; a.rev += r.price ?? 0
    byDay.set(r.booking_date_et, a)
  }
  console.log('\nActive bookings by ET booking date (last ~12 days):')
  for (const day of [...byDay.keys()].sort()) {
    const a = byDay.get(day)!
    console.log(`  ${day}: ${a.n} booking(s), $${a.rev.toFixed(2)}`)
  }

  // Any $0 active appointment is a real appointment the ledger cannot classify (package, gift
  // certificate, staff block, comp or test). Report them so an operator can cancel stray test bookings.
  const zeroValue = rows.filter((r) => (r.price ?? 0) === 0 && !r.canceled)
  console.log(`\n$0 active appointments: ${zeroValue.length}`)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
