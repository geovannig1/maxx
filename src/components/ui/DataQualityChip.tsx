import { measurementKindLabel, blockerLabels } from '@/lib/diagnostics/blocker-labels'

/**
 * Foundation primitive. Puts the evidence tier ON the number, so uncertainty reads as
 * instrumentation rather than apology (acceptance bar 4), and so a figure never arrives without
 * saying what kind of thing it is.
 *
 * The vocabulary is NOT new: `measurementKind` and `coverage` come straight from the engine's own
 * ClaimedSeries contract (lib/cockpit/series-contract.ts), and the long prose comes from
 * `measurementKindLabel`. Nothing here invents a parallel tier scale — the engine already computes
 * all of it, and bar 1 says what it computes must not stay invisible.
 */

export type MeasurementKind =
  | 'measured' | 'modelled' | 'derived' | 'operational'
  | 'telemetry' | 'associated_noncausal' | 'causal_estimate'

export type Coverage = {
  totalDays: number
  measuredDays: number
  noDeliveryDays: number
  notSyncedDays: number
}

/**
 * Chip-length labels. `measurementKindLabel` is sentence-length by design ("Straight from Meta Ads
 * Manager") — right for a tooltip, too long for a pill beside a number. These are the same
 * distinctions at chip length; the full sentence rides along as the accessible name, so nothing is
 * lost and no enum value is ever shown (bar 5).
 */
const SHORT_LABEL: Record<MeasurementKind, string> = {
  // "Counted" was wrong, and wrong on an axis this file's own docblock got backwards. `measured`'s
  // long label is "Straight from Meta Ads Manager" — a PROVENANCE claim. "Counted" is a METHOD
  // claim, and they are not the same distinction at different lengths. Two metrics tagged
  // `measured` are Meta's own ESTIMATES: meta.native_reach (builder.ts:364) is a de-duplicated
  // people estimate and meta.native_frequency (builder.ts:341) is impressions ÷ reach, inheriting
  // it. Both rendered a green "Counted" pill under an estimate. "As reported" keeps the provenance
  // axis, stays true when the source's own figure is an estimate, and stays true on the outcome-source
  // plane where `measured` is also used (governed-audit.ts:272).
  measured: 'As reported',
  modelled: 'Estimated',
  derived: 'Calculated',
  operational: 'Configured',
  telemetry: 'Logged',
  // "Associated" reads to a media buyer as "attributed" — the opposite of what the long label
  // ("Observed alongside — not shown to be the cause") is trying to say.
  associated_noncausal: 'Not proven causal',
  causal_estimate: 'Causal estimate',
}

/**
 * `kind` is not validated at the boundary. An unmapped value produced an empty pill AND
 * `color-mix(in srgb, undefined 12%, transparent)` — invalid CSS, so the chip lost its background
 * and border as well. The sibling module this file draws from does the opposite on purpose
 * (blocker-labels.ts:7-8: "an unmapped code degrades to readable words rather than disappearing or
 * throwing"). Match that rather than assuming totality.
 */
function shortLabel(kind: string): string {
  return SHORT_LABEL[kind as MeasurementKind] ?? kind.replaceAll('_', ' ')
}
function toneFor(kind: string): string {
  return TONE[kind as MeasurementKind] ?? 'var(--text-tertiary)'
}

/**
 * Tone carries how far a number sits from a counted fact — the thing a media buyer needs to read at
 * a glance. Deliberately not a good/bad scale: a modelled number is not a defect, it is a different
 * kind of claim.
 */
const TONE: Record<MeasurementKind, string> = {
  measured: 'var(--success)',
  modelled: 'var(--warning)',
  derived: 'var(--info)',
  operational: 'var(--text-tertiary)',
  telemetry: 'var(--info)',
  associated_noncausal: 'var(--warning)',
  causal_estimate: 'var(--accent)',
}

function coverageNote(c: Coverage): string | null {
  if (c.totalDays <= 0) return null
  if (c.measuredDays >= c.totalDays) return null

  // Days Meta never synced and days the account simply did not deliver are different facts, and
  // collapsing them hides a delivery gap behind a sync gap. The first version said exactly that and
  // then did it: it short-circuited on `notSyncedDays > 0` and never mentioned noDeliveryDays, so
  // {total:30, measured:20, noDelivery:6, notSynced:4} printed "20 of 30 days · 4 not synced" —
  // six days silently gone, and 20 + 4 ≠ 30 on the face of it. The tests covered only the two PURE
  // cases (10/0 and 0/10); the mixed case is the only one where the branch matters at all.
  //
  // There is also a third case neither branch had: a gap that is neither sync nor delivery, which
  // fell through to the delivery branch and printed "0 without delivery" beside a real shortfall —
  // a sentence that reports a gap and denies it at the same time.
  const parts: string[] = []
  if (c.notSyncedDays > 0) parts.push(`${c.notSyncedDays} not synced`)
  if (c.noDeliveryDays > 0) parts.push(`${c.noDeliveryDays} without delivery`)
  const unaccounted = c.totalDays - c.measuredDays - c.noDeliveryDays - c.notSyncedDays
  if (unaccounted > 0) parts.push(`${unaccounted} unaccounted`)

  const head = `${c.measuredDays} of ${c.totalDays} days`
  return parts.length > 0 ? `${head} · ${parts.join(' · ')}` : head
}

export function DataQualityChip({
  kind,
  coverage,
  blockerCodes,
  compact = false,
}: {
  kind: MeasurementKind
  coverage?: Coverage | null
  /** Raw engine codes. Rendered only through `blockerLabels`, never shown as codes. */
  blockerCodes?: readonly string[] | null
  compact?: boolean
}) {
  const unavailable = Boolean(blockerCodes && blockerCodes.length > 0)
  const tone = unavailable ? 'var(--text-tertiary)' : toneFor(kind)
  const text = unavailable ? 'Not available' : shortLabel(kind)

  const reason = unavailable ? blockerLabels(blockerCodes ?? []) : null
  const note = !unavailable && coverage ? coverageNote(coverage) : null

  // Silence is evidenced, never empty (bar 3): when a value is unavailable the chip carries the
  // written reason, so the surface says what was checked rather than simply showing nothing.
  const fullName = [unavailable ? reason : measurementKindLabel(kind), note]
    .filter(Boolean)
    .join(' — ')

  return (
    <span className="inline-flex flex-wrap items-center" style={{ gap: compact ? 5 : 6 }}>
      <span
        className="inline-flex items-center rounded-full font-semibold whitespace-nowrap"
        title={fullName}
        aria-label={fullName}
        style={{
          minHeight: compact ? 20 : 24,
          padding: compact ? '0 7px' : '0 9px',
          fontSize: compact ? 10.5 : 11.5,
          color: tone,
          background: `color-mix(in srgb, ${tone} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${tone} 45%, transparent)`,
        }}
      >
        {text}
      </span>
      {note && (
        <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
          {note}
        </span>
      )}
      {unavailable && reason && (
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {reason}
        </span>
      )}
    </span>
  )
}
