import type { ReportMetric, ReportingData, WebsiteRow, WebsiteEventRow } from '../contracts'
import { websiteRowKey, websiteRowAnchor, websiteEventKey, websiteEventAnchor } from '../website-identity'
import type { ReviewFinding, ReviewPopulationCoverage } from './contracts'
import { comparable, display, metricEvidence, numeric, reportLink, statement } from './evidence'
import { outcomeWords, withIndefiniteArticle } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Kind = 'rows' | 'events'
export type WebsiteDimension = 'landingPage' | 'device' | 'channel'
export interface WebsitePair {
  a: WebsiteRow; b: WebsiteRow; aIndex: number; bIndex: number
  varying: WebsiteDimension; sessions: number; aRate: number; bRate: number; key: string
}
const AUTHORITY = { state: 'diagnostic' as const, executable: false as const }
const DIMENSIONS = ['landingPage', 'device', 'channel'] as const

/** Raw count observations retain their source coverage; rates require complete evidence. */
function observedMetric(data: ReportingData, kind: Kind, index: number, key: string, prior = false, complete = false): ReportMetric | null {
  if (!['available', 'partial'].includes(data.website.state)) return null
  const row = data.website.data?.[kind][index], metric = row?.metrics[key]
  const claim = prior ? metric?.previous : metric?.current, value = numeric(metric, prior)
  const range = prior ? data.context.comparison : data.context.range
  const rate = key === 'engagement_rate'
  if (!row || !metric || !claim || value === null || value < 0 || (rate ? value > 100 : !Number.isSafeInteger(value))
    || metric.key !== key || metric.event !== (kind === 'events' ? (row as WebsiteEventRow).name : null)
    || claim.unit !== (rate ? 'percent' : 'count') || claim.metricKey !== `ga4.${key}`
    || claim.source.system !== 'ga4' || claim.source.role !== 'measurement_qa' || claim.source.evidencePlane !== 'ga4_telemetry'
    || claim.measurementKind !== 'telemetry' || claim.attributionScope !== 'ga4_session_classified'
    || claim.entity.level !== 'account' || claim.entity.id !== `${data.context.account.id}:${kind === 'rows' ? 'journey' : 'event'}:${index}`.slice(0, 160)
    || claim.window.start !== range.from || claim.window.end !== range.to || claim.window.timezone !== data.context.timezone
    || claim.window.basis !== 'closed_account_days' || ((complete || rate) && claim.coverage.state !== 'complete')
    || claim.freshness.state === 'stale' || claim.maturity.state === 'partial') return null
  return metric
}

/** The builder preserves native fractions as Number * 100 without decimal rounding. */
function consistentRate(data: ReportingData, index: number, prior: boolean, rate: ReportMetric): boolean {
  const sessions = numeric(observedMetric(data, 'rows', index, 'sessions', prior, true), prior)
  const engaged = numeric(observedMetric(data, 'rows', index, 'engaged_sessions', prior, true), prior)
  if (sessions === null || engaged === null || sessions <= 0 || engaged > sessions) return false
  const expected = engaged / sessions * 100, actual = numeric(rate, prior)!
  // Division and percent scaling permit machine roundoff, not an inferred source/display precision.
  return Math.abs(expected - actual) <= Number.EPSILON * Math.max(1, Math.abs(expected), Math.abs(actual))
}

/** Eligibility belongs to this metric/population/window, not merged response flags. */
export function websiteMetric(data: ReportingData, kind: Kind, index: number, key: string, prior = false): ReportMetric | null {
  const metric = observedMetric(data, kind, index, key, prior, true)
  return metric && (key !== 'engagement_rate' || consistentRate(data, index, prior, metric)) ? metric : null
}

function ref(data: ReportingData, kind: Kind, index: number, key: string) {
  const read = key === 'engagement_rate' ? websiteMetric : observedMetric
  return read(data, kind, index, key) || read(data, kind, index, key, true)
    ? metricEvidence(data, 'website', [kind, index, 'metrics', key]) : null
}
function priorMetric(data: ReportingData, kind: Kind, index: number, key: string) {
  const metric = websiteMetric(data, kind, index, key)
  return metric && websiteMetric(data, kind, index, key, true) && comparable(metric, metric, true) ? metric : null
}
export function websiteInspection(data: ReportingData, kind: Kind, row: WebsiteRow | WebsiteEventRow): string {
  const filters: Record<string, string> = kind === 'rows' ? { website_page: (row as WebsiteRow).landingPage } : { website_event: (row as WebsiteEventRow).name }
  const anchor = kind === 'rows' ? websiteRowAnchor(row as WebsiteRow) : websiteEventAnchor(row as WebsiteEventRow)
  return `${reportLink(data, '/reports', { report: 'website', ...filters, website_device: row.device, website_channel: row.channel })}#${anchor}`
}

/** Each held-dimension group is assessed. Its widest observed contrast represents its range. */
export function matchedWebsitePairs(data: ReportingData): WebsitePair[] {
  const rows = data.website.data?.rows ?? [], result: WebsitePair[] = []
  for (const varying of DIMENSIONS) {
    const held = DIMENSIONS.filter(key => key !== varying)
    const groups = new Map<string, Array<{ row: WebsiteRow; index: number; rate: number; sessions: number }>>()
    rows.forEach((row, index) => {
      const sessions = websiteMetric(data, 'rows', index, 'sessions'), rate = websiteMetric(data, 'rows', index, 'engagement_rate')
      if (!sessions || !rate || numeric(sessions)! <= 0) return
      const key = JSON.stringify([varying, ...held.map(key => row[key])])
      const members = groups.get(key) ?? []
      members.push({ row, index, rate: numeric(rate)!, sessions: numeric(sessions)! })
      groups.set(key, members)
    })
    for (const [key, members] of groups) {
      if (members.length < 2) continue
      const ordered = [...members].sort((a, b) => a.rate - b.rate || b.sessions - a.sessions || a.index - b.index)
      const low = ordered[0], high = ordered.at(-1)!
      if (low.row[varying] === high.row[varying]
        || !comparable(low.row.metrics.sessions, high.row.metrics.sessions)
        || !comparable(low.row.metrics.engagement_rate, high.row.metrics.engagement_rate)) continue
      const [a, b] = [low, high].sort((a, b) => a.index - b.index)
      result.push({ a: a.row, b: b.row, aIndex: a.index, bIndex: b.index, varying,
        sessions: a.sessions + b.sessions, aRate: a.rate, bRate: b.rate, key })
    }
  }
  return result.sort((a, b) => Number(b.aRate !== b.bRate) - Number(a.aRate !== a.bRate)
    || Math.abs(b.aRate - b.bRate) - Math.abs(a.aRate - a.bRate) || b.sessions - a.sessions || a.key.localeCompare(b.key))
}

function pageAssessment(data: ReportingData, row: WebsiteRow, index: number): ReviewFinding {
  const sessions = observedMetric(data, 'rows', index, 'sessions'), rate = websiteMetric(data, 'rows', index, 'engagement_rate')
  const engaged = observedMetric(data, 'rows', index, 'engaged_sessions')
  const priorSessions = priorMetric(data, 'rows', index, 'sessions'), priorRate = priorMetric(data, 'rows', index, 'engagement_rate')
  const refs = [ref(data, 'rows', index, 'sessions'), ref(data, 'rows', index, 'engaged_sessions'), ref(data, 'rows', index, 'engagement_rate')]
  const canCompare = priorSessions && priorRate && numeric(sessions)! > 0 && numeric(priorSessions, true)! > 0
  const difference = canCompare ? numeric(rate)! - numeric(priorRate, true)! : null
  const direction = difference === null || difference === 0 ? undefined : difference < 0 ? 'declined' as const : 'improved' as const
  const priorAvailable = observedMetric(data, 'rows', index, 'sessions', true)
  const previousRate = websiteMetric(data, 'rows', index, 'engagement_rate', true)
  const limitedCoverage = [sessions?.current, engaged?.current, priorAvailable?.previous,
    observedMetric(data, 'rows', index, 'engaged_sessions', true)?.previous]
    .some(claim => claim && claim.coverage.state !== 'complete')
  const inconsistent = [false, true].some(prior => {
    const candidate = observedMetric(data, 'rows', index, 'engagement_rate', prior, true)
    return candidate && !consistentRate(data, index, prior, candidate)
  })
  const label = `${row.landingPage} · ${row.device} · ${row.channel}`
  return {
    id: `journey.page:${websiteRowKey(row)}`, area: 'website', title: label,
    status: !refs.some(Boolean) ? 'unavailable' : direction ? 'mixed' : difference === 0 ? 'unchanged' : 'observed',
    priority: direction ? 'investigate' : 'context', direction,
    observation: statement(`${label}: ${display(sessions)} sessions, ${display(engaged)} engaged sessions and ${display(rate)} engagement rate; previously ${display(priorAvailable, true)} sessions and ${display(previousRate, true)}.${limitedCoverage ? ' Raw counts are qualified by limited source coverage; rate comparisons are withheld.' : ''}${direction ? ` Engagement rate ${direction} within this same page, device and channel.` : ''}`, ...refs),
    materiality: { ...statement(sessions ? `${display(sessions)} current sessions in this exact row. Session counts accompany the rate; a percentage change is not lost ${OW.many}.` : 'Current session exposure is unavailable; any retained prior observation stays separate.', refs[0]),
      priorityReason: 'Comparable improvements and declines are assessed across every supplied row; no minimum-spend or session cutoff removes rows.' },
    explanations: [], counterEvidence: statement(`GA4 engagement is browser-session behavior, not ${withIndefiniteArticle(OW.one)} rate. Audience mix, page content and observation changes remain possible explanations; this comparison alone does not identify a cause.`, ...refs),
    nextInspection: { question: 'Inspect this exact page/device/channel and its already-compared periods.', href: websiteInspection(data, 'rows', row), outcomes: [
      { result: 'The destination or device has a reproducible obstacle.', interpretation: 'Use that additional evidence to prepare a specific page correction.' },
      { result: 'No obstacle is established.', interpretation: 'Retain the measured comparison without attributing it to a page defect.' },
    ] }, limitations: [`Page rows do not contain ordered user journeys or joined business ${OW.one} identities.`,
      ...(limitedCoverage ? ['Source coverage is limited or unknown; retain the qualified observed counts without a rate or period comparison.'] : []),
      ...(inconsistent ? ['The native engagement rate could not be reconciled with complete sessions and engaged-session counts; the inconsistent or unsupported rate is withheld.'] : []),
      ...(difference === null ? ['A comparable current/prior engagement-rate change could not be established for this row.'] : [])],
    exposure: sessions && refs[0] ? { value: numeric(sessions)!, unit: 'sessions', evidence: [refs[0]] } : null, authority: AUTHORITY,
  }
}

/** A same-page/channel, current/prior device mix reversal; no average of native rate percentages. */
function mixFindings(data: ReportingData): ReviewFinding[] {
  const groups = new Map<string, Array<{ row: WebsiteRow; index: number }>>()
  data.website.data?.rows.forEach((row, index) => {
    const key = JSON.stringify([row.landingPage, row.channel]), members = groups.get(key) ?? []
    members.push({ row, index }); groups.set(key, members)
  })
  return [...groups].flatMap(([key, members]) => {
    if (members.length < 2 || new Set(members.map(item => item.row.device)).size !== members.length) return []
    const observations = members.map(({ row, index }) => {
      const sessions = priorMetric(data, 'rows', index, 'sessions'), engaged = priorMetric(data, 'rows', index, 'engaged_sessions')
      const rate = priorMetric(data, 'rows', index, 'engagement_rate')
      if (!sessions || !engaged || !rate) return null
      const s = numeric(sessions)!, p = numeric(sessions, true)!, e = numeric(engaged)!, q = numeric(engaged, true)!
      if (s <= 0 || p <= 0 || e > s || q > p) return null
      return { row, index, s, p, e, q, difference: e / s - q / p }
    })
    if (observations.some(item => item === null)) return []
    const valid = observations.filter(item => item !== null)
    const total = valid.reduce((a, b) => ({ s: a.s + b.s, p: a.p + b.p, e: a.e + b.e, q: a.q + b.q }), { s: 0, p: 0, e: 0, q: 0 })
    const current = total.e / total.s * 100, previous = total.q / total.p * 100
    const improved = valid.every(item => item.difference >= 0) && current < previous
    const declined = valid.every(item => item.difference <= 0) && current > previous
    if (!improved && !declined) return []
    const movement = valid.every(item => item.difference === 0) ? 'held steady'
      : improved ? valid.every(item => item.difference > 0) ? 'improved' : 'improved or held steady'
        : valid.every(item => item.difference < 0) ? 'declined' : 'declined or held steady'
    const refs = valid.flatMap(({ index }) => ['sessions', 'engaged_sessions', 'engagement_rate'].map(metric => ref(data, 'rows', index, metric)))
    const sample = valid[0].row, format = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
    return [{ id: `journey.mix:${key}`, area: 'website' as const, title: `${sample.landingPage} · device mix reverses the overall comparison`,
      status: 'mixed' as const, priority: 'investigate' as const, direction: 'mixed' as const,
      observation: statement(`${sample.landingPage} · ${sample.channel}: engagement ${movement} within every observed device, while the combined observed-row rate ${improved ? 'fell' : 'rose'} from ${format(previous)} to ${format(current)}. The device session mix shifted; the combined direction does not describe each device.`, ...refs),
      materiality: { ...statement(`${total.s} current and ${total.p} prior sessions across the complete comparable device rows supplied for this page/channel. Combined rates use summed engaged sessions divided by summed sessions.`, ...refs), priorityReason: 'A reversal changes the interpretation of an aggregate; it precedes isolated row differences.' },
      explanations: [], counterEvidence: statement('This describes the arithmetic of the supplied device rows. It does not prove a cause of the traffic shift, unique people, booked demand or paid efficiency.', ...refs),
      nextInspection: { question: 'Compare all device rows and their current/prior session mix for this page.',
        href: `${reportLink(data, '/reports', { report: 'website', website_page: sample.landingPage, website_channel: sample.channel })}#website-pages`,
        outcomes: [{ result: 'The same direction holds after a supported additional split.', interpretation: 'Retain that finer comparison; avoid blaming every device for the aggregate.' },
          { result: 'Another split reverses the result or history is incomplete.', interpretation: 'Qualify that comparison at its measured scope.' }] },
      limitations: ['These are derived totals of supplied mutually scoped session rows, not a substitute for native account user totals.'],
      exposure: null, authority: AUTHORITY,
    }]
  })
}

export function websiteEventFindings(data: ReportingData): ReviewFinding[] {
  const findings = (data.website.data?.events ?? []).map((event, index): ReviewFinding => {
    const metric = observedMetric(data, 'events', index, 'event_count'), previous = priorMetric(data, 'events', index, 'event_count')
    const priorAvailable = observedMetric(data, 'events', index, 'event_count', true), evidence = ref(data, 'events', index, 'event_count')
    const limitedCoverage = [metric?.current, priorAvailable?.previous].some(claim => claim && claim.coverage.state !== 'complete')
    const difference = previous ? numeric(metric)! - numeric(previous, true)! : null
    const direction = difference === null || difference === 0 ? undefined : difference < 0 ? 'declined' as const : 'improved' as const
    return { id: `journey.event:${websiteEventKey(event)}`, area: 'measurement', title: `${event.name} · ${event.device} · ${event.channel}`,
      status: !evidence ? 'unavailable' : direction ? 'mixed' : difference === 0 ? 'unchanged' : 'observed', priority: direction ? 'investigate' : 'context', direction,
      observation: statement(`${event.name} · ${event.device} · ${event.channel}: ${display(metric)} observed events; previously ${display(priorAvailable, true)}.${limitedCoverage ? ' Raw counts are qualified by limited source coverage; the period comparison is withheld.' : ''}${direction ? ` The same named event count ${direction}.` : ''}`, evidence),
      materiality: { ...statement('This named-event/device/channel row is assessed alongside every other supplied event row; counts are not deduplicated submissions.', evidence), priorityReason: 'A smaller named event can reveal a change that the largest event total conceals.' },
      explanations: [], counterEvidence: statement(`Event telemetry has no page identity or ordered journey in this report. An event-count movement does not establish a change in recorded ${OW.many}.`, evidence),
      nextInspection: { question: 'Inspect the named event and its already-compared device/channel periods.', href: websiteInspection(data, 'events', event),
        outcomes: [{ result: 'Independent instrumentation evidence explains the change.', interpretation: 'Separate observation changes from commercial results.' },
          { result: 'No independent explanation is established.', interpretation: 'Keep the named-event comparison and its limits visible.' }] },
      limitations: [`Event counts are not people, unique leads or recorded ${OW.many}.`,
        ...(limitedCoverage ? ['Source coverage is limited or unknown; qualified observed event counts do not establish a comparable period change.'] : [])],
      exposure: metric && evidence ? { value: numeric(metric)!, unit: 'count', evidence: [evidence] } : null, authority: AUTHORITY }
  }).sort((a, b) => Number(b.priority === 'investigate') - Number(a.priority === 'investigate') || (b.exposure?.value ?? -1) - (a.exposure?.value ?? -1))
  return findings.map((finding, index) => index === 0 ? { ...finding, id: 'journey.ga4.event_telemetry' } : finding)
}

export function websitePopulationReview(data: ReportingData): { findings: ReviewFinding[]; coverage: ReviewPopulationCoverage[] } {
  const rows = data.website.data?.rows ?? [], events = data.website.data?.events ?? []
  const pagesEvaluated = rows.filter((_, index) => websiteMetric(data, 'rows', index, 'sessions') && websiteMetric(data, 'rows', index, 'engagement_rate')).length
  const eventsEvaluated = events.filter((_, index) => websiteMetric(data, 'events', index, 'event_count')).length
  return { findings: [...mixFindings(data), ...rows.map((row, index) => pageAssessment(data, row, index))], coverage: [
    { family: 'Website', level: 'page', supplied: rows.length, evaluated: pagesEvaluated, limited: rows.length - pagesEvaluated },
    { family: 'Website', level: 'event', supplied: events.length, evaluated: eventsEvaluated, limited: events.length - eventsEvaluated },
  ] }
}
