import { getAdminClient } from '@/lib/supabase/admin'
import { getGa4ConfirmationTelemetryBySource, getGa4ConfirmationTelemetryByCampaign } from '@/lib/ga4/client'
import {
  computeUtmCoverage,
  splitUtmOffenders,
  type AdUtmHealth,
} from '@/lib/tracking/utm-coverage'
import { assessBookingLinkage } from '@/lib/tracking/utm-validator'
import { ATTRIBUTION_WINDOW_LABEL } from '@/lib/platforms/meta/attribution'
import { rangeLengthDays } from '@/lib/insights/compare'
import {
  reconcileSpendIntegrity,
  reconcilePlaneConflict,
  reconcileBilledContext,
  reconciliationVariancePct,
} from '@/lib/diagnostics/reconcile'
import { computeTrust } from '@/lib/trust/trust'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import type { DatasetQualityResult } from '@/lib/platforms/types'

// RECONCILIATION GATHERER — the body of /api/diagnostics/reconciliation, extracted so the MCP tools
// (get_reconciliation / get_diagnosis_bundle) can share it: Meta-internal spend integrity,
// a Meta-modelled-vs-GA-telemetry plane conflict, lifetime billed context, the attribution-window label, an
// overall trust score, UTM/booking-linkage audit — plus a `signals` block with the best-effort
// CAPI/Event-Match-Quality read (the layer Meta's chat cannot see). This is the source for the
// results-reconciliation preamble: state Meta modelled vs GA telemetry BEFORE narrating performance.

interface AccountRow { id: string; amount_spent: number | null; spend_cap: number | null; last_synced_at: string | null }
interface InsightRow { spend: number | null; bookings: number | null; leads: number | null; appointment_value: number | null }
type ObservedAdUtmHealth = Omit<AdUtmHealth, 'corrected'>

function sumBy<T>(rows: T[], pick: (r: T) => number | null | undefined): number {
  return rows.reduce((s, r) => s + Number(pick(r) ?? 0), 0)
}

/** Allowlist observed fields so the diagnostic response can never leak a generated setup value. */
function observedAdUtmHealth(ad: AdUtmHealth): ObservedAdUtmHealth {
  return {
    meta_ad_id: ad.meta_ad_id,
    ad_name: ad.ad_name,
    campaign_name: ad.campaign_name,
    effective_status: ad.effective_status,
    url_tags: ad.url_tags,
    tags_source: ad.tags_source,
    verdict: ad.verdict,
    defects: ad.defects,
  }
}

export interface ReconciliationReportArgs {
  from: string
  to: string
  adAccountId: string
}

export async function buildReconciliationReport({ from, to, adAccountId }: ReconciliationReportArgs) {
  const db = getAdminClient()
  const { data: account, error: accErr } = await db
    .from('ad_accounts')
    .select('id, amount_spent, spend_cap, last_synced_at')
    .eq('id', adAccountId)
    .eq('is_active', true)
    .maybeSingle()
  if (accErr) throw new Error(accErr.message)
  if (!account) throw new Error('Ad account not found')
  const acc = account as AccountRow

  // ── Window queries (in parallel) ──
  const [accountWin, campaignWin, reportWin, lifetimeWin, ga4, ga4Camp, utmCov, datasetQuality] = await Promise.all([
    db.from('daily_insights').select('spend, bookings, leads, appointment_value').eq('ad_account_id', adAccountId).eq('entity_level', 'account').gte('date_start', from).lte('date_stop', to),
    db.from('daily_insights').select('spend').eq('ad_account_id', adAccountId).eq('entity_level', 'campaign').gte('date_start', from).lte('date_stop', to),
    db.from('daily_reports').select('total_spend').eq('ad_account_id', adAccountId).gte('report_date', from).lte('report_date', to),
    db.from('daily_insights').select('spend').eq('ad_account_id', adAccountId).eq('entity_level', 'account'), // lifetime tracked
    getGa4ConfirmationTelemetryBySource(from, to).catch(() => ({ available: false as const, paid: { bookings: 0, revenue: 0 }, organic: { bookings: 0, revenue: 0 }, metaPaid: { bookings: 0, revenue: 0 }, byChannel: [] })),
    getGa4ConfirmationTelemetryByCampaign(from, to).catch(() => ({ available: false as const, rows: [], totals: { confirmationEvents: 0, eventValue: 0 }, attributedShare: null })),
    computeUtmCoverage(account.id as string),
    requireCapability(getAdPlatform('meta'), 'datasetDiagnostics').fetchQuality({ adAccountDbId: account.id as string }).catch(
      (e): DatasetQualityResult => ({ available: false, reason: e instanceof Error ? e.message : 'dataset quality fetch failed', datasetId: null }),
    ),
  ])

  const failedRead = [accountWin, campaignWin, reportWin, lifetimeWin].find((result) => result.error)
  if (failedRead?.error) throw new Error(`Reconciliation read failed: ${failedRead.error.message}`)

  const accountRows = (accountWin.data ?? []) as InsightRow[]
  const accountInsightsSpend = sumBy(accountRows, (r) => r.spend)
  const metaBookings = sumBy(accountRows, (r) => r.bookings)
  const metaApptValue = sumBy(accountRows, (r) => r.appointment_value)
  const campaignInsightsSpend = campaignWin.data ? sumBy(campaignWin.data as { spend: number | null }[], (r) => r.spend) : null
  // No stored daily report for the window is ABSENCE, not $0: summing an empty list read as a 100%
  // spend mismatch on every install that had not generated reports yet.
  const reportSpend = reportWin.data && reportWin.data.length > 0
    ? sumBy(reportWin.data as { total_spend: number | null }[], (r) => r.total_spend) : null
  const lifetimeTracked = lifetimeWin.data ? sumBy(lifetimeWin.data as { spend: number | null }[], (r) => r.spend) : null

  // GA Meta-scoped paid-channel EVENT VALUE is compared with Meta's modelled value estimate. Google
  // Cross-network / Paid Search stay out. Neither side is business money.
  const ga4Available = ga4.available === true
  // TELEMETRY, both sides: GA confirmation events/value vs Meta's modelled estimate. Neither is the
  // ledger, so this diagnostic compares two non-canonical planes and says nothing about how many
  // bookings occurred.
  const ga4PaidRevenue = ga4Available ? ga4.metaPaid.eventValue : null
  const ga4PaidPurchases = ga4Available ? ga4.metaPaid.confirmationEvents : null
  const ga4OrganicEventValue = ga4Available ? ga4.organic.eventValue : null
  // attributedShare is per-CAMPAIGN UTM health (a finer granularity) — surfaced separately, not used to
  // gate the paid-channel telemetry comparison. It never establishes paid-outcome provenance.
  const attributionCoverage = 'attributedShare' in ga4Camp ? ga4Camp.attributedShare : null

  const days = rangeLengthDays(from, to)

  // ── The three reconciliations ──
  const integrity = reconcileSpendIntegrity({ accountInsightsSpend, reportSpend, campaignInsightsSpend, days })
  const money = reconcilePlaneConflict({
    metaEstimatedValue: metaApptValue > 0 ? metaApptValue : null,
    ga4PaidEventValue: ga4PaidRevenue,
    metaBookings,
    ga4Purchases: ga4PaidPurchases,
    attributionCoverage,
    ga4OrganicEventValue,
  })
  const billed = reconcileBilledContext({ lifetimeBilled: acc.amount_spent, lifetimeTracked, spendCap: acc.spend_cap })

  // ── Overall trust in the reconciled numbers ──
  const dataAgeHours = acc.last_synced_at ? (Date.now() - Date.parse(acc.last_synced_at)) / 3_600_000 : null
  const trust = computeTrust({
    spend: accountInsightsSpend,
    bookings: metaBookings,
    windowDays: days,
    dataAgeHours,
    // This labelled GA `ga4_actual` and set attributionCoverage to 1 merely because GA
    // RESPONDED — producing "Verified (100%) — safe to act on without caveat" with no appointment
    // identity anywhere. GA responding is not attribution coverage. This whole diagnostic compares two
    // NON-CANONICAL planes (Meta modelled vs GA telemetry), so it can never be a verified money read.
    sourceOfTruth: ga4Available ? 'ga4_confirmation_telemetry' : 'meta_modelled',
    revenueClaim: true,
    // Coverage is the share of GA confirmation EVENTS carrying a named campaign — a telemetry
    // statistic. It is never 1 by default, and it is null when unknown rather than assumed complete.
    attributionCoverage,
    reconVariancePct: reconciliationVariancePct(integrity, money),
    dataSourcesCount: 1 + (ga4Available ? 1 : 0),
  })
  const bookingLinkage = assessBookingLinkage({
    utmCoverage: utmCov?.coverage ?? null,
    attributedShare: attributionCoverage,
    totalPurchases: ga4Camp.totals.confirmationEvents,
  })

  // ── Attribution instrumentation: observed UTM coverage + booking-linkage advisory. This is a
  // read-only diagnostic. The tracking contract remains unavailable until a stored CampaignPlan
  // binds immutable Meta IDs, readable labels and the paid-interaction capture contract. ──
  const utm = utmCov
    ? {
        tracking_contract_status: 'unavailable_until_campaign_plan' as const,
        coverage: utmCov.coverage,
        scope: utmCov.scope,
        ads_total: utmCov.adsTotal,
        ads_correct: utmCov.adsCorrect,
        ads_missing: utmCov.adsMissing,
        ads_misconfigured: utmCov.adsMisconfigured,
        // Distinct from missing/misconfigured: no synced source was available to judge these ads.
        // Preserve it so downstream surfaces cannot turn an unreadable audit into a confident 0%.
        ads_unverified: utmCov.adsUnverified,
        // Offenders scoped to what the headline measures (ACTIVE ads), deduped by ad — a to-many creative
        // join fanned out duplicate rows, and paused/historical UTM gaps were dumped under the "100% of
        // active ads correct" headline (a contradiction). Historical gaps are counted separately: cleanup,
        // not an active attribution problem.
        ...(() => {
          const split = splitUtmOffenders(utmCov.ads)
          return {
            offenders: split.active.slice(0, 40).map(observedAdUtmHealth),
            offenders_historical_count: split.historicalCount,
          }
        })(),
        booking_linkage: {
          suspected: bookingLinkage.suspected,
          label: bookingLinkage.label,
          rationale: bookingLinkage.rationale,
          verification_status: 'unavailable_until_campaign_plan' as const,
        },
        source_label: utmCov.source_label,
      }
    : null

  return {
    window: { from, to, days },
    tracking_contract_status: 'unavailable_until_campaign_plan' as const,
    attribution_window_label: ATTRIBUTION_WINDOW_LABEL,
    integrity,
    money,
    billed,
    trust,
    utm,
    // Signal health — CAPI / Event Match Quality (best-effort; { available:false, reason } is an honest
    // "can't read it", never a zero). Meta's chat has no equivalent of this block.
    signals: { dataset_quality: datasetQuality },
    data_age_hours: dataAgeHours,
    ga4_available: ga4Available,
    last_synced_at: acc.last_synced_at,
  }
}
