import type { SupabaseClient } from '@supabase/supabase-js'
import { requireOutcomeLedgerHealth } from '@/lib/outcomes/source-health'
import { requireOutcomeCurrency } from '@/lib/outcomes/aggregation'
import { getAdminClient } from '@/lib/supabase/admin'
import { etDateOf } from '@/lib/utils/date-utils'
import type { BusinessReport, ReportSection, ReportingContext, ReportingRange } from './contracts'
import { buildBusinessReport, type BusinessLedgerRow } from './business-metrics'
import { readBusinessIntelligence } from './business-intelligence-reader'
import { validateReportingPacket } from './validation'
import { BUSINESS_INTELLIGENCE_LOADING_NOTE, finishBusinessProgress, hasPendingBusinessIntelligence, pendingBusinessIntelligence } from './business-progress'

const PAGE_SIZE = 1000

/** A `v_business_outcomes` row as read here (enabled sources only), before the report vocabulary. */
interface OutcomeWindowRow {
  id: string
  currency: string
  gross_value: number | null
  collected_value: number | null
  status: string
  business_date: string | null
  occurred_at: string | null
  outcome_label: string | null
  appointment_type_id?: unknown
  appointment_duration?: unknown
}

/** Read boundary: identity is the outcome uuid; a native type id is read from raw as its writer stored it. */
function toBusinessLedgerRow(row: OutcomeWindowRow): BusinessLedgerRow {
  return {
    id: row.id,
    price: row.gross_value,
    amount_paid: row.collected_value,
    canceled: row.status === 'cancelled' || row.status === 'refunded',
    booking_date_et: row.business_date,
    appointment_type: row.outcome_label,
    appointment_type_id: row.appointment_type_id != null ? Number(row.appointment_type_id) : null,
    ...('appointment_duration' in row ? { appointment_duration: row.appointment_duration } : {}),
  }
}

async function readWindow(
  client: SupabaseClient,
  accountId: string,
  range: ReportingRange,
  currency: string,
): Promise<BusinessLedgerRow[]> {
  const rows: OutcomeWindowRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('v_business_outcomes')
      .select('id, currency, gross_value, collected_value, status, business_date, occurred_at, outcome_label, appointment_type_id:raw->appointmentTypeID, appointment_duration:raw->duration')
      .eq('ad_account_id', accountId)
      .eq('source_enabled', true)
      .gte('business_date', range.from)
      .lte('business_date', range.to)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`outcome_reporting_read_failed:${range.from}..${range.to}`)
    if (!Array.isArray(data)) throw new Error('outcome_reporting_invalid_response')
    const page = data as OutcomeWindowRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  // One currency only (src/lib/outcomes/aggregation.ts, rule 3), then a deterministic order.
  requireOutcomeCurrency(rows, currency)
  return rows
    .sort((a, b) => (a.business_date ?? '').localeCompare(b.business_date ?? '')
      || (a.occurred_at ?? '').localeCompare(b.occurred_at ?? '') || a.id.localeCompare(b.id))
    .map(toBusinessLedgerRow)
}

function safeFailureNote(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const known = message.match(/outcome_[a-z0-9_]+|no_outcome_source/i)?.[0]
  return known ?? 'outcome_reporting_unavailable'
}

export async function readBusinessReport(
  context: ReportingContext,
  options: { includeIntelligence?: boolean; onProgress?: (result: ReportSection<BusinessReport>) => void } = {},
): Promise<ReportSection<BusinessReport>> {
  try {
    const client = getAdminClient()
    const health = await requireOutcomeLedgerHealth(
      client,
      context.account.id,
      context.comparison.from,
      context.range.to,
    )
    const [currentRows, previousRows] = await Promise.all([
      readWindow(client, context.account.id, context.range, context.currency),
      readWindow(client, context.account.id, context.comparison, context.currency),
    ])
    const sourceContext = {
      ...context,
      asOf: health.lastReconciledAt ?? context.asOf,
    }
    // A reconciled source bounds what is observed; push-only sources count as received up to now.
    const reconciled = health.sources.some(source => source.completeness === 'reconciled')
    if (reconciled && !health.windowEndDate) throw new Error('outcome_ledger_health_window_unknown')
    const sourceObservedThrough = etDateOf(sourceContext.asOf)
    const customerObservedThrough = health.windowEndDate !== null && health.windowEndDate < sourceObservedThrough
      ? health.windowEndDate : sourceObservedThrough
    const core: ReportSection<BusinessReport> = {
      state: 'available',
      data: buildBusinessReport(sourceContext, currentRows, previousRows),
      asOf: sourceContext.asOf,
      notes: [],
    }
    if (!options.includeIntelligence) return core
    const checked = (result: ReportSection<BusinessReport>): ReportSection<BusinessReport> => {
      const packet = validateReportingPacket({ context, section: 'business', result, notes: [] })
      if (packet.section !== 'business') throw new Error('business_reporting_invalid_section')
      return packet.result
    }
    const progress = checked({ ...core, state: 'partial', data: { ...core.data!, intelligence: pendingBusinessIntelligence() },
      notes: [BUSINESS_INTELLIGENCE_LOADING_NOTE] })
    try { void Promise.resolve(options.onProgress?.(progress)).catch(() => undefined) }
    catch { /* A failed observer cannot prevent optional reads or invalidate core totals. */ }
    try {
      const intelligence = await readBusinessIntelligence(client, sourceContext, { customerObservedThrough })
      const final = checked({ ...core, state: Object.values(intelligence).every(section => section.state === 'available') ? 'available' : 'partial',
        data: { ...core.data!, intelligence } })
      if (hasPendingBusinessIntelligence(final.data)) throw new Error('business_reporting_unfinished_intelligence')
      return final
    } catch { return checked(finishBusinessProgress(progress)) }
  } catch (error) {
    return { state: 'unavailable', data: null, asOf: null, notes: [safeFailureNote(error)] }
  }
}
