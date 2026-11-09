import type { SupabaseClient } from '@supabase/supabase-js'
import { accountCurrency, isIsoCurrency } from '@/config/business-config'
import { z } from 'zod'
import {
  summarizeVariableCostWindow,
  type VariableCostCoverage,
  type VariableCostEvent,
  type VariableCostWindowSummary,
} from './variable-cost-ledger'

const MAX_EVENTS = 10_000
const PAGE_SIZE = 1_000
const iso = z.string().datetime({ offset: true })
const code = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)
const positiveInteger = z.union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number).refine((value) => Number.isSafeInteger(value) && value > 0)
const signedInteger = z.union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform(Number).refine(Number.isSafeInteger)
const codes = z.array(code).min(1).max(32).superRefine((values, context) => {
  if (new Set(values).size !== values.length
      || values.some((value, index) => index > 0 && values[index - 1].localeCompare(value) > 0)) {
    context.addIssue({ code: 'custom', message: 'codes must be unique and sorted' })
  }
})
const batchSchema = z.object({
  id: z.string().uuid(),
  economics_policy_id: z.string().uuid(),
  cost_source: code,
  window_start: iso,
  window_end: iso,
  complete: z.boolean(),
  blocker_codes: z.array(code).max(32),
  import_sequence: positiveInteger,
  imported_at: iso,
}).strict().superRefine((row, context) => {
  if (row.complete === (row.blocker_codes.length > 0)) {
    context.addIssue({ code: 'custom', message: 'coverage completeness contradicts blocker codes' })
  }
})
const eventSchema = z.object({
  id: z.string().uuid(),
  cost_source: code,
  source_event_id: z.string().min(1).max(512).refine((value) => value.trim().length > 0),
  event_kind: z.enum(['cost_incurred', 'cost_reversed']),
  reverses_source_event_id: z.string().min(1).max(512).nullable(),
  occurred_at: iso,
  available_at: iso,
  currency: z.string().refine((code) => isIsoCurrency(code) && code === accountCurrency(), 'currency must be the account currency'),
  outcome_id: z.string().uuid(),
  category: code,
  amount_minor: signedInteger,
}).strict()
const policySchema = z.object({
  policyId: z.string().uuid(),
  requiredCostSources: codes,
  allowedVariableCostCategories: codes,
  variableCostCategorySources: z.record(code, code),
}).strict()

export type VariableCostCoverageSelection =
  | {
      status: 'selected'
      batchId: string
      importSequence: number
      costSource: string
      complete: boolean
      blockerCodes: string[]
      windowStart: string
      windowEnd: string
    }
  | { status: 'missing' }

export function selectVariableCostCoverage(
  rows: unknown[],
  policyId: string,
  costSource: string,
  asOf: string,
): VariableCostCoverageSelection {
  if (rows.length === 0) return { status: 'missing' }
  let parsed: Array<z.infer<typeof batchSchema>>
  try {
    parsed = rows.map((row) => batchSchema.parse(row))
  } catch (error) {
    throw new Error(`Malformed variable-cost coverage row: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed.some((row) => (
    row.economics_policy_id !== policyId || row.cost_source !== costSource
  ))) {
    throw new Error('Variable-cost coverage returned an unexpected policy or source.')
  }
  const asOfTime = new Date(iso.parse(asOf)).getTime()
  if (parsed.some((row) => new Date(row.imported_at).getTime() > asOfTime)) {
    throw new Error('Variable-cost coverage was imported after the as-of cut.')
  }
  const newest = [...parsed].sort((a, b) => (
    b.import_sequence - a.import_sequence || b.id.localeCompare(a.id)
  ))[0]
  return {
    status: 'selected', batchId: newest.id, importSequence: newest.import_sequence,
    costSource: newest.cost_source, complete: newest.complete,
    blockerCodes: [...newest.blocker_codes],
    windowStart: newest.window_start, windowEnd: newest.window_end,
  }
}

/** Variable-cost rows keyed by outcome uuid: an outcome of any source, never a source system's id. */
export function normalizeVariableCostRows(rows: unknown[]): VariableCostEvent[] {
  try {
    return rows.map((value) => {
      const row = eventSchema.parse(value)
      return {
        id: row.id,
        costSource: row.cost_source,
        sourceEventId: row.source_event_id,
        eventKind: row.event_kind,
        reversesSourceEventId: row.reverses_source_event_id,
        occurredAt: row.occurred_at,
        availableAt: row.available_at,
        currency: row.currency,
        outcomeId: row.outcome_id,
        category: row.category,
        amountMinor: row.amount_minor,
      }
    })
  } catch (error) {
    throw new Error(`Malformed variable-cost row: ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface SourceRead {
  selection: Exclude<VariableCostCoverageSelection, { status: 'missing' }>
  count: number
}

export interface VariableCostRead {
  policyId: string
  sourceCuts: Array<{
    costSource: string
    batchId: string
    importSequence: number
    complete: boolean
  }>
  summary: VariableCostWindowSummary
  events: VariableCostEvent[]
}

export async function readVariableCostWindow(
  db: SupabaseClient,
  adAccountId: string,
  rawPolicy: {
    policyId: string
    requiredCostSources: string[]
    allowedVariableCostCategories: string[]
    variableCostCategorySources: Record<string, string>
  },
  window: { start: string; end: string },
  asOf: string,
): Promise<VariableCostRead> {
  if (!z.string().uuid().safeParse(adAccountId).success) {
    throw new Error('Variable-cost account ID must be a UUID.')
  }
  const policy = policySchema.parse(rawPolicy)
  iso.parse(window.start); iso.parse(window.end); iso.parse(asOf)

  const selections = await Promise.all(policy.requiredCostSources.map(async (costSource) => {
    const result = await db.from('variable_cost_batches')
      .select('id,economics_policy_id,cost_source,window_start,window_end,complete,blocker_codes,import_sequence,imported_at')
      .eq('ad_account_id', adAccountId)
      .eq('economics_policy_id', policy.policyId)
      .eq('cost_source', costSource)
      .lte('window_start', window.start)
      .gte('window_end', window.end)
      .lte('imported_at', asOf)
      .order('import_sequence', { ascending: false })
      .limit(1)
    if (result.error) throw new Error(`Variable-cost coverage read failed: ${result.error.message}`)
    return selectVariableCostCoverage(result.data ?? [], policy.policyId, costSource, asOf)
  }))
  const selected = selections.filter((row): row is Exclude<typeof row, { status: 'missing' }> => (
    row.status === 'selected'
  ))
  const coverage: VariableCostCoverage[] = selected.map((row) => ({
    costSource: row.costSource,
    complete: row.complete,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    blockerCodes: [...row.blockerCodes],
  }))

  const readable = selected.filter((row) => row.complete)
  const counted: SourceRead[] = await Promise.all(readable.map(async (selection) => {
    const result = await db.from('variable_cost_events')
      .select('id', { count: 'exact', head: true })
      .eq('ad_account_id', adAccountId)
      .eq('economics_policy_id', policy.policyId)
      .eq('cost_source', selection.costSource)
      .lte('import_sequence', selection.importSequence)
      .gte('occurred_at', window.start)
      .lt('occurred_at', window.end)
    if (result.error) throw new Error(`Variable-cost event count failed: ${result.error.message}`)
    if (result.count === null || !Number.isSafeInteger(result.count) || result.count < 0) {
      throw new Error('Variable-cost event count was unavailable or malformed.')
    }
    return { selection, count: result.count }
  }))
  const totalCount = counted.reduce((sum, row) => sum + row.count, 0)
  if (!Number.isSafeInteger(totalCount) || totalCount > MAX_EVENTS) {
    throw new Error(`Variable-cost window exceeds the audited ${MAX_EVENTS}-event bound.`)
  }

  const pages = await Promise.all(counted.map(async ({ selection, count }) => {
    const rawRows: unknown[] = []
    while (rawRows.length < count) {
      const from = rawRows.length
      const to = Math.min(from + PAGE_SIZE, count) - 1
      const result = await db.from('variable_cost_events')
        .select('id,cost_source,source_event_id,event_kind,reverses_source_event_id,occurred_at,available_at,currency,outcome_id,category,amount_minor')
        .eq('ad_account_id', adAccountId)
        .eq('economics_policy_id', policy.policyId)
        .eq('cost_source', selection.costSource)
        .lte('import_sequence', selection.importSequence)
        .gte('occurred_at', window.start)
        .lt('occurred_at', window.end)
        .order('occurred_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
      if (result.error) throw new Error(`Variable-cost event read failed: ${result.error.message}`)
      if (!Array.isArray(result.data) || result.data.length === 0) {
        throw new Error('Variable-cost event pages did not match the exact source count.')
      }
      rawRows.push(...result.data)
      if (rawRows.length > count) {
        throw new Error('Variable-cost event pages exceeded the exact source count.')
      }
    }
    return normalizeVariableCostRows(rawRows)
  }))
  const events = pages.flat()
  return {
    policyId: policy.policyId,
    sourceCuts: selected.map((row) => ({
      costSource: row.costSource,
      batchId: row.batchId,
      importSequence: row.importSequence,
      complete: row.complete,
    })),
    summary: summarizeVariableCostWindow({
      requiredSources: policy.requiredCostSources,
      allowedCategories: policy.allowedVariableCostCategories,
      categorySources: policy.variableCostCategorySources,
      coverage,
      requestedWindow: window,
      asOf,
      events,
    }),
    events,
  }
}
