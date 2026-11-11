import { accountTimezone } from '@/config/business-config'
import { differenceInCalendarDays } from 'date-fns'

// Pure date-range helpers — usable from BOTH server components and client components, so a SERVER
// component can call resolveDatePreset/DATE_PRESETS without crossing a client boundary.
//
// Presets resolve to an explicit {from, to} (data runs THROUGH YESTERDAY, since today is partial) plus
// a `days` count for low-data gating. MTD/QTD/YTD need real calendar math, so this returns date ranges.

export type DatePresetKey = '1d' | '1w' | '1m' | 'mtd' | 'qtd' | 'ytd'

export const DATE_PRESETS: { key: DatePresetKey; label: string; title: string }[] = [
  { key: '1d', label: '1D', title: 'Yesterday' },
  { key: '1w', label: '1W', title: 'Last 7 days' },
  { key: '1m', label: '1M', title: 'Last 30 days' },
  { key: 'mtd', label: 'MTD', title: 'Month to date' },
  { key: 'qtd', label: 'QTD', title: 'Quarter to date' },
  { key: 'ytd', label: 'YTD', title: 'Year to date' },
]

export interface ResolvedRange {
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD (yesterday)
  days: number // inclusive day count, for min-data gating
}

// All preset math is done in the ACCOUNT timezone (configured, src/config/business-config.ts) to match the warehouse's
// day boundaries (date-utils.ts). Using the server's local/UTC clock here drifted MTD/QTD/YTD by a day
// near midnight — e.g. at 02:00 UTC on the 1st it's still the previous month in NY, so MTD collapsed to
// a single day while June clearly had data. We derive the NY calendar date, then do stable UTC math.
const ACCOUNT_TZ = accountTimezone()

/** The NY calendar date (year, 0-based month, day) for an absolute instant. */
function nyCalendar(now: Date): { y: number; m0: number; d: number } {
  const [y, m, d] = now.toLocaleDateString('en-CA', { timeZone: ACCOUNT_TZ }).split('-').map(Number)
  return { y, m0: m - 1, d }
}
const utcDate = (y: number, m0: number, d: number): Date => new Date(Date.UTC(y, m0, d))
const addUtcDays = (dt: Date, n: number): Date => {
  const c = new Date(dt)
  c.setUTCDate(c.getUTCDate() + n)
  return c
}
const fmtUtc = (dt: Date): string => dt.toISOString().slice(0, 10)
const daysBetween = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1

export function resolveDatePreset(key: DatePresetKey, now: Date = new Date()): ResolvedRange {
  const { y, m0, d } = nyCalendar(now)
  const today = utcDate(y, m0, d) // NY-today, anchored at UTC midnight for tz-stable date math
  const to = addUtcDays(today, -1) // through yesterday — today's data is incomplete
  let from: Date
  switch (key) {
    case '1d': from = to; break
    case '1w': from = addUtcDays(to, -6); break
    case '1m': from = addUtcDays(to, -29); break
    case 'mtd': from = utcDate(y, m0, 1); break
    case 'qtd': from = utcDate(y, Math.floor(m0 / 3) * 3, 1); break
    case 'ytd': from = utcDate(y, 0, 1); break
    default: from = addUtcDays(to, -6)
  }
  if (from > to) from = to // e.g. MTD/QTD/YTD on the 1st of the period
  return { from: fmtUtc(from), to: fmtUtc(to), days: daysBetween(from, to) }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function daysInRange(from: string, to: string): number {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return 0
  return differenceInCalendarDays(new Date(to + 'T00:00:00'), new Date(from + 'T00:00:00')) + 1
}

export interface ResolvedRangeFull extends ResolvedRange {
  preset: DatePresetKey | 'custom'
  /** A from/to was supplied but rejected (malformed, partial, or from > to) → fell back to a preset. */
  invalidCustom?: boolean
  /** The custom `to` was in the future and was clamped to yesterday (no view can show the future). */
  clampedFuture?: boolean
}

/** Resolve a range from URL-ish params: an explicit, valid from+to wins (custom); otherwise the named
 *  preset (falling back to `fallback`). Used by the server pages that read searchParams.
 *  A future `to` is clamped to yesterday; an invalid/partial/from>to custom range falls back to a
 *  preset and is FLAGGED (`invalidCustom`) so the UI can warn instead of silently showing the default. */
export function resolveRange(
  params: { range?: string; from?: string; to?: string },
  fallback: DatePresetKey = '1w',
  now: Date = new Date()
): ResolvedRangeFull {
  const { from, to } = params
  const presetKey = (DATE_PRESETS.find((p) => p.key === params.range)?.key ?? fallback) as DatePresetKey

  // A custom range was attempted if either bound is present.
  if (from || to) {
    if (from && to && ISO_DATE.test(from) && ISO_DATE.test(to)) {
      const yesterday = resolveDatePreset('1d', now).to // NY yesterday — no view can show the future
      let t = to
      let clampedFuture = false
      if (t > yesterday) {
        t = yesterday
        clampedFuture = true
      }
      if (from <= t) {
        return { from, to: t, days: daysInRange(from, t), preset: 'custom', ...(clampedFuture ? { clampedFuture: true } : {}) }
      }
      // from is after the (clamped) to → invalid ordering; fall through.
    }
    // Malformed, partial, or from > to → fall back to a preset, flagged for the UI.
    return { ...resolveDatePreset(presetKey, now), preset: presetKey, invalidCustom: true }
  }

  return { ...resolveDatePreset(presetKey, now), preset: presetKey }
}

/** Human label for a resolved range (preset title, or the explicit dates for a custom range). */
export function rangeTitle(r: { preset: DatePresetKey | 'custom'; from: string; to: string }): string {
  if (r.preset === 'custom') return `${r.from} → ${r.to}`
  return DATE_PRESETS.find((p) => p.key === r.preset)?.title ?? 'Last 7 days'
}
