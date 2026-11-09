import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'
import type { OutcomeOrigin, OutcomeStatus, OutcomeType } from '@/lib/outcomes/model'
import { decideConversionEvent } from './event-mapping'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import type { CapiResponseVerdict } from '@/lib/platforms/types'

// Conversions for generic outcomes (ADR-058, the v1 release). A source whose adapter declares its own
// conversion sender (the reference example keeps its byte-identical one) is skipped here; every other
// source with an adapter goes here.
//
//   * Gated off → test → live by OUTCOME_CONVERSIONS_SEND, separate from any adapter's own send flag, so
//     turning one on never turns on the other. `test` without the platform's test event code is off,
//     never live.
//   * Event name, origin, status and platform-native suppression: decideConversionEvent.
//   * Send once: never when conversion_sent_at is set; the delivery RPC records the attempt and
//     stamps conversion_sent_at in one transaction, keyed by the derived event id `maxx-<outcome id>`
//     (unique per outcome and platform). The platform deduplicates a retry of the same event id.
//   * Never retract: a later cancellation or refund sends nothing.
//   * True event time: occurred_at, future skew capped at now, older than the platform's window → skip.
// The event payload, its window and the platform credentials are the platform's conversions capability.
// Terminal skips are written to outcomes.conversion_send_error so the sweep stops retrying them.

// The conversions transport and event are the Meta platform's.
const metaConversions = () => requireCapability(getAdPlatform('meta'), 'conversions')

export type OutcomeSendMode = 'live' | 'test' | 'off'

/** Labels that close an outcome out for conversions; the sweep never retries them. */
export const OUTCOME_CONVERSION_TERMINAL: ReadonlySet<string> = new Set([
  'origin_not_website', 'unmapped_type', 'platform_native', 'invalid_source_config',
  'expired', 'no_event_source_url', 'no_user_data', 'missed-48h-window',
])

export function resolveOutcomeSendMode(env: Record<string, string | undefined> = process.env): OutcomeSendMode {
  const flag = (env.OUTCOME_CONVERSIONS_SEND ?? '').trim().toLowerCase()
  if (flag === 'true') return 'live'
  if (flag === 'test') return metaConversions().testEventCode(env) ? 'test' : 'off'
  return 'off'
}

export interface OutcomeConversionRow {
  id: string
  source_id: string
  outcome_type: OutcomeType
  status: OutcomeStatus
  origin: OutcomeOrigin | null
  origin_observed_at: string | null
  occurred_at: string | null
  gross_value: string | number | null
  currency: string
  email: string | null
  phone: string | null
  first_name: string | null
  last_name: string | null
  fbp: string | null
  fbc: string | null
  landing_page: string | null
  conversion_sent_at: string | null
  /** The sender's browser-pixel event id, when it supplied one; otherwise the id is derived. */
  conversion_event_id?: string | null
}

const ROW_COLUMNS = 'id, source_id, outcome_type, status, origin, origin_observed_at, occurred_at, gross_value, currency, '
  + 'email, phone, first_name, last_name, fbp, fbc, landing_page, conversion_sent_at, conversion_event_id'

export interface OutcomeSendResult {
  mode: OutcomeSendMode
  status: 'sent' | 'skipped' | 'error' | 'off' | 'already_sent' | 'accepted_unrecorded'
  skip?: string
  error?: string
  eventId?: string
}

async function label(db: SupabaseClient, outcomeId: string, text: string): Promise<void> {
  const { error } = await db.from('outcomes').update({ conversion_send_error: text.slice(0, 300) }).eq('id', outcomeId)
  if (error) console.error(`[outcome conversions] label write failed for ${outcomeId}: ${error.message}`)
}

/** Send one outcome's conversion if, and only if, every gate passes. Never throws. */
export async function sendOutcomeConversion(
  db: SupabaseClient,
  outcomeId: string,
  opts: { nowMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<OutcomeSendResult> {
  const env = opts.env ?? process.env
  const mode = resolveOutcomeSendMode(env)
  if (mode === 'off') return { mode, status: 'off' }
  try {
    const { data: row, error } = await db.from('outcomes').select(ROW_COLUMNS).eq('id', outcomeId).maybeSingle()
    if (error || !row) return { mode, status: 'error', error: 'outcome unavailable' }
    const outcome = row as unknown as OutcomeConversionRow
    if (outcome.conversion_sent_at) return { mode, status: 'already_sent' }

    const { data: source, error: sourceError } = await db
      .from('outcome_sources').select('kind, enabled, config').eq('id', outcome.source_id).maybeSingle()
    if (sourceError || !source) return { mode, status: 'error', error: 'source unavailable' }
    const { kind, enabled, config } = source as { kind: string; enabled: boolean; config: Record<string, unknown> | null }
    const adapter = getOutcomeAdapter(kind)
    // A source with its own sender, one without an adapter, one that does not establish origin (csv: the
    // stated origin is recorded, never observed) or a disabled one never sends here.
    if (!adapter || adapter.capabilities.ownConversionSender || !enabled || !adapter.capabilities.originKnown) {
      return { mode, status: 'skipped', skip: 'source_not_sendable' }
    }

    const decision = decideConversionEvent({
      outcomeType: outcome.outcome_type,
      origin: outcome.origin_observed_at ? outcome.origin : null,
      status: outcome.status,
      capabilities: adapter.capabilities,
      sourcePlatformNativeEvents: config?.platformNativeEvents,
    })
    if (!decision.send) {
      if (OUTCOME_CONVERSION_TERMINAL.has(decision.reason)) await label(db, outcomeId, decision.reason)
      return { mode, status: 'skipped', skip: decision.reason }
    }

    const built = metaConversions().buildOutcomeEvent(outcome, {
      eventName: decision.eventName, testEventCode: mode === 'test' ? metaConversions().testEventCode(env) : null, nowMs: opts.nowMs,
    })
    if (!built.ok) {
      await label(db, outcomeId, built.skip)
      return { mode, status: 'skipped', skip: built.skip }
    }
    const { event } = built
    const { destinationId, accessToken } = await metaConversions().resolveSendCredentials(env)
    if (!destinationId || !accessToken) return { mode, status: 'error', error: 'pixel id / access token unavailable', eventId: event.id }

    const response = await metaConversions().send(destinationId, accessToken, built.payload)
    const verdict: CapiResponseVerdict = 'networkError' in response
      ? { accepted: false, errorClass: 'network_error', message: response.networkError, eventsReceived: null }
      : metaConversions().interpretResponse(response.httpOk, response.httpStatus, response.parsed)
    const errorState = verdict.accepted ? null : verdict.errorClass
    const recorded = await metaConversions().recordDelivery({
      outcomeId,
      eventId: event.id,
      eventTimeSec: event.timeSec,
      value: event.value,
      currency: event.currency,
      mode,
      eventsReceived: verdict.accepted ? 1 : verdict.eventsReceived,
      errorState,
      errorClass: errorState,
    }, db)

    if (!verdict.accepted) {
      console.error(`[outcome conversions] ${event.id} not delivered (${verdict.errorClass}): ${verdict.message}`)
      await label(db, outcomeId, verdict.message)
      return { mode, status: 'error', error: verdict.message, eventId: event.id }
    }
    if (!recorded.ok) {
      // The platform has it; the audit row does not. Left unsent so the sweep retries the same event id,
      // which the platform deduplicates.
      console.error(`[outcome conversions] CRITICAL: ${event.id} accepted but unrecorded (${recorded.errorClass})`)
      return { mode, status: 'accepted_unrecorded', error: recorded.message, eventId: event.id }
    }
    return { mode, status: 'sent', eventId: event.id }
  } catch (err) {
    console.error('[outcome conversions] send failed:', err instanceof Error ? err.message : err)
    return { mode, status: 'error', error: 'send failed' }
  }
}
