import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { etDateOf } from '@/lib/utils/date-utils'
import type { BusinessCustomers, BusinessIntelligence, BusinessLeadTime, BusinessUpcoming, ReportSection, ReportingContext, ReportingRange } from '@/lib/reporting/contracts'
import { REPORTING_REQUEST_TIMEOUT_MS, withReportingDeadline } from '@/lib/reporting/deadline'
import { upcomingBusinessContext } from '@/lib/reporting/business-intelligence-context'
import {
  buildBusinessCustomers,
  buildBusinessLeadTime,
  buildBusinessUpcoming,
} from '@/lib/reporting/business-intelligence-metrics'
import { accountTimezone } from '@/config/business-config'
import { requireOutcomeCurrency } from '@/lib/outcomes/aggregation'

const PAGE_SIZE = 1_000
// Enabled outcome sources only (src/lib/outcomes/aggregation.ts). Native type ids are read from raw
// under their old names; everything else is the outcome column, mapped to the report row below.
const SOURCE_TABLE = 'v_business_outcomes'
const SELECT_FIELDS = [
  'id', 'currency', 'ad_account_id', 'email', 'outcome_label',
  'appointment_type_id:raw->appointmentTypeID', 'category:raw->>category', 'calendar_id:raw->calendarID',
  'fulfilment_at', 'occurred_at', 'business_date', 'gross_value', 'collected_value', 'status', 'appointment_duration:raw->duration',
].join(', ')

/** The old writer stored these raw values as Number(value) when present, else null. */
function rawNumber(value: unknown): unknown {
  return value != null ? Number(value) : null
}

/** The old writer stored category through cleanStr: trimmed, empty becomes null. */
function rawText(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

const OutcomeIntelligenceRowSchema = z.object({
  id: z.string().uuid(),
  currency: z.string(),
  ad_account_id: z.string().min(1),
  email: z.string().nullable(),
  outcome_label: z.string().nullable(),
  appointment_type_id: z.preprocess(rawNumber, z.number().int().finite().nullable()),
  category: z.preprocess(rawText, z.string().nullable()),
  calendar_id: z.preprocess(rawNumber, z.number().int().finite().nullable()),
  fulfilment_at: z.string().nullable(),
  occurred_at: z.string().nullable(),
  business_date: z.string().nullable(),
  gross_value: z.number().finite().nullable(),
  collected_value: z.number().finite().nullable(),
  status: z.string(),
  appointment_duration: z.unknown().optional(),
}).strict()

/** Read boundary: an outcome row in the appointment-flavoured shape (and key order) the builders consume. */
function toIntelligenceRow(input: unknown): BusinessIntelligenceRow {
  const row = OutcomeIntelligenceRowSchema.parse(input)
  return {
    id: row.id,
    ad_account_id: row.ad_account_id,
    email: row.email,
    appointment_type: row.outcome_label,
    appointment_type_id: row.appointment_type_id,
    category: row.category,
    calendar_id: row.calendar_id,
    datetime: row.fulfilment_at,
    datetime_created: row.occurred_at,
    booking_date_et: row.business_date,
    price: row.gross_value,
    amount_paid: row.collected_value,
    canceled: row.status === 'cancelled' || row.status === 'refunded',
    ...('appointment_duration' in row ? { appointment_duration: row.appointment_duration } : {}),
  }
}

interface ReadSpec {
  kind: 'booking_window' | 'history' | 'upcoming'
  range?: ReportingRange
  before?: string
  serviceStart?: string
  serviceEndExclusive?: string
}

function unavailable<T>(note: string): ReportSection<T> {
  return { state: 'unavailable', data: null, asOf: null, notes: [note] }
}

interface BusinessIntelligenceRow {
  appointment_duration?: unknown
  /** The outcome uuid. */
  id: string
  ad_account_id: string
  email: string | null
  appointment_type: string | null
  appointment_type_id: number | null
  category: string | null
  calendar_id: number | null
  datetime: string | null
  datetime_created: string | null
  booking_date_et: string | null
  price: number | null
  amount_paid: number | null
  canceled: boolean | null
}

function sameRow(left: BusinessIntelligenceRow, right: BusinessIntelligenceRow): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function uniqueRows(rows: readonly BusinessIntelligenceRow[]): BusinessIntelligenceRow[] {
  const byId = new Map<string, BusinessIntelligenceRow>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    if (existing && !sameRow(existing, row)) throw new Error('business_intelligence_conflicting_appointment_id')
    if (!existing) byId.set(row.id, row)
  }
  return [...byId.values()]
}

function parseRows(rows: unknown[], accountId: string, currency: string): BusinessIntelligenceRow[] {
  requireOutcomeCurrency(rows as Array<{ currency?: string | null }>, currency)
  const parsed = rows.map(toIntelligenceRow)
  if (parsed.some(row => row.ad_account_id !== accountId)) throw new Error('business_intelligence_account_scope_mismatch')
  return uniqueRows(parsed)
}

type QueryWithAbort<T> = T & { abortSignal?: (signal: AbortSignal) => T }

function withAbort<T>(query: T, signal: AbortSignal): T {
  const maybe = query as QueryWithAbort<T>
  return typeof maybe.abortSignal === 'function' ? maybe.abortSignal(signal) : query
}

async function readRows(
  client: SupabaseClient,
  context: ReportingContext,
  spec: ReadSpec,
): Promise<BusinessIntelligenceRow[]> {
  return withReportingDeadline(async signal => {
    const rows: BusinessIntelligenceRow[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = client
        .from(SOURCE_TABLE)
        .select(SELECT_FIELDS)
        .eq('ad_account_id', context.account.id)
        .eq('source_enabled', true)

      if (spec.kind === 'booking_window' && spec.range) {
        query = query.gte('business_date', spec.range.from).lte('business_date', spec.range.to)
      } else if (spec.kind === 'history' && spec.before) {
        query = query.lt('business_date', spec.before)
      } else if (spec.kind === 'upcoming' && spec.serviceStart && spec.serviceEndExclusive) {
        query = query.gte('fulfilment_at', spec.serviceStart).lt('fulfilment_at', spec.serviceEndExclusive)
      }

      const ordered = withAbort(query.order('id', { ascending: true }), signal)
      const { data, error } = await ordered.range(from, from + PAGE_SIZE - 1)
      if (error || !Array.isArray(data)) throw new Error('business_intelligence_source_read_failed')
      const page = parseRows(data, context.account.id, context.currency)
      rows.push(...page)
      // Pages are keyed by the outcome uuid; return them in business-time order.
      if (page.length < PAGE_SIZE) {
        return uniqueRows(rows).sort((left, right) => (left.booking_date_et ?? '').localeCompare(right.booking_date_et ?? '')
          || (left.datetime_created ?? '').localeCompare(right.datetime_created ?? '') || left.id.localeCompare(right.id))
      }
    }
  }, REPORTING_REQUEST_TIMEOUT_MS)
}

function timezoneOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: accountTimezone(), hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value)
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'))
  return (asUtc - date.getTime()) / 60_000
}

function etStartInstant(date: string): string {
  const utcGuess = new Date(`${date}T00:00:00.000Z`)
  const first = new Date(utcGuess.getTime() - timezoneOffsetMinutes(utcGuess) * 60_000)
  const second = new Date(utcGuess.getTime() - timezoneOffsetMinutes(first) * 60_000)
  return second.toISOString()
}

function dayAfter(date: string): string {
  const time = Date.parse(`${date}T00:00:00.000Z`)
  return new Date(time + 86_400_000).toISOString().slice(0, 10)
}


function safeBuild<T>(build: () => ReportSection<T>, note: string): ReportSection<T> {
  try {
    return build()
  } catch {
    return unavailable(note)
  }
}

function filterServiceDates(rows: readonly BusinessIntelligenceRow[], range: ReportingRange): BusinessIntelligenceRow[] {
  return rows.filter(row => {
    if (!row.datetime) return false
    const date = etDateOf(row.datetime)
    return date >= range.from && date <= range.to
  })
}

export async function readBusinessIntelligence(
  client: SupabaseClient,
  context: ReportingContext,
  options: { customerObservedThrough?: string } = {},
): Promise<BusinessIntelligence> {
  const observedAt = new Date().toISOString()
  const observedThrough = options.customerObservedThrough ?? etDateOf(context.asOf)
  let upcomingContextForRead: ReportingContext
  try {
    upcomingContextForRead = upcomingBusinessContext(context, observedAt)
  } catch {
    upcomingContextForRead = { ...context, asOf: observedAt }
  }

  const selectedAndPriorRead = readRows(client, context, {
    kind: 'booking_window', range: { from: context.comparison.from, to: context.range.to },
  })
  const customerCohortRead = observedThrough > context.range.to
    ? readRows(client, context, {
        kind: 'booking_window', range: { from: context.comparison.from, to: observedThrough },
      })
    : selectedAndPriorRead
  const historyRead = readRows(client, context, { kind: 'history', before: context.comparison.from })
  const upcomingRead = readRows(client, context, {
    kind: 'upcoming',
    serviceStart: etStartInstant(upcomingContextForRead.range.from),
    serviceEndExclusive: etStartInstant(dayAfter(upcomingContextForRead.range.to)),
  })

  const [selectedAndPrior, customerCohort, history, upcoming] = await Promise.allSettled([
    selectedAndPriorRead, customerCohortRead, historyRead, upcomingRead,
  ])

  const leadTime: ReportSection<BusinessLeadTime> = selectedAndPrior.status === 'fulfilled'
    ? safeBuild(() => buildBusinessLeadTime(context, selectedAndPrior.value), 'business_lead_time_read_unavailable')
    : unavailable('business_lead_time_read_unavailable')

  const customers: ReportSection<BusinessCustomers> = customerCohort.status === 'fulfilled' && history.status === 'fulfilled'
    ? safeBuild(() => buildBusinessCustomers(
        context, [...customerCohort.value, ...history.value], observedThrough,
      ), 'business_customer_read_unavailable')
    : unavailable('business_customer_read_unavailable')

  const upcomingSection: ReportSection<BusinessUpcoming> = upcoming.status === 'fulfilled'
    ? safeBuild(
        () => buildBusinessUpcoming(upcomingContextForRead, filterServiceDates(upcoming.value, upcomingContextForRead.range), observedAt),
        'business_upcoming_read_unavailable',
      )
    : unavailable('business_upcoming_read_unavailable')

  return { customers, leadTime, upcoming: upcomingSection }
}
