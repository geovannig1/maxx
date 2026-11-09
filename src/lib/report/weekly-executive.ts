import { accountCurrency, accountLocale } from '@/config/business-config'
import { z } from 'zod'

import type { ExecutiveEvidenceSnapshotV1 } from '@/lib/report/executive-evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_LINE_LENGTH = 420
const MAX_LINES_PER_SECTION = 10

type OutcomeWindowFacts = NonNullable<ExecutiveEvidenceSnapshotV1['outcomes']>['byWindow']['trailing7']
type MetaWindowFacts = NonNullable<ExecutiveEvidenceSnapshotV1['meta']>['byWindow']['trailing7']

const sectionSchema = z.object({
  setup: z.array(z.string().max(MAX_LINE_LENGTH)).max(MAX_LINES_PER_SECTION),
  audiences: z.array(z.string().max(MAX_LINE_LENGTH)).max(MAX_LINES_PER_SECTION),
  placements: z.array(z.string().max(MAX_LINE_LENGTH)).max(MAX_LINES_PER_SECTION),
  creative: z.array(z.string().max(MAX_LINE_LENGTH)).max(MAX_LINES_PER_SECTION),
  tracking: z.array(z.string().max(MAX_LINE_LENGTH)).max(MAX_LINES_PER_SECTION),
  material_changes: z.array(z.string().max(MAX_LINE_LENGTH)).max(MAX_LINES_PER_SECTION),
}).strict()

const weeklyExecutiveDigestV1Schema = z.object({
  contract: z.literal('weekly_executive_digest'),
  contract_version: z.literal(1),
  generated_from: z.literal('committed_executive_evidence'),
  weekly_report_id: z.uuid(),
  week_start: z.string().regex(DATE_PATTERN),
  week_end: z.string().regex(DATE_PATTERN),
  account_name: z.string().max(300),
  subject: z.string().min(1).max(200),
  action_authority_tier: z.literal('diagnostic_only'),
  prescriptions: z.tuple([]),
  context: z.object({
    current_week: z.string().min(1).max(MAX_LINE_LENGTH),
    prior_week: z.string().min(1).max(MAX_LINE_LENGTH),
    eight_week: z.string().min(1).max(MAX_LINE_LENGTH),
  }).strict(),
  sections: sectionSchema,
  blockers: z.array(z.string().max(200)).max(80),
  text: z.string().min(1).max(90_000),
}).strict()

export type WeeklyExecutiveDigestV1 = z.infer<typeof weeklyExecutiveDigestV1Schema>

export interface WeeklyExecutiveDigestIdentity {
  weeklyReportId: string
  weekStart: string
  weekEnd: string
}

function clean(value: unknown, fallback = 'Unavailable'): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.length === 0 ? fallback : normalized.slice(0, MAX_LINE_LENGTH)
}

function usd(value: number): string {
  return new Intl.NumberFormat(accountLocale(), {
    style: 'currency', currency: accountCurrency(),
  }).format(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function dateValue(value: string): number | null {
  if (!DATE_PATTERN.test(value)) return null
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? parsed : null
}

function isCompletedMondayToSunday(start: string, end: string): boolean {
  const startAt = dateValue(start)
  const endAt = dateValue(end)
  return startAt !== null
    && endAt !== null
    && new Date(startAt).getUTCDay() === 1
    && new Date(endAt).getUTCDay() === 0
    && endAt - startAt === 6 * 86_400_000
}

function businessLine(label: string, facts: OutcomeWindowFacts): string {
  if (!facts) return `${label}: Outcome source unavailable — no business-total zero is inferred.`
  const appointments = finiteNumber(facts.activeAppointments)
  const valueBookings = finiteNumber(facts.valueBearingBookings)
  const revenue = finiteNumber(facts.activeAmountPaidRevenue)
  const observed = finiteNumber(facts.activeAmountPaidObserved)
  if (appointments === null || valueBookings === null) {
    return `${label}: Outcome source unavailable — no business-total zero is inferred.`
  }
  const revenueText = revenue === null
    ? `${observed === null ? 'unavailable' : usd(observed)} observed amount paid on currently active ${OW.many}; complete active-${OW.one} amount paid unavailable`
    : `${usd(revenue)} amount paid on currently active ${OW.many}`
  return `${label}: ${appointments} active ${OW.many}; ${valueBookings} value-bearing ${OW.many}; ${revenueText}.`
}

function metaLine(label: string, facts: MetaWindowFacts): string {
  if (!facts) return `${label}: Meta modelled attribution unavailable — no zero is inferred.`
  const bookings = finiteNumber(facts.modeledBookings)
  const value = finiteNumber(facts.modeledBookingValue)
  const spend = finiteNumber(facts.spendAmount)
  if (spend === null) {
    return `${label}: Meta modelled attribution unavailable — no zero is inferred.`
  }
  if (bookings === null || value === null) {
    return `${label}: ${usd(spend)} spend; Meta modelled outcomes unavailable — current-run outcome-plane reconciliation incomplete; no ${OW.one}/value zero is inferred.`
  }
  return `${label}: ${usd(spend)} spend; ${bookings} modelled ${OW.many}; ${usd(value)} modelled ${OW.one} value.`
}

function eightWeekLine(snapshot: ExecutiveEvidenceSnapshotV1): string {
  const outcomeWeeks = snapshot.outcomes?.weeklyTrend8.slice(-8) ?? null
  const metaWeeks = snapshot.meta?.weeklyTrend8.slice(-8) ?? null
  if (!outcomeWeeks || !metaWeeks || outcomeWeeks.length !== 8 || metaWeeks.length !== 8) {
    const outcomeCoverage = outcomeWeeks === null ? 'unavailable' : `${outcomeWeeks.length}/8 weeks`
    const metaCoverage = metaWeeks === null ? 'unavailable' : `${metaWeeks.length}/8 weeks`
    return `8-week context unavailable — Outcome source coverage ${outcomeCoverage}; Meta coverage ${metaCoverage}; no missing period is converted to zero.`
  }
  const windowsAlign = outcomeWeeks.every((week, index) =>
    week.windowStart === metaWeeks[index]?.windowStart && week.windowEnd === metaWeeks[index]?.windowEnd,
  )
  if (!windowsAlign) {
    return '8-week context unavailable — Outcome source and Meta week boundaries do not align; no mismatched period is combined.'
  }
  const outcomeAppointments = outcomeWeeks.reduce((sum, item) => sum + item.activeAppointments, 0)
  const metaSpend = metaWeeks.reduce((sum, item) => sum + item.spendAmount, 0)
  return `8 observed weeks — Outcome ledger active ${OW.many}: ${outcomeAppointments}; Meta spend: ${usd(metaSpend)}.`
}

function sourceLine(
  label: string,
  source: { availability: string; head: string | null; blockerCodes: string[] },
): string {
  const head = source.head ? clean(source.head) : 'no committed head'
  const blockers = source.blockerCodes.length > 0
    ? `; blockers: ${source.blockerCodes.map((item) => clean(item)).join(', ')}`
    : ''
  return `${label}: ${clean(source.availability)}; ${head}${blockers}.`
}

function trackingLines(snapshot: ExecutiveEvidenceSnapshotV1): string[] {
  const lines = [
    sourceLine('Tracking source', snapshot.sources.tracking),
    sourceLine('CAPI source', snapshot.sources.capi),
    sourceLine('GA identity source', snapshot.sources.gaIdentity),
    sourceLine('Paid cohort source', snapshot.sources.paidCohort),
  ]
  if (snapshot.tracking) {
    lines.push(`Paid-touch identity: ${snapshot.tracking.identityCompleteTouches} complete; ${snapshot.tracking.identityIncompleteTouches} incomplete; ${snapshot.tracking.linkedAppointments} linked ${OW.many}.`)
  }
  if (snapshot.capi) {
    lines.push(`CAPI: ${clean(snapshot.capi.mode)}; ${snapshot.capi.sentAppointments}/${snapshot.capi.eligibleAppointments} eligible ${OW.many} sent; ${snapshot.capi.failedAppointments} failed.`)
  }
  if (snapshot.gaIdentity) {
    lines.push(`GA identity: ${clean(snapshot.gaIdentity.scope)}; ${snapshot.gaIdentity.identifiedEvents}/${snapshot.gaIdentity.confirmationEvents} confirmation events identified.`)
  }
  if (snapshot.blockerCodes.length > 0) {
    lines.push(`Evidence blockers: ${snapshot.blockerCodes.map((item) => clean(item)).join(', ')}.`)
  }
  return lines.map((line) => clean(line))
}

function sectionText(title: string, lines: string[]): string[] {
  return [`## ${title}`, '', ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : ['- None observed.']), '']
}

function renderText(digest: Omit<WeeklyExecutiveDigestV1, 'text'>): string {
  return [
    '# Maxx Weekly Executive Read',
    '',
    `${digest.week_start}–${digest.week_end}`,
    '',
    'Diagnostic only — this email creates no action authority.',
    '',
    '## Weekly context',
    '',
    `- ${digest.context.current_week}`,
    `- ${digest.context.prior_week}`,
    `- ${digest.context.eight_week}`,
    '- Outcome business totals and Meta modelled attribution are separate. They are different populations and must not be reconciled as if they were the same ledger.',
    '',
    ...sectionText('Setup', digest.sections.setup),
    ...sectionText('Audiences', digest.sections.audiences),
    ...sectionText('Placements', digest.sections.placements),
    ...sectionText('Creative', digest.sections.creative),
    ...sectionText('Tracking', digest.sections.tracking),
    ...sectionText('Material changes', digest.sections.material_changes),
  ].join('\n').trim()
}

type SetupProjection = NonNullable<ExecutiveEvidenceSnapshotV1['setupChanges']>

function inline(value: unknown): string {
  if (value === null || value === undefined) return 'unavailable'
  if (typeof value === 'string') return clean(value)
  try {
    return clean(JSON.stringify(value))
  } catch {
    return 'unavailable'
  }
}

function budget(daily: number | null, lifetime: number | null): string {
  if (daily !== null) return `${usd(daily)} daily`
  if (lifetime !== null) return `${usd(lifetime)} lifetime`
  return 'unavailable'
}

function setupSection(setup: SetupProjection | null, snapshot: ExecutiveEvidenceSnapshotV1): string[] {
  if (!setup) return [
    sourceLine('Setup evidence source', snapshot.sources.setupChanges),
    'Setup projection unavailable — no configuration conclusion is inferred.',
  ]
  const campaigns = [...setup.campaigns].sort((a, b) => a.meta_campaign_id.localeCompare(b.meta_campaign_id))
  const adsets = [...setup.adsets].sort((a, b) => a.meta_adset_id.localeCompare(b.meta_adset_id))
  return [
    sourceLine('Setup evidence source', snapshot.sources.setupChanges),
    `Projection: ${setup.status}; complete: ${setup.complete ? 'yes' : 'no'}; blockers: ${setup.blocker_codes.join(', ') || 'none'}.`,
    `Cold/warm comparison: ${setup.cold_warm_comparison.status}; role basis ${setup.cold_warm_comparison.role_basis}; cold ${setup.cold_warm_comparison.cold_meta_adset_id ?? 'unavailable'}; warm ${setup.cold_warm_comparison.warm_meta_adset_id ?? 'unavailable'}.`,
    `Configuration inventory: ${campaigns.length} campaigns; ${adsets.length} ad sets. Detail is bounded to the first 2 campaigns and 4 ad sets by stable Meta ID.`,
    ...campaigns.slice(0, 2).map((item) => clean(
      `Campaign ${item.name ?? item.meta_campaign_id}: objective ${item.objective ?? 'unavailable'}; buying type ${item.buying_type ?? 'unavailable'}; budget control ${item.budget_control.toUpperCase()}; budget ${budget(item.budget.daily_amount, item.budget.lifetime_amount)}.`,
    )),
    ...adsets.slice(0, 4).map((item) => clean(
      `Ad set ${item.name ?? item.meta_adset_id} [${item.comparison_role ?? 'other'}]: objective ${item.objective ?? 'unavailable'}; optimization ${item.optimization_goal ?? 'unavailable'} / ${item.optimization_event ?? 'unavailable'}; attribution ${inline(item.attribution_spec)}; budget ${budget(item.budget.daily_amount, item.budget.lifetime_amount)}; bid ${item.bid.strategy ?? 'unavailable'} ${item.bid.amount === null ? '' : usd(item.bid.amount)}; learning ${item.learning_stage ?? 'unavailable'}.`,
    )),
  ].slice(0, MAX_LINES_PER_SECTION)
}

function audienceNames(items: Array<{ id: string; name: string | null }>): string {
  return items.length > 0
    ? [...items].sort((a, b) => a.id.localeCompare(b.id)).map((item) => clean(item.name ?? item.id)).join(', ')
    : 'none'
}

function metric(value: number | null): string {
  return value === null ? 'unavailable' : String(value)
}

function audienceSection(
  setup: SetupProjection | null,
  snapshot: ExecutiveEvidenceSnapshotV1,
): string[] {
  const setupLines = !setup || setup.adsets.length === 0
    ? ['Audience setup unavailable — no targeting conclusion is inferred.']
    : [
        `Audience inventory: ${setup.adsets.length} configured ad sets; detail is bounded to the first 3 by stable Meta ID.`,
        ...[...setup.adsets]
    .sort((a, b) => a.meta_adset_id.localeCompare(b.meta_adset_id))
    .slice(0, 3)
    .map((item) => {
      const health = item.audience.health.length > 0
        ? [...item.audience.health].sort((a, b) => a.id.localeCompare(b.id)).map((audience) => {
          const range = audience.approximate_count_lower_bound === null
            ? 'size unavailable'
            : `${audience.approximate_count_lower_bound}–${audience.approximate_count_upper_bound ?? 'unavailable'}`
          return `${clean(audience.name ?? audience.id)} ${audience.status} ${range}`
        }).join(', ')
        : 'health unavailable'
      return clean(
        `${item.name ?? item.meta_adset_id} [${item.comparison_role ?? 'other'}]: composition ${item.audience.composition}; custom audiences ${audienceNames(item.audience.includedCustomAudiences)}; lookalikes ${audienceNames(item.audience.includedLookalikes)}; exclusions ${audienceNames(item.audience.excludedAudiences)}; expansion ${item.audience.expansion}; frozen ${item.audience.frozen ? 'yes' : 'no'}; health ${health}.`,
      )
    }),
      ]
  const performance = snapshot.metaColdWarm
  const performanceLines = performance === null
    ? ['Cold/Warm Meta funnel unavailable — no segment-performance zero or comparison is inferred.']
    : [
        clean(`Cold/Warm comparison: ${performance.comparisonStatus}; window ${performance.windowStart}–${performance.windowEnd}; blockers ${performance.blockerCodes.join(', ') || 'none'}.`),
        ...[...performance.units]
          .sort((a, b) => `${a.entityLevel}:${a.entityId}`.localeCompare(`${b.entityLevel}:${b.entityId}`))
          .slice(0, 3)
          .map((item) => {
            const outcomes = item.leads === null || item.modeledBookings === null
              ? 'outcomes unavailable — current-run outcome-plane reconciliation incomplete'
              : `${item.leads} leads; ${item.modeledBookings} Meta-modelled ${OW.many} / ${item.modeledBookingValue === null ? 'modelled value unavailable' : usd(item.modeledBookingValue)}; click/view/unknown split ${metric(item.modeledClickBookings)}/${metric(item.modeledViewBookings)}/${metric(item.modeledUnknownBookings)}`
            return clean(
              `${item.name} [${item.comparisonRole ?? 'other'} ${item.entityLevel}]: ${usd(item.spendAmount)} spend; ${item.impressions} impressions; ${item.reachAggregation === 'peak_daily' ? 'peak daily reach' : 'reach'} ${item.reach}; ${metric(item.linkClicks)} link clicks; ${metric(item.landingPageViews)} landing-page views; ${outcomes}.`,
            )
          }),
      ]
  return [
    sourceLine('Cold/Warm Meta source', snapshot.sources.metaColdWarm),
    ...setupLines,
    ...performanceLines,
  ].slice(0, MAX_LINES_PER_SECTION)
}

function placementSection(
  setup: SetupProjection | null,
  snapshot: ExecutiveEvidenceSnapshotV1,
): string[] {
  const setupLines = !setup || setup.adsets.length === 0
    ? ['Placement setup unavailable — no delivery conclusion is inferred.']
    : [
        `Placement configuration inventory: ${setup.adsets.length} ad sets; detail is bounded to the first 3 by stable Meta ID.`,
        ...[...setup.adsets]
    .sort((a, b) => a.meta_adset_id.localeCompare(b.meta_adset_id))
    .slice(0, 3)
    .map((item) => {
      const selected = Object.entries(item.placements.selected)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, values]) => `${clean(key)}=${[...values].sort().map((value) => clean(value)).join(',')}`)
        .join('; ')
      const mode = item.placements.mode === 'advantage_plus'
        ? 'Advantage+ placements'
        : item.placements.mode === 'manual' ? 'Manual placements' : 'Placements unavailable'
      return clean(`${item.name ?? item.meta_adset_id}: ${mode}; selected ${selected || 'automatic'}; Advantage+ evidence ${item.advantage_plus.placements}.`)
    }),
      ]
  const distributionLines = snapshot.metaPlacements === null
    ? ['Meta placement distribution unavailable — no placement-performance zero is inferred.']
    : [
        clean(`Meta placement window: ${snapshot.metaPlacements.windowStart}–${snapshot.metaPlacements.windowEnd}; blockers ${snapshot.metaPlacements.blockerCodes.join(', ') || 'none'}.`),
        ...[...snapshot.metaPlacements.rows]
          .sort((a, b) => `${a.dimension}:${a.value}`.localeCompare(`${b.dimension}:${b.value}`))
          .slice(0, 3)
          .map((item) => {
            const outcomes = item.leads === null || item.modeledBookings === null
              ? 'outcomes unavailable — current-run outcome-plane reconciliation incomplete'
              : `${item.leads} leads; ${item.modeledBookings} Meta-modelled ${OW.many}`
            return clean(
              `${item.dimension} ${item.value}: ${usd(item.spendAmount)} spend; ${item.impressions} impressions; ${item.clicks} clicks; ${outcomes}.`,
            )
          }),
      ]
  return [
    sourceLine('Meta placement source', snapshot.sources.metaPlacements),
    ...setupLines,
    ...distributionLines,
  ].slice(0, MAX_LINES_PER_SECTION)
}

function creativeSection(setup: SetupProjection | null): string[] {
  if (!setup) return ['Creative setup unavailable — no creative conclusion is inferred.']
  const wrappers = [...setup.active_ad_wrappers]
    .sort((a, b) => a.meta_ad_id.localeCompare(b.meta_ad_id))
    .slice(0, MAX_LINES_PER_SECTION - 2)
    .map((item) => {
      const destinationState = item.landing_destination.ad_level_read_available
        ? `destination UTM ${item.landing_destination.utm_status}`
        : 'current destination and UTM unavailable'
      return clean(
        `${item.name ?? item.meta_ad_id}: wrapper ${item.identity_summary}; concept ${item.concept_id ?? 'unavailable'}; media ${item.underlying_media.media_kind} / ${item.underlying_media.status}; latest-change relationship ${item.wrapper_relationship_to_latest_change}; ${destinationState}.`,
      )
    })
  const mediaCount = setup.creative_reuse.distinct_active_media
  const mediaText = mediaCount === null ? 'distinct media unavailable' : `${mediaCount} distinct media`
  return [
    clean(`Creative identity: ${setup.creative_reuse.distinct_active_ad_wrappers} active wrappers; ${setup.creative_reuse.distinct_active_meta_creative_ids} Meta creative IDs; ${mediaText}; concept coverage ${setup.creative_reuse.concept_coverage_complete ? 'complete' : 'incomplete'}.`),
    `Creative detail is bounded to the first ${MAX_LINES_PER_SECTION - 2} wrappers by stable Meta ad ID.`,
    ...wrappers,
  ]
}

function materialChangeSection(setup: SetupProjection | null): string[] {
  if (!setup) return ['Material-change evidence unavailable — no timing conclusion is inferred.']
  const change = setup.latest_material_change
  if (change.status === 'known') return [clean(
    `${change.occurredAt} — ${change.reason} Source: ${change.source}; categories: ${change.settingCategories.join(', ') || 'unavailable'}; affected Meta IDs: ${change.affectedMetaIds.join(', ') || 'unavailable'}; change ID: ${change.materialChangeId}.`,
  )]
  if (change.status === 'unknown') return [clean(
    `Latest material change unknown; observed time ${change.occurredAt ?? 'unavailable'}; blocker ${change.reasonCode}.`,
  )]
  return [clean(`No material change observed through ${change.through}.`)]
}

export function buildWeeklyExecutiveDigest(
  snapshot: ExecutiveEvidenceSnapshotV1,
  identity: WeeklyExecutiveDigestIdentity,
): WeeklyExecutiveDigestV1 {
  if (
    snapshot.contract !== 'executive_evidence_snapshot'
    || snapshot.version !== 1
    || snapshot.authority.tier !== 'diagnostic_only'
    || snapshot.authority.moneyActionsAuthorized !== false
    || snapshot.lastCompleteDate !== identity.weekEnd
    || snapshot.windows.trailing7.availability !== 'available'
    || snapshot.windows.trailing7.startDate !== identity.weekStart
    || snapshot.windows.trailing7.endDate !== identity.weekEnd
    || !isCompletedMondayToSunday(identity.weekStart, identity.weekEnd)
  ) throw new Error('Committed executive evidence does not cover the exact completed week.')

  const currentOutcome = businessLine('Outcome business totals', snapshot.outcomes?.byWindow.trailing7 ?? null)
  const currentMeta = metaLine('Meta modelled attribution', snapshot.meta?.byWindow.trailing7 ?? null)
  const priorOutcome = businessLine('Prior outcome business totals', snapshot.outcomes?.byWindow.prior7 ?? null)
  const priorMeta = metaLine('Prior Meta modelled attribution', snapshot.meta?.byWindow.prior7 ?? null)
  const setup = snapshot.setupChanges
  const sections = {
    setup: setupSection(setup, snapshot),
    audiences: audienceSection(setup, snapshot),
    placements: placementSection(setup, snapshot),
    creative: creativeSection(setup),
    tracking: [currentMeta, priorMeta, ...trackingLines(snapshot)],
    material_changes: materialChangeSection(setup),
  }
  const withoutText: Omit<WeeklyExecutiveDigestV1, 'text'> = {
    contract: 'weekly_executive_digest',
    contract_version: 1,
    generated_from: 'committed_executive_evidence',
    weekly_report_id: identity.weeklyReportId,
    week_start: identity.weekStart,
    week_end: identity.weekEnd,
    account_name: clean(snapshot.account.name, ''),
    subject: `Maxx weekly executive read — ${identity.weekStart}–${identity.weekEnd}`,
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    context: {
      current_week: `${currentOutcome} ${currentMeta}`,
      prior_week: `${priorOutcome} ${priorMeta}`,
      eight_week: eightWeekLine(snapshot),
    },
    sections,
    blockers: snapshot.blockerCodes.map((item) => clean(item)),
  }
  return weeklyExecutiveDigestV1Schema.parse({ ...withoutText, text: renderText(withoutText) })
}

export function readWeeklyExecutiveDigest(value: unknown): WeeklyExecutiveDigestV1 | null {
  const parsed = weeklyExecutiveDigestV1Schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function isWeeklyExecutiveDigestV1(value: unknown): value is WeeklyExecutiveDigestV1 {
  return readWeeklyExecutiveDigest(value) !== null
}
