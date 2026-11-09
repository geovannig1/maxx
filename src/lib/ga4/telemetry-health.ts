import type { PlaneHealthEvidence } from '@/lib/cockpit/evidence'

/**
 * Ledger G. Turn the monitoring run's stored GA4 snapshot into a plane-health statement.
 *
 * The counterpart of the reference adapter's outcome ledger-health evaluator, and deliberately the same shape: a PURE function
 * over a stored value, so the rule that decides "GA4 is fine" is testable without a network, a
 * database, or a live property.
 *
 * The distinction this module exists to preserve is ABSENT vs DOWN. Returning `null` means the
 * monitoring run has never recorded an answer for this account, so the cockpit omits GA4 entirely and
 * says nothing about it. Every non-null return means GA4 was actually interrogated. Collapsing those
 * two into "unavailable" would let the page assert an outage it never observed — the same error as
 * reading an empty result as absence.
 *
 * There is no branch that infers health from configuration. `GA4_PROPERTY_ID` being set says a
 * request COULD be made; it says nothing about whether one was, or what came back.
 */

/** Daily monitoring run plus twelve hours of scheduling slack — matches the reference outcome adapter's ledger max age. */
export const GA4_TELEMETRY_MAX_AGE_MS = 36 * 60 * 60 * 1000

interface StoredGa4TelemetryHealth {
  checked_at?: unknown
  available?: unknown
  window_start_date?: unknown
  window_end_date?: unknown
  confirmation_events?: unknown
}

function parseStored(value: unknown): StoredGa4TelemetryHealth | null {
  if (value === null || value === undefined) return null
  // Stored as a JSON string by the monitoring upsert; some readers hand back a parsed object.
  if (typeof value === 'string') {
    try { return parseStored(JSON.parse(value)) } catch { return null }
  }
  return typeof value === 'object' ? value as StoredGa4TelemetryHealth : null
}

/**
 * PURE. `null` = never established (omit the plane). Any object = GA4 answered, and this is what it
 * said.
 */
export function evaluateGa4TelemetryHealth(
  value: unknown,
  nowMs: number = Date.now(),
): Omit<PlaneHealthEvidence, 'plane'> | null {
  const raw = parseStored(value)
  if (!raw) return null

  const checkedAt = typeof raw.checked_at === 'string' ? raw.checked_at : null
  const checkedMs = checkedAt === null ? Number.NaN : Date.parse(checkedAt)
  // A row exists, so the plane IS established — but its own timestamp is unreadable, so the age
  // cannot be bounded. That is a broken record, not a healthy one, and not an absent one either.
  if (!Number.isFinite(checkedMs)) {
    return { state: 'unavailable', synchronizedAt: null, blockerCodes: ['ga4_telemetry_health_invalid'] }
  }

  const ageMs = nowMs - checkedMs
  // A future stamp cannot bound age either; treat it exactly as unreadable rather than as fresh.
  if (ageMs < -5 * 60 * 1000) {
    return {
      state: 'unavailable',
      synchronizedAt: checkedAt,
      blockerCodes: ['ga4_telemetry_health_invalid_future_timestamp'],
    }
  }
  if (ageMs > GA4_TELEMETRY_MAX_AGE_MS) {
    return { state: 'stale', synchronizedAt: checkedAt, blockerCodes: ['ga4_telemetry_health_stale'] }
  }
  if (raw.available !== true) {
    // `available` absent is NOT the same as `available: false`, but neither asserts that GA4
    // answered, and neither may be rendered as healthy.
    return {
      state: 'unavailable',
      synchronizedAt: checkedAt,
      blockerCodes: [raw.available === false ? 'ga4_telemetry_unavailable' : 'ga4_telemetry_health_incomplete'],
    }
  }
  return { state: 'available', synchronizedAt: checkedAt, blockerCodes: [] }
}
