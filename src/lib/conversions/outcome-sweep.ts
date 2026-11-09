import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { OUTCOME_CONVERSION_TERMINAL, resolveOutcomeSendMode, sendOutcomeConversion } from './outcome-conversions'

// At-least-once conversions for enabled webhook sources, mirroring the reconciled-source sweep: retry unsent
// confirmed website outcomes while Meta's 48-hour event-id dedup window still protects a retry, and
// close out anything older as 'missed-48h-window' (never sent: a late resend could double-count).
// LIVE mode only — a test submission must not consume delivery state.

const RESEND_CUTOFF_MS = 46 * 3600_000
const CANDIDATE_LIMIT = 200
const PAGE = 500
/** At most PAGE × MAX_PAGES rows are read per window per run; the next run continues. */
const MAX_PAGES = 20

type UnsentRow = { id: string; conversion_send_error: string | null }

export interface OutcomeConversionSweepResult {
  mode: 'live' | 'test' | 'off'
  ran: boolean
  sent?: number
  skipped?: number
  errors?: number
  markedMissed?: number
}

async function webhookSourceIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from('outcome_sources').select('id').eq('kind', 'webhook').eq('enabled', true)
  if (error) throw new Error(`conversion sweep source query: ${error.message}`)
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
}

function unsentWebsiteOutcomes(db: SupabaseClient, sourceIds: string[]) {
  return db
    .from('outcomes')
    .select('id, conversion_send_error')
    .in('source_id', sourceIds)
    .is('conversion_sent_at', null)
    .eq('status', 'confirmed')
    .eq('origin', 'website')
}

const retryable = (rows: UnsentRow[]) =>
  rows.filter((r) => !r.conversion_send_error || !OUTCOME_CONVERSION_TERMINAL.has(r.conversion_send_error))

/**
 * Retryable unsent outcomes on one side of the cutoff, oldest first (occurred_at, then id), read in
 * pages and filtered for terminal labels BEFORE the `want` limit is applied. A plain unordered
 * `limit(200)` could return 200 terminal rows and starve every eligible one behind them. The whole
 * id list is read before anything is sent or labelled, so offset paging never skips a row.
 */
async function retryableIds(
  db: SupabaseClient, sourceIds: string[], side: 'recent' | 'stale', cutoffIso: string, want: number,
): Promise<string[]> {
  const ids: string[] = []
  for (let page = 0; page < MAX_PAGES && ids.length < want; page++) {
    const base = unsentWebsiteOutcomes(db, sourceIds)
    const windowed = side === 'recent' ? base.gte('occurred_at', cutoffIso) : base.lt('occurred_at', cutoffIso)
    const { data, error } = await windowed
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`conversion sweep ${side === 'recent' ? 'candidate' : 'stale'} query: ${error.message}`)
    const rows = (data ?? []) as UnsentRow[]
    ids.push(...retryable(rows).map((r) => r.id))
    if (rows.length < PAGE) break
  }
  return ids.slice(0, want)
}

export async function sweepUnsentOutcomeConversions(
  db: SupabaseClient,
  nowMs: number = Date.now(),
): Promise<OutcomeConversionSweepResult> {
  const mode = resolveOutcomeSendMode()
  if (mode !== 'live') return { mode, ran: false }
  const sourceIds = await webhookSourceIds(db)
  if (sourceIds.length === 0) return { mode, ran: true, sent: 0, skipped: 0, errors: 0, markedMissed: 0 }
  const cutoffIso = new Date(nowMs - RESEND_CUTOFF_MS).toISOString()

  let sent = 0, skipped = 0, errors = 0
  for (const id of await retryableIds(db, sourceIds, 'recent', cutoffIso, CANDIDATE_LIMIT)) {
    const result = await sendOutcomeConversion(db, id, { nowMs })
    if (result.status === 'sent') sent++
    else if (result.status === 'skipped' || result.status === 'already_sent') skipped++
    else errors++
  }

  const stale = await retryableIds(db, sourceIds, 'stale', cutoffIso, PAGE * MAX_PAGES)
  for (let at = 0; at < stale.length; at += PAGE) {
    const ids = stale.slice(at, at + PAGE)
    const { error: updateError } = await db.from('outcomes').update({ conversion_send_error: 'missed-48h-window' }).in('id', ids)
    if (updateError) throw new Error(`conversion sweep mark-missed: ${updateError.message}`)
  }
  const markedMissed = stale.length
  return { mode, ran: true, sent, skipped, errors, markedMissed }
}
