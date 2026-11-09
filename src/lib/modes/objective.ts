import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'

// Resolving Meta's DELIVERY OBJECTIVE from what Meta actually reports. This classifies what Meta is
// asked to optimize inside the auction; it is not Maxx's commercial objective.
//
// The pure mode function correctly refuses to judge an awareness or lead campaign on
// booking CPA, but every production caller hardcoded `objective: 'bookings'`, so that branch could
// never run. The objective is already synced onto `campaigns.objective`; this reads it.
//
// An account can hold booking, lead and awareness campaigns at once, so a SINGLE account-level
// delivery objective cannot interpret every unit's diagnostic CPA. `resolveAccountObjective` returns
// 'bookings' ONLY when every delivering campaign shares that objective, and 'unknown' when they are
// mixed — which blocks booking-CPA rules rather than applying them to a campaign that never had that
// goal. Per-unit resolution is the correct long-term shape; account-level fail-closed is the
// conservative step available now.

/** Meta's delivery objective classification. This is never Maxx's commercial objective. */
export type MetaDeliveryObjective = 'bookings' | 'leads' | 'awareness' | 'unknown'
/** @deprecated Use MetaDeliveryObjective; the old name incorrectly implied a Maxx north star. */
export type MaxxObjective = MetaDeliveryObjective

/** Meta objective enum -> which delivery diagnostics are semantically compatible with the unit.
 * Unlisted values resolve to unknown; none of these values can decide commercial direction. */
export function classifyMetaObjective(raw: string | null | undefined): MetaDeliveryObjective {
  if (!raw) return 'unknown'
  const o = raw.toUpperCase()
  if (o.includes('OUTCOME_SALES') || o.includes('CONVERSIONS') || o.includes('PRODUCT_CATALOG_SALES')) return 'bookings'
  if (o.includes('OUTCOME_LEADS') || o.includes('LEAD_GENERATION')) return 'leads'
  if (o.includes('OUTCOME_AWARENESS') || o.includes('BRAND_AWARENESS') || o.includes('REACH') ||
      o.includes('OUTCOME_ENGAGEMENT') || o.includes('OUTCOME_TRAFFIC') || o.includes('LINK_CLICKS') ||
      o.includes('VIDEO_VIEWS')) return 'awareness'
  return 'unknown'
}

/** PURE: one objective for the account, or 'unknown' when they disagree. */
export function unifyObjectives(objectives: MetaDeliveryObjective[]): MetaDeliveryObjective {
  const distinct = new Set(objectives.filter((o) => o !== 'unknown'))
  if (objectives.some((o) => o === 'unknown')) return 'unknown'
  if (distinct.size === 1) return [...distinct][0]
  return 'unknown'   // mixed, or empty — fail closed
}

/** Resolve the account's objective from SYNCED campaign rows. Fails closed to 'unknown'. */
export async function resolveAccountObjective(
  adAccountDbId: string, supabase: SupabaseClient = getAdminClient(),
): Promise<MetaDeliveryObjective> {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('objective, status')
      .eq('ad_account_id', adAccountDbId)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<{ objective: string | null; status: string | null }>
    // Judge on campaigns that can actually spend. A paused legacy campaign with a different objective
    // must not block the account, but an ACTIVE one with a different objective must.
    const active = rows.filter((r) => (r.status ?? '').toUpperCase() === 'ACTIVE')
    const considered = active.length > 0 ? active : rows
    if (considered.length === 0) return 'unknown'
    return unifyObjectives(considered.map((r) => classifyMetaObjective(r.objective)))
  } catch {
    return 'unknown'   // fail closed: an unreadable objective never authorises a booking-CPA rule
  }
}
