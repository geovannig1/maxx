import { REC_THRESHOLDS } from './thresholds'
import { outcomeWords, withIndefiniteArticle } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// Pre-launch setup manifest (Ad Decision Ledger). A context-free launch screen must NOT
// invent a campaign: objective, event, page, audience, budget, creative, and attribution settings come
// from one approved CampaignPlan. Until that typed plan exists, high-stakes rows fail closed and explain
// which evidence is missing. This module is import-safe for client components (no server imports).
//
// The manifest PLANS the setup. Nothing here (or downstream) launches anything: write mode stays OFF
// and every recorded row carries action_allowed_now:false.

export const MANIFEST_PROPOSAL_STATUSES = ['blocked', 'proposed'] as const
export type ManifestProposalStatus = typeof MANIFEST_PROPOSAL_STATUSES[number]

export interface ManifestPlanSource {
  plan_id: string
  revision: string
  /** Immutable CampaignPlan content digest, including the `sha256:` prefix. */
  content_hash: string
}

export interface ManifestRow {
  setting_category: string
  setting_name: string
  proposed_value: string
  reason: string
  /** Structural state: placeholder prose is never treated as an approvable proposal. */
  proposal_status: ManifestProposalStatus
  /** Stable machine-readable reasons why this row cannot be accepted. */
  blocker_codes: readonly string[]
  /** Present only when an immutable CampaignPlan revision produced this proposal. */
  plan_source?: ManifestPlanSource
  /** "What not to change too soon" — carried onto the ledger row as switch_risk. */
  switch_risk?: string
}

export type ManifestAcceptanceReasonCode =
  | 'manifest_status_missing'
  | 'manifest_blocked'
  | 'proposal_missing'
  | 'placeholder_value'
  | 'final_value_differs_from_plan'
  | 'rationale_missing'
  | 'campaign_plan_source_missing'
  | 'campaign_plan_id_missing'
  | 'campaign_plan_revision_missing'
  | 'campaign_plan_hash_invalid'
  | 'campaign_plan_not_implemented'

export interface ManifestAcceptanceResult {
  allowed: boolean
  reason_codes: string[]
}

const CAMPAIGN_PLAN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i

/** PURE: the editor's structural acceptance contract. A human edit cannot turn a context-free
 * placeholder into a plan-backed proposal. The POST boundary separately rejects every launch_setup
 * acceptance until an account-scoped repository can verify this lineage server-side. */
export function assessManifestAcceptance(
  row: {
    proposed_value?: string | null
    reason?: string | null
    proposal_status?: ManifestProposalStatus | null
    blocker_codes?: readonly string[] | null
    plan_source?: Partial<ManifestPlanSource> | null
  },
  finalValue?: string | null
): ManifestAcceptanceResult {
  const reasons = [...(row.blocker_codes ?? [])]
  const proposedValue = row.proposed_value?.trim() ?? ''
  const chosenValue = finalValue?.trim() ?? ''

  if (!row.proposal_status) reasons.push('manifest_status_missing')
  if (row.proposal_status === 'blocked') reasons.push('manifest_blocked')
  if (!proposedValue || !chosenValue) reasons.push('proposal_missing')
  if (/^BLOCKED\b/i.test(proposedValue) || /^BLOCKED\b/i.test(chosenValue)) reasons.push('placeholder_value')
  if (proposedValue && chosenValue && proposedValue !== chosenValue) reasons.push('final_value_differs_from_plan')
  if (!row.reason?.trim()) reasons.push('rationale_missing')

  // There is no immutable, account-scoped CampaignPlan repository yet. Caller-supplied identifiers and
  // hashes are claims, not provenance; keep acceptance unreachable until the server can verify them.
  reasons.push('campaign_plan_not_implemented')

  const source = row.plan_source
  if (!source) {
    reasons.push('campaign_plan_source_missing')
  } else {
    if (!source.plan_id?.trim()) reasons.push('campaign_plan_id_missing')
    if (!source.revision?.trim()) reasons.push('campaign_plan_revision_missing')
    if (!source.content_hash || !CAMPAIGN_PLAN_HASH_PATTERN.test(source.content_hash)) {
      reasons.push('campaign_plan_hash_invalid')
    }
  }

  const reasonCodes = [...new Set(reasons)]
  return { allowed: row.proposal_status === 'proposed' && reasonCodes.length === 0, reason_codes: reasonCodes }
}

/** Stable entity key: a real id, else a planned-name slug, else 'account'. Lives here (pure module) so
 *  client components can compute it; setup-ledger re-exports it for server callers. */
export function entityKeyForSetup(entityId?: string | null, plannedName?: string | null): string {
  if (entityId && entityId.trim()) return entityId.trim()
  if (plannedName && plannedName.trim()) return plannedName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return 'account'
}

/** Human labels for the ledger's setting categories (manual-action form + manifest). */
export const SETTING_LABELS: Record<string, string> = {
  objective: 'Campaign objective',
  conversion_event: 'Conversion event',
  optimization_event: 'Optimization event',
  attribution_window: 'Attribution window',
  evaluation_window: 'Evaluation window',
  budget: 'Budget',
  bid_strategy: 'Bid strategy',
  audience: 'Audience',
  geo: 'Geo targeting',
  age_gender: 'Age / gender',
  placements: 'Placements',
  advantage_plus: 'Advantage+ settings',
  retargeting: 'Retargeting',
  exclusions: 'Exclusions',
  creative: 'Creative',
  copy: 'Copy',
  landing_page: 'Landing page',
  utm: 'UTM structure',
  pixel_capi: 'Pixel / CAPI',
  schedule: 'Schedule',
  launch_datetime: 'Launch date/time',
  hypothesis: 'Test hypothesis',
  success_metric: 'Success metric',
  min_data_threshold: 'Minimum data threshold',
  follow_up: 'Follow-up date',
}

/** Context-free manifest. `today` = nyToday(). High-stakes values stay blocked until an approved,
 *  page-aware CampaignPlan supplies them; this prevents the UI from silently prescribing the prior
 *  universal cold→booking setup. */
export function defaultManifest(today: string): ManifestRow[] {
  void today // compatibility input only; a context-free date cannot set a plan review date
  const t = REC_THRESHOLDS
  const contextFreeRows: Array<Omit<ManifestRow, 'proposal_status' | 'blocker_codes' | 'plan_source'>> = [
    {
      setting_category: 'objective',
      setting_name: SETTING_LABELS.objective,
      proposed_value: 'BLOCKED — requires an approved CampaignPlan with a declared business outcome and funnel stage',
      reason: `Cold is not automatically Awareness or direct ${OW.one}. Select the Meta objective only after the offer, page journey, follow-up path, event volume, and economics are approved together.`,
    },
    {
      setting_category: 'conversion_event',
      setting_name: SETTING_LABELS.conversion_event,
      proposed_value: 'BLOCKED — requires a verified event compatible with the approved campaign outcome',
      reason: `AppointmentConfirmed may be correct for ${withIndefiniteArticle(OW.one)} plan; a qualified lead or awareness plan needs its own declared outcome. Event delivery and meaning must be proven before spend.`,
      switch_risk: 'Changing the conversion event resets learning and re-bases every CPA comparison.',
    },
    {
      setting_category: 'optimization_event',
      setting_name: SETTING_LABELS.optimization_event,
      proposed_value: 'BLOCKED — requires the approved objective, conversion location, event, and expected weekly volume',
      reason: `Use the deepest meaningful event the declared funnel can support. A proxy event must be labelled as a consideration/audience-building experiment, never as ${OW.one} performance.`,
      switch_risk: 'Changing the optimization event can re-enter learning and breaks the comparison; do it only through an approved CampaignPlan when the current event is demonstrably wrong.',
    },
    {
      setting_category: 'attribution_window',
      setting_name: SETTING_LABELS.attribution_window,
      proposed_value: 'BLOCKED — attribution setting must be declared in the approved CampaignPlan',
      reason: `Use a consistent setting compatible with the objective, then report click and view credit separately. View-through allocation is not proof of incremental ${OW.many}.`,
      switch_risk: 'Switching between 1-day and 7-day mid-flight makes every before/after comparison invalid.',
    },
    {
      setting_category: 'evaluation_window',
      setting_name: SETTING_LABELS.evaluation_window,
      proposed_value: 'BLOCKED — requires the approved outcome, measured interaction-to-outcome lag, change history, and evidence window',
      reason: `One bad day is not evidence. Existing reversal guards (including ${t.MIN_WINDOW_DAYS_REVERSAL}-day windows and ${t.MIN_DAYS_SINCE_LAST_CHANGE} days after a major change) are diagnostics, not permission to invent the CampaignPlan evaluation contract.`,
    },
    {
      setting_category: 'budget',
      setting_name: SETTING_LABELS.budget,
      proposed_value: 'BLOCKED — requires owner spend ceiling, contribution economics, audience size, plan structure, and expected event volume',
      reason: `Budget must be derived from the approved plan. Meta's ~${t.LEARNING_EXIT_EVENTS_PER_WEEK} events/week learning target is a diagnostic constraint, not permission to invent a budget.`,
      switch_risk: 'Material budget changes can alter delivery and learning. The approved CampaignPlan must define the change size; there is no universal percentage authority.',
    },
    {
      setting_category: 'audience',
      setting_name: SETTING_LABELS.audience,
      proposed_value: 'BLOCKED — requires a fresh audience inventory, declared temperature, exclusions, expansion policy, and message fit',
      reason: 'A strict Warm plan cannot include lookalikes or unbounded expansion. A mixed audience must be labelled mixed and use copy valid for every included user.',
    },
    {
      setting_category: 'geo',
      setting_name: SETTING_LABELS.geo,
      proposed_value: 'BLOCKED — requires an owner-approved service area in the current business-context version',
      reason: 'The studio is local, but the exact radius is a business constraint, not a universal model default.',
    },
    {
      setting_category: 'placements',
      setting_name: SETTING_LABELS.placements,
      proposed_value: 'BLOCKED — requires asset-format coverage and an approved placements policy',
      reason: 'Advantage+ placements are the candidate default only when every selected placement has a suitable, safe asset and the plan records the decision.',
    },
    {
      setting_category: 'creative',
      setting_name: SETTING_LABELS.creative,
      proposed_value: 'BLOCKED — requires approved concept slots, claim provenance, placement-fit assets, page, offer, and CTA',
      reason: 'Require genuinely distinct concepts, not cosmetic tour variants. CTA and message must match the chosen page and audience stage.',
    },
    {
      setting_category: 'copy',
      setting_name: SETTING_LABELS.copy,
      proposed_value: 'BLOCKED — requires verified claims from the approved business and page snapshots',
      reason: 'Do not use stale brand memory, unsupported scarcity, availability, review counts, capacity, amenities, or pricing.',
    },
    {
      setting_category: 'landing_page',
      setting_name: SETTING_LABELS.landing_page,
      proposed_value: 'BLOCKED — requires an approved page snapshot whose purpose and journey match the audience and outcome',
      reason: `A cold consideration plan may need the homepage or a lead bridge; a verified warm ${OW.one} plan may use /book. The destination is evidence, not a global default.`,
    },
    {
      setting_category: 'utm',
      setting_name: SETTING_LABELS.utm,
      proposed_value: 'BLOCKED — requires the CampaignPlan tracking contract, destination behavior, and verified field transport',
      reason: `Keep readable names for telemetry and immutable Meta IDs for unit identity. The paid touch must also capture interaction time and link to the ${OW.one}; URL parameters alone do not create outcome authority.`,
    },
    {
      setting_category: 'pixel_capi',
      setting_name: SETTING_LABELS.pixel_capi,
      proposed_value: 'BLOCKED — requires the CampaignPlan outcome event, identity contract, delivery proof, and deduplication design',
      reason: 'Verify each layer independently before spend; an env value or tag configuration is not delivery proof.',
    },
    {
      setting_category: 'schedule',
      setting_name: SETTING_LABELS.schedule,
      proposed_value: 'BLOCKED — requires the approved launch window, spend constraints, service availability, and evaluation design',
      reason: 'Dayparting on no data is a guess.',
    },
    {
      setting_category: 'hypothesis',
      setting_name: SETTING_LABELS.hypothesis,
      proposed_value: 'BLOCKED — requires the CampaignPlan audience, offer, outcome, comparison, and controllable variable',
      reason: 'A launch without a hypothesis cannot produce a lesson.',
    },
    {
      setting_category: 'success_metric',
      setting_name: SETTING_LABELS.success_metric,
      proposed_value: 'BLOCKED — requires the declared business outcome, evidence plane, attribution scope, and decision rule',
      reason: 'Range-aware judgment, not point-value panic.',
    },
    {
      setting_category: 'min_data_threshold',
      setting_name: SETTING_LABELS.min_data_threshold,
      proposed_value: 'BLOCKED — requires plan-specific economics, outcome frequency, lag, risk, and minimum evidence rules',
      reason: `Current diagnostics use minimum spend, time, and outcome-count guards (including ${t.MIN_SPEND_TO_JUDGE}, ${t.MIN_WINDOW_DAYS_REVERSAL}, ${t.MIN_BOOKINGS_PERF_CLAIM}, and ${t.MIN_BOOKINGS_STRONG_CLAIM}), but those guards do not define a new campaign's decision threshold.`,
    },
    {
      setting_category: 'follow_up',
      setting_name: SETTING_LABELS.follow_up,
      proposed_value: 'BLOCKED — requires the approved launch timestamp, measured outcome lag, and CampaignPlan review cadence',
      reason: 'A calendar date without an approved launch and evidence window is manufactured precision.',
    },
  ]
  return contextFreeRows.map((row) => ({
    ...row,
    proposal_status: 'blocked',
    blocker_codes: ['campaign_plan_missing'],
  }))
}
