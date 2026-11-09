import type { MetricClaim } from '@/lib/cockpit/contracts'
import { classifyWindowSettle } from '@/lib/insights/settle-window'
import { canonicalConversion } from '@/lib/conversions/labels'
import { readAppointmentConfirmedResult, readBookingValue } from '@/lib/sync/insight-outcomes'
import type { MetaInsightRow } from '@/types/meta-api'
import { COMPLETE_FIELD_COVERAGE, makeReportMetric, UNKNOWN_FIELD_COVERAGE } from './claims'
import type { ReportMetricMap, ReportingContext } from './contracts'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS, metaNativeMetricDescription, type MetaNativeDefinition } from './meta-metric-definitions'

export type MetaRow = Record<string, unknown>

export function metaNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  if (typeof raw === 'string' && !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function validActions(raw: unknown): raw is Array<{ action_type: string; value: string }> {
  if (!Array.isArray(raw)) return false
  const types = raw.map(entry => entry?.action_type)
  return raw.every(entry => entry && typeof entry.action_type === 'string' && metaNumber(entry.value) !== null)
    && new Set(types).size === types.length
}

function actionValue(raw: unknown, matches: (type: string) => boolean): number | null {
  if (!validActions(raw)) return null
  const values = raw.filter(entry => matches(entry.action_type)).map(entry => Number(entry.value))
  return values.length ? Math.max(...values) : null
}

function appointmentResult(row: MetaRow) {
  if (!Array.isArray(row.results)) return null
  const indicators = row.results.map(entry => entry?.indicator)
  if (indicators.some(value => typeof value !== 'string') || new Set(indicators).size !== indicators.length) return null
  for (const entry of row.results) {
    if (entry.values === undefined || entry.values === null) continue
    if (!Array.isArray(entry.values) || entry.values.some((value: { value?: unknown; attribution_windows?: unknown }) =>
      metaNumber(value?.value) === null || !Array.isArray(value?.attribution_windows)
      || value.attribution_windows.some(window => typeof window !== 'string'))) return null
    const windows = entry.values.flatMap((value: { attribution_windows: string[] }) => value.attribution_windows)
    if (new Set(windows).size !== windows.length) return null
  }
  const result = readAppointmentConfirmedResult(row.results as MetaInsightRow['results'])
  return result.valid && result.matched && Number.isInteger(result.value) ? result : null
}

function appointmentValue(row: MetaRow): number | null {
  for (const key of ['conversion_values', 'action_values']) {
    if (row[key] !== undefined && !validActions(row[key])) return null
  }
  const value = readBookingValue(row.action_values as MetaInsightRow['action_values'], undefined, row.conversion_values as MetaInsightRow['conversion_values'])
  return value.matched && value.valid ? value.value : null
}



function read(row: MetaRow | null, definition: MetaNativeDefinition): number | null {
  if (!row) return null
  const { key, field, action, unit } = definition
  let value: number | null
  if (key === 'bookings') value = appointmentResult(row)?.value ?? null
  else if (key === 'bookings_click' || key === 'bookings_view') {
    const result = appointmentResult(row)
    value = result?.splitComplete ? (key === 'bookings_click' ? result.clickBookings : result.viewBookings) : null
  } else if (key === 'appointment_value') value = appointmentValue(row)
  else if (key === 'purchase_count' || key === 'purchase_value') {
    value = actionValue(row[key === 'purchase_count' ? 'actions' : 'action_values'], type => canonicalConversion(type)?.key === 'purchase')
  } else value = action ? actionValue(row[field!], type => type === action) : metaNumber(row[field!])
  return unit === 'count' && value !== null && !Number.isInteger(value) ? null : value
}

// One formatter per timezone: every metric of every daily point asks for the same account day.
const accountDayFormatters = new Map<string, Intl.DateTimeFormat>()
function accountDay(timezone: string, asOf: string): string {
  let formatter = accountDayFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    accountDayFormatters.set(timezone, formatter)
  }
  return formatter.format(new Date(asOf))
}

function maturityFor(context: ReportingContext, prior: boolean, spend: boolean): MetricClaim['maturity'] {
  const range = prior ? context.comparison : context.range
  const today = accountDay(context.timezone, context.asOf)
  const settle = classifyWindowSettle({ ...range, today })
  if (settle.includes_today) return { state: 'partial', matureThrough: null }
  return spend ? { state: 'settled', matureThrough: range.to } : { state: settle.state, matureThrough: settle.settled_through }
}

const coverage = (value: number | null) => value === null ? UNKNOWN_FIELD_COVERAGE : COMPLETE_FIELD_COVERAGE

/** Ratio inputs are native measures, so a requested subset plus its ratio inputs is self-contained. */
function requestedMetricKeys(keys: readonly string[] | undefined) {
  if (!keys) return { native: () => true, ratio: () => true }
  const ratios = new Set(META_RATIO_METRIC_DEFINITIONS.filter(([key]) => keys.includes(key)).map(([key]) => key))
  const natives = new Set([...keys, ...META_RATIO_METRIC_DEFINITIONS.filter(([key]) => ratios.has(key)).flatMap(([, , numerator, denominator]) => [numerator, denominator])])
  return { native: (key: string) => natives.has(key), ratio: (key: string) => ratios.has(key) }
}

/** `keys` builds only those measures and their inputs: exactly the map `selectMetaMetrics` would keep. */
export function buildMetaMetrics(
  context: ReportingContext, current: MetaRow | null, previous?: MetaRow | null,
  entity: MetricClaim['entity'] = { level: 'account', id: context.account.id }, keys?: readonly string[],
): ReportMetricMap {
  const requested = requestedMetricKeys(keys)
  // Maturity depends only on the period, the account day and whether the measure is spend.
  const maturity = { current: maturityFor(context, false, false), previous: maturityFor(context, true, false),
    currentSpend: maturityFor(context, false, true), previousSpend: maturityFor(context, true, true) }
  const metrics = Object.fromEntries(META_NATIVE_METRIC_DEFINITIONS.filter(definition => requested.native(definition.key)).map(definition => {
    const now = read(current, definition)
    const prior = previous === undefined ? undefined : read(previous, definition)
    const note = metaNativeMetricDescription(definition)
    const spend = definition.key === 'spend'
    return [definition.key, makeReportMetric({
      context, ...definition, definition: note, source: 'meta', current: now, previous: prior, entity,
      coverage: coverage(now), previousCoverage: coverage(prior ?? null),
      maturity: spend ? maturity.currentSpend : maturity.current, previousMaturity: spend ? maturity.previousSpend : maturity.previous,
      attributionScope: definition.event || definition.action || definition.attributed ? 'meta_platform_modelled' : 'none',
      measurementKind: definition.event || definition.action || definition.attributed || ['reach', 'frequency'].includes(definition.key) ? 'modelled' : 'measured',
      basis: 'impression_date_et', freshness: { state: 'fresh', observedAt: context.asOf, maxAgeHours: 24 },
      sourceHead: `meta-live:${context.account.metaAccountId}:${context.asOf}`,
    })]
  }))
  const output: ReportMetricMap = { ...metrics }
  for (const [key, label, numerator, denominator, scale, unit] of META_RATIO_METRIC_DEFINITIONS) {
    if (!requested.ratio(key)) continue
    const calculate = (prior: boolean) => {
      const a = prior ? metrics[numerator].previous : metrics[numerator].current
      const b = prior ? metrics[denominator].previous : metrics[denominator].current
      if (a?.coverage.state !== 'complete' || b?.coverage.state !== 'complete'
        || typeof a.value !== 'number' || typeof b.value !== 'number' || b.value <= 0) return null
      if (key.startsWith('retention_') && a.value > b.value) return null
      return a.value / b.value * scale
    }
    const now = calculate(false)
    const prior = calculate(true)
    const event = metrics[numerator].event ?? metrics[denominator].event
    const attributed = [metrics[numerator], metrics[denominator]].some(metric => metric.current.attributionScope === 'meta_platform_modelled')
    output[key] = makeReportMetric({
      context, key, label, unit, event, entity, source: 'meta', current: now,
      previous: previous === undefined ? undefined : prior,
      definition: `${metrics[numerator].label} / ${metrics[denominator].label}${scale !== 1 ? ` × ${scale}` : ''}; matching Meta population and period with complete input coverage.`,
      maturity: maturity.current, previousMaturity: maturity.previous,
      coverage: coverage(now), previousCoverage: coverage(prior), inputMetrics: [metrics[numerator], metrics[denominator]],
      attributionScope: attributed ? 'meta_platform_modelled' : 'none', measurementKind: 'derived', basis: 'impression_date_et',
      freshness: { state: 'fresh', observedAt: context.asOf, maxAgeHours: 24 },
    })
  }
  return output
}

export function readMetaOutcomeValues(row: MetaRow) {
  return Object.fromEntries(META_NATIVE_METRIC_DEFINITIONS.filter(definition => definition.event).map(definition => [definition.key, read(row, definition)]))
}
