import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutcomeAdapter } from './registry'

// Owner management of outcome sources for the sources screen. Reads and writes only
// the non-secret columns: a source's config and its signing secret (outcome_source_secrets) are never
// selected here. Every query is scoped to the caller's ad account.

export interface OutcomeSourceRow {
  id: string
  kind: string
  label: string
  enabled: boolean
  created_at: string
  last_success_at: string | null
}

const COLUMNS = 'id, kind, label, enabled, created_at, last_success_at'

export async function listOutcomeSources(db: SupabaseClient, adAccountId: string): Promise<OutcomeSourceRow[]> {
  const { data, error } = await db.from('outcome_sources').select(COLUMNS)
    .eq('ad_account_id', adAccountId).order('created_at', { ascending: true })
  if (error || !Array.isArray(data)) throw new Error('outcome_sources_read_failed')
  return data as OutcomeSourceRow[]
}

/** The updated row, or null when the id is not a source of this account. */
export async function setOutcomeSourceEnabled(
  db: SupabaseClient, adAccountId: string, sourceId: string, enabled: boolean,
): Promise<OutcomeSourceRow | null> {
  const { data, error } = await db.from('outcome_sources').update({ enabled })
    .eq('id', sourceId).eq('ad_account_id', adAccountId).select(COLUMNS)
  if (error || !Array.isArray(data)) throw new Error('outcome_sources_write_failed')
  return (data[0] as OutcomeSourceRow | undefined) ?? null
}

/** What enabling a source of this kind means for reports, shown next to its toggle. */
export function sourceKindNote(kind: string): string | null {
  if (kind === 'webhook') return 'Push-only: outcomes count as received; Maxx cannot prove a window is complete. A delivery that carries a paid-touch token is linked to its ad click; one without a token counts as not linked.'
  if (kind === 'csv') return 'Imported files cannot carry an ad-click token, so paid cohorts that include CSV outcomes are reported incomplete (source_cannot_carry_token).'
  const adapter = getOutcomeAdapter(kind)
  if (adapter?.ledgerHealth) return 'Reconciled against its source system: a window counts only once a recent, complete pull covers it.'
  return adapter ? null : 'No adapter handles this kind: it is counted nowhere until one exists.'
}
