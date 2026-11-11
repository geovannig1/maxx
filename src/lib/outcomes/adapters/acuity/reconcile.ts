import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversionSweepResult, SourceReconcileResult } from '@/lib/outcomes/reconciliation'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyToday, nyDaysAgo } from '@/lib/utils/date-utils'
import {
  fetchAllAppointmentsByDateWindows,
  getAppointment,
  getAppointments,
  isAcuityConfigured,
} from './client'
import { ingestAppointments, resolveAdAccountId } from './ledger'
import {
  linkAcuityPaidTouchWithFallback,
  paidTouchLinkConfig,
  type LinkedPaidTouchForCapi,
} from './paid-touch-link'
import { resolveSendMode, sendAcuityCapiEvent } from '@/lib/capi/acuity-capi'
import { ACUITY_SOURCE_KIND, findAcuitySourceId } from './outcome-source'

// Nightly safety net for the Acuity webhook. Webhooks can drop deliveries and auto-disable after 5
// days of failures — if that happens we'd silently stop capturing NEW bookings. The list endpoint
// filters by appointment date, while reports filter by booking-created date, so the default run
// exhausts the account's full possible appointment-date domain and upserts every returned record.
// Targeted date windows remain available for backfills but never certify booking-date completeness.
// Idempotent (upsert on id).
//
// Liveness signal: rows first inserted DURING this run whose booking is recent = bookings the webhook
// should already have delivered. A non-zero count is evidence the webhook is not firing.

const FUTURE_WINDOW_DAYS = 550
// Look 90d BACK too: canceling/editing a past-dated appointment fires only a webhook — with the
// webhook down, a future-only sweep would never see it and the ledger would keep a canceled booking
// active forever. 90d covers any realistic post-hoc edit at trivial cost (a few hundred rows).
const PAST_WINDOW_DAYS = 90
// Any account began long after 1900. Acuity accepts the full Gregorian upper bound, so this domain
// includes every possible appointment date. The API honors max=10,000 per read; if an account grows
// to that cap, the exhaustive reader subdivides the date domain and fails closed if even one
// appointment day reaches the cap.
const EXHAUSTIVE_APPOINTMENT_DATE_START = '1900-01-01'
const EXHAUSTIVE_APPOINTMENT_DATE_END = '9999-12-31'
const FETCH_MAX = 10_000
const MAX_FETCH_WINDOWS = 128
const MISS_LOOKBACK_HOURS = 26 // a full daily cycle + slack
// CAPI re-send cutoff: Meta's event_id dedup window is 48h. Sending an unsent booking LATER than that
// risks double-counting against an un-deduped browser copy — those are marked, never sent.
const CAPI_RESEND_CUTOFF_MS = 46 * 3600_000
// Only Acuity outcomes: other sources have their own conversions sweep (src/lib/conversions). The
// inner join on the outcome's source (named by its foreign key, since outcomes also references
// outcome_sources through the account-scoped composite key) drops every non-Acuity row.
const ACUITY_SOURCE_JOIN = 'outcome_sources!outcomes_source_id_fkey!inner(kind)'
// Terminal capi_send_error labels the sweep must never retry.
/** Exported so monitoring reads the SAME terminal set the sweep skips — a second copy would drift. */
export const CAPI_TERMINAL = new Set(['staff_created', 'expired', 'origin_unknown', 'no_id', 'missed-48h-window'])
/** Stale close-out: rows per page and pages per run (bounded; the next run resumes). */
const STALE_PAGE = 500
const STALE_MAX_PAGES = 20

function todayPlus(days: number): string {
  const d = new Date(nyToday() + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export type AcuityCapiSweepResult = ConversionSweepResult
export type AcuityReconcileResult = SourceReconcileResult

/** At-least-once CAPI delivery: retry unsent website bookings while the 48h dedup window still protects
 *  against double-counting a browser copy; label anything older as missed. LIVE mode only (R2 — test
 *  submissions are quarantined and must not consume delivery attempts or state). Every candidate is
 *  re-fetched BY ID so the origin gate sees the real scheduledBy (the list endpoint omits it). */
export async function sweepUnsentCapi(supabase: SupabaseClient = getAdminClient(), nowMs: number = Date.now()): Promise<AcuityCapiSweepResult> {
  const mode = resolveSendMode()
  if (mode !== 'live') return { mode, ran: false }

  const cutoffIso = new Date(nowMs - CAPI_RESEND_CUTOFF_MS).toISOString()
  const { data: candidates, error: candErr } = await supabase
    .from('outcomes')
    .select(`id, external_id, ad_account_id, fbp, conversion_send_error, ${ACUITY_SOURCE_JOIN}`)
    .eq('outcome_sources.kind', ACUITY_SOURCE_KIND)
    .is('conversion_sent_at', null)
    .neq('status', 'cancelled')
    .gte('occurred_at', cutoffIso)
    .limit(200)
  if (candErr) throw new Error(`capi sweep candidate query: ${candErr.message}`)

  let sent = 0, skipped = 0, errors = 0
  const linkConfig = paidTouchLinkConfig()
  for (const row of (candidates ?? []) as Array<{
    id: string
    external_id: string
    ad_account_id: string | null
    fbp: string | null
    conversion_send_error: string | null
  }>) {
    if (row.conversion_send_error && CAPI_TERMINAL.has(row.conversion_send_error)) continue
    try {
      const appt = await getAppointment(Number(row.external_id))
      if (!appt) { skipped++; continue }
      if (appt.canceled === true) { skipped++; continue } // canceled since — a conversion we no longer assert
      let linkedPaidTouch: LinkedPaidTouchForCapi | null = null
      if (linkConfig && row.ad_account_id) {
        try {
          const linked = await linkAcuityPaidTouchWithFallback(
            supabase, row.ad_account_id, appt, linkConfig,
          )
          if (linked.status === 'linked') linkedPaidTouch = linked.paidTouch
          else if (linked.status !== 'absent') {
            console.warn(`[Acuity CAPI sweep] paid-touch link rejected for id=${row.external_id}: ${linked.reason}`)
          }
        } catch {
          console.warn(`[Acuity CAPI sweep] paid-touch link failed for id=${row.external_id}`)
        }
      }
      const outcome = await sendAcuityCapiEvent(appt, row.fbp, supabase, linkedPaidTouch)
      // conversion_sent_at is stamped INSIDE record_conversion_delivery in the same
      // transaction as the lineage row — this sweep never stamps it itself.
      if (outcome.status === 'sent' && outcome.mode === 'live') {
        sent++
      } else if (outcome.status === 'accepted_unrecorded') {
        // Meta accepted but the audit row failed to persist. Counted as an error and left UNSENT so a
        // later sweep retries the same deterministic event_id (dedup-safe; cannot double-count).
        errors++
        console.error(`[Acuity CAPI sweep] CRITICAL: ${outcome.eventId} accepted by Meta but unrecorded — will retry`)
      } else if (outcome.status === 'skipped' && outcome.skip) {
        skipped++
        const { error: upErr } = await supabase.from('outcomes').update({ conversion_send_error: outcome.skip }).eq('id', row.id)
        if (upErr) console.error(`[Acuity CAPI sweep] skip-label write failed for id=${row.external_id}: ${upErr.message}`)
      } else if (outcome.status === 'error') {
        errors++
        if (outcome.error) {
          const { error: upErr } = await supabase.from('outcomes').update({ conversion_send_error: outcome.error.slice(0, 300) }).eq('id', row.id)
          if (upErr) console.error(`[Acuity CAPI sweep] error-label write failed for id=${row.external_id}: ${upErr.message}`)
        }
      }
    } catch (err) {
      errors++
      console.warn(`[Acuity CAPI sweep] id=${row.external_id}:`, err instanceof Error ? err.message : err)
    }
  }

  // Label everything unsent past the cutoff (incl. the pre-activation backfill on the first live run) —
  // sending those would risk double-counting against un-deduped browser copies; they are closed out.
  // The select excludes EVERY terminal label, not only 'missed-48h-window': rows labelled staff_created,
  // expired, origin_unknown or no_id would otherwise keep matching, fill a page that marks nothing and
  // stop the loop with retryable rows still behind them. Marked rows drop out of the next page, so the
  // loop pages without an offset. At most STALE_PAGE x STALE_MAX_PAGES rows per run, one page in memory
  // at a time; anything left matches again on the next run.
  let markedMissed = 0
  for (let page = 0; page < STALE_MAX_PAGES; page++) {
    const { data: stale, error: staleErr } = await supabase
      .from('outcomes')
      .select(`id, conversion_send_error, ${ACUITY_SOURCE_JOIN}`)
      .eq('outcome_sources.kind', ACUITY_SOURCE_KIND)
      .is('conversion_sent_at', null)
      .neq('status', 'cancelled')
      .lt('occurred_at', cutoffIso)
      .or(`conversion_send_error.is.null,conversion_send_error.not.in.(${[...CAPI_TERMINAL].join(',')})`)
      .limit(STALE_PAGE)
    if (staleErr) throw new Error(`capi sweep stale query: ${staleErr.message}`)
    const rows = (stale ?? []) as Array<{ id: string; conversion_send_error: string | null }>
    // Defensive: the query already excludes terminal labels.
    const toMark = rows.filter((r) => !r.conversion_send_error || !CAPI_TERMINAL.has(r.conversion_send_error)).map((r) => r.id)
    if (toMark.length === 0) break
    const { error: updErr } = await supabase
      .from('outcomes')
      .update({ conversion_send_error: 'missed-48h-window' })
      .in('id', toMark)
    if (updErr) throw new Error(`capi sweep mark-missed: ${updErr.message}`)
    markedMissed += toMark.length
    if (rows.length < STALE_PAGE) break
  }

  return { mode, ran: true, sent, skipped, errors, markedMissed }
}

/** Active outcomes of ONE source first seen since `firstSeenSince` whose moment is after `occurredSince`. */
export async function countRecentFirstSeenOutcomes(
  supabase: SupabaseClient,
  q: { sourceId: string; firstSeenSince: string; occurredSince: string },
): Promise<number> {
  const { count, error } = await supabase
    .from('outcomes')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', q.sourceId)
    .gte('first_seen_at', q.firstSeenSince)
    .gte('occurred_at', q.occurredSince)
    .neq('status', 'cancelled')
  if (error) throw new Error(`webhook-miss count failed: ${error.message}`)
  return count ?? 0
}

export async function reconcileAcuityLedger(
  opts: { supabase?: SupabaseClient; adAccountId?: string; minDate?: string; maxDate?: string } = {},
): Promise<AcuityReconcileResult> {
  if (!isAcuityConfigured()) return { available: false, reason: 'Acuity not configured' }
  const supabase = opts.supabase ?? getAdminClient()

  const requestedAppointmentWindow = Boolean(opts.minDate || opts.maxDate)
  const minDate = opts.minDate ?? nyDaysAgo(PAST_WINDOW_DAYS)
  const maxDate = opts.maxDate ?? todayPlus(FUTURE_WINDOW_DAYS)

  const runStartIso = new Date().toISOString()
  let raws
  let truncated
  let sourceWindowBasis: 'appointment_date' | 'booking_date_et'
  let sourceWindowStart: string
  let sourceWindowEnd: string
  if (requestedAppointmentWindow) {
    // Explicit windows remain appointment-date evidence. Backfills and targeted repairs may use
    // them, but they cannot certify booking-created-date report completeness.
    raws = await getAppointments({ minDate, maxDate, showall: true, max: FETCH_MAX, direction: 'DESC' })
    truncated = raws.length >= FETCH_MAX
    sourceWindowBasis = 'appointment_date'
    sourceWindowStart = minDate
    sourceWindowEnd = maxDate
  } else {
    const sweep = await fetchAllAppointmentsByDateWindows(
      (windowStart, windowEnd) => getAppointments({
        minDate: windowStart,
        maxDate: windowEnd,
        showall: true,
        max: FETCH_MAX,
        direction: 'DESC',
      }),
      {
        minDate: EXHAUSTIVE_APPOINTMENT_DATE_START,
        maxDate: EXHAUSTIVE_APPOINTMENT_DATE_END,
        maxPerWindow: FETCH_MAX,
        maxWindows: MAX_FETCH_WINDOWS,
      },
    )
    raws = sweep.rows
    truncated = !sweep.complete
    sourceWindowBasis = sweep.complete ? 'booking_date_et' : 'appointment_date'
    sourceWindowStart = EXHAUSTIVE_APPOINTMENT_DATE_START
    sourceWindowEnd = sweep.complete ? nyDaysAgo(1) : EXHAUSTIVE_APPOINTMENT_DATE_END
    if (!sweep.complete) {
      console.warn(`[Acuity reconcile] exhaustive source sweep incomplete: ${sweep.blocker}`)
    }
  }
  if (truncated && requestedAppointmentWindow) {
    console.warn(`[Acuity reconcile] window ${minDate}..${maxDate} hit the ${FETCH_MAX}-row cap — narrow the window or use the exhaustive default sweep`)
  }
  const adAccountId = opts.adAccountId ?? await resolveAdAccountId(supabase)
  const upserted = await ingestAppointments(raws, adAccountId, supabase, 'sweep')

  // Rows inserted THIS run (first_seen_at >= runStart) whose booking moment is recent → webhook gap.
  // Only this account's Acuity rows: another source's outcomes are never an Acuity webhook miss.
  const missCutoff = new Date(Date.now() - MISS_LOOKBACK_HOURS * 3600_000).toISOString()
  const acuitySourceId = adAccountId ? await findAcuitySourceId(supabase, adAccountId) : null
  const count = acuitySourceId
    ? await countRecentFirstSeenOutcomes(supabase, { sourceId: acuitySourceId, firstSeenSince: runStartIso, occurredSince: missCutoff })
    : 0

  // At-least-once CAPI: retry unsent recent website bookings (live mode only) + close out stale ones.
  // Runs AFTER the pull so bookings the webhook missed entirely are in the ledger and get delivered here.
  let capi: AcuityCapiSweepResult
  try {
    capi = await sweepUnsentCapi(supabase)
  } catch (err) {
    console.warn('[Acuity reconcile] capi sweep failed:', err instanceof Error ? err.message : err)
    capi = { mode: resolveSendMode(), ran: false }
  }

  return {
    available: true,
    completedAt: new Date().toISOString(),
    sourceWindowBasis,
    windowStartDate: sourceWindowStart,
    windowEndDate: sourceWindowEnd,
    fetched: raws.length,
    upserted,
    truncated,
    webhookMisses: count,
    capi,
  }
}
