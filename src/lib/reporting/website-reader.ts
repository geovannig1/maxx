import 'server-only'
import { BetaAnalyticsDataClient } from '@google-analytics/data'
import type { ReportSection, ReportingContext, WebsiteMetadata, WebsiteReport } from './contracts'
import {
  buildWebsiteReport,
  assertWebsiteJourneyTuples,
  type WebsiteCoverage,
  type WebsiteEventValue,
  type WebsiteJourneyValue,
  type WebsiteTotals,
} from './website-metrics'
import { websiteEventGroups, websiteEventQueryNames } from './website-event-groups'

const PAGE_SIZE = 10_000
const EVENT_INVENTORY_CONTROL = 'page_view'
const TRAFFIC_METRICS = ['sessions', 'engagedSessions', 'engagementRate', 'totalUsers', 'screenPageViews'] as const

interface Ga4Client {
  runReport(request: Record<string, unknown>): Promise<unknown>
}

interface Ga4Metadata {
  timeZone?: unknown
  currencyCode?: unknown
  subjectToThresholding?: unknown
  dataLossFromOtherRow?: unknown
  samplingMetadatas?: unknown
}

interface Ga4Row {
  dimensionValues?: Array<{ value?: unknown } | null> | null
  metricValues?: Array<{ value?: unknown } | null> | null
}

interface Ga4Response {
  rows?: Ga4Row[] | null
  rowCount?: unknown
  metadata?: Ga4Metadata | null
}

interface PageResult<T> {
  rows: T[]
  returnedRows: number
  totalRows: number | null
  metadata: Ga4Metadata | null
  metadatas: Array<Ga4Metadata | null>
  issues: string[]
}

function unwrapResponse(value: unknown): Ga4Response {
  const response = Array.isArray(value) ? value[0] : null
  return response && typeof response === 'object' ? response as Ga4Response : {}
}

function dimension(row: Ga4Row, index: number): string {
  const value = row.dimensionValues?.[index]?.value
  if (typeof value !== 'string' || !value.length) throw new Error('ga4_invalid_dimension')
  return value
}

function metric(row: Ga4Row, index: number, key: string, issues: string[]): number | null {
  const raw = row.metricValues?.[index]?.value
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    issues.push(`ga4_invalid_metric:${key}`)
    return null
  }
  const value = typeof raw === 'number' ? raw : raw.trim() === '' ? Number.NaN : Number(raw)
  const validRate = key !== 'engagementRate' || (value >= 0 && value <= 1)
  if (!Number.isFinite(value) || value < 0 || !validRate || (key !== 'engagementRate' && !Number.isInteger(value))) {
    issues.push(`ga4_invalid_metric:${key}`)
    return null
  }
  return value
}

function rowCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

async function readPaged<T>(
  client: Ga4Client,
  request: Record<string, unknown>,
  parse: (row: Ga4Row, issues: string[]) => T,
  label: string,
): Promise<PageResult<T>> {
  const rows: T[] = []
  const issues: string[] = []
  let offset = 0
  let totalRows: number | null = null
  let metadata: Ga4Metadata | null = null
  const metadatas: Array<Ga4Metadata | null> = []
  const seenDimensionKeys = new Set<string>()
  for (;;) {
    const response = unwrapResponse(await client.runReport({ ...request, limit: PAGE_SIZE, offset }))
    if (metadata === null) metadata = response.metadata ?? null
    metadatas.push(response.metadata ?? null)
    const page = response.rows ?? []
    const reported = rowCount(response.rowCount)
    if (reported === null) issues.push(`ga4_${label}_row_count_unknown`)
    else if (totalRows === null) totalRows = reported
    else if (reported !== totalRows) {
      issues.push(`ga4_${label}_row_count_changed`)
      totalRows = null
    }
    for (const value of page) {
      const key = JSON.stringify(value.dimensionValues?.map(item => item?.value ?? null) ?? [])
      if (seenDimensionKeys.has(key)) throw new Error(`ga4_duplicate_dimension_row:${label}`)
      seenDimensionKeys.add(key)
      rows.push(parse(value, issues))
    }
    offset += page.length
    if (totalRows === null || offset >= totalRows) break
    if (page.length === 0) {
      issues.push(`ga4_${label}_truncated:${offset}_of_${totalRows}`)
      break
    }
  }
  if (totalRows !== null && rows.length < totalRows && !issues.some(issue => issue.includes('truncated'))) {
    issues.push(`ga4_${label}_truncated:${rows.length}_of_${totalRows}`)
  }
  if (totalRows !== null && rows.length > totalRows) {
    issues.push(`ga4_${label}_row_count_underreported`)
    totalRows = null
  }
  return { rows, returnedRows: rows.length, totalRows, metadata, metadatas, issues }
}

function clientFromEnvironment(): { client: Ga4Client | null; propertyId: string | null; reason: string | null } {
  const propertyId = process.env.GA4_PROPERTY_ID?.trim() || null
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON
  if (!propertyId || !raw) return { client: null, propertyId, reason: 'ga4_not_configured' }
  try {
    const credentials = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown }
    if (typeof credentials.client_email !== 'string' || typeof credentials.private_key !== 'string') {
      return { client: null, propertyId, reason: 'ga4_credentials_invalid' }
    }
    return {
      client: new BetaAnalyticsDataClient({
        credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
      }) as Ga4Client,
      propertyId,
      reason: null,
    }
  } catch {
    return { client: null, propertyId, reason: 'ga4_credentials_invalid' }
  }
}

async function readTotals(
  client: Ga4Client,
  property: string,
  range: { from: string; to: string },
): Promise<{ totals: WebsiteTotals; metadata: Ga4Metadata | null; issues: string[] }> {
  const response = unwrapResponse(await client.runReport({
    property,
    dateRanges: [{ startDate: range.from, endDate: range.to }],
    metrics: TRAFFIC_METRICS.map(name => ({ name })),
    limit: 1,
  }))
  const issues: string[] = []
  const row = response.rows?.[0]
  if (!row) {
    issues.push('ga4_totals_row_missing')
    return {
      totals: { sessions: null, engagedSessions: null, engagementRate: null, users: null, pageViews: null },
      metadata: response.metadata ?? null,
      issues,
    }
  }
  return {
    totals: {
      sessions: metric(row, 0, 'sessions', issues),
      engagedSessions: metric(row, 1, 'engagedSessions', issues),
      engagementRate: metric(row, 2, 'engagementRate', issues),
      users: metric(row, 3, 'totalUsers', issues),
      pageViews: metric(row, 4, 'screenPageViews', issues),
    },
    metadata: response.metadata ?? null,
    issues,
  }
}

function textMetadata(metadata: Ga4Metadata | null, key: 'timeZone' | 'currencyCode'): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableFlag(metadata: Ga4Metadata | null, key: 'subjectToThresholding' | 'dataLossFromOtherRow') {
  const value = metadata?.[key]
  return typeof value === 'boolean' ? value : null
}

function sampled(metadata: Ga4Metadata | null): boolean | null {
  if (!metadata || !Array.isArray(metadata.samplingMetadatas)) return null
  return metadata.samplingMetadatas.length > 0
}

function mergedFlag(values: Array<boolean | null>): boolean | null {
  if (values.includes(true)) return true
  return values.some(value => value === false) ? false : null
}

function pageCoverage<T>(page: PageResult<T>): WebsiteCoverage {
  if (page.totalRows === null) return { state: 'unknown', numerator: null, denominator: null }
  const lossy = page.metadatas.some(metadata =>
    nullableFlag(metadata, 'dataLossFromOtherRow') === true
      || nullableFlag(metadata, 'subjectToThresholding') === true
      || sampled(metadata) === true)
  if (lossy) return { state: 'partial', numerator: null, denominator: null }
  if (page.issues.length > 0) {
    return { state: 'partial', numerator: page.returnedRows, denominator: page.totalRows }
  }
  return {
    state: page.returnedRows === page.totalRows ? 'complete' : 'partial',
    numerator: page.returnedRows,
    denominator: page.totalRows,
  }
}

function totalsCoverage(metadata: Ga4Metadata | null): WebsiteCoverage {
  if (!metadata) return { state: 'unknown', numerator: null, denominator: null }
  const lossy = nullableFlag(metadata, 'dataLossFromOtherRow') === true
    || nullableFlag(metadata, 'subjectToThresholding') === true
    || sampled(metadata) === true
  return lossy
    ? { state: 'partial', numerator: null, denominator: null }
    : { state: 'complete', numerator: 1, denominator: 1 }
}

function eventInventory(page: PageResult<WebsiteEventValue>, names: readonly string[]) {
  const coverage = pageCoverage(page)
  const controlPresent = page.rows.some(
    row => row.name === EVENT_INVENTORY_CONTROL && row.eventCount !== null && row.eventCount > 0,
  )
  return {
    // The control is reported only when a card also counts it.
    rows: page.rows.filter(row => row.name !== EVENT_INVENTORY_CONTROL || names.includes(EVENT_INVENTORY_CONTROL)),
    coverage,
    absenceProven: coverage.state === 'complete' && controlPresent,
  }
}

function summaryEventEvidenceMissing(inventory: ReturnType<typeof eventInventory>, names: readonly string[]): boolean {
  if (inventory.absenceProven) return false
  const observed = new Set(inventory.rows.map(row => row.name))
  return names.some(name => !observed.has(name))
}

function combineMetadata(
  context: ReportingContext,
  sources: Array<Ga4Metadata | null>,
  journey: PageResult<WebsiteJourneyValue>,
  events: PageResult<WebsiteEventValue>,
  issues: string[],
): WebsiteMetadata {
  const timezones = [...new Set(sources.map(source => textMetadata(source, 'timeZone')).filter(
    (value): value is string => value !== null,
  ))]
  const currencies = [...new Set(sources.map(source => textMetadata(source, 'currencyCode')).filter(
    (value): value is string => value !== null,
  ))]
  const timezone = timezones[0] ?? null
  const currency = currencies[0] ?? null
  if (sources.some(source => textMetadata(source, 'timeZone') === null)) issues.push('ga4_timezone_unknown')
  if (sources.some(source => textMetadata(source, 'currencyCode') === null)) issues.push('ga4_currency_unknown')
  if (timezone !== null && timezone !== context.timezone) issues.push(`ga4_timezone_mismatch:${timezone}`)
  if (currency !== null && currency !== context.currency) issues.push(`ga4_currency_mismatch:${currency}`)
  for (const value of timezones.filter(value => value !== context.timezone)) {
    issues.push(`ga4_timezone_mismatch:${value}`)
  }
  for (const value of currencies.filter(value => value !== context.currency)) {
    issues.push(`ga4_currency_mismatch:${value}`)
  }
  const subjectToThresholding = mergedFlag(sources.map(source => nullableFlag(source, 'subjectToThresholding')))
  const dataLossFromOtherRow = mergedFlag(sources.map(source => nullableFlag(source, 'dataLossFromOtherRow')))
  const isSampled = mergedFlag(sources.map(source => sampled(source)))
  if (subjectToThresholding === true) issues.push('ga4_subject_to_thresholding')
  if (dataLossFromOtherRow === true) issues.push('ga4_data_loss_from_other_row')
  if (isSampled === true) issues.push('ga4_sampled')
  return {
    timezone,
    currency,
    subjectToThresholding,
    dataLossFromOtherRow,
    sampled: isSampled,
    returnedRows: journey.returnedRows + events.returnedRows,
    totalRows: journey.totalRows === null || events.totalRows === null
      ? null
      : journey.totalRows + events.totalRows,
  }
}

function readJourney(client: Ga4Client, property: string, range: ReportingContext['range'], label: string) {
  const dimensions = ['landingPage', 'deviceCategory', 'sessionDefaultChannelGroup']
  return readPaged(client, {
    property, dateRanges: [{ startDate: range.from, endDate: range.to }],
    dimensions: dimensions.map(name => ({ name })), metrics: TRAFFIC_METRICS.map(name => ({ name })),
    orderBys: dimensions.map(dimensionName => ({ dimension: { dimensionName } })),
  }, (row, issues) => ({
    landingPage: dimension(row, 0), device: dimension(row, 1), channel: dimension(row, 2),
    sessions: metric(row, 0, 'sessions', issues), engagedSessions: metric(row, 1, 'engagedSessions', issues),
    engagementRate: metric(row, 2, 'engagementRate', issues), users: metric(row, 3, 'totalUsers', issues),
    pageViews: metric(row, 4, 'screenPageViews', issues),
  }), label)
}

function readEvents(
  client: Ga4Client, property: string, range: ReportingContext['range'], label: string, names: readonly string[],
) {
  const dimensions = ['eventName', 'deviceCategory', 'sessionDefaultChannelGroup']
  return readPaged(client, {
    property, dateRanges: [{ startDate: range.from, endDate: range.to }],
    dimensions: dimensions.map(name => ({ name })), metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [...new Set([...names, EVENT_INVENTORY_CONTROL])], caseSensitive: true } } },
    orderBys: dimensions.map(dimensionName => ({ dimension: { dimensionName } })),
  }, (row, issues) => ({ name: dimension(row, 0), device: dimension(row, 1), channel: dimension(row, 2),
    eventCount: metric(row, 0, 'eventCount', issues),
  }), label)
}

async function readComparison<T extends { issues: string[] }>(
  context: ReportingContext, label: string, read: () => Promise<T>,
  metadataOf: (result: T) => Array<Ga4Metadata | null>, issues: string[],
): Promise<T | null> {
  const prefix = `ga4_comparison_${label}`
  try {
    const result = await read()
    const sources = metadataOf(result)
    const invalidTimezone = sources.some(source => textMetadata(source, 'timeZone') !== context.timezone)
    if (invalidTimezone) {
      issues.push(`${prefix}_timezone_unavailable`)
      return null
    }
    issues.push(...result.issues.map(issue => `${prefix}:${issue}`))
    if (sources.some(source => sampled(source) === true)) issues.push(`${prefix}_sampled`)
    if (sources.some(source => nullableFlag(source, 'subjectToThresholding') === true)) issues.push(`${prefix}_subject_to_thresholding`)
    if (sources.some(source => nullableFlag(source, 'dataLossFromOtherRow') === true)) issues.push(`${prefix}_data_loss_from_other_row`)
    if (sources.some(source => textMetadata(source, 'currencyCode') !== context.currency)) issues.push(`${prefix}_currency_unverified`)
    return result
  } catch {
    issues.push(`${prefix}_read_failed`)
    return null
  }
}

export async function readWebsiteReport(
  context: ReportingContext,
): Promise<ReportSection<WebsiteReport>> {
  const configured = clientFromEnvironment()
  if (!configured.client || !configured.propertyId) {
    return { state: 'unavailable', data: null, asOf: null, notes: [configured.reason ?? 'ga4_not_configured'] }
  }
  const property = `properties/${configured.propertyId}`
  const eventGroups = websiteEventGroups(process.env)
  const eventNames = websiteEventQueryNames(eventGroups)
  try {
    const client = configured.client
    const issues: string[] = []
    const current = await readTotals(client, property, context.range)
    const previous = await readComparison(context, 'totals', () => readTotals(client, property, context.comparison),
      result => [result.metadata], issues)
    const journey = await readJourney(client, property, context.range, 'journey')
    assertWebsiteJourneyTuples(journey.rows)
    const events = await readEvents(client, property, context.range, 'events', eventNames)
    const previousJourney = await readComparison(context, 'journey', async () => {
      const page = await readJourney(client, property, context.comparison, 'comparison_journey')
      assertWebsiteJourneyTuples(journey.rows, page.rows)
      return page
    }, result => result.metadatas, issues)
    const previousEvents = await readComparison(context, 'events', () => readEvents(client, property, context.comparison, 'comparison_events', eventNames),
      result => result.metadatas, issues)
    issues.push(...current.issues, ...journey.issues, ...events.issues)
    const metadata = combineMetadata(
      context,
      [current.metadata, ...journey.metadatas, ...events.metadatas],
      journey,
      events,
      issues,
    )
    const currentEventInventory = eventInventory(events, eventNames)
    const previousEventInventory = previousEvents ? eventInventory(previousEvents, eventNames) : null
    if (summaryEventEvidenceMissing(currentEventInventory, eventNames)) issues.push('ga4_event_inventory_uncontrolled')
    if (previousEventInventory && summaryEventEvidenceMissing(previousEventInventory, eventNames)) issues.push('ga4_comparison_event_inventory_uncontrolled')
    const uniqueIssues = [...new Set(issues)]
    if (uniqueIssues.some(issue => issue === 'ga4_timezone_unknown' || issue.startsWith('ga4_timezone_mismatch:'))) {
      return { state: 'unavailable', data: null, asOf: null, notes: uniqueIssues }
    }
    const built = buildWebsiteReport(context, {
      currentTotals: current.totals,
      previousTotals: previous?.totals ?? null,
      currentTotalsCoverage: totalsCoverage(current.metadata),
      previousTotalsCoverage: previous ? totalsCoverage(previous.metadata) : undefined,
      rows: journey.rows,
      previousRows: previousJourney?.rows,
      events: currentEventInventory.rows,
      previousEvents: previousEventInventory?.rows,
      eventAbsenceProven: currentEventInventory.absenceProven,
      previousEventAbsenceProven: previousEventInventory?.absenceProven,
      journeyCoverage: pageCoverage(journey),
      previousJourneyCoverage: previousJourney ? pageCoverage(previousJourney) : undefined,
      eventCoverage: currentEventInventory.coverage,
      previousEventCoverage: previousEventInventory?.coverage,
      metadata,
      issues,
      eventGroups,
    })
    return {
      state: built.issues.length > 0 ? 'partial' : 'available',
      data: built.report,
      asOf: context.asOf,
      notes: built.issues,
    }
  } catch {
    return { state: 'unavailable', data: null, asOf: null, notes: ['ga4_reporting_read_failed'] }
  }
}
