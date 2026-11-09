import { logToolError } from '@/lib/security/api-error'
import { getGa4ConfirmationTelemetryByCampaign } from '@/lib/ga4/client'
import { computeUtmCoverage } from '@/lib/tracking/utm-coverage'
import { assessBookingLinkage } from '@/lib/tracking/utm-validator'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

/**
 * Per-ad health for the LEGACY readable-name UTM set. This diagnoses existing instrumentation only;
 * it does not emit a final tracking contract or unlock paid ROAS. The future plan must add immutable
 * Meta IDs and exact appointment linkage, then prove complete identity/mapping and authoritative spend.
 */
export async function getUtmHealth(args: { start_date?: string; end_date?: string }): Promise<object> {
  const start = args.start_date ?? nyDaysAgo(30)
  const end = args.end_date ?? nyDaysAgo(1)

  let cov
  try {
    cov = await computeUtmCoverage()
  } catch (e) {
    return { error: `UTM audit unavailable: ${logToolError('get_utm_health', 'UTM_AUDIT_UNAVAILABLE', e)}`, error_code: 'UTM_AUDIT_UNAVAILABLE', ads: [] }
  }

  // GA4 attributed share over the window — feeds the booking-linkage heuristic. Optional.
  let attributedShare: number | null = null
  let totalPurchases = 0
  try {
    const ga = await getGa4ConfirmationTelemetryByCampaign(start, end)
    if (ga.available) {
      attributedShare = ga.attributedShare
      totalPurchases = ga.totals.confirmationEvents
    }
  } catch { /* GA4 optional — linkage assessment will say it cannot assess */ }

  const offenders = cov.ads.filter((a) => a.verdict !== 'correct')

  return {
    coverage: {
      scope: cov.scope,
      ads_total: cov.adsTotal,
      ads_correct: cov.adsCorrect,
      ads_missing: cov.adsMissing,
      ads_misconfigured: cov.adsMisconfigured,
      ads_unverified: cov.adsUnverified,
      coverage: cov.coverage,
      source_label: cov.source_label,
    },
    tracking_contract_status: 'unavailable_until_campaign_plan',
    ads_to_fix: offenders.map((a) => ({
      meta_ad_id: a.meta_ad_id,
      ad_name: a.ad_name,
      campaign_name: a.campaign_name,
      effective_status: a.effective_status,
      tags_source: a.tags_source,
      current_url_tags: a.url_tags,
      verdict: a.verdict,
      defects: a.defects,
      correction_status: 'withheld_until_campaign_plan',
    })),
    ads_correct_count: cov.adsCorrect,
    booking_linkage: assessBookingLinkage({ utmCoverage: cov.coverage, attributedShare, totalPurchases }),
    ga4_window: { start, end, attributed_share: attributedShare, total_purchases: totalPurchases },
    note:
      'Read-only diagnostic — nothing here writes to Meta. No paste-ready setting is emitted without an approved CampaignPlan. ' +
      `Readable UTM coverage or campaign-tagged GA events never unlock paid CPA/ROAS; that requires complete exact ${OW.one} identity, immutable Meta-ID mapping, authoritative reconciled spend, and a fully covered window.`,
  }
}
