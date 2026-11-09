import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutcomeAdapter, listOutcomeAdapters } from './registry'
import { readEnabledOutcomeSources } from './source-health'

/** One run of a conversion-delivery retry sweep inside a source reconciliation. */
export interface ConversionSweepResult {
  mode: 'live' | 'test' | 'off'
  /** The sweep only runs live; in test/off it reports and does nothing. */
  ran: boolean
  sent?: number
  skipped?: number
  errors?: number
  /** Unsent rows past the dedup-safe cutoff, now labelled and permanently excluded. */
  markedMissed?: number
}

/** The result of reconciling a source's stored outcomes against the source system. */
export interface SourceReconcileResult {
  available: boolean
  reason?: string
  /** True when no enabled source can reconcile (a push-only install): nothing ran and nothing is owed. */
  noReconcilingSource?: true
  /** Durable source head: stamped only after the pull, ledger upsert, and retry sweep finish. */
  completedAt?: string
  /** `business_date` when the pull is proven complete on the business-date axis; otherwise the
   *  source's own scheduling axis, which cannot certify business-date completeness. */
  sourceWindowBasis?: 'appointment_date' | 'booking_date_et'
  /** Exact window on sourceWindowBasis covered by this pull. */
  windowStartDate?: string
  windowEndDate?: string
  fetched?: number
  upserted?: number
  /** True when the source returned exactly the fetch cap: the window may be truncated. */
  truncated?: boolean
  /** Recent outcomes first seen only because reconciliation pulled them: likely missed pushes. */
  webhookMisses?: number
  capi?: ConversionSweepResult
  /** Non-fatal problems the run hit after a successful pull (for example, a failed health-head write). */
  warnings?: string[]
}

/** PURE. Same-run gate for durable evidence publication. */
export function reconciliationCoversWindow(
  reconcile: SourceReconcileResult | null | undefined,
  requestedStartDate: string,
  requestedEndDate: string,
): boolean {
  return reconcile?.available === true
    && reconcile.truncated === false
    && typeof reconcile.completedAt === 'string'
    && reconcile.sourceWindowBasis === 'booking_date_et'
    && typeof reconcile.windowStartDate === 'string'
    && typeof reconcile.windowEndDate === 'string'
    && reconcile.windowStartDate <= requestedStartDate
    && reconcile.windowEndDate >= requestedEndDate
}

/**
 * Reconcile the account's ENABLED outcome sources whose adapter can reconcile against its source system
 * (a registered but unused adapter, such as the unconfigured reference adapter on a push-only
 * install, is not run). Each adapter records its own ledger-health head. With one reconciling adapter
 * its result is returned unchanged; with several, the combined result is available only when all are,
 * covers only the window all of them cover, and is truncated when any is. No reconciling source at all
 * returns `noReconcilingSource`, which is not a partial run.
 */
export async function reconcileOutcomeSources(
  opts: { supabase: SupabaseClient; adAccountId: string },
): Promise<SourceReconcileResult> {
  const kinds = [...new Set((await readEnabledOutcomeSources(opts.supabase, opts.adAccountId)).map((s) => s.kind))]
  const adapters = kinds.flatMap((kind) => {
    const adapter = getOutcomeAdapter(kind)
    return adapter && typeof adapter.reconcile === 'function' ? [adapter] : []
  })
  if (adapters.length === 0) return { available: false, reason: 'no reconciled outcome source', noReconcilingSource: true }
  const results: SourceReconcileResult[] = []
  for (const adapter of adapters) results.push(await adapter.reconcile!(opts))
  return results.length === 1 ? results[0] : combineReconcileResults(results)
}

/** PURE. The sync's partial errors for one reconcile result; none when no source needed reconciling. */
export function reconcilePartialErrors(result: SourceReconcileResult): string[] {
  if (result.noReconcilingSource) return []
  if (!result.available) return [`outcome-reconcile: ${result.reason ?? 'unavailable'}`]
  return [
    ...(result.truncated ? ['outcome-reconcile: source window was truncated'] : []),
    ...(result.warnings ?? []).map((warning) => `outcome-reconcile: ${warning}`),
  ]
}

/** PURE. The conservative combination described on reconcileOutcomeSources. */
export function combineReconcileResults(results: readonly SourceReconcileResult[]): SourceReconcileResult {
  const missing = results.find((r) => !r.available)
  if (missing) return { available: false, reason: missing.reason ?? 'unavailable' }
  const basis = results.every((r) => r.sourceWindowBasis === 'booking_date_et') ? 'booking_date_et' : 'appointment_date'
  const max = (xs: (string | undefined)[]) => xs.every((x) => typeof x === 'string') ? (xs as string[]).reduce((a, b) => (a > b ? a : b)) : undefined
  const min = (xs: (string | undefined)[]) => xs.every((x) => typeof x === 'string') ? (xs as string[]).reduce((a, b) => (a < b ? a : b)) : undefined
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0)
  return {
    available: true,
    completedAt: min(results.map((r) => r.completedAt)),
    sourceWindowBasis: basis,
    windowStartDate: max(results.map((r) => r.windowStartDate)),
    windowEndDate: min(results.map((r) => r.windowEndDate)),
    fetched: sum(results.map((r) => r.fetched)),
    upserted: sum(results.map((r) => r.upserted)),
    truncated: results.some((r) => r.truncated !== false) ? true : false,
    webhookMisses: sum(results.map((r) => r.webhookMisses)),
  }
}

/** A reconciled source's stored ledger-health head, evaluated for a requested business-date window. */
export interface StoredLedgerHealthStatus {
  available: boolean
  reason: string | null
  lastReconciledAt: string | null
}

/** Every reconciled source's stored ledger-health setting key and its evaluator (for read-only views). */
export function storedLedgerHealthReaders(): Array<{
  kind: string
  settingKey: string
  evaluate: (raw: unknown, startDate: string, endDate: string, nowMs: number) => StoredLedgerHealthStatus
}> {
  return listOutcomeAdapters().flatMap((a) => a.storedLedgerHealth ? [{ kind: a.kind, ...a.storedLedgerHealth }] : [])
}
