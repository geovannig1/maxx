import { getAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * CONFIRMATION / DELIVERY facts — a TRACKING reader, deliberately separate from the BUSINESS reader
 * in `business-facts.ts`.
 *
 * The two ask different questions and must never share a population:
 *
 *   BUSINESS  — "what did the studio sell?"  Canceled rows are excluded, because a canceled
 *               appointment is not revenue.
 *   TRACKING  — "did the tag fire and did Meta receive it?"  Canceled rows are INCLUDED, because the
 *               confirmation event fired when the booking was CREATED. Excluding them makes real
 *               telemetry look missing and manufactures phantom tag failures.
 *
 * A review reached the right conclusion from a partly wrong premise, so the correction is recorded
 * here. The premise was that `booking_date_et` is a business/service-date column. It is not:
 * the baseline view defines it as `datetime_created` projected onto the account-timezone calendar
 * (`etDateOf`, which uses Intl and is therefore DST-correct) — i.e. the CONFIRMATION-CREATION date,
 * exactly the axis a tracking reader needs. The source's appointment time is the SERVICE date and is
 * not read here at all. `tests/db/integration/confirmation-facts.test.ts` pins that equivalence,
 * including across a DST transition, so this rests on a proof rather than on the column's name.
 *
 * The real defects in using `BusinessFacts` for tracking were the POPULATION, not the date
 * axis: `confirmedAppointments` drops canceled rows, and it offered no way to see that a window's
 * origins were simply never established.
 */

/** Origin classes are reported SEPARATELY and never merged. */
export interface ConfirmationFacts {
  /** Every confirmation CREATED in the window, canceled included. The tag-firing population. */
  totalConfirmations: number
  /** Origin = website. These SHOULD have produced a GA confirmation event and an accepted CAPI event. */
  websiteConfirmations: number
  /** Origin = staff/manual. No browser session, so browser/CAPI coverage is NOT expected of them. */
  staffOrManualConfirmations: number
  /** Origin never established. Coverage over these is NOT EVALUABLE — never counted as website
   *  activity, and never used to claim there was none. */
  originUnknownConfirmations: number
  /** Website confirmations with a LIVE-ACCEPTED lineage row (`conversion_deliveries.live_accepted_at`).
   *  This is the ONLY admissible accepted-delivery figure. */
  websiteWithAcceptedCapi: number
  /** Website confirmations carrying a legacy `capi_sent_at` stamp but NO live-accepted lineage row.
   *  Legacy (pre-lineage) stamps came from an HTTP-2xx path that never checked Meta's response, so these are
   *  historical operational timestamps of UNVERIFIED provenance — visible, never counted as accepted. */
  websiteLegacyStampUnverified: number
  /** Website confirmations created in the window that were later canceled. Reported so a reader can
   *  see why the tracking population is larger than the business one. */
  websiteLaterCanceled: number
}

export const EMPTY_CONFIRMATION_FACTS: ConfirmationFacts = {
  totalConfirmations: 0, websiteConfirmations: 0, staffOrManualConfirmations: 0,
  originUnknownConfirmations: 0, websiteWithAcceptedCapi: 0, websiteLegacyStampUnverified: 0,
  websiteLaterCanceled: 0,
}

interface ConfirmationRow {
  id: number | string
  canceled: boolean | null
  web_origin_state: string | null
  /** LEGACY operational marker. Retained for history; NEVER read as acceptance. See below. */
  capi_sent_at: string | null
}

/** Outcome ids with a LIVE-ACCEPTED lineage row (`conversion_deliveries.live_accepted_at`). */
export type AcceptedLiveIds = ReadonlySet<string>

/** PURE. Separated so the classification is testable without a database. */
export function aggregateConfirmationFacts(
  rows: ConfirmationRow[],
  acceptedLiveIds: AcceptedLiveIds,
): ConfirmationFacts {
  const website = rows.filter((r) => r.web_origin_state === 'website')
  const accepted = website.filter((r) => acceptedLiveIds.has(String(r.id)))
  return {
    totalConfirmations: rows.length,
    websiteConfirmations: website.length,
    staffOrManualConfirmations: rows.filter((r) => r.web_origin_state === 'staff_or_manual').length,
    originUnknownConfirmations: rows.filter((r) => r.web_origin_state === 'origin_unknown').length,
    // ACCEPTANCE COMES FROM THE LINEAGE ROW, never from the parent mirror.
    //
    // The previous version counted any non-null `capi_sent_at` as a proven
    // Meta acceptance because `record_conversion_delivery` writes it only on a live accepted send. True
    // for rows written through that RPC — but an upgraded database can hold legacy stamps from an older
    // path, which set the column from an HTTP 2xx without checking whether Meta accepted anything, and
    // the schema never clears or reclassifies them. Applying the schema does not retroactively upgrade
    // old evidence. So acceptance is derived from conversion_deliveries.live_accepted_at, which only
    // exists when a live send was actually accepted.
    websiteWithAcceptedCapi: accepted.length,
    // A legacy stamp with NO lineage row: an operational timestamp of unverified provenance. Counted
    // separately so the history stays visible without being promoted to evidence.
    websiteLegacyStampUnverified:
      website.filter((r) => r.capi_sent_at != null && !acceptedLiveIds.has(String(r.id))).length,
    websiteLaterCanceled: website.filter((r) => r.canceled === true).length,
  }
}

const PAGE_SIZE = 1000

/**
 * Account-scoped read over CONFIRMATION-CREATION ET dates, inclusive of both endpoints.
 * Returns `null` on any failure — NOT READ is never the same claim as zero.
 */
export async function getConfirmationFacts(
  adAccountDbId: string,
  startDateEt: string,
  endDateEt: string,
  supabase: SupabaseClient = getAdminClient(),
): Promise<ConfirmationFacts | null> {
  try {
    const all: ConfirmationRow[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('v_business_outcomes')
        .select('id, status, web_origin_state, conversion_sent_at')
        .eq('ad_account_id', adAccountDbId)
        // Enabled outcome sources only (src/lib/outcomes/aggregation.ts, rule 1).
        .eq('source_enabled', true)
        // business_date IS etDateOf(occurred_at) — the confirmation-creation ET date.
        .gte('business_date', startDateEt)
        .lte('business_date', endDateEt)
        // Deterministic paging: .range() without ORDER BY has no defined row order, so pages could
        // overlap or skip. `id` (the outcome uuid) is the primary key and therefore a total order.
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      const page = (data ?? []) as Array<{
        id: string; status: string; web_origin_state: string | null; conversion_sent_at: string | null
      }>
      // `id` is the outcome uuid: the join key to conversion_deliveries.outcome_id below.
      all.push(...page.map((r) => ({
        id: r.id, canceled: r.status === 'cancelled', web_origin_state: r.web_origin_state, capi_sent_at: r.conversion_sent_at,
      })))
      if (page.length < PAGE_SIZE) break
    }

    // LIVE-ACCEPTED lineage for exactly these appointments. `live_accepted_at` is set only when Meta
    // accepted a LIVE send; a test acceptance populates test_accepted_at instead and must never count.
    const acceptedLiveIds = new Set<string>()
    const ids = all.map((r) => String(r.id))
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      const slice = ids.slice(i, i + PAGE_SIZE)
      if (slice.length === 0) break
      const { data, error } = await supabase
        .from('conversion_deliveries')
        .select('outcome_id, live_accepted_at')
        .in('outcome_id', slice)
        .not('live_accepted_at', 'is', null)
      if (error) throw new Error(error.message)
      for (const r of data ?? []) acceptedLiveIds.add(String(r.outcome_id))
    }
    return aggregateConfirmationFacts(all, acceptedLiveIds)
  } catch {
    return null
  }
}
