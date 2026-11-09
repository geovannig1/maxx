import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { storedLedgerHealthReaders } from '@/lib/outcomes/reconciliation'
import { evaluateGa4TelemetryHealth } from '@/lib/ga4/telemetry-health'
import { readDecisionQueueForAccount } from '@/lib/decisions/read-model'
import { decisionIdsForCockpit } from '@/lib/decisions/queue-v2'
import type { PerformanceCockpitData } from './contracts'
import {
  COCKPIT_TIMEZONE,
  comparisonWindowKey,
  type CockpitRange,
  type PlaneHealthEvidence,
  type ComparisonEvidence,
  type LoadPerformanceCockpitOptions,
  type MetaDeliveryEvidence,
} from './evidence'
import { classifyWindowSettle } from '@/lib/insights/settle-window'
import { comparableWindows, cockpitTrendsEnabled } from './comparison-window'
import {
  readDailyBudget,
  readMetaDelivery,
  readPartialToday,
} from './source-readers'
import { assemblePerformanceCockpitData } from './builder'

function localDate(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COCKPIT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant))
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

/**
 * Read the windows a per-claim trend can need, and say so when one could not be read.
 *
 * At most TWO distinct comparable pairs exist for any request, because only two maturities are in
 * play: claims stamped `settled` unconditionally (money does not re-attribute) and claims that run
 * the settle classifier. Both are derived here from the SAME inputs the builder uses, and the builder
 * still looks each claim's pair up by window rather than being handed a named one — so a disagreement
 * shows up as a missing window and an unavailable trend, not as a number computed over the wrong days.
 *
 * The requested window is already read by the caller and is passed in rather than re-queried.
 *
 * EVERY FAILURE DEGRADES TO A BLOCKER. A read that throws leaves its window absent; a window that
 * cannot be compared at all (nothing settled yet) contributes a blocker naming that. Nothing here can
 * produce a trend that is wrong — only one that is missing and says why.
 */
/**
 * Exported for tests. The blocker paths below are not observable through the assembled cockpit until
 * the builder consumes `comparison`, and a failure path that is only checked once something else
 * starts reading it is a failure path that ships untested.
 */
export async function readComparisonWindows(
  db: Parameters<typeof readMetaDelivery>[0],
  account: { id: string; accountId: string },
  range: CockpitRange,
  today: string,
  requestedDelivery: MetaDeliveryEvidence,
): Promise<ComparisonEvidence> {
  // Off means no extra reads at all, not "read them and refuse to use them".
  if (!cockpitTrendsEnabled()) return { deliveryByWindow: {}, blockerCodes: [] }
  const settle = classifyWindowSettle({ from: range.start, to: range.end, today })
  const maturities = [
    // Mirrors `spendClaim`: money is final as soon as it is spent.
    { state: 'settled' as const, matureThrough: range.end },
    // Mirrors `commonClaim`'s default for everything else.
    { state: settle.state, matureThrough: settle.settled_through },
  ]

  const blockerCodes = new Set<string>()
  const wanted = new Map<string, CockpitRange>()
  for (const maturity of maturities) {
    const pair = comparableWindows(range, maturity)
    if (!pair) {
      // Named per maturity, because the two can differ: spend may be comparable in the same request
      // where conversions are not.
      blockerCodes.add(`cockpit_trend_window_uncomparable:${maturity.state}`)
      continue
    }
    for (const window of [pair.current, pair.prior]) wanted.set(comparisonWindowKey(window), window)
  }

  const deliveryByWindow: Record<string, MetaDeliveryEvidence> = {}
  const requestedKey = comparisonWindowKey(range)
  // The requested window is already in hand. Re-reading it would be a second query returning the same
  // rows, and would let the two copies disagree if a sync landed between them.
  if (wanted.delete(requestedKey)) deliveryByWindow[requestedKey] = requestedDelivery

  const reads = await Promise.all([...wanted.entries()].map(async ([key, window]) => {
    try {
      return [key, await readMetaDelivery(db, account.id, account.accountId, window)] as const
    } catch {
      return [key, null] as const
    }
  }))
  for (const [key, delivery] of reads) {
    if (delivery === null) blockerCodes.add(`cockpit_trend_window_read_failed:${key}`)
    else deliveryByWindow[key] = delivery
  }

  return { deliveryByWindow, blockerCodes: [...blockerCodes].sort() }
}

/**
 * Ledger G. Health for the two NON-Meta planes, read from what each one durably recorded.
 *
 * Both kinds of key are written by scheduled jobs — each reconciled outcome source's ledger-health
 * head by its adapter's reconcile step, `ga4_telemetry_health` by the monitoring run — so this reads evidence rather than
 * probing a live service on a page render.
 *
 * A missing key yields an ABSENT plane (the field stays undefined and the builder emits no row), not
 * an unavailable one. The cockpit must be able to say "GA4 was never established here" without
 * claiming GA4 is down.
 */
async function readNonMetaPlaneHealth(
  db: SupabaseClient,
  adAccountDbId: string,
  range: CockpitRange,
  asOf: string,
): Promise<PlaneHealthEvidence[]> {
  const ledgerReaders = storedLedgerHealthReaders()
  const { data, error } = await db
    .from('app_settings')
    .select('key, value')
    .eq('ad_account_id', adAccountDbId)
    .in('key', [...ledgerReaders.map((reader) => reader.settingKey), 'ga4_telemetry_health'])

  // A FAILED READ IS NOT AN ABSENCE. `error` was previously destructured away, so an RLS or Postgres
  // failure produced `data = null` -> empty map -> no rows -> the page said these planes were never
  // established. That is the fail-open read this repo's own mistake log names as root cause #1, and it
  // defeats the entire absent-vs-down distinction the rest of this function is built on: "we never
  // asked", "we asked and it is down", and "we could not ask" are three different facts.
  //
  // Emitted as `unavailable` with a named blocker, for both planes, because a failed read tells us
  // nothing about either one. Neither is consumed by Today, so this stays quiet rather than alarming
  // the owner about a database hiccup — but it is stated, not swallowed.
  if (error) {
    return (['outcome_business', 'ga4_telemetry'] as const).map((plane) => ({
      plane,
      state: 'unavailable' as const,
      synchronizedAt: null,
      blockerCodes: ['plane_health_read_failed'],
    }))
  }

  const byKey = new Map((data ?? []).map((row) => [row.key as string, row.value as unknown]))
  const nowMs = Date.parse(asOf)
  const health: PlaneHealthEvidence[] = []

  // Each reconciled outcome source reuses its adapter's SHIPPED evaluator rather than a second opinion
  // about the same key. Its window-coverage rules are the reason it can say "the ledger does not cover
  // the dates you asked for" — a distinction a fresh implementation here would have quietly lost.
  // Several reconciled sources form one business plane: available only when every present one is.
  const ledgerStatuses = ledgerReaders.flatMap((reader) => {
    const raw = byKey.get(reader.settingKey)
    return raw === undefined ? [] : [reader.evaluate(raw, range.start, range.end, nowMs)]
  })
  if (ledgerStatuses.length) {
    const synced = ledgerStatuses.map((status) => status.lastReconciledAt)
    health.push({
      plane: 'outcome_business',
      state: ledgerStatuses.every((status) => status.available) ? 'available' : 'unavailable',
      synchronizedAt: synced.every((at): at is string => typeof at === 'string') ? synced.sort()[0] : null,
      blockerCodes: [...new Set(ledgerStatuses.flatMap((status) => status.reason ? [status.reason] : []))].sort(),
    })
  }

  const ga4 = evaluateGa4TelemetryHealth(byKey.get('ga4_telemetry_health'), nowMs)
  if (ga4) health.push({ plane: 'ga4_telemetry', ...ga4 })
  return health
}

export async function loadPerformanceCockpitDataImpl(
  options: LoadPerformanceCockpitOptions,
): Promise<PerformanceCockpitData> {
  const db = options.db ?? getAdminClient()
  const asOf = (options.now ?? new Date()).toISOString()
  const range: CockpitRange = {
    start: options.range.from,
    end: options.range.to,
    basis: 'closed_account_days',
    timezone: COCKPIT_TIMEZONE,
  }
  const accountResolution = await resolveOnlyActiveAccount(db as ReturnType<typeof getAdminClient>)
  if (!accountResolution.ok) {
    throw new Error(`cockpit_account_scope_unavailable:${accountResolution.reason}`)
  }
  const account = accountResolution.account
  const today = localDate(asOf)
  const [delivery, dailyBudget, decisionQueue, planeHealth] = await Promise.all([
    readMetaDelivery(db, account.id, account.accountId, range),
    readDailyBudget(db, account.id),
    readDecisionQueueForAccount(db as ReturnType<typeof getAdminClient>, account.id).catch(() => null),
    // Ledger G. CAUGHT and concurrent, like its siblings above. Plane health is a diagnostic strip;
    // it must never be able to cost the owner the page it sits on. A throw degrades to an EMPTY
    // list, which omits both planes — the page then says nothing about either, which is the honest
    // reading of "we could not establish it".
    readNonMetaPlaneHealth(db, account.id, range, asOf).catch((): PlaneHealthEvidence[] => []),
  ])
  delivery.dailyBudget = dailyBudget
  // CONCURRENT, not sequential. Both depend only on the batch above — `readPartialToday` on
  // `dailyBudget`, `readComparisonWindows` on `delivery` — and neither on the other. Awaiting them in
  // turn put a full Meta Graph round trip on the critical path of a server-rendered page for no
  // structural reason: `readMetaDelivery` is three Supabase queries PLUS an uncached live
  // `readNativePeriodDelivery` call, and the straddling window shape issues three of them.
  const [partialToday, comparison] = await Promise.all([
    readPartialToday(db, account.id, today, dailyBudget),
    // CAUGHT, like its sibling on the line above. This was awaited bare, so a throw anywhere in
    // `classifyWindowSettle`, `comparableWindows` or key construction took down the whole dashboard —
    // in a function whose own docstring says "EVERY FAILURE DEGRADES TO A BLOCKER". A trend feature
    // must never be able to cost the owner the page the trends sit on.
    cockpitTrendsEnabled()
      ? readComparisonWindows(db, account, range, today, delivery)
        .catch(() => ({ deliveryByWindow: {}, blockerCodes: ['cockpit_trend_read_threw'] }))
      : Promise.resolve(undefined),
  ])
  const rankedDecisions = decisionQueue
    ? decisionIdsForCockpit(decisionQueue.items, 3)
    : { decisionIds: [], primaryDecisionId: null }
  const primaryDecision = rankedDecisions.primaryDecisionId === null
    ? null
    : decisionQueue?.items.find((item) => item.source_id === rankedDecisions.primaryDecisionId) ?? null

  return assemblePerformanceCockpitData({
    account: { id: account.id, metaAccountId: account.accountId, name: account.accountName },
    range,
    asOf,
    delivery,
    comparison,
    planeHealth,
    partialToday,
    synchronizedAt: delivery.synchronizedAt,
    decisionIds: rankedDecisions.decisionIds,
    primaryDecisionId: rankedDecisions.primaryDecisionId,
    primaryDecision: primaryDecision && rankedDecisions.primaryDecisionId
      ? {
          id: rankedDecisions.primaryDecisionId,
          title: primaryDecision.title,
          summary: primaryDecision.summary,
          bucket: primaryDecision.bucket,
          lifecycle: primaryDecision.lifecycle,
          authority: primaryDecision.authority,
          reviewDate: primaryDecision.review_date,
        }
      : null,
  })
}
