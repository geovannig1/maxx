import { resolveOnlyActiveAccount, type ActiveAccountResolution } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'
import {
  EDITABLE_RANGE_FIELDS,
  METRIC_RANGES,
  applyTargetOverrides,
  mergeRanges,
  validateRangeOrdering,
  type EditableRangeField,
  type MetricKey,
  type TargetOverrides,
} from '@/lib/targets/target-ranges'

// Persistence for the Performance-Targets editor. The legacy app_settings row records values, but it
// does NOT record an immutable version, owner approval, effective date, or approval provenance. Valid
// legacy values may therefore configure diagnostic/display bands; they must not authorize moving money.
// A `governed` read path can be added once that durable approval contract exists.

const TARGETS_KEY = 'performance_targets'

export type TargetPolicyStatus =
  | 'governed'
  | 'unversioned'
  | 'missing'
  | 'invalid'
  | 'unavailable'
  | 'not_evaluated'

export type TargetPolicyHealth =
  | {
      status: 'governed'
      authorityEligible: true
      reasonCode: null
      reason: null
    }
  | {
      status: Exclude<TargetPolicyStatus, 'governed'>
      authorityEligible: false
      reasonCode: TargetPolicyUnavailableReasonCode | 'not_evaluated'
      reason: string
    }

export type TargetPolicyUnavailableReasonCode =
  | 'account_not_found'
  | 'account_ambiguous'
  | 'account_unavailable'
  | 'settings_read_failed'
  | 'not_configured'
  | 'invalid_json'
  | 'invalid_values'
  | 'unversioned_app_setting'

export type TargetPolicyRead =
  | {
      status: 'unversioned'
      overrides: TargetOverrides
      authorityEligible: false
      reasonCode: 'unversioned_app_setting'
      reason: string
      provenance: {
        source: 'app_settings.performance_targets'
        status: 'unversioned_app_setting'
        updatedAt: string | null
        ownerApprovalRecorded: false
        versionRecorded: false
      }
    }
  | {
      status: 'missing' | 'invalid' | 'unavailable'
      overrides: null
      authorityEligible: false
      reasonCode: Exclude<TargetPolicyUnavailableReasonCode, 'unversioned_app_setting'>
      reason: string
      provenance: null
    }

export interface SaveTargetOverridesResult {
  ok: boolean
  authorityEligible?: false
  policyStatus?: 'unversioned'
  errorCode?: TargetPolicyUnavailableReasonCode | 'write_failed'
  error?: string
}

type ParsedOverrides =
  | { ok: true; overrides: TargetOverrides }
  | { ok: false; reasonCode: 'invalid_json' | 'invalid_values'; reason: string }

function unavailable(
  status: 'missing' | 'invalid' | 'unavailable',
  reasonCode: Exclude<TargetPolicyUnavailableReasonCode, 'unversioned_app_setting'>,
  reason: string,
): TargetPolicyRead {
  return { status, overrides: null, authorityEligible: false, reasonCode, reason, provenance: null }
}

function accountFailure(
  resolution: Exclude<ActiveAccountResolution, { ok: true }>,
): TargetPolicyRead {
  if (resolution.reason === 'not_found') {
    return unavailable('unavailable', 'account_not_found', 'No active ad account is configured.')
  }
  if (resolution.reason === 'ambiguous') {
    return unavailable(
      'unavailable',
      'account_ambiguous',
      'More than one active ad account is configured; target-policy ownership is ambiguous.',
    )
  }
  return unavailable('unavailable', 'account_unavailable', 'The active ad account could not be resolved.')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Strictly parse the persisted boundary. Unknown metrics/fields and non-finite/negative values are
 * invalid rather than silently dropped. Validation covers the complete effective range so a partial
 * override cannot invert the default band ordering. */
export function parseStoredTargetOverrides(value: unknown): ParsedOverrides {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return { ok: false, reasonCode: 'invalid_json', reason: 'The stored performance targets are not valid JSON.' }
    }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reasonCode: 'invalid_values', reason: 'The stored performance targets must be an object.' }
  }

  const metricKeys = new Set(Object.keys(METRIC_RANGES) as MetricKey[])
  const editableFields = new Set<string>(EDITABLE_RANGE_FIELDS)
  const overrides: TargetOverrides = {}

  for (const [rawMetric, rawFields] of Object.entries(parsed)) {
    if (!metricKeys.has(rawMetric as MetricKey) || !isPlainObject(rawFields)) {
      return {
        ok: false,
        reasonCode: 'invalid_values',
        reason: `The stored performance targets contain an unknown or malformed metric: ${rawMetric}.`,
      }
    }

    const fields: Partial<Record<EditableRangeField, number>> = {}
    for (const [rawField, rawValue] of Object.entries(rawFields)) {
      if (
        !editableFields.has(rawField) ||
        typeof rawValue !== 'number' ||
        !Number.isFinite(rawValue) ||
        rawValue < 0
      ) {
        return {
          ok: false,
          reasonCode: 'invalid_values',
          reason: `The stored performance targets contain an invalid ${rawMetric}.${rawField} value.`,
        }
      }
      fields[rawField as EditableRangeField] = rawValue
    }
    overrides[rawMetric as MetricKey] = fields
  }

  const ordering = validateRangeOrdering(mergeRanges(overrides))
  if (!ordering.ok) {
    return {
      ok: false,
      reasonCode: 'invalid_values',
      reason: `The stored performance target bands are out of order: ${ordering.errors.join(' ')}`,
    }
  }

  return { ok: true, overrides }
}

export async function loadTargetOverrides(): Promise<TargetPolicyRead> {
  try {
    const db = getAdminClient()
    const account = await resolveOnlyActiveAccount(db)
    if (!account.ok) return accountFailure(account)

    const { data, error } = await db
      .from('app_settings')
      .select('value, updated_at')
      .eq('ad_account_id', account.account.id)
      .eq('key', TARGETS_KEY)
      .maybeSingle()

    if (error) {
      return unavailable('unavailable', 'settings_read_failed', `Performance-target settings read failed: ${error.message}`)
    }
    if (data?.value === undefined || data?.value === null || data.value === '') {
      return unavailable('missing', 'not_configured', 'Performance targets have not been configured.')
    }

    const parsed = parseStoredTargetOverrides(data.value)
    if (!parsed.ok) return unavailable('invalid', parsed.reasonCode, parsed.reason)

    return {
      status: 'unversioned',
      overrides: parsed.overrides,
      authorityEligible: false,
      reasonCode: 'unversioned_app_setting',
      reason: 'Performance targets are stored, but no immutable version or owner-approval provenance is recorded. They are diagnostic only.',
      provenance: {
        source: 'app_settings.performance_targets',
        status: 'unversioned_app_setting',
        updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
        ownerApprovalRecorded: false,
        versionRecorded: false,
      },
    }
  } catch (error) {
    return unavailable(
      'unavailable',
      'settings_read_failed',
      `Performance-target settings read failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function saveTargetOverrides(overrides: TargetOverrides): Promise<SaveTargetOverridesResult> {
  try {
    const parsed = parseStoredTargetOverrides(overrides)
    if (!parsed.ok) return { ok: false, errorCode: parsed.reasonCode, error: parsed.reason }

    const db = getAdminClient()
    const account = await resolveOnlyActiveAccount(db)
    if (!account.ok) {
      const failure = accountFailure(account)
      return { ok: false, errorCode: failure.reasonCode, error: failure.reason }
    }

    const { error } = await db.from('app_settings').upsert(
      {
        ad_account_id: account.account.id,
        key: TARGETS_KEY,
        value: JSON.stringify(parsed.overrides),
        setting_type: 'json',
        label: 'Performance Targets',
        description: 'Editable diagnostic target ranges. Immutable owner approval and version provenance are not recorded.',
      },
      { onConflict: 'ad_account_id,key' },
    )
    if (error) return { ok: false, errorCode: 'write_failed', error: error.message }
    return { ok: true, policyStatus: 'unversioned', authorityEligible: false }
  } catch (error) {
    return { ok: false, errorCode: 'write_failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** Load the diagnostic ranges for this server request and return their authority health. Defaults are
 * applied BEFORE any I/O so a warm process can never retain another request's override after a read
 * failure, missing row, malformed row, or ambiguous account resolution. */
export async function hydrateTargetOverrides(): Promise<TargetPolicyRead> {
  applyTargetOverrides(null)
  const read = await loadTargetOverrides()
  if (read.status === 'unversioned') applyTargetOverrides(read.overrides)
  return read
}
