import type { ReportEntity, ReportMetric, ReportingData } from '../contracts'
import type { ReviewEvidence, ReviewFinding } from './contracts'
import { comparable, delta, display, metricEvidence, numeric, reportLink, statement, unavailableFinding } from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Ad = { entity: ReportEntity; index: number; context: ReportingData['context'] }
type Watch = { percent: number; count: string; rate: string }
type Contrast = { other: Ad; prior: boolean; watch: number; response: number }
const watches: Watch[] = [50, 25, 75, 100].map(percent => ({ percent, count: `watch_p${percent}`, rate: `retention_p${percent}` }))
const metric = (ad: Ad, key: string) => ad.entity.metrics[key]
const isRate = (key: string) => key === 'outbound_ctr' || watches.some(watch => watch.rate === key)
const refs = (data: ReportingData, ad: Ad, keys: string[]) => keys.map(key =>
  nativeMetric(ad, key) && (!isRate(key) || rateConsistent(ad, key)) ? metricEvidence(data, 'meta', ['entities', ad.index, 'metrics', key]) : null)
const knownRefs = (values: Array<ReviewEvidence | null>) => values.filter((value): value is ReviewEvidence => value !== null)
const count = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** Supported native definitions; self-comparability cannot establish units or event meaning. */
function nativeMetric(ad: Ad, key: string, prior = false): ReportMetric | null {
  const value = metric(ad, key), claim = prior ? value?.previous : value?.current
  const range = prior ? ad.context.comparison : ad.context.range
  const amount = numeric(value, prior)
  const measured = ['spend', 'impressions'].includes(key)
  const unit = key === 'spend' ? 'money' : isRate(key) ? 'percent' : 'count'
  if (!claim || amount === null || amount < 0 || value.key !== key || value.event !== (key === 'bookings' ? 'AppointmentConfirmed' : null)
    || claim.metricKey !== `meta.${key}` || claim.unit !== unit || (unit === 'count' && !Number.isInteger(amount))
    || claim.window.basis !== 'impression_date_et' || claim.window.timezone !== ad.context.timezone
    || claim.window.start !== range.from || claim.window.end !== range.to
    || claim.source.system !== 'meta' || claim.source.role !== 'delivery_truth' || claim.source.evidencePlane !== 'meta_delivery'
    || claim.entity.level !== 'ad' || claim.entity.id !== ad.entity.id || claim.definitionVersion !== 1
    || claim.attributionScope !== (measured ? 'none' : 'meta_platform_modelled')
    || claim.measurementKind !== (isRate(key) ? 'derived' : measured ? 'measured' : 'modelled')
    || claim.coverage.state !== 'complete' || claim.freshness.state === 'stale' || claim.maturity.state === 'partial') return null
  return value
}

/** Verify the supplied rate; never repair it or manufacture a replacement report metric. */
function rateConsistent(ad: Ad, key: string, prior = false): boolean {
  const watch = watches.find(item => item.rate === key)
  const numeratorKey = watch?.count ?? 'outbound_clicks', denominatorKey = watch ? 'video_plays' : 'impressions'
  const rate = nativeMetric(ad, key, prior), numerator = nativeMetric(ad, numeratorKey, prior), denominator = nativeMetric(ad, denominatorKey, prior)
  if (!isRate(key) || !rate || !numerator || !denominator) return false
  const a = numeric(numerator, prior)!, b = numeric(denominator, prior)!, supplied = numeric(rate, prior)!
  if (b <= 0 || (watch && a > b)) return false
  const expected = a / b * 100
  const claim = prior ? rate.previous! : rate.current
  const inputs = [prior ? numerator.previous!.claimId : numerator.current.claimId, prior ? denominator.previous!.claimId : denominator.current.claimId]
  return Number.isFinite(expected) && claim.inputClaimIds.length === 2 && inputs.every(id => claim.inputClaimIds.includes(id))
    && Math.abs(supplied - expected) <= Number.EPSILON * Math.max(1, supplied, expected) * 8
}

function ads(data: ReportingData): Ad[] {
  if (!['available', 'partial'].includes(data.meta.state)) return []
  return (data.meta.data?.entities ?? []).map((entity, index) => ({ entity, index, context: data.context }))
    .filter(ad => ad.entity.level === 'ad' && nativeMetric(ad, 'spend'))
    .sort((a, b) => numeric(metric(b, 'spend'))! - numeric(metric(a, 'spend'))! || a.entity.id.localeCompare(b.entity.id))
}

function watchFor(ad: Ad, prior = false): Watch | undefined {
  if (ad.entity.creative?.format !== 'video' || !nativeMetric(ad, 'video_plays', prior) || numeric(metric(ad, 'video_plays'), prior)! <= 0) return undefined
  return watches.find(watch => nativeMetric(ad, watch.count, prior)
    && numeric(metric(ad, watch.count), prior)! <= numeric(metric(ad, 'video_plays'), prior)!)
}

function hasResponse(ad: Ad, prior = false): boolean {
  return ['outbound_clicks', 'impressions'].every(key => nativeMetric(ad, key, prior)) && numeric(metric(ad, 'impressions'), prior)! > 0
}

/** Distinct count definitions may be described together only within the same observed scope. */
function landingScope(outbound: ReportMetric, landing?: ReportMetric): boolean {
  if (!landing || [outbound, landing].some(value => value.event !== null || value.current.unit !== 'count')) return false
  const a = outbound.current, b = landing.current
  return a.entity.level === b.entity.level && a.entity.id === b.entity.id && a.attributionScope === b.attributionScope
    && a.source.system === b.source.system && a.source.evidencePlane === b.source.evidencePlane && a.source.role === b.source.role
    && a.window.start === b.window.start && a.window.end === b.window.end && a.window.basis === b.window.basis && a.window.timezone === b.window.timezone
}

function contrastFor(anchor: Ad, rows: Ad[], watch: Watch): Contrast | null {
  const keys = [watch.count, watch.rate, 'video_plays', 'outbound_clicks', 'outbound_ctr', 'impressions']
  const other = rows.find(row => row !== anchor && watchFor(row) && hasResponse(row)
    && rateConsistent(row, watch.rate) && rateConsistent(row, 'outbound_ctr')
    && keys.every(key => comparable(metric(anchor, key), metric(row, key))))
  if (other) return { other, prior: false,
    watch: numeric(metric(anchor, watch.rate))! - numeric(metric(other, watch.rate))!,
    response: numeric(metric(anchor, 'outbound_ctr'))! - numeric(metric(other, 'outbound_ctr'))! }
  if (keys.every(key => nativeMetric(anchor, key, true) && comparable(metric(anchor, key), metric(anchor, key), true))
    && rateConsistent(anchor, watch.rate, true) && rateConsistent(anchor, 'outbound_ctr', true)
    && numeric(metric(anchor, 'video_plays'), true)! > 0 && numeric(metric(anchor, 'impressions'), true)! > 0) {
    return { other: anchor, prior: true, watch: delta(metric(anchor, watch.rate))!, response: delta(metric(anchor, 'outbound_ctr'))! }
  }
  return null
}

function watchDescription(ad: Ad, watch: Watch, prior = false): string {
  const value = (key: string) => display(nativeMetric(ad, key, prior) && (!isRate(key) || rateConsistent(ad, key, prior)) ? metric(ad, key) : null, prior)
  const duration = ad.entity.creative?.durationSeconds
  const asset = prior ? '' : duration !== null && duration !== undefined && duration > 0
    ? ` Current preview duration ${count(duration)} seconds; historical media duration is not established by this preview.`
    : ' Asset duration unavailable.'
  return `${ad.entity.name}${prior ? ' in the prior equal period' : ''}: ${value(watch.count)} ${watch.percent}% watches from ${value('video_plays')} video starts (${value(watch.rate)}); `
    + `${value('outbound_ctr')} outbound CTR from ${value('outbound_clicks')} outbound clicks / ${value('impressions')} impressions.${asset}`
}

function bookingCounter(data: ReportingData, anchor: Ad) {
  const bookings = metric(anchor, 'bookings')
  return nativeMetric(anchor, 'bookings')
    ? statement(`Meta AppointmentConfirmed: ${display(bookings)} reported ${OW.many} on this ad. These attributed estimates do not identify which viewers later booked.`, ...refs(data, anchor, ['bookings']))
    : statement(`Meta AppointmentConfirmed counterevidence is unavailable for this ad; missing or differently named events are not zero ${OW.many}.`)
}

function exposure(data: ReportingData, anchor: Ad): Pick<ReviewFinding, 'materiality' | 'exposure'> {
  const evidence = refs(data, anchor, ['spend', 'impressions'])
  return { materiality: {
    ...statement(`${anchor.entity.name} has ${display(nativeMetric(anchor, 'spend'))} measured spend and ${display(nativeMetric(anchor, 'impressions'))} impressions in this report window.`, ...evidence),
    priorityReason: 'Selected by measured spend among ads with evidence for this check, not by the most extreme percentage. Spend is exposure to inspect, not a recoverable amount.',
  }, exposure: { value: numeric(metric(anchor, 'spend'))!, unit: 'money', evidence: knownRefs(refs(data, anchor, ['spend'])) } }
}

function unavailableAttention(data: ReportingData, anchor: Ad, watch?: Watch): ReviewFinding {
  const reason = 'The attention/response comparison is withheld: a native field or rate is missing, incompatible, or inconsistent with its supplied counts and denominator.'
  const finding = unavailableFinding(data, { id: 'creative_attention', area: 'creative', title: `Video attention and response: ${anchor.entity.name}`, reason, href: '/creative' })
  const keys = ['video_plays', 'outbound_clicks', 'impressions', 'outbound_ctr', ...(watch ? [watch.count, watch.rate] : [])]
  const text = watch ? watchDescription(anchor, watch)
    : `${anchor.entity.name}: ${display(nativeMetric(anchor, 'video_plays'))} video starts; ${display(nativeMetric(anchor, 'outbound_clicks'))} outbound clicks. A usable watch count and denominator are unavailable.`
  return { ...finding, observation: statement(`${text} ${reason}`, ...refs(data, anchor, keys)), ...exposure(data, anchor),
    counterEvidence: bookingCounter(data, anchor),
    nextInspection: { ...finding.nextInspection,
      question: `For ${anchor.entity.name}, do the native watch counts, video starts, outbound clicks and impressions support the supplied rate arithmetic and definitions? Recheck the source response before interpreting the creative.`,
      href: reportLink(data, '/creative', { ad: anchor.entity.id, group: 'attention' }),
      outcomes: [
        { result: 'The source returns compatible rates that agree with the supplied native counts and denominators.', interpretation: 'Reopen the scoped attention/response comparison.' },
        { result: 'A rate remains missing or contradicts the native inputs.', interpretation: 'Retain valid raw counts and withhold the inconsistent derived field; do not replace it with a silently recalculated percentage.' },
      ],
    }, limitations: [...finding.limitations, 'Missing or invalid watch evidence cannot establish weak creative. Native raw counts remain inspectable.'],
  }
}

function attentionReview(data: ReportingData, rows: Ad[]): ReviewFinding {
  const anchor = rows.find(ad => watchFor(ad) && hasResponse(ad)) ?? rows.find(ad => ad.entity.creative?.format === 'video')
  if (!anchor) return unavailableFinding(data, { id: 'creative_attention', area: 'creative', title: 'Video attention and response',
    reason: 'This check needs native video starts above zero, a supplied watch count and its retention denominator, outbound clicks, impressions and measured spend. Missing watch data cannot establish weak creative.', href: '/creative' })
  const watch = watchFor(anchor)
  if (!watch || !hasResponse(anchor) || !rateConsistent(anchor, watch.rate) || !rateConsistent(anchor, 'outbound_ctr')) return unavailableAttention(data, anchor, watch)
  const contrast = contrastFor(anchor, rows, watch)
  const keys = [watch.count, watch.rate, 'video_plays', 'outbound_ctr', 'outbound_clicks', 'impressions']
  const evidence = [...refs(data, anchor, keys), ...(contrast ? refs(data, contrast.other, keys) : [])]
  const opposed = contrast !== null && contrast.watch * contrast.response < 0
  const lowerWatchStrongerResponse = opposed && contrast!.watch < 0
  const weakerTogether = contrast !== null && contrast.watch < 0 && contrast.response < 0
  const strongerTogether = contrast !== null && contrast.watch > 0 && contrast.response > 0
  const direction: ReviewFinding['direction'] = !contrast?.prior ? undefined
    : opposed ? 'mixed' : weakerTogether ? 'declined' : strongerTogether ? 'improved' : undefined
  const booking = bookingCounter(data, anchor)
  const relation = lowerWatchStrongerResponse
    ? 'Lower watch percentage accompanies higher outbound CTR; attention alone does not support a weaker-response verdict.'
    : opposed ? 'Higher watch percentage accompanies lower outbound CTR; watching alone does not establish stronger visitor response.'
      : weakerTogether ? 'Both observed rates are lower, but the packet cannot separate message quality from who received the ad.'
        : direction === 'improved' ? `Both current rates exceed their same-ad prior-period values; delivery selection or asset changes may explain the improvement. ${OW.One} intent and causal creative effects remain unestablished.`
        : `Watch depth and outbound response remain distinct observations; neither alone establishes ${OW.one} intent or creative quality.`
  const question = lowerWatchStrongerResponse
    ? `Does ${anchor.entity.name}'s message qualify visitors before the click, or does delivery mix explain lower watch percentage with stronger outbound response? Inspect the exact asset, offer and destination.`
    : opposed ? `Does ${anchor.entity.name} hold attention without making the offer or next step clear? Inspect the exact asset and destination against its outbound response.`
      : weakerTogether ? `Is ${anchor.entity.name}'s message or offer unclear, or did its delivery population change? Inspect the asset, destination and comparable exposure before deciding.`
        : direction === 'improved' ? `Do ${anchor.entity.name}'s higher watch percentage and outbound CTR persist under comparable delivery? Inspect the asset, offer and destination alongside audience and configuration changes.`
        : `What does ${anchor.entity.name}'s asset promise before the click, and does the destination fulfill it? Check response under comparable exposure before judging the message.`
  const duration = anchor.entity.creative?.durationSeconds
  const otherDuration = contrast && !contrast.prior ? contrast.other.entity.creative?.durationSeconds : null
  return {
    id: 'creative_attention', area: 'creative', title: `Video attention and response: ${anchor.entity.name}`,
    status: opposed ? 'mixed' : 'observed',
    ...(direction ? { direction } : {}),
    observation: statement(watchDescription(anchor, watch) + (contrast ? ` ${watchDescription(contrast.other, watch, contrast.prior)}` : ''), ...evidence),
    ...exposure(data, anchor),
    explanations: [
      { hypothesis: lowerWatchStrongerResponse
        ? 'Offer qualification may reduce casual watching while attracting visitors who choose to leave the platform.'
        : 'The message, offer or next step may influence how watching relates to outbound response.',
      evidence: knownRefs(evidence), missing: ['Inspection of the exact asset and landing offer', 'Comparable delivery or a controlled creative experiment'] },
      { hypothesis: 'Optimizer selection, audience composition and delivery conditions may explain the observed contrast.',
        evidence: knownRefs(refs(data, anchor, ['spend', 'impressions'])), missing: ['Matched exposure and audience conditions; allocation is not randomized'] },
    ],
    counterEvidence: statement(`${relation} ${booking.text}`, ...evidence, ...booking.evidence),
    nextInspection: { question, href: reportLink(data, '/creative', { ad: anchor.entity.id, group: 'attention' }), outcomes: [
      { result: 'The asset and destination make the same offer clear, and response persists under comparable exposure.',
        interpretation: 'Qualification or audience selection remains plausible; low watch percentage alone is insufficient reason to replace the asset.' },
      { result: 'The asset obscures the offer or next step, or the destination contradicts it.',
        interpretation: 'Form a specific message or destination test; the present observations still do not establish its causal effect.' },
    ] },
    limitations: [
      'Exposure is reported explicitly; no generic threshold establishes adequate sample size or a controlled experiment.',
      'Optimizer delivery is unequal. Whole-period differences are not a causal creative test.',
      'The packet cannot establish daily fatigue or placement-matched watch behavior.',
      ...(duration === null || duration === undefined || duration <= 0 ? ['Asset duration is unavailable; elapsed watch depth cannot be established.'] : []),
      'Current previews do not establish historical media durations or delivered dynamic combinations; elapsed watch depth is not inferred.',
      ...(duration && otherDuration && otherDuration !== duration ? ['Different current preview durations make equal percentages different viewing tasks if those assets were delivered; historical assignment remains unverified.'] : []),
      ...(!contrast ? ['No compatible attention/response comparison is available; the current measurements remain descriptive.'] : []),
      ...(!contrast && (metric(anchor, watch.rate)?.previous || metric(anchor, 'outbound_ctr')?.previous)
        && (!rateConsistent(anchor, watch.rate, true) || !rateConsistent(anchor, 'outbound_ctr', true))
        ? ['Prior rates are missing, incompatible or inconsistent with their native inputs; prior rate interpretation is withheld.'] : []),
      ...(contrast?.prior ? ['Prior asset configuration and delivery composition are not bound to these period metrics.'] : []),
    ], authority: { state: 'diagnostic', executable: false },
  }
}

function landingReview(data: ReportingData, rows: Ad[]): ReviewFinding {
  const anchor = rows.find(ad => nativeMetric(ad, 'outbound_clicks'))
  if (!anchor) return unavailableFinding(data, { id: 'creative_landing', area: 'creative', title: 'Outbound clicks and landing-page views',
    reason: 'Native outbound clicks and measured ad spend are unavailable. Link clicks cannot substitute for outbound clicks.', href: '/performance' })
  const outgoing = numeric(metric(anchor, 'outbound_clicks'))!
  const landingMetric = metric(anchor, 'landing_page_views')
  const arrivals = nativeMetric(anchor, 'landing_page_views') && landingScope(metric(anchor, 'outbound_clicks'), landingMetric) ? numeric(landingMetric) : null
  const destination = anchor.entity.creative?.destination ?? 'the destination configured for this exact ad (URL unavailable in this packet)'
  const evidence = refs(data, anchor, ['outbound_clicks', 'landing_page_views'])
  const question = arrivals === null
    ? `Can Meta supply matching native landing-page-view definitions and coverage for ${anchor.entity.name}, and does ${destination} load and record the intended event? Inspect the exact ad and placement configuration first.`
    : outgoing === 0 ? `What delivery produced ${anchor.entity.name}'s reported zero outbound clicks? Inspect its exposure and placement rows before diagnosing ${destination}.`
      : arrivals < outgoing ? `For ${anchor.entity.name}, does ${destination} load and fire the intended landing event after an outbound click? Inspect redirects, device behavior and available placement rows for this exact ad.`
        : `Why are landing-page-view counts not lower than outbound clicks for ${anchor.entity.name}? Inspect event definitions, ${destination} and placement reporting before treating the counts as a journey.`
  return {
    id: 'creative_landing', area: 'creative', title: `Outbound clicks and landing-page views: ${anchor.entity.name}`,
    status: arrivals === null ? 'unavailable' : outgoing === 0 && arrivals === 0 ? 'unchanged' : 'observed',
    observation: statement(`${anchor.entity.name}: ${count(outgoing)} outbound clicks; ${arrivals === null ? 'landing-page views unavailable for this comparison' : `${count(arrivals)} landing-page views`}. These are separately reported Meta counts.`, ...evidence),
    ...exposure(data, anchor),
    explanations: [
      { hypothesis: arrivals === null ? 'Landing-event collection or response-field coverage may be incomplete.'
        : arrivals < outgoing ? 'A load, redirect or landing-event collection issue could explain some of the count difference.'
          : 'Counting rules, repeated observations or attribution/reporting scope may explain the count relationship.',
      evidence: knownRefs(evidence), missing: ['An observed test of the exact destination and landing event', 'Event definitions and reporting coverage for the same placement and window'] },
    ],
    counterEvidence: statement(arrivals === null
      ? 'Unavailable landing-page views cannot establish a complete arrival loss.'
      : arrivals >= outgoing && outgoing > 0 ? 'Landing-page views are not lower than outbound clicks; the counts do not support an assumed arrival deficit.'
        : 'These counts have no shared person or click identity; tracking coverage, repeat observations and reporting scope remain alternative explanations.', ...evidence),
    nextInspection: { question, href: reportLink(data, '/performance', { ad: anchor.entity.id, group: 'clicks' }), outcomes: [
      { result: 'The exact destination fails to load or the intended landing event is absent in a controlled check.',
        interpretation: `Investigate that observed delivery or collection failure; its occurrence does not quantify lost ${OW.many}.` },
      { result: 'The destination and event work, while the aggregate count relationship remains.',
        interpretation: 'Inspect source definitions, coverage and same-ad placement rows; aggregate counts cannot establish individual abandonment.' },
    ] },
    limitations: [
      'Outbound clicks and landing-page views are aggregate observations, not joined people or an ordered funnel. Their difference is not a bounce rate or proven loss.',
      'Placement inspection is a next check, not evidence of a placement-specific defect; optional detail may be unavailable.',
      'The destination is current creative configuration; its historic behavior during the metric window is unverified.',
      'Unequal optimizer delivery and different exposure prevent a causal comparison between ads.',
      ...(arrivals === null ? ['Landing-page-view evidence is missing, incomplete or incompatible with this native outbound observation scope.'] : []),
    ], authority: { state: 'diagnostic', executable: false },
  }
}

export function deriveCreativeReview(data: ReportingData): ReviewFinding[] {
  const rows = ads(data)
  return [attentionReview(data, rows), landingReview(data, rows)]
}

/** All supplied executions; only same-ad prior metrics can establish a population-scan contrast. */
export function deriveCreativePopulationReview(data: ReportingData): {
  findings: ReviewFinding[]
  coverage: { level: 'ad'; supplied: number; evaluated: number; limited: number }
} {
  const supplied = ['available', 'partial'].includes(data.meta.state)
    ? (data.meta.data?.entities ?? []).filter(entity => entity.level === 'ad').length : 0
  const findings: ReviewFinding[] = []
  let evaluated = 0
  for (const anchor of ads(data)) {
    // A single retained anchor preserves source indexes and prevents cross-ad pair expansion.
    const assessments = [
      ...(anchor.entity.creative?.format === 'video' ? [attentionReview(data, [anchor])] : []),
      ...(nativeMetric(anchor, 'outbound_clicks') ? [landingReview(data, [anchor])] : []),
    ]
    if (assessments.some(finding => finding.status !== 'unavailable')) evaluated++
    for (const finding of assessments) findings.push({
      ...finding,
      id: `${finding.id}:${anchor.entity.id}`,
      entity: { id: anchor.entity.id, level: 'ad', name: anchor.entity.name },
      priority: finding.status === 'mixed' || finding.direction ? 'investigate' : 'context',
      materiality: { ...finding.materiality,
        priorityReason: 'Every supplied ad with usable native evidence is assessed. Spend describes exposure, not recoverable money or sufficient evidence for a buying action.',
      },
    })
  }
  return { findings, coverage: { level: 'ad', supplied, evaluated, limited: supplied - evaluated } }
}
