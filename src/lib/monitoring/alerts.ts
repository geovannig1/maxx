import * as Sentry from '@sentry/nextjs'

// Central alert emitter. One place that:
//   - maps a severity to a Sentry level,
//   - MASKS anything token-shaped so secrets never reach logs/Sentry,
//   - de-dupes within a window so we don't SPAM the same alert every cron tick,
//   - is no-throw (a monitoring failure must never break the job it's monitoring).
//
// Routing (email/Slack) is configured owner-side in Sentry; this just emits with the right level+tags.

export type Severity = 'info' | 'warning' | 'critical'

export type MonitoringArea =
  | 'sync'
  | 'stale_data'
  | 'meta_token'
  | 'ga4'
  | 'supabase'
  | 'cron'
  | 'report'
  | 'llm'
  | 'write_attempt'
  | 'write_mode'
  /** GA event-VALUE tag health. Renamed from 'booking_revenue': the check reads GA confirmation
   *  events and GA event value, which are telemetry — it never observes a booking or revenue. */
  | 'ga_event_value_health'
  /** GA BROWSER-TAG coverage: website-origin appointments vs GA confirmation events over the same
   *  dates. Separate from meta_delivery_health — one all-source check let organic volume
   *  argue about a paid subset and claimed a "tracking outage" it could not support. */
  | 'ga_tag_health'
  /** Server-side CAPI delivery to Meta. Judged ONLY on recorded sends, never on ledger volume. */
  | 'meta_delivery_health'
  | 'meta_ga4_mismatch'
  | 'duplicate_data'
  | 'utm_coverage'

const SEVERITY_TO_SENTRY: Record<Severity, Sentry.SeverityLevel> = {
  info: 'info',
  warning: 'warning',
  critical: 'fatal',
}

// Token-shaped strings get masked to prefix…suffix (mirrors the sync orchestrator's masker).
export function maskSecrets(s: string): string {
  return s.replace(
    /\b([A-Za-z0-9]{6})[A-Za-z0-9]{5,}([A-Za-z0-9]{4})\b/g,
    (match: string, prefix: string, suffix: string) => (match.length > 20 ? `${prefix}...${suffix}` : match)
  )
}

// Best-effort in-process de-dupe. Serverless cold starts reset this (documented), so it's a spam
// REDUCER, not a guarantee. Default window: 6h.
const lastEmitted = new Map<string, number>()
const DEFAULT_DEDUPE_MS = 6 * 60 * 60 * 1000

export interface EmitOptions {
  area: MonitoringArea
  severity: Severity
  message: string
  /** Stable key for de-duping (defaults to area). */
  dedupeKey?: string
  dedupeMs?: number
  context?: Record<string, unknown>
}

export interface EmitResult {
  emitted: boolean
  reason?: 'deduped'
  area: MonitoringArea
  severity: Severity
}

export function emitAlert(opts: EmitOptions): EmitResult {
  const key = `${opts.area}:${opts.dedupeKey ?? ''}`
  const now = Date.now()
  const window = opts.dedupeMs ?? DEFAULT_DEDUPE_MS
  const prev = lastEmitted.get(key)
  if (prev !== undefined && now - prev < window) {
    return { emitted: false, reason: 'deduped', area: opts.area, severity: opts.severity }
  }
  lastEmitted.set(key, now)

  const safeMessage = maskSecrets(opts.message)
  try {
    // Console first so it shows up in platform logs even without a Sentry DSN.
    const line = `[monitor:${opts.area}] ${opts.severity.toUpperCase()} — ${safeMessage}`
    if (opts.severity === 'critical') console.error(line)
    else if (opts.severity === 'warning') console.warn(line)
    else console.log(line)

    Sentry.captureMessage(safeMessage, {
      level: SEVERITY_TO_SENTRY[opts.severity],
      tags: { area: opts.area, monitor: 'true' },
      extra: opts.context,
    })
  } catch {
    /* monitoring must never throw */
  }
  return { emitted: true, area: opts.area, severity: opts.severity }
}

/** Test/maintenance helper to reset the de-dupe memory. */
export function _resetAlertDedupe(): void {
  lastEmitted.clear()
}
