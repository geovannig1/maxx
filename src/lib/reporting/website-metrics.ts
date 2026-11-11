import type {
  ReportMetricMap, ReportingContext, WebsiteEventRow, WebsiteMetadata, WebsiteReport, WebsiteRow,
} from './contracts'
import { makeReportMetric } from './claims'
import { websiteEventKey, websiteRowKey } from './website-identity'
import { websiteEventGroups, type WebsiteEventGroup } from './website-event-groups'

export interface WebsiteTotals {
  sessions: number | null
  engagedSessions: number | null
  engagementRate: number | null
  users: number | null
  pageViews: number | null
}

export interface WebsiteJourneyValue extends WebsiteTotals {
  landingPage: string
  device: string
  channel: string
}

export interface WebsiteEventValue {
  name: string
  device: string
  channel: string
  eventCount: number | null
}

export interface WebsiteCoverage {
  state: 'complete' | 'partial' | 'unknown'
  numerator: number | null
  denominator: number | null
}

export interface BuildWebsiteReportInput {
  currentTotals: WebsiteTotals
  previousTotals: WebsiteTotals | null
  currentTotalsCoverage?: WebsiteCoverage
  previousTotalsCoverage?: WebsiteCoverage
  rows: WebsiteJourneyValue[]
  previousRows?: WebsiteJourneyValue[]
  events: WebsiteEventValue[]
  previousEvents?: WebsiteEventValue[]
  eventAbsenceProven?: boolean
  previousEventAbsenceProven?: boolean
  journeyCoverage?: WebsiteCoverage
  previousJourneyCoverage?: WebsiteCoverage
  eventCoverage?: WebsiteCoverage
  previousEventCoverage?: WebsiteCoverage
  metadata: WebsiteMetadata
  issues?: string[]
  /** The configured event cards; defaults to the GA4-recommended groups when omitted. */
  eventGroups?: readonly WebsiteEventGroup[]
}

const SOURCE_DESCRIPTION =
  'GA4 web telemetry by landing page, device category and session default channel group. Event counts are browser events, not users, sessions or business outcomes.'

const complete = { state: 'complete' as const, numerator: 1, denominator: 1 }
const unknown = { state: 'unknown' as const, numerator: null, denominator: null }
const missingTotals: WebsiteTotals = { sessions: null, engagedSessions: null, engagementRate: null, users: null, pageViews: null }

function validNumber(value: number | null, rate = false): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && (rate ? value <= 1 : Number.isInteger(value)) ? value : null
}

function validTotals(value: WebsiteTotals): WebsiteTotals {
  return { sessions: validNumber(value.sessions), engagedSessions: validNumber(value.engagedSessions),
    engagementRate: validNumber(value.engagementRate, true), users: validNumber(value.users), pageViews: validNumber(value.pageViews) }
}

function valueCoverage(value: number | null, supplied?: WebsiteCoverage) {
  return value === null ? unknown : supplied ?? complete
}

function percent(value: number | null): number | null {
  return value === null ? null : value * 100
}

function trafficMetrics(
  context: ReportingContext,
  currentValue: WebsiteTotals,
  previousValue?: WebsiteTotals,
  entityId: string = context.account.id,
  suppliedCoverage?: WebsiteCoverage,
  previousSuppliedCoverage?: WebsiteCoverage,
): ReportMetricMap {
  const current = validTotals(currentValue)
  const previous = previousValue === undefined ? undefined : validTotals(previousValue)
  const common = {
    context,
    source: 'ga4' as const,
    entity: { level: 'account' as const, id: entityId.slice(0, 160) },
  }
  const prior = (value: number | null): number | null | undefined => previous === undefined ? undefined : value
  return {
    sessions: makeReportMetric({
      ...common, key: 'sessions', label: 'Sessions', unit: 'count',
      definition: 'GA4 sessions for the requested period.', current: current.sessions,
      previous: prior(previous?.sessions ?? null), coverage: valueCoverage(current.sessions, suppliedCoverage),
      previousCoverage: previous ? valueCoverage(previous.sessions, previousSuppliedCoverage) : undefined,
      reason: 'GA4 did not return a valid sessions total.', previousReason: 'GA4 did not return a valid comparison sessions total.',
    }),
    engaged_sessions: makeReportMetric({
      ...common, key: 'engaged_sessions', label: 'Engaged sessions', unit: 'count',
      definition: 'GA4 engagedSessions for the requested period.', current: current.engagedSessions,
      previous: prior(previous?.engagedSessions ?? null), coverage: valueCoverage(current.engagedSessions, suppliedCoverage),
      previousCoverage: previous ? valueCoverage(previous.engagedSessions, previousSuppliedCoverage) : undefined,
      reason: 'GA4 did not return a valid engagedSessions total.',
    }),
    engagement_rate: makeReportMetric({
      ...common, key: 'engagement_rate', label: 'Engagement rate', unit: 'percent',
      definition: 'Native GA4 engagementRate for the whole requested period, multiplied by 100; row rates are not averaged or summed.',
      current: percent(current.engagementRate), previous: prior(percent(previous?.engagementRate ?? null)),
      coverage: valueCoverage(current.engagementRate, suppliedCoverage),
      previousCoverage: previous ? valueCoverage(previous.engagementRate, previousSuppliedCoverage) : undefined,
      reason: 'GA4 did not return a valid native engagementRate total.',
    }),
    users: makeReportMetric({
      ...common, key: 'users', label: 'Users', unit: 'count',
      definition: 'Native GA4 totalUsers for the whole requested period; row user counts are not summed.',
      current: current.users, previous: prior(previous?.users ?? null), coverage: valueCoverage(current.users, suppliedCoverage),
      previousCoverage: previous ? valueCoverage(previous.users, previousSuppliedCoverage) : undefined,
      reason: 'GA4 did not return a valid totalUsers total.',
    }),
    page_views: makeReportMetric({
      ...common, key: 'page_views', label: 'Page views', unit: 'count',
      definition: 'GA4 screenPageViews for the requested period.', current: current.pageViews,
      previous: prior(previous?.pageViews ?? null), coverage: valueCoverage(current.pageViews, suppliedCoverage),
      previousCoverage: previous ? valueCoverage(previous.pageViews, previousSuppliedCoverage) : undefined,
      reason: 'GA4 did not return a valid screenPageViews total.',
    }),
  }
}

function eventTotal(
  events: WebsiteEventValue[],
  names: ReadonlySet<string>,
  absenceProven: boolean,
): number | null {
  const relevant = events.filter(event => names.has(event.name))
  if (relevant.some(event => validNumber(event.eventCount) === null)) return null
  const observedNames = new Set(relevant.map(event => event.name))
  if (!absenceProven && [...names].some(name => !observedNames.has(name))) return null
  return validNumber(relevant.reduce((sum, event) => sum + (event.eventCount ?? 0), 0))
}

function eventGroupMetric(
  context: ReportingContext,
  group: WebsiteEventGroup,
  events: WebsiteEventValue[],
  previousEvents: WebsiteEventValue[] | undefined,
  coverage: { current?: WebsiteCoverage; previous?: WebsiteCoverage },
  absenceProven: { current: boolean; previous: boolean },
) {
  const common = { context, source: 'ga4' as const, unit: 'count' as const, key: group.key, label: group.label }
  if (group.invalid) {
    const reason = `${group.variable} is not a valid GA4 event name list, so ${group.label} are unavailable.`
    return makeReportMetric({ ...common, event: null,
      definition: `GA4 eventCount for the events named by ${group.variable}, which is not configured with valid GA4 event names.`,
      current: null, previous: previousEvents ? null : undefined, coverage: unknown,
      previousCoverage: previousEvents ? unknown : undefined, reason, previousReason: reason })
  }
  const names = new Set(group.names)
  const listed = group.names.join(group.names.length > 2 ? ', ' : ' and ')
  const current = eventTotal(events, names, absenceProven.current)
  const previous = previousEvents ? eventTotal(previousEvents, names, absenceProven.previous) : undefined
  return makeReportMetric({
    ...common, event: group.names.join(' + '),
    definition: group.names.length === 1
      ? `GA4 eventCount for ${listed} (${group.variable}). This browser telemetry is not a session, user or recorded outcome count.`
      : `Sum of GA4 eventCount for ${listed} (${group.variable}). Events may occur in the same user journey and are not deduplicated people, submissions or recorded outcomes.`,
    current, previous, coverage: valueCoverage(current, coverage.current),
    previousCoverage: previous === undefined ? undefined : valueCoverage(previous, coverage.previous),
    reason: `GA4 did not return a valid eventCount for ${listed}.`,
  })
}

function eventSummaryMetrics(
  context: ReportingContext,
  groups: readonly WebsiteEventGroup[],
  events: WebsiteEventValue[],
  previousEvents?: WebsiteEventValue[],
  eventCoverage?: WebsiteCoverage,
  previousEventCoverage?: WebsiteCoverage,
  eventAbsenceProven: boolean = false,
  previousEventAbsenceProven: boolean = false,
): ReportMetricMap {
  return Object.fromEntries(groups.map(group => [group.key, eventGroupMetric(context, group, events, previousEvents,
    { current: eventCoverage, previous: previousEventCoverage },
    { current: eventAbsenceProven, previous: previousEventAbsenceProven })]))
}

export function stripLandingPageQuery(value: string): string {
  if (!value || value.startsWith('(')) return value || '(unknown)'
  try {
    const parsed = new URL(value, 'https://report.invalid')
    return parsed.pathname || '/'
  } catch {
    return value.split(/[?#]/, 1)[0] || '/'
  }
}

function requireDimensions(values: unknown[]): void {
  if (values.some(value => typeof value !== 'string' || !value.length)) throw new Error('ga4_invalid_dimension')
}

function journeyIndex(rows: WebsiteJourneyValue[], nativeKeys: Map<string, string>): Map<string, WebsiteJourneyValue> {
  const indexed = new Map<string, WebsiteJourneyValue>()
  for (const row of rows) {
    requireDimensions([row.landingPage, row.device, row.channel])
    const sanitized = { ...row, landingPage: stripLandingPageQuery(row.landingPage) }
    const key = websiteRowKey(sanitized)
    const nativeKey = websiteRowKey(row)
    if (indexed.has(key)) throw new Error('ga4_duplicate_journey_tuple')
    if (nativeKeys.has(key) && nativeKeys.get(key) !== nativeKey) throw new Error('ga4_ambiguous_journey_tuple')
    nativeKeys.set(key, nativeKey)
    indexed.set(key, sanitized)
  }
  return indexed
}

export function assertWebsiteJourneyTuples(rows: WebsiteJourneyValue[], previousRows: WebsiteJourneyValue[] = []): void {
  const nativeKeys = new Map<string, string>()
  journeyIndex(rows, nativeKeys)
  journeyIndex(previousRows, nativeKeys)
}

function journeyRows(context: ReportingContext, input: BuildWebsiteReportInput): WebsiteRow[] {
  const nativeKeys = new Map<string, string>()
  const current = journeyIndex(input.rows, nativeKeys)
  const previous = journeyIndex(input.previousRows ?? [], nativeKeys)
  return [...new Set([...current.keys(), ...previous.keys()])].sort().map((id, index) => {
    const row = current.get(id) ?? previous.get(id)!
    return { id, landingPage: row.landingPage, device: row.device, channel: row.channel,
      metrics: trafficMetrics(context, current.get(id) ?? missingTotals,
        input.previousRows === undefined ? undefined : previous.get(id) ?? missingTotals,
        `${context.account.id}:journey:${index}`, input.journeyCoverage, input.previousJourneyCoverage),
    }
  })
}

function eventIndex(events: WebsiteEventValue[]): Map<string, WebsiteEventValue> {
  const indexed = new Map<string, WebsiteEventValue>()
  for (const event of events) {
    requireDimensions([event.name, event.device, event.channel])
    const key = websiteEventKey(event)
    if (indexed.has(key)) throw new Error('ga4_duplicate_event_tuple')
    indexed.set(key, event)
  }
  return indexed
}

function eventRows(context: ReportingContext, input: BuildWebsiteReportInput): WebsiteEventRow[] {
  const current = eventIndex(input.events)
  const previous = eventIndex(input.previousEvents ?? [])
  return [...new Set([...current.keys(), ...previous.keys()])].sort().map((id, index) => {
    const event = current.get(id) ?? previous.get(id)!
    const value = validNumber(current.get(id)?.eventCount ?? null)
    const prior = input.previousEvents === undefined ? undefined : validNumber(previous.get(id)?.eventCount ?? null)
    return { name: event.name, device: event.device, channel: event.channel, metrics: {
      event_count: makeReportMetric({
        context, source: 'ga4', key: 'event_count', label: 'Event count', unit: 'count', event: event.name,
        entity: { level: 'account', id: `${context.account.id}:event:${index}`.slice(0, 160) },
        definition: `GA4 eventCount for ${event.name}; distinct from sessions, users and business outcomes.`,
        current: value, previous: prior, coverage: valueCoverage(value, input.eventCoverage),
        previousCoverage: prior === undefined ? undefined : valueCoverage(prior, input.previousEventCoverage),
        reason: `GA4 did not return a valid eventCount for ${event.name}.`,
        previousReason: `GA4 did not return a valid comparison eventCount for ${event.name}.`,
      }),
    } }
  })
}

export function buildWebsiteReport(
  context: ReportingContext,
  input: BuildWebsiteReportInput,
): { report: WebsiteReport; issues: string[] } {
  const groups = input.eventGroups ?? websiteEventGroups({})
  const configIssues = groups.filter(group => group.invalid).map(group => `ga4_event_config_invalid:${group.variable}`)
  return {
    report: {
      metrics: {
        ...trafficMetrics(
          context,
          input.currentTotals,
          input.previousTotals ?? undefined,
          context.account.id,
          input.currentTotalsCoverage,
          input.previousTotalsCoverage,
        ),
        ...eventSummaryMetrics(
          context,
          groups,
          input.events,
          input.previousEvents,
          input.eventCoverage,
          input.previousEventCoverage,
          input.eventAbsenceProven,
          input.previousEventAbsenceProven,
        ),
      },
      rows: journeyRows(context, input),
      events: eventRows(context, input),
      metadata: input.metadata,
      sourceDescription: SOURCE_DESCRIPTION,
    },
    issues: [...new Set([...input.issues ?? [], ...configIssues])],
  }
}
