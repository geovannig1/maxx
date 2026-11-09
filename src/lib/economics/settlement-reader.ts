import type { SupabaseClient } from '@supabase/supabase-js'
import { accountCurrency, isIsoCurrency } from '@/config/business-config'
import { z } from 'zod'
import {
  summarizeSettlementWindow,
  type ProcessorSettlementEvent,
  type SettlementWindowSummary,
} from './settlement-ledger'

const iso = z.string().datetime({ offset: true })
const MAX_EVENTS = 10_000
const PAGE_SIZE = 1_000
const code = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)
const blockerCodes = z.array(code).max(32).superRefine((values, context) => {
  if (new Set(values).size !== values.length
      || values.some((value, index) => index > 0 && values[index - 1].localeCompare(value) > 0)) {
    context.addIssue({ code: 'custom', message: 'blocker codes must be unique and sorted' })
  }
})
const opaqueIdentity = (max: number) => z.string().min(1).max(max)
  .refine((value) => value.trim().length > 0)
const positiveInteger = z.union([z.number(), z.string().regex(/^\d+$/)])
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value) && value > 0)
const batchSchema = z.object({
  id: z.string().uuid(),
  processor: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  processor_account_ref: opaqueIdentity(256),
  window_start: iso,
  window_end: iso,
  complete: z.boolean(),
  blocker_codes: blockerCodes,
  imported_at: iso,
  import_sequence: positiveInteger,
}).strict().superRefine((row, context) => {
  if (row.complete === (row.blocker_codes.length > 0)) {
    context.addIssue({ code: 'custom', message: 'coverage completeness contradicts blocker codes' })
  }
})

const minorUnits = z.union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform((value) => Number(value))
  .refine(Number.isSafeInteger)
const eventSchema = z.object({
  id: z.string().uuid(),
  processor_event_id: opaqueIdentity(512),
  processor_transaction_id: opaqueIdentity(512),
  event_kind: z.enum([
    'payment_settled', 'refund_settled', 'chargeback_settled',
    'chargeback_reversed', 'fee_adjustment',
  ]),
  occurred_at: iso,
  available_at: iso,
  currency: z.string().refine((code) => isIsoCurrency(code) && code === accountCurrency(), 'currency must be the account currency'),
  outcome_id: z.string().uuid().nullable(),
  collected_ex_tax_minor: minorUnits,
  refunds_ex_tax_minor: minorUnits,
  chargebacks_ex_tax_minor: minorUnits,
  recovered_chargebacks_ex_tax_minor: minorUnits,
  payment_fees_minor: minorUnits,
  tax_amount_minor: minorUnits,
}).strict()

export type SettlementCoverageSelection =
  | {
      status: 'selected'
      batchId: string
      processor: string
      processorAccountRef: string
      importSequence: number
      windowStart: string
      windowEnd: string
      complete: boolean
      blockerCodes: string[]
    }
  | { status: 'unavailable'; blockerCode: 'processor_source_missing' }

export interface GovernedSettlementSource {
  processor: string
  processorAccountRef: string
}

export function selectSettlementCoverageForSource(
  rows: unknown[],
  source: GovernedSettlementSource,
  asOf: string,
): SettlementCoverageSelection {
  if (rows.length === 0) return { status: 'unavailable', blockerCode: 'processor_source_missing' }
  const parsed = rows.map((row) => batchSchema.parse(row))
  if (parsed.some((row) => (
    row.processor !== source.processor || row.processor_account_ref !== source.processorAccountRef
  ))) {
    throw new Error('Settlement coverage returned an unexpected processor source.')
  }
  const asOfTime = new Date(iso.parse(asOf)).getTime()
  if (parsed.some((row) => new Date(row.imported_at).getTime() > asOfTime)) {
    throw new Error('Settlement coverage was imported after the as-of cut.')
  }
  const newest = [...parsed].sort((a, b) => (
    b.import_sequence - a.import_sequence || b.id.localeCompare(a.id)
  ))[0]
  return {
    status: 'selected',
    batchId: newest.id,
    processor: newest.processor,
    processorAccountRef: newest.processor_account_ref,
    importSequence: newest.import_sequence,
    windowStart: newest.window_start,
    windowEnd: newest.window_end,
    complete: newest.complete,
    blockerCodes: [...newest.blocker_codes],
  }
}

/** Settlement rows keyed by outcome uuid: an outcome of any source, never a source system's id. */
export function normalizeSettlementRows(rows: unknown[]): ProcessorSettlementEvent[] {
  try {
    return rows.map((value) => {
      const row = eventSchema.parse(value)
      return {
        id: row.id,
        processorEventId: row.processor_event_id,
        processorTransactionId: row.processor_transaction_id,
        eventKind: row.event_kind,
        occurredAt: row.occurred_at,
        availableAt: row.available_at,
        currency: row.currency,
        outcomeId: row.outcome_id,
        collectedExTaxMinor: row.collected_ex_tax_minor,
        refundsExTaxMinor: row.refunds_ex_tax_minor,
        chargebacksExTaxMinor: row.chargebacks_ex_tax_minor,
        recoveredChargebacksExTaxMinor: row.recovered_chargebacks_ex_tax_minor,
        paymentFeesMinor: row.payment_fees_minor,
        taxAmountMinor: row.tax_amount_minor,
      }
    })
  } catch (error) {
    throw new Error(`Malformed processor settlement row: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface ProcessorSettlementRead {
  source: null | {
    batchId: string
    processor: string
    processorAccountRef: string
    importSequence: number
  }
  summary: SettlementWindowSummary
  events: ProcessorSettlementEvent[]
}

export async function readProcessorSettlementWindow(
  db: SupabaseClient,
  adAccountId: string,
  window: { start: string; end: string },
  asOf: string,
  source: GovernedSettlementSource,
): Promise<ProcessorSettlementRead> {
  if (!z.string().uuid().safeParse(adAccountId).success) {
    throw new Error('Settlement account ID must be a UUID.')
  }
  iso.parse(window.start); iso.parse(window.end); iso.parse(asOf)
  const parsedSource = z.object({
    processor: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    processorAccountRef: opaqueIdentity(256),
  }).strict().parse(source)

  const batches = await db.from('processor_settlement_batches')
    .select('id,processor,processor_account_ref,window_start,window_end,complete,blocker_codes,imported_at,import_sequence')
    .eq('ad_account_id', adAccountId)
    .eq('processor', parsedSource.processor)
    .eq('processor_account_ref', parsedSource.processorAccountRef)
    .lte('window_start', window.start)
    .gte('window_end', window.end)
    .lte('imported_at', asOf)
    .order('import_sequence', { ascending: false })
    .limit(1)
  if (batches.error) throw new Error(`Processor settlement coverage read failed: ${batches.error.message}`)
  const selection = selectSettlementCoverageForSource(batches.data ?? [], parsedSource, asOf)
  if (selection.status === 'unavailable') {
    return {
      source: null,
      summary: summarizeSettlementWindow({
        coverage: {
          complete: false,
          windowStart: window.start,
          windowEnd: window.end,
          blockerCodes: [selection.blockerCode],
        },
        requestedWindow: window,
        asOf,
        events: [],
      }),
      events: [],
    }
  }

  if (!selection.complete) {
    return {
      source: {
        batchId: selection.batchId,
        processor: selection.processor,
        processorAccountRef: selection.processorAccountRef,
        importSequence: selection.importSequence,
      },
      summary: summarizeSettlementWindow({
        coverage: {
          complete: false,
          windowStart: selection.windowStart,
          windowEnd: selection.windowEnd,
          blockerCodes: selection.blockerCodes,
        },
        requestedWindow: window,
        asOf,
        events: [],
      }),
      events: [],
    }
  }

  const countResult = await db.from('processor_settlement_events')
    .select('id', { count: 'exact', head: true })
    .eq('ad_account_id', adAccountId)
    .eq('processor', selection.processor)
    .eq('processor_account_ref', selection.processorAccountRef)
    .lte('import_sequence', selection.importSequence)
    .gte('occurred_at', window.start)
    .lt('occurred_at', window.end)
  if (countResult.error) {
    throw new Error(`Processor settlement event count failed: ${countResult.error.message}`)
  }
  const expectedCount = countResult.count
  if (!Number.isSafeInteger(expectedCount) || expectedCount === null || expectedCount < 0) {
    throw new Error('Processor settlement event count was unavailable or malformed.')
  }
  if (expectedCount > MAX_EVENTS) {
    throw new Error(`Processor settlement window exceeds the audited ${MAX_EVENTS}-event bound.`)
  }

  const rawRows: unknown[] = []
  while (rawRows.length < expectedCount) {
    const from = rawRows.length
    const to = Math.min(from + PAGE_SIZE, expectedCount) - 1
    const page = await db.from('processor_settlement_events')
      .select('id,processor_event_id,processor_transaction_id,event_kind,occurred_at,available_at,currency,outcome_id,collected_ex_tax_minor,refunds_ex_tax_minor,chargebacks_ex_tax_minor,recovered_chargebacks_ex_tax_minor,payment_fees_minor,tax_amount_minor')
      .eq('ad_account_id', adAccountId)
      .eq('processor', selection.processor)
      .eq('processor_account_ref', selection.processorAccountRef)
      .lte('import_sequence', selection.importSequence)
      .gte('occurred_at', window.start)
      .lt('occurred_at', window.end)
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (page.error) throw new Error(`Processor settlement event read failed: ${page.error.message}`)
    if (!Array.isArray(page.data) || page.data.length === 0) {
      throw new Error('Processor settlement event pages did not match the exact source count.')
    }
    rawRows.push(...page.data)
    if (rawRows.length > expectedCount) {
      throw new Error('Processor settlement event pages exceeded the exact source count.')
    }
  }
  const normalized = normalizeSettlementRows(rawRows)
  return {
    source: {
      batchId: selection.batchId,
      processor: selection.processor,
      processorAccountRef: selection.processorAccountRef,
      importSequence: selection.importSequence,
    },
    summary: summarizeSettlementWindow({
      coverage: {
        complete: true,
        windowStart: selection.windowStart,
        windowEnd: selection.windowEnd,
        blockerCodes: [],
      },
      requestedWindow: window,
      asOf,
      events: normalized,
    }),
    events: normalized,
  }
}
