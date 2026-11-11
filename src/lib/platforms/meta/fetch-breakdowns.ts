import { metaGetPaginated } from './client'
import { ACTION_ATTRIBUTION_WINDOWS } from './attribution'
import { getAdminClient } from '@/lib/supabase/admin'
import { readOutcomeEventResult } from '@/lib/sync/upsert-insights'
import type { MetaInsightRow } from '@/types/meta-api'

// ============================================================
// Types
// ============================================================

export type BreakdownType =
  | 'age'
  | 'gender'
  | 'publisher_platform'
  | 'device_platform'
  | 'region'
  | 'platform_position'

export interface BreakdownRow {
  meta_entity_id: string
  entity_level: 'campaign' | 'adset' | 'ad'
  breakdown_type: BreakdownType
  breakdown_value: string
  spend: number
  impressions: number
  clicks: number
  leads: number | null
  bookings: number | null
  ctr: number | null
  cpa: number | null
}

interface MetaBreakdownAction {
  action_type: string
  value: string
}

export interface MetaBreakdownRecord {
  campaign_id?: string
  adset_id?: string
  ad_id?: string
  impressions?: string
  spend?: string
  clicks?: string
  ctr?: string
  actions?: MetaBreakdownAction[]
  results?: MetaInsightRow['results']
  // Breakdown dimension fields returned inline by Meta
  age?: string
  gender?: string
  publisher_platform?: string
  device_platform?: string
  region?: string
  platform_position?: string
}

// ============================================================
// Internal helpers
// ============================================================

function parseFloat0(val: string | undefined | null): number {
  if (!val) return 0
  const n = parseFloat(val)
  return isFinite(n) ? n : 0
}

function requiredDeliveryValue(
  value: string | undefined,
  field: 'spend' | 'impressions' | 'clicks' | 'ctr',
  integer: boolean,
): number {
  const parsed = value === undefined || value === '' ? Number.NaN : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Meta breakdown required delivery field ${field} is missing or malformed`)
  }
  return parsed
}

function outcomeValue(value: string | undefined): number | null {
  const parsed = value === undefined || value === '' ? Number.NaN : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function strictActionSum(
  actions: MetaBreakdownAction[],
  matches: (type: string) => boolean,
): number | null {
  let total = 0
  for (const action of actions) {
    if (!matches(action.action_type ?? '')) continue
    const parsed = outcomeValue(action.value)
    if (parsed === null) return null
    total += parsed
  }
  return total
}

const APPOINTMENT_CONVERSION_ID = '10000000000000002'

function isAppointmentSpecific(type: string): boolean {
  const t = (type ?? '').toLowerCase()
  return t.includes('appointmentconfirmed') || t.includes(APPOINTMENT_CONVERSION_ID)
}

/** Diagnostic action-alias reading. Specific AppointmentConfirmed aliases are one logical conversion,
 * so use MAX. The generic custom aggregate is never AppointmentConfirmed. */
export function findBookingsFromActions(actions: MetaBreakdownAction[] | undefined): number {
  if (!Array.isArray(actions)) return 0
  let specific = 0
  for (const a of actions) {
    const type = a.action_type ?? ''
    if (isAppointmentSpecific(type)) {
      specific = Math.max(specific, parseFloat0(a.value))
    }
  }
  return Math.round(specific)
}

/** Bookings for one breakdown record: the indicator-named `results` field is the canonical source
 *  (Ads Manager's Results column). Missing/invalid Results is unavailable; actions are diagnostic only. */
export function bookingsForBreakdownRecord(
  rec: Pick<MetaBreakdownRecord, 'actions' | 'results'>,
): number | null {
  const result = readOutcomeEventResult(rec.results)
  return result.matched && result.valid ? Math.round(result.value) : null
}

function normalizedBreakdownOutcomes(
  rec: Pick<MetaBreakdownRecord, 'actions' | 'results'>,
): { leads: number | null; bookings: number | null } {
  const bookings = bookingsForBreakdownRecord(rec)
  // Placement evidence is committed atomically: a booking result without a readable lead plane
  // (or vice versa) is not a complete outcome observation. In particular, Meta can return an
  // actions array with no lead actions while omitting the canonical Results indicator; treating
  // that as `0` leads and unavailable bookings produces a mixed pair the database correctly
  // rejects. Preserve a pair only when both canonical planes are readable.
  if (bookings === null || !Array.isArray(rec.actions)) {
    return { leads: null, bookings: null }
  }
  const leads = strictActionSum(
    rec.actions,
    (type) => type === 'lead' || type === 'offsite_conversion.fb_pixel_lead',
  )
  if (leads === null) return { leads: null, bookings: null }
  return {
    leads: Math.round(leads),
    bookings,
  }
}

function entityIdFor(
  record: MetaBreakdownRecord,
  level: 'campaign' | 'adset' | 'ad',
): string | null {
  if (level === 'campaign') return record.campaign_id ?? null
  if (level === 'adset') return record.adset_id ?? null
  return record.ad_id ?? null
}

/**
 * The dimension value Meta reported, or null when Meta did not report the field at all.
 *
 * These are NOT the same thing, and collapsing them to a shared `'unknown'` sentinel is what
 * broke the executive placement step: Meta returns the literal string `"unknown"` as a real
 * placement bucket (verified against the live API — `publisher_platform` was never absent on
 * any day of the trailing window, and came back as `"unknown"` for one ad set on 2026-08-16).
 * The caller rejects `'unknown'` as unreadable, so a legitimate observed value failed the
 * contract, the step threw, and every sync stayed `partial` for three days.
 *
 * Null now means only one thing: Meta omitted the field. Meta's own values pass through
 * untouched, including "unknown", which downstream already labels as "Unknown".
 */
function breakdownValueFor(
  record: MetaBreakdownRecord,
  breakdownType: BreakdownType,
): string | null {
  switch (breakdownType) {
    case 'age':                return record.age ?? null
    case 'gender':             return record.gender ?? null
    case 'publisher_platform': return record.publisher_platform ?? null
    case 'device_platform':    return record.device_platform ?? null
    case 'region':             return record.region ?? null
    case 'platform_position':  return record.platform_position ?? null
  }
}

/** Convert one Meta breakdown record without inventing delivery or outcome zeros. Required scalar
 * delivery fields must be explicit. Outcomes are atomic: both are observed numbers, or both null. */
export function buildBreakdownRow(
  rec: MetaBreakdownRecord,
  level: 'campaign' | 'adset',
  breakdownType: BreakdownType,
): BreakdownRow {
  const metaEntityId = entityIdFor(rec, level)
  if (!metaEntityId) throw new Error(`Meta breakdown required ${level} identifier is missing`)
  const breakdownValue = breakdownValueFor(rec, breakdownType)
  // Absent or blank is still a contract violation — we could not read the dimension. A value
  // Meta actually reported is kept, whatever it says, including "unknown".
  if (breakdownValue === null || !breakdownValue.trim()) {
    throw new Error(`Meta breakdown required ${breakdownType} value is missing`)
  }
  const spend = requiredDeliveryValue(rec.spend, 'spend', false)
  const impressions = requiredDeliveryValue(rec.impressions, 'impressions', true)
  const clicks = requiredDeliveryValue(rec.clicks, 'clicks', true)
  const outcomes = normalizedBreakdownOutcomes(rec)
  const ctr = rec.ctr === undefined ? null : requiredDeliveryValue(rec.ctr, 'ctr', false)
  return {
    meta_entity_id: metaEntityId,
    entity_level: level,
    breakdown_type: breakdownType,
    breakdown_value: breakdownValue,
    spend,
    impressions,
    clicks,
    leads: outcomes.leads,
    bookings: outcomes.bookings,
    ctr,
    cpa: outcomes.bookings !== null && outcomes.bookings > 0 ? spend / outcomes.bookings : null,
  }
}

// ============================================================
// fetchBreakdowns
// ============================================================

/** Meta's supported-permutation table never lists `platform_position` on its own — it appears only
 *  joined with `publisher_platform` (`publisher_platform, platform_position`, asterisk-marked, i.e.
 *  explicitly joinable with `action_type` / `action_target_id` / `action_destination`). Requesting it
 *  alone is rejected with "(#100) Current combination of data breakdown columns (action_type,
 *  platform_position) is invalid" — and, verified live against v25.0 on 2026-08-16, the SAME error
 *  comes back with `actions`/`results` removed from `fields`, so the action fields are not the cause:
 *  Meta always evaluates an implicit `action_type` action-breakdown. Requesting the documented joint
 *  permutation is therefore the fix that keeps outcomes rather than sacrificing them.
 *  Ref: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/ */
const REQUEST_DIMENSIONS: Record<BreakdownType, readonly BreakdownType[]> = {
  age: ['age'],
  gender: ['gender'],
  publisher_platform: ['publisher_platform'],
  device_platform: ['device_platform'],
  region: ['region'],
  platform_position: ['publisher_platform', 'platform_position'],
}

/** Collapse a joint-permutation response back onto the single dimension that was asked for. Meta
 *  returns one cell per (publisher_platform × platform_position), so the same position (`feed` runs on
 *  both facebook and instagram — verified live) arrives more than once; left unfolded those rows share
 *  a (entity, breakdown_type, breakdown_value) key, which `replace_executive_placement_window` rejects
 *  as 'executive placement snapshot contains duplicate rows' and `upsertBreakdowns` would silently
 *  collapse to whichever chunk landed last. Delivery sums; outcomes stay atomic and go NULL whenever
 *  ANY contributing cell lacks them, so a partially-reported placement is never reported as zero. */
function collapseToRequestedDimension(rows: BreakdownRow[]): BreakdownRow[] {
  const grouped = new Map<string, BreakdownRow>()
  for (const row of rows) {
    const key = `${row.entity_level} ${row.meta_entity_id} ${row.breakdown_value}`
    const current = grouped.get(key)
    if (!current) {
      grouped.set(key, row)
      continue
    }
    const outcomesKnown = current.leads !== null && current.bookings !== null
      && row.leads !== null && row.bookings !== null
    const spend = current.spend + row.spend
    const impressions = current.impressions + row.impressions
    const clicks = current.clicks + row.clicks
    const leads = outcomesKnown ? current.leads! + row.leads! : null
    const bookings = outcomesKnown ? current.bookings! + row.bookings! : null
    grouped.set(key, {
      ...current,
      spend,
      impressions,
      clicks,
      leads,
      bookings,
      // Meta's per-cell ctr no longer describes the merged row. Re-derive it from Meta's own
      // definition (clicks / impressions) using required delivery fields — never invented.
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      cpa: bookings !== null && bookings > 0 ? spend / bookings : null,
    })
  }
  return [...grouped.values()]
}

export async function fetchBreakdowns(params: {
  accountId: string
  level: 'campaign' | 'adset'
  since: string
  until: string
  breakdowns: BreakdownType[]
  /** Publication-boundary reads must fail the whole requested slice when one dimension fails. */
  strict?: boolean
}): Promise<BreakdownRow[]> {
  const { accountId, level, since, until, breakdowns, strict = false } = params

  // Request id fields per level plus breakdown dimensions
  const levelIdFields = level === 'campaign'
    ? ['campaign_id']
    : ['campaign_id', 'adset_id']

  const fields = [
    ...levelIdFields,
    'impressions',
    'spend',
    'clicks',
    'actions',
    // Indicator-named Results (canonical bookings source; actions may only carry the generic
    // fb_pixel_custom aggregate — see bookingsForBreakdownRecord).
    'results',
    'ctr',
  ].join(',')

  const allRows: BreakdownRow[] = []

  // Fetch each breakdown type separately (Meta requires one breakdown per request). Resilient
  // per-dimension: a breakdown Meta rejects (e.g. an unsupported standalone combo) is logged and
  // skipped so the remaining dimensions still sync.
  for (const breakdownType of breakdowns) {
    const requestDimensions = REQUEST_DIMENSIONS[breakdownType]
    let records: MetaBreakdownRecord[]
    try {
      records = await metaGetPaginated<MetaBreakdownRecord>(
        `/act_${accountId}/insights`,
        {
          fields,
          level,
          breakdowns: requestDimensions.join(','),
          time_range: JSON.stringify({ since, until }),
          time_increment: 'all_days',
          action_attribution_windows: ACTION_ATTRIBUTION_WINDOWS,
          limit: '500',
        },
      )
    } catch (err) {
      if (strict) throw err
      console.warn(`[fetchBreakdowns] breakdown "${breakdownType}" failed, skipping:`, err instanceof Error ? err.message : err)
      continue
    }

    const built = records.map((rec) => buildBreakdownRow(rec, level, breakdownType))
    allRows.push(...(requestDimensions.length > 1 ? collapseToRequestedDimension(built) : built))
  }

  return allRows
}

// ============================================================
// upsertBreakdowns
// ============================================================

const CHUNK_SIZE = 500

export async function upsertBreakdowns(
  adAccountDbId: string,
  dateStart: string,
  rows: BreakdownRow[],
): Promise<number> {
  if (rows.length === 0) return 0

  const supabase = getAdminClient()

  const dbRows = rows.map((r) => ({
    ad_account_id: adAccountDbId,
    date_start: dateStart,
    entity_level: r.entity_level,
    meta_entity_id: r.meta_entity_id,
    breakdown_type: r.breakdown_type,
    breakdown_value: r.breakdown_value,
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    leads: r.leads,
    bookings: r.bookings,
    ctr: r.ctr,
    cpa: r.cpa,
  }))

  let totalUpserted = 0

  for (let i = 0; i < dbRows.length; i += CHUNK_SIZE) {
    const chunk = dbRows.slice(i, i + CHUNK_SIZE)

    const { data, error } = await supabase
      .from('insight_breakdowns')
      .upsert(chunk, {
        onConflict: 'ad_account_id,date_start,entity_level,meta_entity_id,breakdown_type,breakdown_value',
        ignoreDuplicates: false,
      })
      .select('id')

    if (error) {
      throw new Error(`upsertBreakdowns chunk ${i}-${i + chunk.length} failed: ${error.message}`)
    }

    totalUpserted += data?.length ?? 0
  }

  return totalUpserted
}
