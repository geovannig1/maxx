import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregateOutcomeFacts, type OutcomeFacts } from './facts'
import type { OutcomeLite, OutcomeStatus, OutcomeValueState } from './model'
import { requireOutcomeCurrency } from './aggregation'
import { requireOutcomeLedgerHealth, type OutcomeLedgerHealth } from './source-health'

// The scoped reader every business-outcome consumer uses (rules in ./aggregation.ts): enabled sources
// only, outcome uuids as identity, one currency, and the per-source completeness gate first.

const PAGE_SIZE = 1000
const MAX_PAGES = 100

export type WebOrigin = 'website' | 'staff_or_manual' | 'origin_unknown'

export interface ScopedOutcomeRow {
  /** The outcome uuid. */
  id: string
  sourceId: string
  sourceKind: string
  /** The source system's own id; interpreted only by that source's adapter. */
  externalId: string
  outcomeType: string
  currency: string
  grossValue: number | null
  collectedValue: number | null
  status: OutcomeStatus
  valueState: OutcomeValueState
  webOrigin: WebOrigin
  businessDate: string | null
  occurredAt: string | null
  label: string | null
  conversionSentAt: string | null
}

interface ViewRow {
  id: string; source_id: string; source_kind: string; external_id: string; outcome_type: string; currency: string
  gross_value: number | string | null; collected_value: number | string | null; status: OutcomeStatus
  business_state: OutcomeValueState; web_origin_state: WebOrigin | null; business_date: string | null
  occurred_at: string | null; outcome_label: string | null; conversion_sent_at: string | null
}

const money = (v: number | string | null): number | null => (v === null ? null : Number(v))

function toRow(r: ViewRow): ScopedOutcomeRow {
  return {
    id: r.id, sourceId: r.source_id, sourceKind: r.source_kind, externalId: r.external_id, outcomeType: r.outcome_type,
    currency: String(r.currency).trim(), grossValue: money(r.gross_value), collectedValue: money(r.collected_value),
    status: r.status, valueState: r.business_state, webOrigin: r.web_origin_state ?? 'origin_unknown',
    businessDate: r.business_date, occurredAt: r.occurred_at, label: r.outcome_label, conversionSentAt: r.conversion_sent_at,
  }
}

/** Deterministic order: business date, then the conversion instant, then the uuid. */
export function byBusinessTime(a: ScopedOutcomeRow, b: ScopedOutcomeRow): number {
  return (a.businessDate ?? '').localeCompare(b.businessDate ?? '')
    || (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '')
    || a.id.localeCompare(b.id)
}

/** Enabled-source outcomes whose business date is in [start, end]. No health gate; see readOutcomeFacts. */
export async function readScopedOutcomeRows(
  db: SupabaseClient, adAccountId: string, start: string, end: string,
): Promise<ScopedOutcomeRow[]> {
  const rows: ScopedOutcomeRow[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await db
      .from('v_business_outcomes')
      .select('id, source_id, source_kind, external_id, outcome_type, currency, gross_value, collected_value, status, business_state, web_origin_state, business_date, occurred_at, outcome_label, conversion_sent_at')
      .eq('ad_account_id', adAccountId)
      .eq('source_enabled', true)
      .gte('business_date', start)
      .lte('business_date', end)
      // Paging needs a total order; `id` is the primary key.
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error || !Array.isArray(data)) throw new Error(`outcome_read_failed:${start}..${end}`)
    rows.push(...(data as unknown as ViewRow[]).map(toRow))
    if (data.length < PAGE_SIZE) return rows.sort(byBusinessTime)
  }
  throw new Error('outcome_read_too_large')
}

export function toOutcomeLite(row: ScopedOutcomeRow): OutcomeLite {
  return {
    id: row.id,
    grossValue: row.grossValue,
    collectedValue: row.collectedValue,
    status: row.status,
    origin: row.webOrigin === 'origin_unknown' ? 'unknown' : row.webOrigin,
    valueState: row.valueState,
  }
}

export interface OutcomeFactsRead {
  facts: OutcomeFacts
  rows: ScopedOutcomeRow[]
  /** Outcomes per enabled source (rule 2: counts sum across sources). */
  bySource: Array<{ sourceId: string; kind: string; outcomes: number }>
  /** The single currency every value is in (rule 3). */
  currency: string
  health: OutcomeLedgerHealth
}

/** The gated, scoped facts read over a business-date window. */
export async function readOutcomeFacts(
  db: SupabaseClient, adAccountId: string, start: string, end: string, nowMs: number = Date.now(),
): Promise<OutcomeFactsRead> {
  const health = await requireOutcomeLedgerHealth(db, adAccountId, start, end, nowMs)
  const rows = await readScopedOutcomeRows(db, adAccountId, start, end)
  const currency = requireOutcomeCurrency(rows)
  return {
    facts: aggregateOutcomeFacts(rows.map(toOutcomeLite)),
    rows,
    bySource: health.sources.map((s) => ({ sourceId: s.sourceId, kind: s.kind, outcomes: rows.filter((r) => r.sourceId === s.sourceId).length })),
    currency,
    health,
  }
}

/** Facts per business date (ascending) and per label (richest gross value first), from one gated read. */
export function groupOutcomeFacts(rows: readonly ScopedOutcomeRow[], key: (row: ScopedOutcomeRow) => string | null): Map<string, OutcomeFacts> {
  const groups = new Map<string, ScopedOutcomeRow[]>()
  for (const row of rows) {
    const k = key(row)
    if (k === null) continue
    groups.set(k, [...(groups.get(k) ?? []), row])
  }
  return new Map([...groups].map(([k, g]) => [k, aggregateOutcomeFacts(g.map(toOutcomeLite))]))
}
