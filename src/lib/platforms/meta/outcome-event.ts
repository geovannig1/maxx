import 'server-only'
import { hashEmail, hashName, hashPhone } from '@/lib/capi/conversion-events'
import type {
  ConversionEventBuild,
  ConversionEventOptions,
  ConversionOutcome,
  ConversionSendCredentials,
} from '../types'
import { metaEventValue, resolvePixelId } from './conversions-delivery'
import { exceedsOutcomeMoneyCeiling } from '@/lib/outcomes/money-ceiling'

// Meta's Conversions API event for a generic outcome, moved out of core
// src/lib/conversions/outcome-conversions.ts, which now reaches it through the registry's
// conversions capability. The event, its 7-day window and the META_* configuration are Meta's.

const EVENT_MAX_AGE_MS = 7 * 24 * 3600_000
const FBC = /^fb\.1\.(\d{10,16})\.[^\s.][^\s]*$/

export type MetaOutcomeEventBuild =
  | { ok: true; payload: { data: [Record<string, unknown> & { event_id: string; event_time: number }]; test_event_code?: string } }
  | { ok: false; skip: 'expired' | 'no_event_source_url' | 'no_user_data' }

function httpUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** PURE: the single Meta event for one outcome, or the terminal reason it cannot be built. */
export function buildOutcomeConversionEvent(
  row: ConversionOutcome,
  opts: { eventName: string; testEventCode?: string | null; nowMs?: number },
): MetaOutcomeEventBuild {
  const now = opts.nowMs ?? Date.now()
  const occurredMs = row.occurred_at ? new Date(row.occurred_at).getTime() : NaN
  if (!Number.isFinite(occurredMs) || now - occurredMs > EVENT_MAX_AGE_MS) return { ok: false, skip: 'expired' }
  const sourceUrl = httpUrl(row.landing_page)
  if (!sourceUrl) return { ok: false, skip: 'no_event_source_url' }

  const user: Record<string, unknown> = {}
  const em = hashEmail(row.email)
  const ph = hashPhone(row.phone)
  const fn = hashName(row.first_name)
  const ln = hashName(row.last_name)
  if (em) { user.em = [em]; user.external_id = [em] }
  if (ph) user.ph = [ph]
  if (fn) user.fn = [fn]
  if (ln) user.ln = [ln]
  const fbp = (row.fbp ?? '').trim()
  if (fbp) user.fbp = fbp
  // A browser _fbc carries its own creation time; one created after the outcome cannot have led to it.
  const fbcMatch = FBC.exec((row.fbc ?? '').trim())
  if (fbcMatch && Number(fbcMatch[1]) <= occurredMs) user.fbc = fbcMatch[0]
  if (Object.keys(user).length === 0) return { ok: false, skip: 'no_user_data' }

  const value = row.gross_value === null ? NaN : Number(row.gross_value)
  const event = {
    event_name: opts.eventName,
    event_time: Math.floor(Math.min(occurredMs, now) / 1000),
    event_id: row.conversion_event_id ?? `maxx-${row.id}`,
    event_source_url: sourceUrl,
    action_source: 'website',
    user_data: user,
    // A value above OUTCOME_MONEY_CEILING is never sent (ingest refuses it; this guards older rows).
    ...(Number.isFinite(value) && value > 0 && !exceedsOutcomeMoneyCeiling(value) ? { custom_data: { value: metaEventValue(value, row.currency), currency: row.currency } } : {}),
  }
  return {
    ok: true,
    payload: { data: [event], ...(opts.testEventCode ? { test_event_code: opts.testEventCode } : {}) },
  }
}

/** Meta's event with the platform-neutral identity, time and value the delivery record needs. */
export function buildMetaOutcomeEvent(outcome: ConversionOutcome, options: ConversionEventOptions): ConversionEventBuild {
  const built = buildOutcomeConversionEvent(outcome, options)
  if (!built.ok) return built
  const event = built.payload.data[0]
  const customData = event.custom_data as { value: number; currency: string } | undefined
  return {
    ok: true,
    payload: built.payload,
    event: {
      id: event.event_id,
      timeSec: event.event_time,
      value: customData?.value ?? null,
      currency: customData?.currency ?? null,
    },
  }
}

/** The Test Events code; generic sending in `test` mode is off without it. */
export function metaTestEventCode(env: Record<string, string | undefined>): string | null {
  return env.META_TEST_EVENT_CODE || null
}

/** The pixel (configured, else the active account's) and the Conversions API token, else the general one. */
export async function resolveMetaSendCredentials(env: Record<string, string | undefined>): Promise<ConversionSendCredentials> {
  const pixelId = env.META_PIXEL_ID || await resolvePixelId()
  const accessToken = env.META_CAPI_ACCESS_TOKEN ?? env.META_ACCESS_TOKEN
  return { destinationId: pixelId || null, accessToken: accessToken || null }
}
