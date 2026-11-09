import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedOutcome } from './adapter'
import type { OutcomeStatus } from './model'

/**
 * The core outcome writer for pushed sources (ADR-058: the core, not adapters, owns the upsert and
 * observations). One row per (account, source, external id); a later delivery for the same external
 * id is the source's newer full state and replaces the stored state. Observations are recorded by the
 * database triggers from `observation_source`, exactly as for the outcome ledger.
 */

export interface OutcomeWriteContext {
  adAccountId: string
  sourceId: string
  /** IANA timezone of the ad account; business_date is the occurred_at calendar date there. */
  timezone: string
  observationSource: 'webhook'
}

export interface OutcomeWriteResult {
  outcomeId: string
  /** The stored status before this write, or null when the outcome is new. */
  previousStatus: OutcomeStatus | null
  /** False when the delivery was older than the stored state (`updated_at`) and was not applied. */
  applied: boolean
}

/** A delivery tried to change an outcome's conversion event id after it was set or used. */
export class OutcomeEventIdChangedError extends Error {
  constructor() {
    super('outcome_conversion_event_id_immutable')
    this.name = 'OutcomeEventIdChangedError'
  }
}

/** Calendar date (YYYY-MM-DD) of an instant in an IANA timezone. Throws on an invalid zone or instant. */
export function calendarDateIn(instant: string, timezone: string): string {
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) throw new Error('calendarDateIn: invalid instant')
  return d.toLocaleDateString('en-CA', { timeZone: timezone })
}

/** PURE: a normalized outcome → an `outcomes` row. `nowIso` is the observation time. */
export function toNormalizedOutcomeRow(
  o: NormalizedOutcome,
  ctx: OutcomeWriteContext,
  nowIso: string,
): Record<string, unknown> {
  const originObserved = o.origin !== 'unknown'
  return {
    ad_account_id: ctx.adAccountId,
    source_id: ctx.sourceId,
    external_id: o.externalId,
    outcome_type: o.outcomeType,
    outcome_label: o.outcomeLabel,
    status: o.status,
    currency: o.currency,
    gross_value: o.grossValue,
    collected_value: o.collectedValue,
    occurred_at: o.occurredAt,
    business_date: calendarDateIn(o.occurredAt, ctx.timezone),
    fulfilment_at: o.fulfilmentAt,
    fulfilment_status: o.fulfilmentStatus,
    origin: o.origin,
    // The sender states the origin on every delivery, so each delivery is an observation of it. An
    // `unknown` origin clears the pair: eligibility is unknown, never assumed.
    origin_observed_at: originObserved ? nowIso : null,
    origin_observed_source: originObserved ? ctx.observationSource : null,
    first_name: o.customer.firstName,
    last_name: o.customer.lastName,
    email: o.customer.email,
    phone: o.customer.phone,
    utm_source: o.attribution.utmSource,
    utm_medium: o.attribution.utmMedium,
    utm_campaign: o.attribution.utmCampaign,
    utm_content: o.attribution.utmContent,
    utm_term: o.attribution.utmTerm,
    fbclid: o.attribution.fbclid,
    gclid: o.attribution.gclid,
    landing_page: o.attribution.landingPage,
    referrer: o.attribution.referrer,
    fbp: o.attribution.fbp,
    fbc: o.attribution.fbc,
    raw: o,
    observation_source: ctx.observationSource,
    synced_at: nowIso,
    // Written only when supplied: an omitted value never clears a stored one (the database also keeps it).
    ...(o.conversionEventId ? { conversion_event_id: o.conversionEventId } : {}),
    ...(o.sourceUpdatedAt ? { source_updated_at: o.sourceUpdatedAt } : {}),
  }
}

/** Idempotent upsert of one pushed outcome. Returns its uuid and the status it had before. */
export async function upsertNormalizedOutcome(
  db: SupabaseClient,
  outcome: NormalizedOutcome,
  ctx: OutcomeWriteContext,
  nowIso: string = new Date().toISOString(),
): Promise<OutcomeWriteResult> {
  const row = toNormalizedOutcomeRow(outcome, ctx, nowIso)
  const { data: existing, error: readError } = await db
    .from('outcomes')
    .select('id, status')
    .eq('ad_account_id', ctx.adAccountId)
    .eq('source_id', ctx.sourceId)
    .eq('external_id', outcome.externalId)
    .maybeSingle()
  if (readError) throw new Error(`outcome read failed: ${readError.message}`)
  const { data, error } = await db
    .from('outcomes')
    .upsert(row, { onConflict: 'ad_account_id,source_id,external_id', ignoreDuplicates: false })
    .select('id')
  if (error) {
    if (/outcome_conversion_event_id_immutable/.test(error.message)) throw new OutcomeEventIdChangedError()
    throw new Error(`outcome upsert failed: ${error.message}`)
  }
  const previous = existing as { id?: string; status?: OutcomeStatus } | null
  const id = (data as Array<{ id: string }> | null)?.[0]?.id
  // The ordering guard skips an update older than the stored state: no row comes back for it.
  if (!id && previous?.id) return { outcomeId: previous.id, previousStatus: previous.status ?? null, applied: false }
  if (!id) throw new Error('outcome upsert failed: no row returned')
  return { outcomeId: id, previousStatus: previous?.status ?? null, applied: true }
}
