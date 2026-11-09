import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import { etDateOf } from '@/lib/utils/date-utils'
import type { AcuityAppointmentRaw, AcuityForm } from './client'
import { ACUITY_OUTCOME_TYPE, ensureAcuitySource } from './outcome-source'

// Pure mappers + persistence for the Acuity ledger. The ledger rows are Acuity-shaped; the write maps
// each one to a generic `outcomes` row (ADR-058) under the account's Acuity outcome source. The mappers
// are side-effect-free and unit-tested against the real payload shape; upsertAppointments is the only DB
// touch and is idempotent on (account, source, Acuity id) (safe for webhook retries + backfill).

const CHUNK_SIZE = 500

export interface AttributionCols {
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  fbclid: string | null
  gclid: string | null
  landing_page: string | null
  referrer: string | null
}

/** Which write path observed this appointment. Recorded verbatim on the row so the
 *  outcome-observation trigger can attribute a change without guessing; 'unknown' is stored when unset. */
export type AcuityObservationSource = 'webhook' | 'sweep' | 'backfill' | 'manual'

/** Sources that fetch ONE appointment BY ID and therefore genuinely observe Acuity's `scheduledBy`.
 *
 *  Only these may establish origin provenance (`origin_observed_at`). Enforcing this on the WRITER'S ROLE
 *  rather than on the payload's shape matters: `'scheduledBy' in appt` delegates a durable business
 *  fact to an external API's response shape, so if Acuity's LIST endpoint ever returns the key (even
 *  as null) a sweep would manufacture an origin observation it never made — stamping its own clock as
 *  the observation time and promoting an origin-UNKNOWN booking to CAPI-eligible.
 *
 *  Verified by-id: 'webhook' → getAppointment(id).
 *  Verified LIST-shaped: 'sweep' → reconcileAcuityLedger, 'backfill' → scripts/backfill-acuity.ts.
 *  'manual' has no writer today; it is deliberately EXCLUDED so an unclassified new source fails
 *  CLOSED — no origin fact, the booking reads origin_unknown, which is honest rather than a guess. */
const ORIGIN_OBSERVING_SOURCES: ReadonlySet<AcuityObservationSource> = new Set(['webhook'])

export interface AcuityLedgerRow extends AttributionCols {
  id: number
  ad_account_id: string | null
  /** Set ONLY by a by-id payload that actually carried Acuity's scheduledBy key. Never by a sweep. */
  origin_observed_at?: string
  origin_observed_source?: AcuityObservationSource
  /** Writer-declared provenance of THIS observation (`observation_source`). Never inferred. */
  observation_source: AcuityObservationSource
  /** Present ONLY when the source payload carried Acuity's scheduledBy key (by-id fetches). Omitted for
   *  list-endpoint rows so a re-upsert never clobbers a previously stored origin. null = client-booked. */
  scheduled_by?: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  appointment_type: string | null
  appointment_type_id: number | null
  category: string | null
  calendar_id: number | null
  datetime: string | null
  datetime_created: string | null
  booking_date_et: string | null
  price: number | null
  price_sold: number | null
  amount_paid: number | null
  paid: boolean | null
  canceled: boolean
  no_show: boolean | null
  raw: unknown
  synced_at: string
}

const EMPTY_ATTRIBUTION: AttributionCols = {
  utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null,
  fbclid: null, gclid: null, landing_page: null, referrer: null,
}

// Intake field name (normalized: lowercased, non-alphanumerics stripped) → ledger column. Matching by
// NAME (not a hardcoded field id) so it survives field recreation; the tracking hidden fields are named
// exactly utm_source/…/referrer so their normalized forms land here.
const ATTRIBUTION_BY_NORM_NAME: Record<string, keyof AttributionCols> = {
  utmsource: 'utm_source',
  utmmedium: 'utm_medium',
  utmcampaign: 'utm_campaign',
  utmcontent: 'utm_content',
  utmterm: 'utm_term',
  fbclid: 'fbclid',
  gclid: 'gclid',
  landingpage: 'landing_page',
  referrer: 'referrer',
  referer: 'referrer',
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Money as Acuity returns it ("125.00" | 0 | null) → number | null (never NaN; negatives dropped). */
export function parseMoney(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Acuity "paid" is the string 'yes'/'no'. Returns null when absent. */
export function parsePaid(v: string | null | undefined): boolean | null {
  if (v === null || v === undefined || v === '') return null
  return String(v).trim().toLowerCase() === 'yes'
}

function cleanStr(v: unknown): string | null {
  if (typeof v !== 'string') return v == null ? null : String(v)
  const t = v.trim()
  return t ? t : null
}

/** PURE: pull recognized attribution params out of the appointment's intake form values.
 *  Empty/whitespace values are ignored; the first non-empty match per key wins. */
export function extractAttribution(forms: AcuityForm[] | null | undefined): AttributionCols {
  const out: AttributionCols = { ...EMPTY_ATTRIBUTION }
  if (!Array.isArray(forms)) return out
  for (const form of forms) {
    for (const v of form?.values ?? []) {
      const col = ATTRIBUTION_BY_NORM_NAME[normName(v?.name ?? '')]
      if (!col) continue
      const val = cleanStr(v?.value)
      if (val && out[col] == null) out[col] = val
    }
  }
  return out
}

/** PURE: Acuity appointment → ledger row. `raw` retains the full payload for audit/reprocessing. */
export function toLedgerRow(
  appt: AcuityAppointmentRaw,
  adAccountId: string | null = null,
  source: AcuityObservationSource = 'sweep',
): AcuityLedgerRow {
  const created = cleanStr(appt.datetimeCreated)
  return {
    // scheduled_by only when the payload HAS the key (by-id fetches) — list rows omit it entirely so
    // the upsert leaves any stored origin untouched (provided-columns-only update semantics).
    //
    // origin_observed_* needs BOTH: the key present AND a by-id WRITER. observation_source records
    // the LATEST WRITER, so the nightly sweep overwrote 'webhook' with 'sweep' and a genuine client
    // booking — even one with an accepted live CAPI delivery — was reclassified 'origin_unknown' and
    // dropped from reconciliation. Origin provenance is a durable fact about WHERE the origin was
    // established; keying it on the payload shape alone let a LIST-shaped writer claim an observation
    // it never made (see ORIGIN_OBSERVING_SOURCES).
    ...('scheduledBy' in appt
      ? {
          scheduled_by: cleanStr(appt.scheduledBy),
          ...(ORIGIN_OBSERVING_SOURCES.has(source)
            ? { origin_observed_at: new Date().toISOString(), origin_observed_source: source }
            : {}),
        }
      : {}),
    id: Number(appt.id),
    ad_account_id: adAccountId,
    observation_source: source,
    first_name: cleanStr(appt.firstName),
    last_name: cleanStr(appt.lastName),
    email: cleanStr(appt.email),
    phone: cleanStr(appt.phone),
    appointment_type: cleanStr(appt.type),
    appointment_type_id: appt.appointmentTypeID != null ? Number(appt.appointmentTypeID) : null,
    category: cleanStr(appt.category),
    calendar_id: appt.calendarID != null ? Number(appt.calendarID) : null,
    datetime: cleanStr(appt.datetime),
    datetime_created: created,
    booking_date_et: created ? (etDateOf(created) || null) : null,
    price: parseMoney(appt.price),
    price_sold: parseMoney(appt.priceSold),
    amount_paid: parseMoney(appt.amountPaid),
    paid: parsePaid(appt.paid),
    canceled: appt.canceled === true,
    no_show: typeof appt.noShow === 'boolean' ? appt.noShow : null,
    ...extractAttribution(appt.forms),
    raw: appt,
    synced_at: new Date().toISOString(),
  }
}

/** PURE: Acuity ledger row → `outcomes` row for one account's Acuity source. Dropped Acuity columns
 *  (appointment type id, category, calendar id, priceSold, paid) stay readable from `raw`. `origin` is
 *  present ONLY when the ledger row carries `scheduled_by` (a by-id payload) — omitted otherwise so a
 *  list-shaped re-upsert never clobbers a stored origin, exactly as scheduled_by was omitted. */
export function toOutcomeRow(
  row: AcuityLedgerRow,
  sourceId: string,
  currency: string,
): Record<string, unknown> {
  return {
    ...('scheduled_by' in row
      ? { origin: row.scheduled_by ? 'staff_or_manual' : 'website' }
      : {}),
    ...(row.origin_observed_at !== undefined ? { origin_observed_at: row.origin_observed_at } : {}),
    ...(row.origin_observed_source !== undefined ? { origin_observed_source: row.origin_observed_source } : {}),
    external_id: String(row.id),
    ad_account_id: row.ad_account_id,
    source_id: sourceId,
    outcome_type: ACUITY_OUTCOME_TYPE,
    currency,
    observation_source: row.observation_source,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    outcome_label: row.appointment_type,
    fulfilment_at: row.datetime,
    occurred_at: row.datetime_created,
    business_date: row.booking_date_et,
    gross_value: row.price,
    collected_value: row.amount_paid,
    status: row.canceled ? 'cancelled' : 'confirmed',
    fulfilment_status: row.no_show === null ? null : row.no_show ? 'no_show' : 'fulfilled',
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    utm_content: row.utm_content,
    utm_term: row.utm_term,
    fbclid: row.fbclid,
    gclid: row.gclid,
    landing_page: row.landing_page,
    referrer: row.referrer,
    raw: row.raw,
    synced_at: row.synced_at,
  }
}

/** Idempotent upsert on (account, Acuity source, Acuity id). Returns the number of rows written.
 *  Throws when a row has no ad account: outcomes.ad_account_id is NOT NULL, and dropping the row
 *  silently would lose a booking from the business ledger. */
export async function upsertAppointments(
  rows: AcuityLedgerRow[],
  supabase: SupabaseClient = getAdminClient(),
): Promise<number> {
  const valid = rows.filter((r) => Number.isFinite(r.id))
  if (valid.length === 0) return 0
  const unowned = valid.filter((r) => !r.ad_account_id)
  if (unowned.length > 0) {
    throw new Error(
      `upsertAppointments: ${unowned.length} Acuity appointment(s) have no ad account (no single active ad account resolved); outcomes require one.`,
    )
  }
  const sources = new Map<string, { sourceId: string; currency: string }>()
  for (const accountId of new Set(valid.map((r) => r.ad_account_id as string))) {
    sources.set(accountId, await ensureAcuitySource(supabase, accountId))
  }
  const outcomeRows = valid.map((r) => {
    const source = sources.get(r.ad_account_id as string)!
    return toOutcomeRow(r, source.sourceId, source.currency)
  })
  let total = 0
  for (let i = 0; i < outcomeRows.length; i += CHUNK_SIZE) {
    const chunk = outcomeRows.slice(i, i + CHUNK_SIZE)
    const { data, error } = await supabase
      .from('outcomes')
      .upsert(chunk, { onConflict: 'ad_account_id,source_id,external_id', ignoreDuplicates: false })
      .select('id')
    if (error) {
      throw new Error(`upsertAppointments chunk ${i}-${i + chunk.length} failed: ${error.message}`)
    }
    total += data?.length ?? 0
  }
  return total
}

/** Convenience: map raw Acuity appointments → ledger rows and upsert. */
export async function ingestAppointments(
  raws: AcuityAppointmentRaw[],
  adAccountId: string | null = null,
  supabase?: SupabaseClient,
  source: AcuityObservationSource = 'sweep',
): Promise<number> {
  return upsertAppointments(raws.map((r) => toLedgerRow(r, adAccountId, source)), supabase)
}

export { resolveAdAccountId } from '@/lib/outcomes/ledger-account'
