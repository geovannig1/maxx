import type { PerformanceCockpitData } from '@/lib/cockpit/contracts'
import { EVIDENCE_PLANE_LABEL } from '@/lib/cockpit/contracts'
import { AlertTriangle } from 'lucide-react'
import { blockerLabels } from '@/lib/diagnostics/blocker-labels'
import { FreshnessStrip } from '@/components/ui/FreshnessStrip'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'

/**
 * Ledger G's plane-health surface, extracted so TWO destinations can render it.
 *
 * It was written inside `TodayPerformanceCockpit`, which was right while Today was the only page that
 * showed source health. Truth is now a destination whose entire subject is "how do we know what we
 * know", and the choice was to duplicate these rules or move them. Duplicated, the two pages could
 * disagree about whether a plane is healthy — the one bug a truth surface must not have.
 *
 * Nothing here changed in the move except the `export` keywords.
 */

/**
 * Ledger G. Owner words for a plane's state. `capitalize` on the raw enum shipped "Unavailable" by
 * luck and would have shipped "Stale" for a state whose owner meaning is "these numbers have not
 * refreshed".
 */
export const SOURCE_STATE_LABEL: Record<PerformanceCockpitData['sourceHealth'][number]['state'], string> = {
  available: 'Current',
  partial: 'Partial data',
  stale: 'Not refreshed',
  unavailable: 'Unavailable',
}

/**
 * Ledger G. A plane the owner should not be alarmed about.
 *
 * `consumedByToday: false` means nothing on this page reads the plane. An amber "unavailable" chip
 * for a source no rendered number depends on is a false signal — it spends the owner's alarm budget
 * on something that cannot move a single figure in front of them, and GA4 outages already page
 * through monitoring. The row still appears in the drawer, so the plane is never silently dropped;
 * it just says what is true, which is that Today does not use it.
 */
export function isQuiet(source: PerformanceCockpitData['sourceHealth'][number]): boolean {
  return source.state === 'available' || !source.consumedByToday
}

export function SourceHealthCard({ source, nowMs, context = 'today' }: {
  source: PerformanceCockpitData['sourceHealth'][number]
  nowMs: number
  /**
   * On TODAY, a plane the page does not read shows "Not a Today source" and nothing else — the state
   * is deliberately suppressed so an outage in an unread source cannot spend the owner's alarm budget.
   *
   * On TRUTH that suppression is a lie of omission. The page's own header promises "how far each
   * source can be trusted right now"; rendering a neutral grey chip while the plane is `unavailable`
   * withholds exactly what was promised. Truth always shows the state, and says separately that Today
   * does not use it.
   */
  context?: 'today' | 'truth'
}) {
  const healthy = source.state === 'available'
  const unused = !source.consumedByToday
  const tone = unused && context === 'today'
    ? { border: 'var(--border)', bg: 'var(--bg-subtle)', text: 'var(--text-tertiary)' }
    : healthy
      ? { border: 'var(--success-border)', bg: 'var(--success-bg)', text: 'var(--success)' }
      : { border: 'var(--warning-border)', bg: 'var(--warning-bg)', text: 'var(--warning)' }
  return <div className="rounded-xl p-4" style={{ background: 'var(--bg-subtle)' }}>
    <div className="flex items-center justify-between gap-3"><p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{EVIDENCE_PLANE_LABEL[source.plane]}</p><span className="rounded-full border px-2 py-0.5 text-[12px] font-semibold" style={{ borderColor: tone.border, background: tone.bg, color: tone.text }}>{unused && context === 'today' ? 'Not a Today source' : SOURCE_STATE_LABEL[source.state]}</span>{unused && context === 'truth' && <span className="rounded-full border px-2 py-0.5 text-[12px]" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>Not used on Today</span>}</div>
    {/* `synchronizedAt` is sync_generations.completed_at, gated on a SUCCESSFUL generation whose
        date range covers this window (source-readers.ts:96-119) — so it bounds the age of the data,
        unlike ad_accounts.last_synced_at, which is re-stamped by attempts that returned nothing. */}
    <div className="mt-2">
      <FreshnessStrip
        label={EVIDENCE_PLANE_LABEL[source.plane]}
        freshness={{ asOf: source.synchronizedAt, staleAfterHours: REC_THRESHOLDS.MAX_DATA_AGE_HOURS }}
        nowMs={nowMs}
        compact
      />
    </div>
    {source.blockerCodes.length > 0 && <p className="mt-2 text-[14px] leading-5" style={{ color: 'var(--text-secondary)' }}>{blockerLabels(source.blockerCodes.slice(0, 2))}</p>}
  </div>
}

/**
 * Ledger G. Plane health OUTSIDE the drawer — but only when it deviates.
 *
 * The whole point is that a degraded plane must not require the owner to open something to find out.
 * The equally important half is the converse: when every established plane is fine, this must not
 * become wallpaper. A permanent three-cell status board trains the reader to skip the region, and
 * then it fails to be read on the one day it matters.
 *
 * So: all quiet renders ONE line naming how many planes were checked — enough to prove the check
 * happened, small enough to ignore. Any deviation renders the offending planes, with their blockers,
 * unprompted. Planes Today does not consume can never trigger the loud form (`isQuiet`), because an
 * alarm about a source no number on the page depends on is a false alarm.
 */
export function PlaneHealthStrip({ sources }: { sources: PerformanceCockpitData['sourceHealth'] }) {
  const deviating = sources.filter((source) => !isQuiet(source))
  if (deviating.length === 0) {
    // NEVER "No issues." over a plane that is degraded but unread.
    //
    // This line used to print `Sources checked: N. No issues.` whenever nothing LOUD was due — and
    // `isQuiet` returns true for any plane with `consumedByToday: false`, whatever its state. So a
    // plane counted in N could be `unavailable` and the sentence still claimed the all-clear. On this
    // account that is the live case, not a hypothetical: the outcome ledger resolves `unavailable` for
    // any range ending today, and it is not read by Today. The strip said "2 sources checked, no
    // issues" over one that was down.
    //
    // A cardinal number is also unactionable — the owner cannot do anything with "2". Name the planes.
    const inUse = sources.filter((source) => source.consumedByToday)
    const idle = sources.filter((source) => !source.consumedByToday)
    const idleDegraded = idle.filter((source) => source.state !== 'available')
    const nameList = (rows: typeof sources) => rows.map((r) => EVIDENCE_PLANE_LABEL[r.plane]).join(', ')
    return <section className="owner-surface" style={{ padding: '10px 20px' }}>
      <p className="text-[12.5px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
        {inUse.length > 0
          ? <>In use on this page: <span style={{ color: 'var(--text-secondary)' }}>{nameList(inUse)}</span> — current.</>
          : <>No source on this page is currently in use.</>}
        {/* PER-PLANE CLAUSES. Rendering the names and the states as two parallel lists produced
            "recorded bookings, GA4 telemetry are unavailable, not refreshed, and not used here" — which
            tells the reader nothing about WHICH plane is which, prints "unavailable, unavailable" when
            two share a state, and welds "and not used here" onto the state list so it reads as a third
            state. Same class of defect as the "No issues." line this block replaced: a sentence that
            is not true read plainly. Not hypothetical — the monitoring run establishes the GA4 plane
            on its first cycle, making the two-plane case the default. */}
        {idleDegraded.length > 0
          ? <> {idleDegraded.map((r) => `${EVIDENCE_PLANE_LABEL[r.plane]} is ${SOURCE_STATE_LABEL[r.state].toLowerCase()}`).join('; ')}
              {idleDegraded.length === 1 ? '. It is not used on this page.'
                : idleDegraded.length === 2 ? '. Neither is used on this page.'
                : '. None of these are used on this page.'}</>
          : idle.length > 0
            ? <> {nameList(idle)} {idle.length === 1 ? 'is' : 'are'} not used on this page.</>
            : null}
      </p>
    </section>
  }
  return <section className="owner-surface owner-surface-section" aria-labelledby="plane-health-title">
    <div className="flex items-start gap-3">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" style={{ color: 'var(--warning)' }} />
      <div className="min-w-0 flex-1">
        <p className="section-label">Source health</p>
        <h2 id="plane-health-title" className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {deviating.length === 1
            ? `${EVIDENCE_PLANE_LABEL[deviating[0].plane]} is not current`
            : `${deviating.length} sources are not current`}
        </h2>
        <ul className="mt-2 flex flex-col gap-1">
          {deviating.map((source) => <li key={source.plane} className="text-[14px] leading-6" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-semibold">{EVIDENCE_PLANE_LABEL[source.plane]}</span>
            {' — '}{SOURCE_STATE_LABEL[source.state]}
            {source.blockerCodes.length > 0 && <>. {blockerLabels(source.blockerCodes.slice(0, 2))}</>}
          </li>)}
        </ul>
      </div>
    </div>
  </section>
}
