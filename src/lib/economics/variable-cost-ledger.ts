import { accountCurrency, isIsoCurrency } from '@/config/business-config'
export type VariableCostEventKind = 'cost_incurred' | 'cost_reversed'

export interface VariableCostEvent {
  id: string
  costSource: string
  sourceEventId: string
  eventKind: VariableCostEventKind
  reversesSourceEventId: string | null
  occurredAt: string
  availableAt: string
  /** ISO 4217; must be the ad account's currency. */
  currency: string
  /** The outcome uuid this cost belongs to. */
  outcomeId: string
  category: string
  amountMinor: number
}

export interface VariableCostCoverage {
  costSource: string
  complete: boolean
  windowStart: string
  windowEnd: string
  blockerCodes: string[]
}

interface VariableCostDiagnostics {
  sourceEventCount: number
  inWindowEventCount: number
  ignoredOutsideWindow: number
  requiredSourceCount: number
  coveredSourceCount: number
}

export type VariableCostWindowSummary =
  | {
      status: 'available'
      incurredVariableCostsMinor: number
      reversedVariableCostsMinor: number
      totalVariableCostsMinor: number
      byCategoryMinor: Record<string, number>
      outcomeCount: number
      eventCount: number
      blockerCodes: string[]
      diagnostics: VariableCostDiagnostics
    }
  | {
      status: 'unavailable'
      incurredVariableCostsMinor: null
      reversedVariableCostsMinor: null
      totalVariableCostsMinor: null
      byCategoryMinor: null
      outcomeCount: null
      eventCount: null
      blockerCodes: string[]
      diagnostics: VariableCostDiagnostics
    }

const CODE = /^[a-z][a-z0-9_]{1,63}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const MAX_AMOUNT_MINOR = 100_000_000_000
const MAX_EVENTS = 10_000

function timestamp(value: string, label: string): number {
  const parsed = new Date(value).getTime()
  if (!ISO_INSTANT.test(value) || !Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label} timestamp.`)
  }
  return parsed
}

function validateCodes(values: string[], label: string): void {
  if (values.length < 1 || values.length > 32
      || values.some((value) => !CODE.test(value))
      || new Set(values).size !== values.length
      || values.some((value, index) => index > 0 && values[index - 1].localeCompare(value) > 0)) {
    throw new Error(`Invalid governed ${label} codes.`)
  }
}

function validateEvent(
  event: VariableCostEvent,
  requiredSources: Set<string>,
  allowedCategories: Set<string>,
  categorySources: Map<string, string>,
): void {
  if (!event.id?.trim() || !event.sourceEventId?.trim()) {
    throw new Error('Variable-cost event identity is incomplete.')
  }
  if (!requiredSources.has(event.costSource)) {
    throw new Error(`Variable-cost source ${event.costSource} is not required by policy.`)
  }
  if (!allowedCategories.has(event.category)) {
    throw new Error(`Variable-cost category ${event.category} is not allowed by policy.`)
  }
  if (categorySources.get(event.category) !== event.costSource) {
    throw new Error(`Variable-cost category ${event.category} came from a non-authoritative source.`)
  }
  if (!isIsoCurrency(event.currency) || event.currency !== accountCurrency()) {
    throw new Error(`Variable-cost event currency must be the account currency (${accountCurrency()}); currencies are never converted.`)
  }
  const occurred = timestamp(event.occurredAt, 'variable-cost occurred_at')
  const available = timestamp(event.availableAt, 'variable-cost available_at')
  if (available < occurred) throw new Error('Variable-cost available_at precedes occurred_at.')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.outcomeId)) {
    throw new Error('Variable-cost outcome identity is invalid.')
  }
  if (!Number.isSafeInteger(event.amountMinor)) {
    throw new Error('Variable-cost amount must use exact integer minor units.')
  }
  if (event.amountMinor < 1 || event.amountMinor > MAX_AMOUNT_MINOR) {
    throw new Error('Invalid variable-cost amount_minor.')
  }
  const incurred = event.eventKind === 'cost_incurred' && event.reversesSourceEventId === null
  const reversed = event.eventKind === 'cost_reversed'
    && typeof event.reversesSourceEventId === 'string'
    && event.reversesSourceEventId.trim().length > 0
  if (!incurred && !reversed) {
    throw new Error(`Variable-cost reversal shape contradicts ${event.eventKind}.`)
  }
}

export function summarizeVariableCostWindow(input: {
  requiredSources: string[]
  allowedCategories: string[]
  categorySources: Record<string, string>
  coverage: VariableCostCoverage[]
  requestedWindow: { start: string; end: string }
  asOf: string
  events: VariableCostEvent[]
}): VariableCostWindowSummary {
  validateCodes(input.requiredSources, 'required cost source')
  validateCodes(input.allowedCategories, 'allowed variable-cost category')
  if (input.events.length > MAX_EVENTS) {
    throw new Error(`Variable-cost window exceeds ${MAX_EVENTS} events.`)
  }
  const requestedStart = timestamp(input.requestedWindow.start, 'variable-cost requested start')
  const requestedEnd = timestamp(input.requestedWindow.end, 'variable-cost requested end')
  const asOf = timestamp(input.asOf, 'variable-cost as-of')
  if (requestedEnd <= requestedStart) {
    throw new Error('Variable-cost window is invalid.')
  }
  if (asOf < requestedEnd) {
    throw new Error('Variable-cost as-of cut cannot precede the requested window end.')
  }
  const requiredSources = new Set(input.requiredSources)
  const allowedCategories = new Set(input.allowedCategories)
  const categorySources = new Map(Object.entries(input.categorySources))
  if (categorySources.size !== allowedCategories.size
      || [...allowedCategories].some((category) => !categorySources.has(category))
      || [...categorySources].some(([category, source]) => (
        !allowedCategories.has(category) || !requiredSources.has(source)
      ))
      || [...requiredSources].some((source) => (
        ![...categorySources.values()].includes(source)
      ))) {
    throw new Error('Governed variable-cost category/source ownership is contradictory.')
  }
  const coverageBySource = new Map<string, VariableCostCoverage>()
  for (const row of input.coverage) {
    if (!requiredSources.has(row.costSource)) {
      throw new Error(`Variable-cost coverage source ${row.costSource} is not required by policy.`)
    }
    if (coverageBySource.has(row.costSource)) {
      throw new Error(`Duplicate variable-cost coverage source: ${row.costSource}.`)
    }
    const start = timestamp(row.windowStart, 'variable-cost coverage start')
    const end = timestamp(row.windowEnd, 'variable-cost coverage end')
    if (end <= start) throw new Error('Variable-cost coverage window is invalid.')
    if (row.complete === (row.blockerCodes.length > 0)) {
      throw new Error(`Variable-cost coverage completeness contradicts ${row.costSource}.`)
    }
    coverageBySource.set(row.costSource, row)
  }

  const ids = new Set<string>()
  const sourceIds = new Set<string>()
  for (const row of input.events) {
    validateEvent(row, requiredSources, allowedCategories, categorySources)
    const sourceIdentity = `${row.costSource}\u0000${row.sourceEventId}`
    if (ids.has(row.id) || sourceIds.has(sourceIdentity)) {
      throw new Error(`Duplicate variable-cost event identity: ${row.sourceEventId}.`)
    }
    ids.add(row.id); sourceIds.add(sourceIdentity)
  }
  const inWindow = input.events.filter((row) => {
    const occurred = timestamp(row.occurredAt, 'variable-cost occurred_at')
    return occurred >= requestedStart && occurred < requestedEnd
  })
  const blockers: string[] = []
  for (const source of input.requiredSources) {
    const row = coverageBySource.get(source)
    if (!row) {
      blockers.push(`variable_cost_source_missing:${source}`)
      continue
    }
    if (!row.complete) {
      blockers.push(`variable_cost_source_incomplete:${source}`, ...row.blockerCodes)
    }
    if (timestamp(row.windowStart, 'variable-cost coverage start') > requestedStart
        || timestamp(row.windowEnd, 'variable-cost coverage end') < requestedEnd) {
      blockers.push(`variable_cost_window_not_covered:${source}`)
    }
  }
  if (inWindow.some((row) => timestamp(row.availableAt, 'variable-cost available_at') > asOf)) {
    blockers.push('variable_cost_event_not_available_as_of')
  }
  const diagnostics: VariableCostDiagnostics = {
    sourceEventCount: input.events.length,
    inWindowEventCount: inWindow.length,
    ignoredOutsideWindow: input.events.length - inWindow.length,
    requiredSourceCount: input.requiredSources.length,
    coveredSourceCount: coverageBySource.size,
  }
  if (blockers.length > 0) {
    return {
      status: 'unavailable', incurredVariableCostsMinor: null,
      reversedVariableCostsMinor: null, totalVariableCostsMinor: null,
      byCategoryMinor: null, outcomeCount: null, eventCount: null,
      blockerCodes: [...new Set(blockers)].sort(), diagnostics,
    }
  }

  let incurred = 0
  let reversed = 0
  const byCategory = new Map<string, number>()
  for (const row of inWindow) {
    const signed = row.eventKind === 'cost_incurred' ? row.amountMinor : -row.amountMinor
    if (row.eventKind === 'cost_incurred') incurred += row.amountMinor
    else reversed += row.amountMinor
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + signed)
  }
  const total = incurred - reversed
  if (![incurred, reversed, total, ...byCategory.values()].every(Number.isSafeInteger)) {
    throw new Error('Variable-cost aggregate exceeds the exact safe-integer range.')
  }
  return {
    status: 'available',
    incurredVariableCostsMinor: incurred,
    reversedVariableCostsMinor: reversed,
    totalVariableCostsMinor: total,
    byCategoryMinor: Object.fromEntries([...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))),
    outcomeCount: new Set(inWindow.map((row) => row.outcomeId)).size,
    eventCount: inWindow.length,
    blockerCodes: [],
    diagnostics,
  }
}
