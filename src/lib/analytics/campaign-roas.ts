import { getAdminClient } from '@/lib/supabase/admin'
import { getGa4ConfirmationTelemetryByCampaign, getGa4ConfirmationTelemetryBySource, isMetaPaidChannel } from '@/lib/ga4/client'
import { buildGa4ReconciliationBlock, exactPaidEvidence, type AttributionScope } from '@/lib/ga4/booking-reconciliation'
import { readAccountSpendWindow } from '@/lib/economics/ad-spend-reader'
import { formatMoney } from '@/lib/utils/format-currency'

// ROAS was GA4 eventValue / Meta spend and was labelled ACTUAL. GA eventValue is the value
// the SCHEDULER DISPLAYED for an event with no appointment identity — it cannot be deduplicated,
// checked against ledger lifecycle state, or reconciled to a charged amount. A campaign-level RESULT now
// requires an exact appointment-id join valued from the LEDGER. Without it every roas field is null
// with a stated reason: unavailable, never zero, and never backfilled from GA telemetry.
//
// The GA telemetry below is RETAINED as attribution context and is named for what it is
// (confirmation events / event value). The normalized-name matcher still maps a GA campaign label to
// a Meta campaign, but that is a LABEL mapping — it can never turn an unlinked GA event into a
// business booking.
// GA4's campaign value is whatever utm_campaign the ad carried; it rarely equals the Meta campaign
// name exactly. We match by a normalized token-subset rule with a uniqueness guard, so a slug like
// "weekday_portrait_sessions" maps to the one Meta campaign whose name contains those tokens, and
// anything ambiguous or placeholder is left UNATTRIBUTED rather than assigned a wrong ROAS.

/** How much of account spend may be unaccounted for by campaign rows before per-campaign ratios are
 *  withheld. Small enough that a missing campaign-day is caught; loose enough to tolerate rounding. */
export const CAMPAIGN_SPEND_TOLERANCE = 0.02

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'your', 'our'])
const GA4_PLACEHOLDERS = new Set(['(not set)', '(direct)', '(referral)', '(organic)', '(none)', '(unknown)', ''])

/** Significant tokens of a campaign name/slug: lowercase, alphanumeric, length >= 3, no stopwords. */
export function campaignTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  )
}

function isSubset(sub: Set<string>, sup: Set<string>): boolean {
  if (sub.size === 0) return false
  for (const t of sub) if (!sup.has(t)) return false
  return true
}

/**
 * Match a GA4 utm_campaign value to one Meta campaign name. Returns the matched name, or null when
 * it is a GA4 placeholder, matches nothing, or matches more than one (ambiguous → unattributed).
 * Exported for tests.
 */
export function matchGa4Campaign(ga4Value: string, metaCampaignNames: string[]): string | null {
  if (GA4_PLACEHOLDERS.has(ga4Value.toLowerCase())) return null
  const gtok = campaignTokens(ga4Value)
  if (gtok.size === 0) return null
  const matches = metaCampaignNames.filter((name) => isSubset(gtok, campaignTokens(name)))
  return matches.length === 1 ? matches[0] : null
}

export interface CampaignRoasRow {
  campaign_name: string
  meta_spend: number
  meta_bookings_est: number
  /** GA confirmation-event telemetry. NOT bookings. */
  ga4_confirmation_events: number
  /** GA eventValue telemetry. NOT revenue and NOT booked value. */
  ga4_event_value: number
  /** LEDGER booked value from EXACT appointment-id joins, or null when no exact evidence exists. */
  exact_booked_value: number | null
  /** Outcome-source amount_paid on active appointments from the same joins, or null when incomplete. */
  exact_checkout_revenue: number | null
  /** Exact value-bearing bookings joined to this campaign, or null without exact evidence. */
  exact_value_bearing_bookings: number | null
  /** exact_checkout_revenue / meta_spend. NULL unless exact evidence exists. */
  roas: number | null
}

export interface PerCampaignRoas {
  ga4Available: boolean
  reason?: string
  rows: CampaignRoasRow[]
  /** True only when the campaign rows reconcile to account spend within tolerance. */
  campaign_spend_complete: boolean
  campaign_spend_reason: string | null
  /** Which spend figure the denominators used. A campaign-row sum can understate account spend, which
   *  would INFLATE every ratio built on it, so a degraded basis blocks money authority. */
  spend_basis: 'account_level_insights' | 'campaign_row_sum' | 'account_level_window_incomplete'
  /** False when at least one exact paid booking could not be mapped to a single Meta campaign. */
  campaign_mapping_complete: boolean
  campaign_mapping_reason: string | null
  /** Why ROAS is or is not computable. Every consumer must render this, not a zero. */
  attribution_scope: AttributionScope
  attribution_scope_reason: string | null
  unattributed: { ga4_confirmation_events: number; ga4_event_value: number }
  account: {
    meta_spend: number
    ga4_confirmation_events: number
    ga4_event_value: number
    /** Active-appointment amount_paid (all sources) / complete Meta spend; never paid performance. */
    mer: number | null
    mer_basis?: string
    revenue_coverage_complete: boolean
    revenue_coverage_reason: string | null
  }
  attributed_share: number | null // fraction of GA confirmation EVENTS tied to a named campaign
  /** Paid outcome block. ROAS is null unless the complete exact appointment join and authoritative
   *  spend contract are satisfied; GA fields remain telemetry context only. */
  paid: {
    ga4_confirmation_events: number
    ga4_event_value: number
    /** Exact ledger-linked paid figures, or null. */
    exact_value_bearing_bookings: number | null
    exact_booked_value: number | null
    exact_checkout_revenue: number | null
    /** NULL unless exact. */
    roas: number | null
    /** GA Paid Social is a session channel, not proof that Meta was the paid platform. */
    attribution_reason: string
  }
  /** Of the window's Meta-attributed bookings, the share that were 1d_view view-through (saw the ad,
   *  didn't click). View-throughs can NEVER carry GA4 campaign attribution — the structural reason
   *  per-campaign GA4 ROAS stays sparse on a view-through-heavy account. Null until the per-window
   *  breakdown is synced (`daily_insights.bookings_view_through`). */
  meta_view_through_share: number | null
}

export async function getPerCampaignRoas(
  adAccountDbId: string,
  startDate: string,
  endDate: string
): Promise<PerCampaignRoas> {
  const db = getAdminClient()

  // Meta spend + Meta-attributed bookings (est) by campaign for the window.
  const campaignInsightResult = await db
    .from('daily_insights')
    .select('meta_campaign_id, spend, bookings, bookings_view_through')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'campaign')
    .gte('date_start', startDate)
    .lte('date_start', endDate)
  if (campaignInsightResult.error) {
    throw new Error(`campaign insights read failed: ${campaignInsightResult.error.message}`)
  }
  const rows = campaignInsightResult.data

  const metaAgg = new Map<string, { spend: number; bookings: number }>()
  let metaBookingsTotal = 0
  let metaViewThroughTotal: number | null = null
  for (const r of rows ?? []) {
    const id = r.meta_campaign_id as string | null
    if (!id) continue
    const a = metaAgg.get(id) ?? { spend: 0, bookings: 0 }
    a.spend += Number(r.spend ?? 0)
    a.bookings += Number(r.bookings ?? 0)
    metaAgg.set(id, a)
    metaBookingsTotal += Number(r.bookings ?? 0)
    // Null-aware: only rows with the per-window breakdown count toward the share.
    if (r.bookings_view_through != null) metaViewThroughTotal = (metaViewThroughTotal ?? 0) + Number(r.bookings_view_through)
  }
  const metaViewThroughShare =
    metaViewThroughTotal != null && metaBookingsTotal > 0 ? metaViewThroughTotal / metaBookingsTotal : null

  const ids = [...metaAgg.keys()]
  const nameById = new Map<string, string>()
  if (ids.length > 0) {
    const { data: camps } = await db.from('campaigns').select('campaign_id, campaign_name').in('campaign_id', ids)
    for (const c of camps ?? []) nameById.set(c.campaign_id as string, (c.campaign_name as string) ?? (c.campaign_id as string))
  }
  const metaCampaigns = ids.map((id) => ({
    id,
    name: nameById.get(id) ?? id,
    tokens: campaignTokens(nameById.get(id) ?? id),
    spend: metaAgg.get(id)!.spend,
    bookings: metaAgg.get(id)!.bookings,
  }))
  // Account spend was SUMMED FROM CAMPAIGN ROWS. A campaign missing from the sync (or one
  // whose rows failed to ingest) shrinks the denominator and inflates both paid ROAS and blended MER.
  // The account-level insight row is authoritative; the campaign sum is only the fallback, and the
  // basis is reported so a reader can tell which was used.
  const campaignSpendSum = metaCampaigns.reduce((s, m) => s + m.spend, 0)
  let accountSpend = campaignSpendSum
  let spendBasis: PerCampaignRoas['spend_basis'] = 'account_level_window_incomplete'
  // An authoritative ACCOUNT row does not prove each CAMPAIGN denominator is complete.
  // Reproduced: account $400, synced campaign rows $100, an exact $800 booking mapped to that
  // campaign -> 800/100 = 8x ROAS, permitted purely because an account row existed. Per-campaign
  // ratios additionally require the campaign rows to RECONCILE to the account total.
  let campaignSpendComplete = false
  let campaignSpendReason: string | null = 'not evaluated'
  try {
    const accountWindow = await readAccountSpendWindow(
      db,
      adAccountDbId,
      { start: startDate, end: endDate },
      new Date().toISOString(),
    )
    if (accountWindow.status === 'available') {
      accountSpend = Number(accountWindow.totalSpend)
      spendBasis = 'account_level_insights'
      // Reconcile: the campaign rows must account for essentially all of the account's spend. A gap
      // means at least one campaign's denominator is missing days, which INFLATES its ROAS.
      const gap = accountSpend > 0 ? Math.abs(accountSpend - campaignSpendSum) / accountSpend : 1
      campaignSpendComplete = accountSpend > 0 && gap <= CAMPAIGN_SPEND_TOLERANCE
      campaignSpendReason = campaignSpendComplete
        ? null
        : `campaign rows sum to ${formatMoney(campaignSpendSum, { maximumFractionDigits: 0 })} against ${formatMoney(accountSpend, { maximumFractionDigits: 0 })} of account spend (${(gap * 100).toFixed(0)}% unaccounted). At least one campaign denominator is incomplete, which would INFLATE its ROAS — per-campaign figures are UNAVAILABLE.`
    } else {
      spendBasis = 'account_level_window_incomplete'
      campaignSpendComplete = false
      campaignSpendReason = `Exact account spend is UNAVAILABLE: ${accountWindow.blockerCodes.join(', ')}. A partial successful read is not a denominator.`
    }
  } catch (err) {
    spendBasis = 'account_level_window_incomplete'
    campaignSpendComplete = false
    campaignSpendReason = `Exact account spend read failed: ${err instanceof Error ? err.message : String(err)}`
  }

  const ga = await getGa4ConfirmationTelemetryByCampaign(startDate, endDate)

  // EXACT evidence. Everything money-shaped below is gated on this being an appointment-id join.
  let scope: AttributionScope = 'unavailable'
  let scopeReason: string | null = 'not evaluated'
  let exactByCampaign = new Map<string, { bookings: number; bookedValue: number; recordedRevenue: number }>()
  let exactPaid: { valueBearingBookings: number; bookedValue: number; recordedRevenue: number } | null = null
  let ledgerRecordedRevenue: number | null = null
  let revenueCoverageComplete = false
  let revenueCoverageReason: string | null = 'Outcome ledger revenue coverage was not evaluated.'
  let campaignMappingComplete = true
  let campaignMappingReason: string | null = null
  try {
    const { reconciliation } = await buildGa4ReconciliationBlock(adAccountDbId, startDate, endDate)
    const coverage = reconciliation.business?.amountPaidCoverage ?? null
    revenueCoverageComplete = coverage !== null
      && coverage.withRecordedAmount === coverage.total
    revenueCoverageReason = revenueCoverageComplete
      ? null
      : coverage
        ? `recorded collected value exists for ${coverage.withRecordedAmount}/${coverage.total} active appointments; the active-appointment amount/spend ratio is UNAVAILABLE.`
        : 'The outcome ledger could not provide amount_paid coverage.'
    ledgerRecordedRevenue = revenueCoverageComplete
      ? reconciliation.business?.recordedOutcomeValue ?? null
      : null
    scope = reconciliation.scope
    scopeReason = reconciliation.scopeReason
    exactPaid = revenueCoverageComplete
      ? exactPaidEvidence(reconciliation, isMetaPaidChannel)
      : null
    if (reconciliation.scope === 'exact_appointment_join' && revenueCoverageComplete) {
      // An exact booking whose GA campaign LABEL does not map uniquely to a Meta campaign
      // was silently skipped (`if (!matched) continue`). The dropped bookings could belong to ANY
      // campaign, so every remaining per-campaign numerator became a LOWER BOUND presented as an exact
      // ROAS. Mapping completeness is now tracked, and any unmapped paid booking makes ALL per-campaign
      // ROAS unavailable — a partial numerator over full campaign spend is not a result.
      const built = new Map<string, { bookings: number; bookedValue: number; recordedRevenue: number }>()
      let unmappedSessionAttributedAppointments = 0
      for (const c of reconciliation.byChannel) {
        const matched = matchGa4Campaign(c.campaign, metaCampaigns.map((m) => m.name))
        if (!matched) {
          // A zero-price appointment can still have positive amount_paid. Count every ACTIVE joined
          // appointment for mapping completeness; otherwise its dollars disappear without blocking.
          if (isMetaPaidChannel(c.channel)) {
            unmappedSessionAttributedAppointments += c.valueBearingBookings + c.zeroValueAppointments
          }
          continue
        }
        const a = built.get(matched) ?? { bookings: 0, bookedValue: 0, recordedRevenue: 0 }
        a.bookings += c.valueBearingBookings
        a.bookedValue += c.bookedValue
        a.recordedRevenue += c.recordedRevenue
        built.set(matched, a)
      }
      if (unmappedSessionAttributedAppointments > 0) {
        campaignMappingComplete = false
        campaignMappingReason = `${unmappedSessionAttributedAppointments} exact session-attributed appointment(s) carry a GA campaign label that does not map to exactly one Meta campaign. They could belong to any campaign, so every per-campaign numerator would be a LOWER BOUND — per-campaign return is UNAVAILABLE, not approximate.`
      } else {
        exactByCampaign = built
      }
    }
  } catch (err) {
    scopeReason = `reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
  }

  // Account-level paid bucket (Meta-paid channels ÷ Meta spend) — statable even below the per-campaign
  // gate. Non-blocking: a failure here must not take down the panel's Meta-side numbers.
  let paid: PerCampaignRoas['paid'] = {
    ga4_confirmation_events: 0, ga4_event_value: 0,
    exact_value_bearing_bookings: null, exact_booked_value: null,
    exact_checkout_revenue: null, roas: null,
    attribution_reason: 'GA Paid Social is a session channel and does not prove Meta was the paid platform; Meta view-through outcomes also cannot carry a GA session attribution. Meta paid ROAS is withheld.',
  }
  try {
    const src = await getGa4ConfirmationTelemetryBySource(startDate, endDate)
    if (src.available) {
      paid = {
        ga4_confirmation_events: src.metaPaid.confirmationEvents,
        ga4_event_value: src.metaPaid.eventValue,
        // The linked amount is session-attributed context. GA Paid Social can contain another paid
        // social platform, while Meta view-through outcomes have no GA paid session. Never call the
        // result exact Meta paid ROAS, even with complete appointment identity.
        exact_value_bearing_bookings: exactPaid?.valueBearingBookings ?? null,
        exact_booked_value: exactPaid?.bookedValue ?? null,
        exact_checkout_revenue: exactPaid?.recordedRevenue ?? null,
        roas: null,
        attribution_reason: 'GA Paid Social is a session channel and does not prove Meta was the paid platform; Meta view-through outcomes also cannot carry a GA session attribution. Meta paid ROAS is withheld.',
      }
    }
  } catch { /* keep telemetry at zero and every exact field null */ }

  const baseRows = metaCampaigns
    .map((m) => ({
      campaign_name: m.name, meta_spend: m.spend, meta_bookings_est: m.bookings,
      ga4_confirmation_events: 0, ga4_event_value: 0,
      exact_booked_value: null as number | null, exact_checkout_revenue: null as number | null,
      exact_value_bearing_bookings: null as number | null,
      roas: null as number | null,
    }))
    .sort((a, b) => b.meta_spend - a.meta_spend)

  if (!ga.available) {
    return {
      ga4Available: false,
      reason: ga.reason,
      rows: baseRows,
      spend_basis: spendBasis,
      campaign_spend_complete: campaignSpendComplete,
      campaign_spend_reason: campaignSpendReason,
      campaign_mapping_complete: campaignMappingComplete,
      campaign_mapping_reason: campaignMappingReason,
      attribution_scope: scope,
      attribution_scope_reason: scopeReason,
      unattributed: { ga4_confirmation_events: 0, ga4_event_value: 0 },
      account: {
        meta_spend: accountSpend,
        ga4_confirmation_events: 0, ga4_event_value: 0,
        // This returned null whenever GA campaign telemetry was unavailable, even after the
        // ledger read succeeded. Blended MER depends on the LEDGER and Meta spend — not on GA at all.
        mer: ledgerRecordedRevenue !== null && spendBasis === 'account_level_insights' && accountSpend > 0
          ? ledgerRecordedRevenue / accountSpend : null,
        mer_basis: 'BLENDED DIAGNOSTIC: amount_paid on active appointments (all sources) / complete Meta spend. Active appointments only. NOT paid performance and NOT paid ROAS.',
        revenue_coverage_complete: revenueCoverageComplete,
        revenue_coverage_reason: revenueCoverageReason,
      },
      attributed_share: null,
      paid,
      meta_view_through_share: metaViewThroughShare,
    }
  }

  // Match GA4 campaign rows to Meta campaigns.
  const ga4ById = new Map<string, { events: number; eventValue: number }>()
  let unattrB = 0
  let unattrR = 0
  for (const g of ga.rows) {
    const matchName = matchGa4Campaign(g.campaign, metaCampaigns.map((m) => m.name))
    const meta = matchName ? metaCampaigns.find((m) => m.name === matchName) : null
    if (meta) {
      const a = ga4ById.get(meta.id) ?? { events: 0, eventValue: 0 }
      a.events += g.confirmationEvents
      a.eventValue += g.eventValue
      ga4ById.set(meta.id, a)
    } else {
      unattrB += g.confirmationEvents
      unattrR += g.eventValue
    }
  }

  const roasRows: CampaignRoasRow[] = metaCampaigns
    .map((m) => {
      const g = ga4ById.get(m.id)
      const ex = exactByCampaign.get(m.name) ?? null
      return {
        campaign_name: m.name,
        meta_spend: m.spend,
        meta_bookings_est: m.bookings,
        ga4_confirmation_events: g?.events ?? 0,
        ga4_event_value: g?.eventValue ?? 0,
        exact_value_bearing_bookings: ex ? ex.bookings : null,
        exact_booked_value: ex ? ex.bookedValue : null,
        exact_checkout_revenue: ex ? ex.recordedRevenue : null,
        // This quotient is withheld: a GA campaign label does not establish Meta platform provenance,
        // and Meta view-through outcomes cannot carry a GA session attribution.
        roas: null,
      }
    })
    .sort((a, b) => b.meta_spend - a.meta_spend)

  return {
    ga4Available: true,
    rows: roasRows,
    spend_basis: spendBasis,
    campaign_spend_complete: campaignSpendComplete,
    campaign_spend_reason: campaignSpendReason,
    campaign_mapping_complete: campaignMappingComplete,
    campaign_mapping_reason: campaignMappingReason,
    attribution_scope: scope,
    attribution_scope_reason: scopeReason,
    unattributed: { ga4_confirmation_events: unattrB, ga4_event_value: unattrR },
    account: {
      meta_spend: accountSpend,
      ga4_confirmation_events: ga.totals.confirmationEvents,
      ga4_event_value: ga.totals.eventValue,
      // This divided EXACT PAID booked value by spend and called it MER. That is paid
      // ROAS. MER is BLENDED — total business checkout revenue across ALL sources (paid, organic, phone,
      // manual) over ad spend — and it is available from the ledger right now, with no GA identity
      // required. It is reported here as what it is, and never as paid performance.
      // The GA-UNAVAILABLE branch required an authoritative spend basis but this one — the
      // NORMAL path — did not, so ordinary operation could show MER on a denominator the UI was
      // simultaneously warning was incomplete. Same condition, both branches.
      mer: ledgerRecordedRevenue !== null && spendBasis === 'account_level_insights' && accountSpend > 0
        ? ledgerRecordedRevenue / accountSpend : null,
      mer_basis: 'BLENDED DIAGNOSTIC: amount_paid on active appointments (all sources) / complete Meta spend. Active appointments only. NOT paid performance and NOT paid ROAS.',
      revenue_coverage_complete: revenueCoverageComplete,
      revenue_coverage_reason: revenueCoverageReason,
    },
    attributed_share: ga.attributedShare,
    paid,
    meta_view_through_share: metaViewThroughShare,
  }
}
