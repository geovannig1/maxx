import { roundMoney } from '@/lib/utils/format-currency'
import { ToolInputError, logToolError } from '@/lib/security/api-error'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { resolveClosedDateRange } from '@/lib/dashboard/closed-date-range'
import { isMetaPaidChannel } from '@/lib/ga4/client'
import { buildGa4ReconciliationBlock, exactPaidEvidence } from '@/lib/ga4/booking-reconciliation'
import { resolveAdAccountId } from '@/lib/outcomes/ledger-account'
import { loadEconomicsInputs } from '@/lib/economics/settings'
import { CHAMPION_BENCHMARK } from '@/lib/economics/champion'
import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { readAccountSpendWindow, type AccountSpendWindowSummary } from '@/lib/economics/ad-spend-reader'
import { accountDateRangeToHalfOpenInstants } from '@/lib/economics/account-date-window'
import { readGovernedEconomicsPolicy } from '@/lib/economics/economics-policy-reader'
import { readProcessorSettlementWindow } from '@/lib/economics/settlement-reader'
import { readVariableCostWindow } from '@/lib/economics/variable-cost-reader'
import { readPaidTouchAdAssignments } from '@/lib/economics/paid-touch-assignment-reader'
import { buildObservedContributionView, type ObservedContributionView } from '@/lib/economics/observed-contribution'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// MCP tool: the PROFIT view. Read-only.
//
// This tool used to treat GA paid-channel eventCount as canonical money and computed
// CPA and the whole profit view from it. Those events carry NO appointment identity, so they cannot be
// deduplicated, checked against cancel state, or valued — a canceled comp reporting its nominal price
// counted as a paid booking. Paid CPA now requires EXACT appointment-id evidence and is UNAVAILABLE
// without it. Unavailable is not zero, and GA telemetry is not a fallback.

function historicalChampionAuditContext() {
  return {
    ...CHAMPION_BENCHMARK,
    context_status: 'historical_audit_only' as const,
    action_authority: 'none' as const,
    current_policy: false as const,
    warning:
      'Historical Meta-attributed performance under different measurement conditions. It is not a current target, scaling rule, or money authority.',
  }
}

export interface EconomicsArgs {
  window_days?: number
  start_date?: string
  end_date?: string
}

export async function getEconomics(args: EconomicsArgs): Promise<object> {
  const hasStart = args?.start_date !== undefined
  const hasEnd = args?.end_date !== undefined
  if (hasStart !== hasEnd) throw new ToolInputError('Economics start_date and end_date must be provided together.')
  if (hasStart && args.window_days !== undefined) {
    throw new ToolInputError('Economics accepts either an explicit date range or window_days, not both.')
  }
  const requestedWindowDays = args?.window_days ?? 30
  if (!Number.isSafeInteger(requestedWindowDays)) {
    throw new ToolInputError('Economics window_days must be an integer.')
  }
  const windowDays = Math.min(Math.max(requestedWindowDays, 7), 90)
  const explicitRange = hasStart && hasEnd
    ? resolveClosedDateRange(args.start_date, args.end_date)
    : null
  const start = explicitRange?.start ?? nyDaysAgo(windowDays)
  // Default to YESTERDAY (last complete calendar day). A caller with a proven older warehouse
  // boundary supplies an explicit range so Meta, the outcome source and GA4 stay on the same closed population.
  const end = explicitRange?.end ?? nyDaysAgo(1)
  const reportedWindowDays = explicitRange
    ? Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1
    : windowDays
  const asOf = new Date().toISOString()
  const ledgerWindow = accountDateRangeToHalfOpenInstants({ start, end })

  // Every quantity below starts as NULL. The previous version initialised spend and the
  // business facts to 0, ignored the Supabase `error` result (Supabase does NOT throw on a failed
  // read, so a failure became "available, $0"), and did not scope spend to the account. The result was
  // a confident zero-everything economic narrative at exactly the moment the tool should fail closed.
  const adAccountDbId = await resolveAdAccountId().catch(() => null)
  let db: ReturnType<typeof getAdminClient> | null = null
  let databaseUnavailableReason: string | null = null
  if (adAccountDbId) {
    try {
      db = getAdminClient()
    } catch (err) {
      databaseUnavailableReason = logToolError('get_economics', 'ECONOMICS_DATABASE_UNAVAILABLE', err)
    }
  }

  let spend: number | null = null
  let spendUnavailableReason: string | null = null
  let spendWindow: AccountSpendWindowSummary = {
    status: 'unavailable', totalSpend: null, dayCount: null,
    blockerCodes: ['meta_spend_account_missing'],
  }
  if (!adAccountDbId || !db) {
    spendUnavailableReason = !adAccountDbId
      ? 'no active ad account resolved'
      : `database unavailable: ${databaseUnavailableReason}`
  } else {
    try {
      spendWindow = await readAccountSpendWindow(db, adAccountDbId, { start, end }, asOf)
      if (spendWindow.status === 'available') {
        spend = Number(spendWindow.totalSpend)
      } else {
        spendUnavailableReason = spendWindow.blockerCodes.join(', ')
      }
    } catch (err) {
      spendUnavailableReason = logToolError('get_economics', 'ECONOMICS_SPEND_READ_FAILED', err)
      spendWindow = {
        status: 'unavailable', totalSpend: null, dayCount: null,
        blockerCodes: ['meta_spend_source_read_failed'],
      }
    }
  }

  // An appointment-id join can make the outcome-source value exact for a GA Paid Social session association.
  // It cannot establish Meta platform identity or recover Meta view-through outcomes, so it never
  // supplies a Meta CPA/ROAS denominator pairing.
  let sessionAssociated: { valueBearingBookings: number; bookedValue: number; recordedRevenue: number } | null = null
  let attributionScope = 'unavailable'
  let scopeReason: string | null = 'not evaluated'
  let confirmedAppointments: number | null = null
  let bookedValue: number | null = null
  let recordedRevenue: number | null = null
  let recordedAmountPaidLowerBound: number | null = null
  let amountPaidCoverage: { withRecordedAmount: number; total: number } | null = null
  let businessUnavailableReason: string | null = adAccountDbId ? null : 'no active ad account resolved'
  if (adAccountDbId) {
    try {
      const { reconciliation } = await buildGa4ReconciliationBlock(adAccountDbId, start, end)
      attributionScope = reconciliation.scope
      scopeReason = reconciliation.scopeReason
      if (reconciliation.business === null) {
        // The reconciler now reports a ledger OUTAGE explicitly instead of returning empty facts, so
        // this branch exists and is reachable. Previously the zeros arrived as a valid object and were
        // presented as outcome-source facts.
        businessUnavailableReason = reconciliation.businessUnavailableReason ?? 'the outcome ledger could not be read'
      } else {
        confirmedAppointments = reconciliation.business.confirmedAppointments
        bookedValue = reconciliation.business.bookedValue
        recordedRevenue = reconciliation.business.recordedOutcomeValue
        recordedAmountPaidLowerBound = reconciliation.business.observedCollectedValue
        amountPaidCoverage = reconciliation.business.amountPaidCoverage
      }
      sessionAssociated = recordedRevenue !== null
        ? exactPaidEvidence(reconciliation, isMetaPaidChannel)
        : null
    } catch (err) {
      // BUSINESS availability is separate from ATTRIBUTION availability: a failed ledger read must not
      // be reported as a ledger-sourced zero.
      businessUnavailableReason = logToolError('get_economics', 'ECONOMICS_LEDGER_READ_FAILED', err)
      scopeReason = `reconciliation failed: ${businessUnavailableReason}`
    }
  }

  const economicsInputs = await loadEconomicsInputs()
  let contribution: ObservedContributionView | null = null
  let contributionBlockers: string[] = []
  let contributionUnavailableReason: string | null = null
  if (!adAccountDbId || !db) {
    contributionBlockers = [adAccountDbId ? 'economics_database_unavailable' : 'ad_account_missing']
  } else {
    try {
      const policy = await readGovernedEconomicsPolicy(db, adAccountDbId, ledgerWindow.start, asOf)
      if (policy.status === 'unavailable') {
        contributionBlockers = [...policy.blockerCodes, ...spendWindow.blockerCodes]
      } else {
        const [settlement, variableCosts] = await Promise.all([
          readProcessorSettlementWindow(
            db, adAccountDbId, ledgerWindow, asOf, policy.settlementSource,
          ),
          readVariableCostWindow(db, adAccountDbId, {
            policyId: policy.policyId,
            requiredCostSources: policy.requiredCostSources,
            allowedVariableCostCategories: policy.allowedVariableCostCategories,
            variableCostCategorySources: policy.variableCostCategorySources,
          }, ledgerWindow, asOf),
        ])
        const candidateOutcomeIds = [...new Set([
          ...settlement.events.flatMap((event) => (
            event.outcomeId === null ? [] : [event.outcomeId]
          )),
          ...variableCosts.events.map((event) => event.outcomeId),
        ])].sort()
        let paidTouchAssignments: Awaited<ReturnType<typeof readPaidTouchAdAssignments>> | null = null
        let paidTouchAssignmentBlockerCodes: string[] | undefined
        try {
          paidTouchAssignments = await readPaidTouchAdAssignments(
            db, adAccountDbId, candidateOutcomeIds, asOf,
          )
        } catch {
          paidTouchAssignmentBlockerCodes = ['paid_touch_assignment_source_read_failed']
        }
        contribution = buildObservedContributionView({
          settlement: settlement.summary,
          settlementEvents: settlement.events,
          variableCosts: variableCosts.summary,
          variableCostEvents: variableCosts.events,
          adSpend: spendWindow,
          paidTouchAssignments: paidTouchAssignments?.assignments,
          paidTouchAssignmentBlockerCodes,
          policyVersion: policy.policyHash,
        })
        if (contribution.observedBusinessContribution.status === 'unavailable') {
          contributionBlockers = contribution.observedBusinessContribution.blockerCodes
        } else if (contribution.adAttributedContribution.status !== 'available') {
          contributionBlockers = contribution.adAttributedContribution.blockerCodes
        }
      }
    } catch (err) {
      contributionBlockers = ['settled_contribution_source_read_failed']
      contributionUnavailableReason = logToolError('get_economics', 'ECONOMICS_CONTRIBUTION_READ_FAILED', err)
    }
  }

  // Observed account-total contribution is useful reconciliation, but it mixes paid and non-paid
  // collections. Payment-to-ad assignment and a causal comparator remain separate missing planes.
  const profitBlockers = [...new Set([
    ...contributionBlockers,
    'payment_to_experiment_assignment_missing',
    'causal_comparison_missing',
  ])].sort()
  const profitView = contribution
    ? {
        status: contribution.observedBusinessContribution.status === 'unavailable'
          ? 'unavailable' as const
          : contribution.adAttributedContribution.status === 'available'
            ? 'paid_touch_association_available' as const
            : contribution.adAttributedContribution.status === 'partial'
              ? 'paid_touch_association_partial' as const
              : 'observed_diagnostic_available' as const,
        reason_code: contribution.observedBusinessContribution.status === 'available'
          ? 'incremental_contribution_unavailable' as const
          : 'settled_contribution_unavailable' as const,
        north_star_status: 'unavailable' as const,
        action_authority: 'none' as const,
        north_star: MAXX_OWNER_PROFIT_POLICY.objective,
        daily_budget_ceiling: MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling,
        blocker_codes: profitBlockers,
        ...contribution,
        note:
          `Observed business contribution is account-total reconciliation. The paid-touch contribution view includes only ${OW.many} joined through immutable complete Meta identity; partial means missing links remain unclassified, never organic. Paid-touch association is not incrementality and grants no action authority.`,
      }
    : {
        status: 'unavailable' as const,
        reason_code: 'settled_contribution_unavailable' as const,
        north_star_status: 'unavailable' as const,
        action_authority: 'none' as const,
        north_star: MAXX_OWNER_PROFIT_POLICY.objective,
        daily_budget_ceiling: MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling,
        blocker_codes: profitBlockers,
        unavailable_reason:
          'Incremental contribution requires processor-settled collections excluding tax, payment fees, governed variable costs, complete account ad spend, payment-to-experiment assignment, and controlled or defensible quasi-experimental evidence. Missing sources are unavailable, never zero. Exact paid touch can describe association but is not a causal substitute. recorded booked value, recorded collected value, AOV/margin estimates, GA event value, and Meta action value are not substitutes.'
          + (contributionUnavailableReason ? ` Source read failed: ${contributionUnavailableReason}` : ''),
      }

  return {
    window: { start, end, days: reportedWindowDays },
    sources: {
      spend: spend !== null
        ? 'daily_insights (Meta, ACCOUNT-SCOPED, exact complete-day window)'
        : `UNAVAILABLE (${spendUnavailableReason})`,
      business_truth: businessUnavailableReason === null
        ? 'Outcome ledger (v_business_outcomes)'
        : `UNAVAILABLE (${businessUnavailableReason}) — the ledger was NOT read; nothing below is a ledger fact`,
      paid_attribution: sessionAssociated
        ? `GA4 Paid Social session association joined by ${OW.one} id and valued from recorded collected value; diagnostic only, NOT exact Meta paid attribution`
        : `UNAVAILABLE (${attributionScope}${scopeReason ? `: ${scopeReason}` : ''})`,
      settled_paid_touch_assignment: contribution?.adAttributedContribution.status === 'available'
        ? `EXACT immutable ${OW.one}-to-Meta-ad association`
        : contribution?.adAttributedContribution.status === 'partial'
          ? `PARTIAL exact positive-link association; unmatched ${OW.many} remain unclassified`
          : 'UNAVAILABLE (settled payment-to-ad assignment incomplete)',
    },
    business: businessUnavailableReason === null
      ? {
          confirmed_appointments: confirmedAppointments,
          booked_value: bookedValue === null ? null : roundMoney(bookedValue),
          outcome_recorded_checkout_revenue: recordedRevenue === null ? null : roundMoney(recordedRevenue),
          observed_amount_paid_lower_bound: recordedAmountPaidLowerBound === null
            ? null : roundMoney(recordedAmountPaidLowerBound),
          amount_paid_coverage: amountPaidCoverage,
          note: recordedRevenue === null
            ? 'Outcome ledger counts and booked value are available, but checkout revenue is UNAVAILABLE because amount_paid coverage is incomplete. observed_amount_paid_lower_bound is diagnostic only and must never be used for MER, ROAS, or a budget decision.'
            : `Outcome ledger facts. Checkout revenue is owner-confirmed amount_paid collected at checkout after discounts on active ${OW.many}. Booked value is the separate scheduled price.`,
        }
      : {
          confirmed_appointments: null,
          booked_value: null,
          outcome_recorded_checkout_revenue: null,
          unavailable_reason: `The outcome ledger could not be read (${businessUnavailableReason}). These are UNAVAILABLE, not zero. Do not describe business performance from this response.`,
        },
    paid: sessionAssociated
      ? {
          spend: spend === null ? null : roundMoney(spend),
          value_bearing_bookings: sessionAssociated.valueBearingBookings,
          booked_value: roundMoney(sessionAssociated.bookedValue),
          outcome_recorded_checkout_revenue: roundMoney(sessionAssociated.recordedRevenue),
          association_basis: 'ga4_paid_social_session_association' as const,
          action_authority: 'diagnostic_only' as const,
          cpa: null,
          revenue_roas: null,
          unavailable_reason:
            `Meta CPA and paid revenue ROAS are unavailable: GA Paid Social is a session association, not Meta platform identity, and Meta view-through outcomes are absent. Do not divide these associated ${OW.many} or amount_paid by Meta spend.`,
        }
      : {
          spend: spend === null ? null : roundMoney(spend),
          value_bearing_bookings: null,
          booked_value: null,
          outcome_recorded_checkout_revenue: null,
          cpa: null,
          revenue_roas: null,
          unavailable_reason: `Paid CPA, paid checkout revenue, and paid revenue ROAS require an EXACT ${OW.one}-id join between GA4 and the outcome ledger over a window fully covered by proven appointment_id identity and complete amount_paid coverage. Scope is ${attributionScope}${scopeReason ? ` (${scopeReason})` : ''}${amountPaidCoverage && amountPaidCoverage.withRecordedAmount !== amountPaidCoverage.total ? `; amount_paid coverage is ${amountPaidCoverage.withRecordedAmount}/${amountPaidCoverage.total}` : ''}. This is NOT a claim that paid produced zero ${OW.many} or revenue, and raw GA event counts must NOT be substituted.`,
        },
    economics_inputs: economicsInputs,
    profit_view: profitView,
    champion_benchmark: historicalChampionAuditContext(),
    note:
      `Business truth is the outcome ledger: amount_paid is owner-confirmed checkout revenue after discounts, while booked value is scheduled price. An exact ${OW.one}-id join may expose a GA Paid Social session association, but it is diagnostic only: other platforms may share that channel and Meta view-through is absent, so Meta CPA and paid revenue ROAS remain UNAVAILABLE. Without ${OW.one} identity, even that session association is unavailable, never zero and never backfilled from GA event counts. ` +
      `Observed business contribution is emitted only when settlement, fee, governed variable-cost, and exact complete-day spend sources reconcile. It is account-total and noncausal. Exact paid-touch contribution is a positive-link association diagnostic; unmatched ${OW.many} remain unclassified and are never inferred organic. Incremental contribution stays UNAVAILABLE until governed experiment assignment and comparison evidence are complete. Existing app_settings AOV/margin inputs are unversioned planning scenarios, not realized profit or action authority. ` +
      `The champion is historical audit context only, never current policy or a scaling rule. Never quote Meta pixel ${OW.many} as money; never credit organic or MER to campaigns.`,
  }
}
