import 'server-only'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedOutcome } from '@/lib/outcomes/adapter'
import { calendarDateIn } from '@/lib/outcomes/store'
import { readOutcomeCsv, type CsvFileError, type CsvLocale, type CsvRowError } from './read'

/**
 * Preview and commit of an outcome CSV. The core, not the adapter, owns the write
 * (ADR-058): `planCsvImport` validates the whole file and classifies every valid row against what the
 * source already holds; `commitCsvImport` sends only new and changed rows to one database function
 * that writes them and the audit row in a single transaction.
 *
 * Identity is (account, source, external id). A row is "unchanged" when its normalized outcome equals
 * the stored one (`outcomes.raw`), so importing the same file again writes nothing and records no
 * observation. Money is compared in canonical decimal form, so 120.50 and 120.5 are the same value.
 */

export type CsvRowStatus = 'new' | 'changed' | 'unchanged'

export interface CsvImportPlan {
  fileSha256: string
  fileBytes: number
  totalRows: number
  newRows: number
  changedRows: number
  unchangedRows: number
  invalidRows: number
  errors: CsvRowError[]
  rows: Array<{ row: number; status: CsvRowStatus; outcome: NormalizedOutcome }>
  /** The timezone business dates were computed in. */
  timezone: string
}

export type CsvImportPlanResult = { ok: true; plan: CsvImportPlan } | { ok: false; fileError: CsvFileError }

export type CsvImportTarget = { sourceId: string } | { label: string; enabled: boolean }

export interface CsvImportCommitResult {
  sourceId: string
  importId: string
  inserted: number
  updated: number
  unchanged: number
}

export class CsvImportError extends Error {
  constructor(readonly code: 'SOURCE_NOT_FOUND' | 'SOURCE_LABEL_TAKEN' | 'ROWS_INVALID') {
    super(code)
    this.name = 'CsvImportError'
  }
}

export interface CsvSourceSummary {
  id: string
  label: string
  enabled: boolean
  lastSuccessAt: string | null
}

/** The account's csv sources, oldest first. */
export async function listCsvSources(db: SupabaseClient, adAccountId: string): Promise<CsvSourceSummary[]> {
  const { data, error } = await db.from('outcome_sources')
    .select('id, label, enabled, last_success_at')
    .eq('ad_account_id', adAccountId)
    .eq('kind', 'csv')
    .order('created_at', { ascending: true })
  if (error || !Array.isArray(data)) throw new Error(`csv source list failed: ${error?.message ?? 'no rows'}`)
  return (data as Array<{ id: string; label: string; enabled: boolean; last_success_at: string | null }>)
    .map((r) => ({ id: r.id, label: r.label, enabled: r.enabled, lastSuccessAt: r.last_success_at }))
}

async function requireCsvSource(db: SupabaseClient, adAccountId: string, sourceId: string): Promise<void> {
  const { data, error } = await db.from('outcome_sources').select('id')
    .eq('id', sourceId).eq('ad_account_id', adAccountId).eq('kind', 'csv').maybeSingle()
  if (error) throw new Error(`csv source lookup failed: ${error.message}`)
  if (!data) throw new CsvImportError('SOURCE_NOT_FOUND')
}

/** A label already used by a csv source of this account. */
export async function csvSourceLabelTaken(db: SupabaseClient, adAccountId: string, label: string): Promise<boolean> {
  const { data, error } = await db.from('outcome_sources').select('id')
    .eq('ad_account_id', adAccountId).eq('kind', 'csv').eq('label', label).maybeSingle()
  if (error) throw new Error(`csv source lookup failed: ${error.message}`)
  return data !== null
}

/** JSON with object keys sorted, so a jsonb round trip (which reorders keys) compares equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// Keeps each `in.(...)` filter well inside URL limits: ids are up to 256 characters.
const ID_BATCH_CHARS = 4000
const ID_BATCH_MAX = 100

function idBatches(ids: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let chars = 0
  for (const id of ids) {
    if (current.length > 0 && (current.length >= ID_BATCH_MAX || chars + id.length > ID_BATCH_CHARS)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(id)
    chars += id.length + 3
  }
  if (current.length > 0) batches.push(current)
  return batches
}

// Ids safe inside an `in.(...)` list. The client library quotes a value containing , ( ) but does not
// escape " or \, so any other id is looked up on its own with an exact-match filter.
const IN_LIST_SAFE = /^[A-Za-z0-9_.:@\/-]+$/
const SINGLE_LOOKUP_CONCURRENCY = 8

async function storedRaw(db: SupabaseClient, adAccountId: string, sourceId: string, ids: string[]): Promise<Map<string, string>> {
  const stored = new Map<string, string>()
  const read = async (by: { in: string[] } | { eq: string }) => {
    const query = db.from('outcomes').select('external_id, raw').eq('ad_account_id', adAccountId).eq('source_id', sourceId)
    const { data, error } = 'in' in by ? await query.in('external_id', by.in) : await query.eq('external_id', by.eq)
    if (error || !Array.isArray(data)) throw new Error(`stored outcome read failed: ${error?.message ?? 'no rows'}`)
    for (const row of data as Array<{ external_id: string; raw: unknown }>) stored.set(row.external_id, canonical(row.raw))
  }
  for (const batch of idBatches(ids.filter((id) => IN_LIST_SAFE.test(id)))) await read({ in: batch })
  const single = ids.filter((id) => !IN_LIST_SAFE.test(id))
  for (let i = 0; i < single.length; i += SINGLE_LOOKUP_CONCURRENCY) {
    await Promise.all(single.slice(i, i + SINGLE_LOOKUP_CONCURRENCY).map((id) => read({ eq: id })))
  }
  return stored
}

export function csvFileSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export async function planCsvImport(
  db: SupabaseClient,
  input: { adAccountId: string; sourceId: string | null; text: string; locale: CsvLocale },
): Promise<CsvImportPlanResult> {
  if (input.sourceId) await requireCsvSource(db, input.adAccountId, input.sourceId)
  const read = readOutcomeCsv(input.text, input.locale)
  if (!read.ok) return read
  const stored = input.sourceId
    ? await storedRaw(db, input.adAccountId, input.sourceId, read.rows.map((r) => r.outcome.externalId))
    : new Map<string, string>()
  const rows = read.rows.map((r) => {
    const previous = stored.get(r.outcome.externalId)
    const status: CsvRowStatus = previous === undefined ? 'new' : previous === canonical(r.outcome) ? 'unchanged' : 'changed'
    return { row: r.row, status, outcome: r.outcome }
  })
  const tally = (status: CsvRowStatus) => rows.filter((r) => r.status === status).length
  return {
    ok: true,
    plan: {
      fileSha256: csvFileSha256(input.text),
      fileBytes: Buffer.byteLength(input.text, 'utf8'),
      totalRows: read.totalRows,
      newRows: tally('new'),
      changedRows: tally('changed'),
      unchangedRows: tally('unchanged'),
      invalidRows: read.invalidRows,
      errors: read.errors,
      rows,
      timezone: input.locale.timezone,
    },
  }
}

/** PURE: a validated outcome → the row shape commit_outcome_csv_import reads. No customer data. */
function toImportRow(o: NormalizedOutcome, timezone: string): Record<string, unknown> {
  return {
    external_id: o.externalId,
    outcome_type: o.outcomeType,
    outcome_label: o.outcomeLabel,
    status: o.status,
    currency: o.currency,
    gross_value: o.grossValue,
    collected_value: o.collectedValue,
    occurred_at: o.occurredAt,
    business_date: calendarDateIn(o.occurredAt, timezone),
    fulfilment_at: o.fulfilmentAt,
    origin: o.origin,
    fbclid: o.attribution.fbclid,
    gclid: o.attribution.gclid,
    utm_source: o.attribution.utmSource,
    utm_medium: o.attribution.utmMedium,
    utm_campaign: o.attribution.utmCampaign,
    utm_content: o.attribution.utmContent,
    utm_term: o.attribution.utmTerm,
    landing_page: o.attribution.landingPage,
    referrer: o.attribution.referrer,
    raw: o,
  }
}

export async function commitCsvImport(
  db: SupabaseClient,
  input: { adAccountId: string; target: CsvImportTarget; actorUserId: string; plan: CsvImportPlan },
): Promise<CsvImportCommitResult> {
  const { plan, target } = input
  if (plan.invalidRows > 0) throw new CsvImportError('ROWS_INVALID')
  if ('sourceId' in target) await requireCsvSource(db, input.adAccountId, target.sourceId)
  else if (await csvSourceLabelTaken(db, input.adAccountId, target.label)) throw new CsvImportError('SOURCE_LABEL_TAKEN')

  const writes = plan.rows.filter((r) => r.status !== 'unchanged').map((r) => toImportRow(r.outcome, plan.timezone))
  const { data, error } = await db.rpc('commit_outcome_csv_import', {
    p_ad_account_id: input.adAccountId,
    p_source_id: 'sourceId' in target ? target.sourceId : null,
    p_new_source_label: 'label' in target ? target.label : null,
    p_new_source_enabled: 'enabled' in target ? target.enabled : null,
    p_actor_user_id: input.actorUserId,
    p_file_sha256: plan.fileSha256,
    p_file_bytes: plan.fileBytes,
    p_row_count: plan.totalRows,
    p_unchanged_count: plan.unchangedRows,
    p_rows: writes,
  })
  if (error) {
    if (/csv_import_source_not_found/.test(error.message)) throw new CsvImportError('SOURCE_NOT_FOUND')
    if (error.code === '23505' || /duplicate key/.test(error.message)) throw new CsvImportError('SOURCE_LABEL_TAKEN')
    throw new Error(`csv import commit failed: ${error.message}`)
  }
  const result = data as { source_id?: unknown; import_id?: unknown; inserted?: unknown; updated?: unknown } | null
  if (!result || typeof result.source_id !== 'string' || typeof result.import_id !== 'string'
      || typeof result.inserted !== 'number' || typeof result.updated !== 'number') {
    throw new Error('csv import commit failed: unexpected result')
  }
  return {
    sourceId: result.source_id,
    importId: result.import_id,
    inserted: result.inserted,
    updated: result.updated,
    unchanged: plan.unchangedRows,
  }
}
