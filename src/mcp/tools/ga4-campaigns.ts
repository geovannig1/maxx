import { getGa4ConfirmationTelemetryByCampaign } from '@/lib/ga4/client'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { outcomeWords, withIndefiniteArticle } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

/**
 * GA CONFIRMATION-EVENT TELEMETRY by session campaign.
 *
 * This was described as "actual bookings + revenue" and "the per-campaign ROAS source of
 * truth". It is neither. These aggregate rows expose GA event counts and GA event VALUES with no
 * appointment identity (even though some recent underlying events may be ID-bearing):
 * they may double-count one booking, include canceled appointments, and report a comp at its nominal
 * price. A per-campaign ROAS requires an exact appointment-id join valued from the outcome ledger.
 */
export async function getGa4ByCampaign(args: { start_date?: string; end_date?: string }): Promise<object> {
  const start = args.start_date ?? nyDaysAgo(30)
  const end = args.end_date ?? nyDaysAgo(1)
  const res = await getGa4ConfirmationTelemetryByCampaign(start, end)

  if (!res.available) {
    return { error: res.reason ?? 'GA4 not available', period: { start, end }, rows: [] }
  }

  const lowCoverage = res.attributedShare !== null && res.attributedShare < 0.5
  return {
    period: { start, end },
    totals: res.totals,
    attributed_share: res.attributedShare,
    rows: res.rows,
    what_these_are:
      `GA confirmation EVENTS and GA event VALUE per session campaign. NOT ${OW.many}, NOT revenue, NOT a ROAS numerator. This aggregate output exposes no ${OW.one} identity, so it cannot be deduplicated against the ledger, checked against cancel state, or valued. Some recent underlying events may be ID-bearing; the separate exact reconciliation must prove complete identity coverage. Business counts, scheduled booked value, and checkout revenue come from get_outcomes; an exact per-campaign result requires ${withIndefiniteArticle(OW.one)}-id join over a window with proven identity coverage.`,
    note: lowCoverage
      ? `WARNING: only ${res.attributedShare === null ? 'n/a' : Math.round(res.attributedShare * 100) + '%'} of PAID-channel confirmation EVENTS carry a named campaign — the rest landed as (not set)/(direct). Paid attribution is misconfigured (ad UTMs and/or GA4 cross-domain/unwanted-referrals). Per-campaign ROAS is UNAVAILABLE regardless of this share — it requires an exact ${OW.one}-id join, not campaign-tagged telemetry. See the tracking attribution analysis.`
      : `GA CONFIRMATION-EVENT telemetry by session campaign. NOT ${OW.many}, NOT revenue, NOT a ROAS numerator — these aggregate rows carry no ${OW.one} identity. Some recent underlying events may be ID-bearing, but only the separate exact reconciliation may use them after proving complete coverage. attributed_share is a coverage statistic about telemetry (share of paid-channel EVENTS with a named campaign); organic events correctly carry no campaign. Per-campaign ROAS requires an exact ${OW.one}-id join to the outcome ledger and is UNAVAILABLE without one — report unavailable, never 0.`,
  }
}
