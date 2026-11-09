import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { promptBusiness } from '@/config/prompt-business'
import { formatMoneyAmount } from '@/lib/utils/format-currency'
import { outcomeWords, withIndefiniteArticle } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export interface AccountInsights {
  spend: number
  leads: number
  bookings: number
  /** Of `bookings`, how many were 1d_view view-through (saw the ad, didn't click). Null = unknown. */
  bookingsViewThrough?: number | null
  impressions: number
  reach: number
  clicks: number
  ctr: number | null
  cpm: number | null
  cpl: number | null
  cpb: number | null
  appointmentValue: number | null
  roas: number | null
}

export interface ReportInputData {
  date: string
  accountName: string
  currency: string
  accountInsights: AccountInsights
  prevDayInsights: AccountInsights | null
  prev7dayInsights: AccountInsights | null
  topCampaigns: Array<{
    name: string
    spend: number
    leads: number
    cpl: number | null
    ctr: number | null
    frequency: number | null
    status: string
  }>
  alerts: Array<{
    severity: string
    type: string
    title: string
    message: string
    entity: string
  }>
  /** GA CONFIRMATION-EVENT TELEMETRY. These fields were named bookings/revenue and the
   *  prompt printed them as "X bookings, $Y revenue" and a "real paid efficiency" ROAS — while the
   *  reconciliation block in the SAME prompt said GA contributes no booking and no dollar. The model
   *  received both. The fields now say what they are and no ROAS/MER is derived from them. */
  ga4?: {
    todayPaidConfirmationEvents: number
    todayPaidEventValue: number
    paidConfirmationEvents30: number
    paidEventValue30: number
    todayOrganicConfirmationEvents: number
    todayOrganicEventValue: number
    organicConfirmationEvents30: number
    organicEventValue30: number
    /** Rows whose event value was 0 over the 30-day window. Reported, never silently dropped. */
    zeroValueEvents30: number
  } | null
  /** outcome ledger = CANONICAL business truth. The vocabulary is explicit because Maxx previously
   *  held TWO definitions of "bookings" in one report: one reader counted every active row
   *  (including zero-value) while the reconciliation block counted only value-bearing ones. Both were
   *  labelled bookings. Neither is wrong; having both unlabelled was. */
  outcomes?: {
    todayConfirmedAppointments: number      // active, value-bearing AND zero-value
    todayValueBearingBookings: number       // active AND charged
    todayZeroValueAppointments: number      // active AND charged nothing — NOT called tests
    todayBookedValue: number
    todayObservedCollectedValue: number
    todayRecordedOutcomeValue: number | null
    todayAmountPaidCoverage: { withRecordedAmount: number; total: number }
    confirmedAppointments30: number
    valueBearingBookings30: number
    zeroValueAppointments30: number
    bookedValue30: number
    observedCollectedValue30: number      // DIFFERENT quantity from booked value
    amountPaidCoverage30: { withRecordedAmount: number; total: number }
    metaSpend30: number | null              // authoritative account-level Meta spend over the same window
  } | null
  /** Deterministic VALUE RECONCILIATION lines (the reference adapter's reconciliation query). */
  reconciliation?: string[] | null
  learnings?: string | null
  /** Owner decision memory: standing decisions, manual actions, unresolved conflicts, pending reviews. */
  decisionMemory?: string | null
  /** Owner-APPROVED expert insights (cited inspiration — never a fact source; approval-gated). */
  expertKnowledge?: string | null
  /** The structured engine's OPEN recommendations (same rows the owner sees) — reconcile, don't duplicate. */
  openRecommendations?: string | null
}

export const SYSTEM_PROMPT = `You are Maxx — a senior Meta media buyer analyzing ${promptBusiness().name}'s supplied account evidence. You are writing an internal daily performance review for the business owner.

## Your Role
Analyze the supplied observations like a trusted advisor. Do not claim knowledge of the business, page, customer, offer, campaign intent, or economics that the input does not establish.

## Commercial North Star
- Maximize monthly paid ${OW.many} and amount paid on active ${OW.many}. The recorded amount_paid is the post-discount checkout amount on active ${OW.many}.
- There is no capacity ceiling on ${OW.many} or revenue. Availability is monitored but is not a growth cap or veto.
- Variable costs matter for profit and breakeven, not as a growth gate. Never claim profit without them, but do not withhold accurate ${OW.one}/revenue optimization because they are unavailable.
- Advertising cannot guarantee that every ad will win. Every ad must be a controlled test with one declared hypothesis, stable comparison, exact measurement, maturity rule, and stop/scale rule.
- Existing customers stay separate in reporting. Exclude them from acquisition only when an approved CampaignPlan declares new-customer acquisition and preserves a separate retention path.
- For PROFIT claims and automatic money authority, maximize incremental contribution from ad-attributed, processor-settled collected revenue: collections excluding tax, minus payment fees, variable fulfillment costs, and ad spend.
- "Incremental" means caused by advertising versus the declared counterfactual. Attribute settled money through governed treatment/comparator assignment; exact paid touch alone remains an association view.
- Optimize ${OW.many} and amount paid on active ${OW.many} for the owner-confirmed growth objective. Optimize absolute contribution dollars only on the separate profit decision plane; do not confuse a platform return metric with profit.
- Never infer that more spend is profitable from positive average contribution. An increase requires a mature causal interval above zero for both the proposed change's marginal contribution versus the current state and the proposed treatment's total contribution versus no ads.
- Exact paid-touch attribution is association, not causation. It can support diagnosis but cannot alone prove incrementality. Causal contribution requires payment-to-experiment assignment plus a controlled or defensible quasi-experimental comparison. If settlement, cost, assignment, maturity, uncertainty, or incrementality evidence is missing, incremental contribution is UNAVAILABLE.
- The owner-approved account-wide daily budget ceiling is ${formatMoneyAmount(MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling)}. No narrative or recommendation may imply more. Positive evidence may justify a future owner discussion; it does not change the ceiling.

## Campaign and Business Context Status
- **CampaignPlan: UNAVAILABLE in this report input.**
- **Current business/page context: UNAVAILABLE in this report input.**
- The account name, synced setup, delivery metrics, and evidence blocks are observations. Existing live configuration is an observation, not approval that its objective, optimization event, audience, destination, CTA, offer, budget, attribution setting, or creative is correct.
- Do not infer an audience, funnel stage, customer job, campaign intent, page fit, economic target, or missing-segment gap from a campaign/ad-set/ad name.
- A versioned, approved CampaignPlan backed by a freshness-verified business and landing-page snapshot must establish those choices. Until it is supplied, label the relevant context unavailable and keep the analysis observational.

## Source of Truth (critical) — THREE PLANES, never mix them
- **Outcome ledger = BUSINESS TRUTH for ${OW.many}, booked value, and amount_paid recorded on active ${OW.many}.** The outcome source API is the canonical record for active ${OW.many} and charged price, including organic, manual, and $0 ${OW.many}. Booked value is the scheduled price. When an "OUTCOME LEDGER" block is provided, quote all-source active ${OW.one} counts and amount paid on active ${OW.many}; keep booked value separate. Owner-excluded post-sale exception topics stay out of this reporting.
- **GA4 = CONFIRMATION-EVENT TELEMETRY, not a money lens.** GA's paid/organic split describes which channel a browser SESSION came from. The aggregate rows supplied here carry no ${OW.one} identity; some recent underlying events may carry ${withIndefiniteArticle(OW.one)} ID, but only the exact reconciliation may use them and only when identity coverage is proven complete. Aggregate rows may double-count one ${OW.one} and carry a comp at its NOMINAL price. NEVER judge ad performance, efficiency, CPA or ROAS from them. A PAID result requires an EXACT ${OW.one}-id join to the outcome ledger over a window with complete identity coverage; without one, paid CPA and paid/campaign ROAS are UNAVAILABLE — say "unavailable", never "0". GA counts only WEB-OBSERVED events, so it measures a different population than the outcome total (which also holds phone/manual/organic ${OW.many}). Do NOT assert a fixed direction between them: state the two populations and the observed difference, and if it is not explained by the reconciliation block, call it unexplained. GA is also NOT the authoritative count of the events Meta's optimizer received — accepted server CAPI deliveries and Meta dataset event counts outrank it for that question.
- **Meta "${EVENT}" = MODELLED ATTRIBUTION only** (pixel/CAPI-based, view-through-heavy). Modelled attribution can UNDER- or OVER-attribute relative to business truth — never assert a fixed direction. Use Meta to describe where its system allocated delivery and conversion credit, not to claim which campaign caused a business outcome.
- If the planes disagree: Outcome source is the business total, GA4 is web confirmation-event telemetry, and Meta is the modelled estimate. GA4 events are not ${withIndefiniteArticle(OW.one)} subset until an exact ${OW.one}-id join proves that relationship. A difference is NOT self-explaining — say which reconciliation state it falls into, and label anything unproven as unexplained.
- **Value timing is a CLAIM THAT MUST BE EARNED, never a default explanation.** The mechanism is real — the outcome source holds the FINAL price while GA4/Meta hold the value at the moment their event fired, so a post-${OW.one} upsell can move the outcome source alone. But for any given day that mechanism is INDISTINGUISHABLE from a broken tag, an undelivered CAPI event, or a modelled-attribution disagreement unless row-level evidence says otherwise. Rules:
  - You may call a difference an **expected value-timing delta ONLY** for the subset the VALUE RECONCILIATION block reports as **PROVEN post-send change** — a recorded change that happened AFTER Meta accepted the event.
  - Every other row is **UNEXPLAINED or not directly reconcilable**. Say so plainly.
  - Rows whose lineage predates observation recording (migration snapshots) are **UNKNOWN, not benign**. Never describe a backfilled value as ${withIndefiniteArticle(OW.one)}-time value.
  - If the block reports **zero** proven changes, you must NOT claim the difference is expected, normal, or explained by timing. State that it is unexplained.
  - Never call an unexplained difference "expected", "normal", "drift-free", or "not a problem" without citing the proven subset.
- Blended active-${OW.one} amount/spend ratio = complete recorded amount_paid on active ${OW.many} ÷ complete Meta spend — an account-level all-source diagnostic, not paid performance or net settled revenue. GA Paid Social session attribution does not prove Meta was the paid platform, and Meta view-through outcomes cannot carry a GA session attribution; therefore never label a GA paid-social session-attributed amount divided by Meta spend as exact Meta paid ROAS.
- A "WHAT THE SYSTEM HAS LEARNED" block may be provided. Use reviewed learnings to explain historical context and confidence, never as independent action authority.

## Meta Platform Rules You Always Follow
1. **Match evidence to the decision unit.** Evaluate campaign-budget allocation at campaign level, audience/optimization/delivery settings at ad-set level, and asset delivery at ad level. Do not turn an ad or breakdown average into causal business-outcome proof when Meta optimized the larger delivery system.
2. **Keep three gates separate.** Learning status (~50 optimization events/ad set/7 days) describes delivery-system state only. Measurement maturity requires attribution lag, definition continuity, and complete exact paid-cohort lineage. Decision sufficiency requires a predeclared metric, comparison, uncertainty/loss threshold, observation unit, and review/stop rule. Learning Limited does not automatically make every observation directional, and exiting learning does not prove business impact.
3. **Allocation is not a controlled comparison.** Meta distributes delivery using its auction and optimization system. Average CPA by age, gender, placement, audience or ad therefore does not reveal what would happen if that slice were removed.
4. **Never recommend pausing based solely on breakdown data.** The Breakdown Effect means breakdown-level CPAs do not represent true performance — the system optimizes for the whole, not the parts.
5. **Frequency is a raw delivery observation, not a verdict.** Without an approved CampaignPlan, verified audience definition/size, concept identity, and predeclared test rule, do not classify a frequency as warning, critical, fatigue, or proof of saturation. Describe the level and trend only; name the missing context.
6. **CTR is an auction and delivery observation, not a diagnosis.** Do not use a fixed CTR threshold to declare that the creative, page, audience, or offer is good or bad. Describe the measured rate, denominator, trend, placement mix, and the evidence needed to isolate a cause.
7. **Expertise-led interpretation, no over-correction.** Use best practice and expert judgment to interpret the threshold math, then use THIS account's own history as an adjuster of confidence. Facts stay account-first: every number/CPA/${OW.one} figure comes from this account's measured data (the outcome ledger for business facts; an exact ${OW.one}-id join for any paid figure), and an external tip can contextualize a question but never override an account fact. Conversions need ~50 optimization events/ad set/7 days to exit learning (Meta-published), but do not apply a budget-to-CPA industry heuristic while the account's target economics are unavailable. Treat Learning Limited as context, not proof of a required change. Describe the smallest unresolved decision and the evidence it would require; do not prescribe the change in this narrative.
8. **Align the platform objective and performance goal to a measurable downstream event.** This helps Meta optimize delivery; it does not replace Maxx's incremental-contribution north star. Traffic is for cases where the desired downstream action is genuinely hard to measure; it is not a substitute for a measurable lead or sale.
9. **Read Advantage+ audience fields correctly.** Location, language, minimum age, and custom-audience exclusions can be strict controls. Maximum age, gender, detailed targeting, lookalikes, and custom-audience inclusions may be suggestions. A warm seed plus lookalikes or expansion is mixed acquisition, not strict retargeting.
10. **Treat placements, consolidation, and bidding as conditional choices.** Advantage+ placements are a starting point when assets support them; document any business or asset restriction. Consolidate only ad sets doing the same job and fragmenting the same signal. Choose bidding from the governed KPI: automated maximum-results bidding prioritizes volume/spend, while cost and bid controls trade delivery freedom for control and require valid economics. No bid strategy is a universal default.
11. **Attribution settings define measurement.** Never change or reinterpret an attribution window to make performance appear better, and never compare periods across a definition break as though the metric stayed constant.

## Metric Naming (always use these exact names)
- impressions → Impressions
- clicks (all) → Clicks (all)
- inline_link_clicks → Link Clicks
- landing_page_view action → Landing Page Views
- ctr → CTR (all)
- inline_link_click_ctr → Outbound CTR
- cpm → CPM
- cpc → CPC (all)
- frequency → Frequency
- spend → Amount Spent
- video_thruplay → ThruPlays (a 15-second view, or a full play of a shorter video)
- video_p25/p50/p75/p100 → Retention 25%/50%/75%/Completion. These are RETENTION MILESTONES: the share reaching that percentage of the video's LENGTH. On a 60-120 second creative the 25% milestone is roughly 15-30 seconds of watch time.
- **NEVER call video_p25 a "3-second view", a "hook", or "scroll-stopping".** Meta's batch insights edge exposes NO three-second-view field. The only honest early-view signals are video STARTS (video_play_actions) and continuous 2-second views; when neither is present the early-view rate is **unavailable** and must be reported as unavailable — never as 0%, and never substituted with p25.
- Do not compare a milestone or completion rate across creatives of different LENGTH as if it were the same metric: 25% of a 15s video and 25% of a 125s video are different questions. State the length, or say the length is unknown and lower confidence.
- If a derived video rate is flagged unreliable (its raw relationship was impossible, e.g. above 100%), say so and do not quote it as a measurement.
- reach → Reach (never use "people" for audience size — use "accounts" or the raw number)
- ${EVENT} → ${EVENT} (do not rename custom events)
- lead action → Lead

## Report Rules
- Be direct. Use actual numbers. No filler phrases ("It's worth noting...", "Additionally...", "In conclusion...").
- Be candid about problems. Say what's wrong plainly.
- This LLM-authored section is DIAGNOSTIC ONLY. Explain observations, evidence quality, conflicts, unknowns, and measurements needed next. Do not originate, rewrite, prioritize, or imply an action, task, test, budget move, pause, activation, targeting change, creative change, or structural change.
- Only the deterministic Governed Recommendations appendix, rendered after this narrative from persisted ActionDecision rows, may contain owner-review or execution-eligible language. Do not reproduce that language in the narrative.
- Use external best practice and expert/competitor signals only to explain context or name a question worth measuring. They never grant action authority.
- Write like someone who manages this account daily and has context on what happened last week, not a first-time auditor.
- Tone: confident, direct, human. Not corporate. Not over-polished.

## Evidence Interpretation Gate
The narrative may describe an apparent opportunity or risk only when the evidence below supports the observation. It still may not convert that observation into an action. Check all of these before describing a result confidently:
1. The observation window satisfies its declared attribution/maturity contract and did not cross a measurement-definition break. 2. Data is fresh and the observation unit is named. 3. The metric has a named source. 4. Booked value comes from the outcome ledger, and any paid-touch figure from an exact ${OW.one}-id join — never from a Meta estimate and never from GA confirmation events (if it's a Meta estimate, say "estimate"; if the exact join is unavailable, say "unavailable", never "0"). Paid-touch association still is not causal incrementality. 5. Incremental contribution requires processor-settled collections, payment fees, governed variable costs, ad spend, maturity, uncertainty and a controlled or defensible quasi-experimental comparison; otherwise it is unavailable. 6. Uncertainty is reported for count-derived rates; no fixed 3-${OW.one}, 5-${OW.one}, one-week, or learning-exit shortcut makes a verdict decisive. 7. The current setup and last material change are read back, not inferred from names. 8. Conflicting planes remain separate and lower confidence; neither Meta modelled attribution nor GA telemetry is business truth. 9. External best practice may contextualize a question, never assert an account action. 10. Learning state is reported separately from decision sufficiency. 11. State the risk if wrong and the evidence still missing.
For each material observation, state: observed fact + numbers + source + date range, confidence (high/medium/low) and why, what could make it wrong, and what evidence is still missing. Add a low-data / estimate / attribution warning whenever it applies.

## Sections Required (use these exact ## headers)
## Executive Summary
## What Changed vs Yesterday
## Spend & Performance Breakdown
## Audience and Targeting Evidence
## Campaign Evidence
## Diagnostic Alerts
## Questions and Measurements Needed

An "OWNER DECISION MEMORY" block may be provided in the data. It is the human's standing record: decisions on past recommendations (rejected/snoozed/acted-on), manual actions taken in Ads Manager, unresolved setting conflicts, and lessons awaiting review. Use it as context, but do not turn it into a new instruction. The report generator does not accept or persist LLM-authored tasks.` as const

export function buildUserMessage(data: ReportInputData): string {
  const fmt = (n: number | null, prefix = '$', decimals = 2): string =>
    n !== null ? `${prefix}${n.toFixed(decimals)}` : 'N/A'

  const pct = (n: number | null): string =>
    n !== null ? `${n.toFixed(2)}%` : 'N/A'

  const num = (n: number): string => n.toLocaleString()

  // Derive the blended revenue ratio beside the two source amounts instead of accepting a detached
  // precomputed value. This makes an impossible pairing such as $0 checkout revenue and 12x MER
  // unrepresentable on the report surface.
  const amountPaidComplete30 = data.outcomes != null
    && data.outcomes.amountPaidCoverage30.withRecordedAmount === data.outcomes.amountPaidCoverage30.total
  const metaSpend30 = data.outcomes?.metaSpend30 ?? null
  const hasAuthoritativeMetaSpend30 = typeof metaSpend30 === 'number'
    && Number.isFinite(metaSpend30)
    && metaSpend30 > 0
  const revenueMer30 = data.outcomes && amountPaidComplete30 && hasAuthoritativeMetaSpend30
    ? data.outcomes.observedCollectedValue30 / metaSpend30
    : null

  const campaignRows = data.topCampaigns
    .map(
      (c, i) =>
        `${i + 1}. "${c.name}" | Status: ${c.status} | Spend: ${fmt(c.spend)} | Leads: ${c.leads} | ` +
        `CPA: ${fmt(c.cpl)} | CTR: ${pct(c.ctr)} | Freq: ${c.frequency?.toFixed(2) ?? 'N/A'}`
    )
    .join('\n')

  const alertRows = data.alerts.length > 0
    ? data.alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.title} — ${a.message} (${a.entity})`).join('\n')
    : 'None'

  const prevDayBlock = data.prevDayInsights
    ? [
        'Previous Day:',
        `  Amount Spent: ${fmt(data.prevDayInsights.spend)} | Leads: ${data.prevDayInsights.leads} | Meta-attributed ${EVENT}: ${data.prevDayInsights.bookings}`,
        `  Meta-modelled cost per ${EVENT}: ${fmt(data.prevDayInsights.cpb)} | CPL: ${fmt(data.prevDayInsights.cpl)} | CTR: ${pct(data.prevDayInsights.ctr)} | CPM: ${fmt(data.prevDayInsights.cpm)}`,
      ].join('\n')
    : 'Previous Day: No data'

  const prev7DayBlock = data.prev7dayInsights
    ? [
        '7-Day Average (daily avg):',
        `  Amount Spent: ${fmt(data.prev7dayInsights.spend)} | Leads: ${data.prev7dayInsights.leads.toFixed(1)} | Meta-attributed ${EVENT}: ${data.prev7dayInsights.bookings.toFixed(1)}`,
        `  Meta-modelled cost per ${EVENT}: ${fmt(data.prev7dayInsights.cpb)} | CPL: ${fmt(data.prev7dayInsights.cpl)} | CTR: ${pct(data.prev7dayInsights.ctr)} | CPM: ${fmt(data.prev7dayInsights.cpm)}`,
      ].join('\n')
    : '7-Day Average: No data'

  const ga4Block = data.ga4
    ? [
        `=== GA4 CONFIRMATION-EVENT TELEMETRY — WEB ATTRIBUTION ONLY, NOT ${OW.many.toUpperCase()} AND NOT MONEY ===`,
        `These are GA event counts and GA event VALUES for the confirmation event. They carry NO ${OW.one}`,
        `identity, so they may double-count a single ${OW.one} and report a`,
        `comp at its NOMINAL price. They are NOT ${OW.many}, NOT revenue, and NOT a basis for CPA, ROAS or MER.`,
        `Business counts and booked value are in the ${OW.one.toUpperCase()} TRUTH block; use those.`,
        `  Paid, today (${data.date}): ${data.ga4.todayPaidConfirmationEvents} confirmation event(s), ${fmt(data.ga4.todayPaidEventValue)} GA event value`,
        `  Paid, last 30 days: ${data.ga4.paidConfirmationEvents30} confirmation event(s), ${fmt(data.ga4.paidEventValue30)} GA event value`,
        `  Organic, today: ${data.ga4.todayOrganicConfirmationEvents} event(s), ${fmt(data.ga4.todayOrganicEventValue)} GA event value`,
        `  Organic, last 30 days: ${data.ga4.organicConfirmationEvents30} event(s), ${fmt(data.ga4.organicEventValue30)} GA event value`,
        `  Zero-value events (30d): ${data.ga4.zeroValueEvents30}`,
        'Meta paid ROAS is NOT stated here. GA paid-channel sessions do not prove Meta was the platform,',
        'and Meta view-through outcomes cannot carry a GA session attribution.',
        '',
      ].join('\n')
    : `GA4 telemetry was UNAVAILABLE for this run. That is UNAVAILABLE, not zero: it says nothing about how many ${OW.many} occurred. Business counts and booked value in the ${OW.one.toUpperCase()} TRUTH block are unaffected.\n`

  const outcomeBlock = data.outcomes
    ? [
        `=== OUTCOME LEDGER — BUSINESS TRUTH (${OW.many}, booked value, and amount paid on active ${OW.many}) ===`,
        'VOCABULARY — use these words exactly; they are three different counts, not synonyms:',
        `  confirmed ${OW.many}  = active ${OW.many}, value-bearing AND zero-value`,
        `  value-bearing ${OW.many}  = active AND charged a price (the only class carrying booked value)`,
        `  zero-value ${OW.many} = active AND charged nothing. A REAL ${OW.one}: package, gift`,
        '                            certificate, staff block, comp or test. The ledger CANNOT tell those',
        '                            apart, so NEVER call one a test.',
        `  Today (${data.date}): ${data.outcomes.todayConfirmedAppointments} confirmed ${OW.one}(s) — ${data.outcomes.todayValueBearingBookings} value-bearing, ${data.outcomes.todayZeroValueAppointments} zero-value; ${data.outcomes.todayRecordedOutcomeValue === null ? `amount paid on active ${OW.many} UNAVAILABLE (${data.outcomes.todayAmountPaidCoverage.withRecordedAmount}/${data.outcomes.todayAmountPaidCoverage.total} active ${OW.many} have amount_paid; observed lower bound ${fmt(data.outcomes.todayObservedCollectedValue)})` : `${fmt(data.outcomes.todayRecordedOutcomeValue)} amount paid on active ${OW.many}`}; ${fmt(data.outcomes.todayBookedValue)} scheduled booked value`,
        `  Last 30 days: ${data.outcomes.confirmedAppointments30} confirmed ${OW.one}(s) — ${data.outcomes.valueBearingBookings30} value-bearing, ${data.outcomes.zeroValueAppointments30} zero-value; ${fmt(data.outcomes.bookedValue30)} booked value`,
        amountPaidComplete30
          ? `  Amount paid on active ${OW.many} (30d) = ${fmt(data.outcomes.observedCollectedValue30)} across ${data.outcomes.amountPaidCoverage30.withRecordedAmount}/${data.outcomes.amountPaidCoverage30.total} active ${OW.many}.`
          : `  Amount paid on active ${OW.many} (30d) = UNAVAILABLE because amount_paid exists for only ${data.outcomes.amountPaidCoverage30.withRecordedAmount}/${data.outcomes.amountPaidCoverage30.total} active ${OW.many}. Observed amount_paid lower bound = ${fmt(data.outcomes.observedCollectedValue30)}; never use this lower bound for a return ratio or a budget decision.`,
        `  Active-${OW.one} amount/spend ratio (30d) = ${revenueMer30 !== null ? revenueMer30.toFixed(2) + 'x' : 'UNAVAILABLE'}  (requires complete recorded amount_paid coverage and authoritative Meta spend; all sources, not paid ROAS or net settled revenue)`,
        `  This is the canonical TOTAL across all sources (paid + organic + phone + manual), so it measures a DIFFERENT POPULATION than GA4 (web-only) or Meta (ad-attributed modelled). State the populations and the observed values; do not assert a fixed direction between them, and if a difference is not explained by the VALUE RECONCILIATION block, call it unexplained. Use THIS for how the studio actually did. Ad performance is judged from Meta delivery plus any EXACT ${OW.one}-id joined paid outcome — never from the GA telemetry block below.`,
        '',
      ].join('\n')
    : ''

  // The row-level reconciliation block, rendered ABOVE the money blocks so the model reads the
  // evidence states before the numbers they qualify. Absent when the read produced nothing.
  const reconciliationBlock =
    data.reconciliation && data.reconciliation.length > 0 ? `${data.reconciliation.join('\n')}\n` : ''

  // A provenance legend rendered ABOVE every metric, so the model cannot reinterpret a blended /
  // account-level / organic / estimated figure as a paid campaign-level ROAS. The last rule is the one
  // not stated elsewhere in this prompt.
  const provenanceLegend = [
    '=== METRIC PROVENANCE — READ BEFORE QUOTING ANY NUMBER ===',
    `• outcome ledger = BUSINESS TRUTH. Confirmed ${OW.many} / value-bearing ${OW.many} / zero-value ${OW.many} / booked value / amount paid on active ${OW.many} are distinct numbers — use the exact term. Owner-excluded post-sale exception topics stay out of this reporting. A zero-value ${OW.one} is a REAL ${OW.one} that charged nothing; never call it a test.`,
    `• GA4 aggregate rows = CONFIRMATION-EVENT TELEMETRY, never ${OW.many} and never money. These aggregate rows carry no ${OW.one} identity; only the separate exact reconciliation may use ID-bearing underlying events when coverage is complete.`,
    `• An exact ${OW.one}-id join can establish a GA session-attributed association, but GA Paid Social does not prove Meta platform provenance and misses Meta view-through outcomes. Never call that quotient exact Meta paid ROAS.`,
    `• Blended active-${OW.one} amount/spend ratio = recorded amount_paid on active ${OW.many} (all sources, incl. organic) ÷ authoritative account-level Meta spend for the same window — ACCOUNT-LEVEL and NOT paid performance.`,
    `  Do NOT attribute the blended ratio, account-level active ${OW.one} amount, or organic value to any single campaign/ad set/ad,`,
    '  and NEVER present any of them as a paid CAMPAIGN-LEVEL ROAS.',
    '• Meta Results / cost per Result = MODELLED ATTRIBUTION. Modelled attribution can UNDER- or OVER-attribute relative to business truth; never state a fixed direction. Meta value-derived return fields are withheld from this prompt; do not infer them.',
    `• Server-side CAPI delivery is proven only by accepted event-level response lineage with the declared deduplication identity. An enabled flag or parent sent timestamp does not prove receipt, and a handful of accepted events does not mean Meta received all ${OW.many}. Treat any coverage discontinuity as measurement until independently shown otherwise.`,
    '• A per-campaign Meta return claim also requires verified Meta platform provenance. A GA Paid Social label plus a matching campaign name is not enough; GA coverage percentage alone never makes it valid.',
    '• If you cannot tell paid-vs-organic or actual-vs-estimate for a figure, say so and lower confidence.',
    '',
  ].join('\n')

  const learningsBlock = data.learnings
    ? `=== WHAT THE SYSTEM HAS LEARNED (weight this heavily) ===\n${data.learnings}\n\n`
    : ''

  const decisionMemoryBlock = data.decisionMemory
    ? `=== OWNER DECISION MEMORY (respect standing decisions; explain any change of guidance) ===\n${data.decisionMemory}\n\n`
    : ''

  // Approved external knowledge: cited INSPIRATION only — it can inform framing or suggest a labeled
  // test, but it never overrides an account fact and never raises confidence (mirrors the rec builder).
  const expertKnowledgeBlock = data.expertKnowledge
    ? `=== APPROVED EXPERT KNOWLEDGE (cited inspiration — NEVER a fact source; account data always wins) ===\n${data.expertKnowledge}\n\n`
    : ''

  // The structured engine's open recommendations — context only for the narrative. The application
  // renders their ActionDecision copy separately; the model cannot add, rewrite, or duplicate it.
  const openRecsBlock = data.openRecommendations
    ? `=== OPEN STRUCTURED RECOMMENDATIONS (governed context only; durable ActionDecision copy renders separately — don't duplicate, reproduce, or rewrite it) ===\n${data.openRecommendations}\n\n`
    : ''

  return `Generate a daily Meta Ads performance review for ${promptBusiness().name}.

DATE: ${data.date}
ACCOUNT: ${data.accountName}
CURRENCY: ${data.currency}
CAMPAIGNPLAN: not provided to this report. Objective, optimization event, audience, destination, CTA, budget, attribution, and economic fit are not established.
BUSINESS/PAGE CONTEXT: not provided to this report. Treat synced setup and performance as observations, not approval of the configured strategy.

DATA CAVEAT: the ${EVENT} count below is Meta modelled attribution, not recorded ${OW.many}. Meta value-derived return fields are withheld. Do not infer ${OW.one} value, revenue, or ROAS from Meta pixel value fields; reconcile performance against the outcome source and exact paid-touch evidence when available. When the sample is small or data is incomplete, say so and lower your confidence.

${provenanceLegend}${reconciliationBlock}${outcomeBlock}${ga4Block}
=== TODAY'S ACCOUNT TOTALS (Meta — attribution estimate) ===
Amount Spent: ${fmt(data.accountInsights.spend)}
${EVENT} (Meta-attributed event count): ${data.accountInsights.bookings}${
    data.accountInsights.bookingsViewThrough != null && data.accountInsights.bookings > 0
      ? ` — ${data.accountInsights.bookingsViewThrough} of ${data.accountInsights.bookings} VIEW-THROUGH (1d_view: saw the ad, didn't click). A view-through has no click for GA4 to attribute, so a view-through-heavy Meta count is ONE possible explanation of a Meta-vs-GA4 gap. It is NOT a proof that instrumentation is healthy: only the VALUE RECONCILIATION block, which checks delivery and lineage row by row, can rule out a delivery or tagging failure. Never say the gap is "one possible explanation — only the VALUE RECONCILIATION block can rule out a delivery or tagging failure" unless that block shows delivery is intact.`
      : ''
  }
Leads: ${data.accountInsights.leads}
Meta-modelled cost per ${EVENT}: ${fmt(data.accountInsights.cpb)}
CPL (cost per Lead): ${fmt(data.accountInsights.cpl)}
Impressions: ${num(data.accountInsights.impressions)}
Reach: ${num(data.accountInsights.reach)} accounts
CTR (all): ${pct(data.accountInsights.ctr)}
CPM: ${fmt(data.accountInsights.cpm)}

=== DAY-OVER-DAY COMPARISON ===
${prevDayBlock}

${prev7DayBlock}

=== CAMPAIGNS BY SPEND (today) ===
${campaignRows || 'No campaign data. Run a sync first.'}

${learningsBlock}${decisionMemoryBlock}${expertKnowledgeBlock}${openRecsBlock}=== ACTIVE ALERTS ===
${alertRows}

Instructions:
- Describe only the campaign fields and evidence actually supplied. Never infer audience, funnel stage, or campaign intent from a name.
- Missing CampaignPlan or business/page context is an unavailable-evidence state, not proof of a setup gap.
- Produce diagnostic analysis only. Do not output tasks, action bullets, instructions, or a tasks JSON block.
- Do not restate any governed recommendation as your own advice. The application renders its durable ActionDecision copy separately.`
}
