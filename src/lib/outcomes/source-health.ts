import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutcomeAdapter } from './registry'

/**
 * Which outcome sources an account's readers count, and whether their stored outcomes are
 * authoritative for a business-date window (per-source readers).
 *
 * - Only ENABLED sources count. A disabled source's rows stay stored and are counted nowhere.
 * - A source Maxx reconciles against its system (an adapter with `ledgerHealth`) must prove the window
 *   is covered by a recent, complete pull; otherwise the whole read fails with that source's reason,
 *   because a missing reconciliation would make an incomplete total look complete.
 * - A push-only source (the signed webhook) has no completeness proof: its outcomes count as received,
 *   and readers name it `push_as_received` so a report can say so.
 * - No enabled source at all is `no_outcome_source`: reports say so rather than show zero.
 */

export interface OutcomeSourceRef {
  sourceId: string
  kind: string
}

export type SourceCompleteness = 'reconciled' | 'push_as_received'

export interface OutcomeLedgerHealth {
  /** Oldest reconciliation among reconciled sources; null when every source is push-only. */
  lastReconciledAt: string | null
  /** Earliest proven window end among reconciled sources; null when every source is push-only. */
  windowEndDate: string | null
  sources: Array<OutcomeSourceRef & { completeness: SourceCompleteness }>
}

/** The account's enabled outcome sources, in a stable order. */
export async function readEnabledOutcomeSources(db: SupabaseClient, adAccountId: string): Promise<OutcomeSourceRef[]> {
  const { data, error } = await db
    .from('outcome_sources')
    .select('id, kind')
    .eq('ad_account_id', adAccountId)
    .eq('enabled', true)
    .order('id', { ascending: true })
  if (error) throw new Error('outcome_sources_read_failed')
  if (!Array.isArray(data)) throw new Error('outcome_sources_read_failed')
  return (data as Array<{ id: string; kind: string }>).map((row) => ({ sourceId: row.id, kind: row.kind }))
}

const earliest = (values: Array<string | null>): string | null =>
  values.reduce<string | null>((min, v) => (v !== null && (min === null || v < min) ? v : min), null)

/** Throws `no_outcome_source`, `outcome_source_unsupported:<kind>` or a reconciled source's reason. */
export async function requireOutcomeLedgerHealth(
  db: SupabaseClient,
  adAccountId: string,
  startDate: string,
  endDate: string,
  nowMs: number = Date.now(),
): Promise<OutcomeLedgerHealth> {
  const sources = await readEnabledOutcomeSources(db, adAccountId)
  if (sources.length === 0) throw new Error('no_outcome_source')
  const checked: OutcomeLedgerHealth['sources'] = []
  const reconciled: Array<{ lastReconciledAt: string | null; windowEndDate: string | null }> = []
  for (const source of sources) {
    const adapter = getOutcomeAdapter(source.kind)
    if (!adapter) throw new Error(`outcome_source_unsupported:${source.kind}`)
    if (adapter.ledgerHealth) {
      reconciled.push(await adapter.ledgerHealth(db, adAccountId, startDate, endDate, nowMs))
      checked.push({ ...source, completeness: 'reconciled' })
    } else {
      checked.push({ ...source, completeness: 'push_as_received' })
    }
  }
  return {
    lastReconciledAt: earliest(reconciled.map((r) => r.lastReconciledAt)),
    windowEndDate: earliest(reconciled.map((r) => r.windowEndDate)),
    sources: checked,
  }
}
