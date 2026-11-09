/**
 * Foundation primitive. One freshness claim, stated the same way everywhere.
 *
 * WHY IT TAKES TWO TIMESTAMPS. The 2026-08-18 teardown found three freshness claims disagreeing on
 * one screen — sidebar "7d sync", topbar "14h ago", body "38h stale". They were not a rendering
 * bug. They were two different facts wearing the same word:
 *
 *   checkedAt  `ad_accounts.last_synced_at` — an ATTEMPT watermark. Re-stamped on every sync,
 *              including a partial one that brought back nothing.
 *   asOf       the timestamp of the data actually in hand.
 *
 * A surface that shows only `checkedAt` reports "synced 14h ago" over data that is 38h old. This
 * component refuses to collapse them: the age it states is always the age of the DATA, and the
 * attempt is shown separately whenever the two disagree. That is bar 3 — silence is evidenced,
 * never empty — applied to time.
 */

export type Freshness = {
  /** When the data in hand is from. `null` means nothing has been observed yet — not "zero". */
  asOf: string | null
  /** When a sync was last ATTEMPTED. Re-stamped even when the attempt returned nothing. */
  checkedAt?: string | null
  /** Past this age the data should not be leaned on. */
  staleAfterHours: number
  /** When it looks again, if that is known. */
  nextCheckAt?: string | null
}

function hoursSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (nowMs - t) / 3_600_000
}

/** Whole units, past tense. Deliberately coarse: false precision on an age is its own lie. */
function ageWords(h: number): string {
  if (h < 0) return 'dated in the future'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m old`
  if (h < 48) return `${Math.round(h)}h old`
  return `${Math.round(h / 24)}d old`
}

function untilWords(h: number): string {
  const m = Math.abs(h) * 60
  if (m < 90) return `in ${Math.max(1, Math.round(m))}m`
  if (Math.abs(h) < 48) return `in ${Math.round(Math.abs(h))}h`
  return `in ${Math.round(Math.abs(h) / 24)}d`
}

export function FreshnessStrip({
  label,
  freshness,
  nowMs,
  compact = false,
}: {
  /** What this describes, in the owner's words — "Meta delivery", not a table name. */
  label: string
  freshness: Freshness
  /**
   * Required, not defaulted to `Date.now()`. A clock read inside a component body is impure —
   * it makes the component untestable and, in a client tree, produces a hydration mismatch.
   * The caller reads the clock once at the render boundary and threads it down.
   */
  nowMs: number
  compact?: boolean
}) {
  const { asOf, checkedAt, staleAfterHours, nextCheckAt } = freshness
  const dataAge = hoursSince(asOf, nowMs)
  const attemptAge = hoursSince(checkedAt, nowMs)
  const nextIn = nextCheckAt ? hoursSince(nextCheckAt, nowMs) : null

  const stale = dataAge !== null && dataAge > staleAfterHours
  const never = dataAge === null

  // Never observed is its own state, not a stale state and never a zero. It gets the neutral tone
  // and says what is missing, because an account that has genuinely never synced and one that is
  // merely behind call for different actions.
  const tone = never ? 'var(--text-tertiary)' : stale ? 'var(--danger)' : 'var(--success)'
  const headline = never ? 'Not yet observed' : ageWords(dataAge)

  // Only worth showing when the two disagree by more than rounding — that gap IS the finding.
  const attemptDiffers =
    attemptAge !== null && (dataAge === null || Math.abs(dataAge - attemptAge) >= 1)

  const detail: string[] = []
  if (attemptDiffers) detail.push(`last checked ${ageWords(attemptAge)}`)
  if (stale) detail.push(`counts as stale past ${staleAfterHours}h`)
  if (nextIn !== null && nextIn < 0) detail.push(`looks again ${untilWords(nextIn)}`)

  const fullName = `${label}: ${headline}${detail.length ? ` — ${detail.join(', ')}` : ''}`

  return (
    <span
      className="inline-flex flex-wrap items-center"
      style={{ gap: compact ? 5 : 7 }}
      aria-label={fullName}
      title={fullName}
    >
      <span
        aria-hidden
        className="rounded-full shrink-0"
        style={{ width: 6, height: 6, background: tone }}
      />
      <span
        className="font-semibold whitespace-nowrap"
        style={{ fontSize: compact ? 11 : 12, color: 'var(--text-secondary)' }}
      >
        {label}
      </span>
      <span
        className="whitespace-nowrap"
        style={{ fontSize: compact ? 11 : 12, color: tone, fontWeight: 600 }}
      >
        {headline}
      </span>
      {detail.length > 0 && (
        <span style={{ fontSize: compact ? 10.5 : 11.5, color: 'var(--text-tertiary)' }}>
          {detail.join(' · ')}
        </span>
      )}
    </span>
  )
}
