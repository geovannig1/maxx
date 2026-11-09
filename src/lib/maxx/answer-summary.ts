import { accountLocale } from '@/config/business-config'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import { blockerLabel } from '@/lib/diagnostics/blocker-labels'
import type { PersistedFinalActionDecisionEvidence } from './answer-brief'
import { changeMagnitude, displayValue, isPriorPeriodChange, roundedChange } from './answer-values'

/**
 * The plain-English lead of a governed answer, composed by TEMPLATE from the claims and persisted
 * decisions the answer already renders as evidence. The model selects ids; it writes none of this.
 *
 * Every figure here is `displayValue` of a rendered claim (or the magnitude of a rendered change), so
 * the summary can only restate what the evidence below it shows. Wording is chosen to pass the
 * action-language guards that scan the whole answer: it describes, it never instructs.
 */

/** Most decision-relevant first. Unlisted metrics follow in the order they were cited. */
const LEAD_ORDER = [
  'meta.spend', 'meta.purchase_roas', 'meta.cost_per_result', 'meta.appointment_confirmed_results',
  'appointments', 'outcomes.checkout_revenue', 'meta.cost_per_lead', 'meta.purchase_value',
  'meta.link_ctr', 'meta.cpm', 'meta.link_clicks', 'meta.native_reach', 'meta.impressions',
  'meta.native_frequency',
]

/** Costs: a fall is an improvement. Every other metric is described as up or down. */
const COST_METRICS = new Set(['meta.cost_per_result', 'meta.cost_per_lead', 'meta.cpm'])

const MAX_LEAD_FIGURES = 3

/** A change smaller than this (in percent) reads as "held": 0.01% is noise, not a direction. */
const HELD_BELOW_PERCENT = 0.5

interface Figure { key: string; level: MetricClaim | null; change: MetricClaim | null; order: number }

function baseKey(claim: MetricClaim): string {
  return isPriorPeriodChange(claim) && claim.metricKey.endsWith('_change')
    ? claim.metricKey.slice(0, -'_change'.length)
    : claim.metricKey
}

function rank(key: string, order: number): number {
  const index = LEAD_ORDER.indexOf(key)
  return index >= 0 ? index : LEAD_ORDER.length + order
}

/** Pair each change with the level it was computed from (by lineage, else by metric and window). */
function figures(observed: readonly MetricClaim[]): Figure[] {
  const byKey = new Map<string, Figure>()
  observed.forEach((claim, order) => {
    const key = baseKey(claim)
    const figure = byKey.get(key) ?? { key, level: null, change: null, order }
    if (isPriorPeriodChange(claim)) figure.change ??= claim
    else figure.level ??= claim
    byKey.set(key, figure)
  })
  return [...byKey.values()]
    .map((figure) => ({ ...figure, level: pairedLevel(figure) }))
    .sort((a, b) => rank(a.key, a.order) - rank(b.key, b.order))
}

function pairedLevel(figure: Figure): MetricClaim | null {
  if (!figure.level || !figure.change) return figure.level
  const lineage = figure.change.inputClaimIds[0]
  const sameWindow = figure.change.window.start === figure.level.window.start
    && figure.change.window.end === figure.level.window.end
  return lineage === figure.level.claimId || sameWindow ? figure.level : null
}

function phrase(figure: Figure): string {
  const label = (figure.level ?? figure.change)!.label.replace(/ vs prior period$/, '')
  if (figure.change && typeof figure.change.value === 'number') {
    const rounded = roundedChange(figure.change.value)
    const to = figure.level ? ` to ${displayValue(figure.level)}` : ' against the prior period'
    if (Math.abs(rounded) < HELD_BELOW_PERCENT) return figure.level ? `${label} held at ${displayValue(figure.level)}` : `${label} held against the prior period`
    const cost = COST_METRICS.has(figure.key)
    const verb = cost
      ? rounded < 0 ? 'improved' : 'worsened'
      : rounded > 0 ? 'is up' : 'is down'
    return `${label} ${verb} ${changeMagnitude(rounded)}${to}`
  }
  const level = figure.level!
  return typeof level.value === 'string' || level.unit === 'state'
    ? `${label} is ${displayValue(level)}`
    : `${label} came to ${displayValue(level)}`
}

function windowText(claims: readonly MetricClaim[]): string | null {
  const [first] = claims
  if (!first || claims.some((c) => c.window.start !== first.window.start || c.window.end !== first.window.end)) return null
  const date = (iso: string, withYear: boolean) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(accountLocale(), {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  })
  const { start, end } = first.window
  if (start === end) return date(start, true)
  return `${date(start, start.slice(0, 4) !== end.slice(0, 4))} – ${date(end, true)}`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function leadSentence(lead: Figure[]): string {
  const parts = lead.map(phrase)
  const body = parts[0] + (parts[1] ? ` while ${parts[1]}` : '') + (parts[2] ? `; ${parts[2]}` : '')
  const claims = lead.flatMap((figure) => [figure.level, figure.change]).filter((c): c is MetricClaim => c !== null)
  const window = windowText(claims)
  return `${window ? `${window}: ` : ''}${capitalise(body)}.`
}

function unavailableSentence(unavailable: readonly MetricClaim[]): string | null {
  if (unavailable.length === 0) return null
  const ordered = [...unavailable].sort((a, b) =>
    Number(isPriorPeriodChange(a)) - Number(isPriorPeriodChange(b))
    || rank(baseKey(a), unavailable.indexOf(a)) - rank(baseKey(b), unavailable.indexOf(b)))
  const first = ordered[0]
  const [code] = first.availability.blockerCodes
  const reason = code ? ` because ${blockerLabel(code)}` : ''
  const others = ordered.length - 1
  const tail = others > 0 ? `; ${others} other ${others === 1 ? 'figure is' : 'figures are'} also unavailable` : ''
  return `${first.label} isn't available for this window${reason}${tail}.`
}

const TIER_RANK: Record<PersistedFinalActionDecisionEvidence['authority_tier'], number> = {
  execution_eligible: 0, owner_review: 1, diagnostic_only: 2,
}
const APPROVAL_RANK: Record<PersistedFinalActionDecisionEvidence['approval_state'], number> = {
  approved: 0, pending: 1, not_requested: 2, rejected: 3,
}
const KIND_RANK: Record<NonNullable<PersistedFinalActionDecisionEvidence['action_kind']>, number> = {
  pause: 0, budget_cut: 1, creative_refresh: 2, budget_scale: 3, structural: 4, activate: 5, observe: 6,
}
// Noun phrases only: a clause opening with a directive verb ("Refresh…", "Pause…") or a "budget
// <verb>" pair would trip the action-language guards and withhold the whole answer.
const KIND_NOUN: Record<NonNullable<PersistedFinalActionDecisionEvidence['action_kind']>, string> = {
  pause: 'pause', budget_cut: 'spend reduction', creative_refresh: 'creative refresh',
  budget_scale: 'spend scale-up', structural: 'structural', activate: 'activation', observe: 'observation',
}
const TIER_LABEL: Record<PersistedFinalActionDecisionEvidence['authority_tier'], string> = {
  execution_eligible: 'eligible after your approval', owner_review: 'owner review',
  diagnostic_only: 'diagnostic only, no live change authorised',
}

function nextStepText(decisions: readonly PersistedFinalActionDecisionEvidence[]): string | null {
  const live = decisions.filter((decision) => decision.approval_state !== 'rejected')
  if (live.length === 0) return null
  const kindRank = (d: PersistedFinalActionDecisionEvidence) => (d.action_kind ? KIND_RANK[d.action_kind] : 7)
  const [top] = [...live].sort((a, b) => TIER_RANK[a.authority_tier] - TIER_RANK[b.authority_tier]
    || APPROVAL_RANK[a.approval_state] - APPROVAL_RANK[b.approval_state]
    || kindRank(a) - kindRank(b)
    || live.indexOf(a) - live.indexOf(b))
  const what = top.owner_copy?.trim().replace(/[.\s]+$/, '')
    || `Review the persisted ${top.action_kind ? KIND_NOUN[top.action_kind] : 'action'} decision`
  const approval = top.approval_state === 'pending' ? ', awaiting your approval'
    : top.approval_state === 'approved' ? ', approved' : ''
  return `${what} — ${TIER_LABEL[top.authority_tier]}${approval}`
}

export interface AnswerSummaryInput {
  /** Available claims, in the order the evidence renders them. */
  observed: readonly MetricClaim[]
  unavailable: readonly MetricClaim[]
  decisions: readonly PersistedFinalActionDecisionEvidence[]
}

export interface AnswerSummary {
  /** One to three sentences, most decision-relevant fact first. */
  summary: string
  /** The highest-priority selected persisted decision, or null when none was selected. */
  nextStep: string | null
}

export function composeAnswerSummary(input: AnswerSummaryInput): AnswerSummary {
  const all = figures(input.observed)
  const sentences: string[] = []
  if (all.length > 0) {
    sentences.push(leadSentence(all.slice(0, MAX_LEAD_FIGURES)))
    if (all.length > MAX_LEAD_FIGURES) sentences.push('More figures are in the evidence below.')
  } else if (input.unavailable.length > 0) {
    sentences.push('None of the cited figures could be measured for this window.')
  } else if (input.decisions.length > 0) {
    sentences.push('This answer cites no account figures; the persisted decision below is the answer.')
  } else {
    sentences.push('This answer cites no governed evidence.')
  }
  const missing = unavailableSentence(input.unavailable)
  if (missing) sentences.push(missing)
  return { summary: sentences.join(' '), nextStep: nextStepText(input.decisions) }
}
