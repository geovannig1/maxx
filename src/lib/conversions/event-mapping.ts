import type { OutcomeSourceCapabilities } from '@/lib/outcomes/adapter'
import type { OutcomeOrigin, OutcomeStatus, OutcomeType } from '@/lib/outcomes/model'

/**
 * Which ad-platform event, if any, an outcome becomes (ADR-058). The order of the gates is the
 * contract:
 *   1. origin: only an outcome observed to come from the website is ever sent (CSV, staff and
 *      unknown origins never are);
 *   2. status: only a confirmed outcome; cancellations, refunds and pending outcomes never send;
 *   3. type: lead → Lead, sale → Purchase, booking → Schedule, signup → CompleteRegistration, unless
 *      the adapter overrides the name; any other type is not sent;
 *   4. platform-native events: an event the source already sends to the platform (declared by the
 *      adapter or by the source's own config) is never mirrored, so one result is never counted
 *      twice. A malformed per-source list refuses the send rather than ignoring the list.
 */
export const DEFAULT_CONVERSION_EVENTS: Readonly<Partial<Record<OutcomeType, string>>> = Object.freeze({
  lead: 'Lead',
  sale: 'Purchase',
  booking: 'Schedule',
  signup: 'CompleteRegistration',
})

export type ConversionSkipReason =
  | 'origin_not_website'
  | 'not_confirmed'
  | 'unmapped_type'
  | 'platform_native'
  | 'invalid_source_config'

export type ConversionDecision = { send: true; eventName: string } | { send: false; reason: ConversionSkipReason }

export function decideConversionEvent(input: {
  outcomeType: OutcomeType
  origin: OutcomeOrigin | null
  status: OutcomeStatus
  capabilities: Pick<OutcomeSourceCapabilities, 'platformNativeEvents' | 'conversionEventNames'>
  /** The source's non-secret `config.platformNativeEvents`, when it declares one. */
  sourcePlatformNativeEvents?: unknown
}): ConversionDecision {
  if (input.origin !== 'website') return { send: false, reason: 'origin_not_website' }
  if (input.status !== 'confirmed') return { send: false, reason: 'not_confirmed' }
  const eventName = input.capabilities.conversionEventNames?.[input.outcomeType]
    ?? DEFAULT_CONVERSION_EVENTS[input.outcomeType]
  if (!eventName) return { send: false, reason: 'unmapped_type' }
  const sourceNative = input.sourcePlatformNativeEvents
  if (sourceNative !== undefined && !(Array.isArray(sourceNative) && sourceNative.every((e) => typeof e === 'string'))) {
    return { send: false, reason: 'invalid_source_config' }
  }
  const native = new Set<string>([...input.capabilities.platformNativeEvents, ...((sourceNative as string[] | undefined) ?? [])])
  if (native.has(eventName)) return { send: false, reason: 'platform_native' }
  return { send: true, eventName }
}
