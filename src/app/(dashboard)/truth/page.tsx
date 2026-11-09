export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { Scale } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { loadPerformanceCockpitData } from '@/lib/cockpit/builder'
import { loadTodayExtras } from '@/lib/cockpit/series-loader'
import { resolveRange } from '@/lib/date-range'
import { AttributionLadderPanel } from '@/components/dashboard/AttributionLadderPanel'
import { SourceHealthCard } from '@/components/dashboard/PlaneHealth'

// Local, like the dashboard's own copy — `date-range` exports the resolver, not this shape.
interface TruthSearchParams { range?: string; from?: string; to?: string }

/**
 * Read once per render, OUTSIDE the component. This tree is server-rendered so a clock read is
 * legitimate, but calling `Date.now()` inside the JSX is an impure call during render (lint
 * catches it) and makes the component untestable. Same shape as the cockpit's `renderClockMs`.
 */
function renderClockMs(): number {
  return Date.now()
}

/**
 * Truth — how we know what we know.
 *
 * The sixth of the seven destinations ratified 2026-08-28 (design decision). Every other destination shows
 * numbers; this one shows the standing of the sources those numbers came from, which until now was
 * reachable only by opening a `<details>` drawer at the bottom of Today.
 *
 * Two panels, both already shipped and tested elsewhere — this destination re-homes them, it does not
 * invent a new measurement:
 *
 *   SOURCE HEALTH — one row per evidence plane, from Ledger G. A plane appears only when a reader
 *   established it. An absent plane shows NO ROW rather than a synthesized "unavailable", because
 *   "we never asked" and "we asked and it is down" are different facts, and a truth surface is the
 *   last place that distinction may be collapsed.
 *
 *   ATTRIBUTION LADDER — the same panel Today renders, at full width. It is the closest thing this
 *   product has to a three-plane reconciliation.
 *
 * Deliberately NOT here: any blended number. The point of the page is that the planes are separate,
 * so a figure computed across them would contradict the surface carrying it.
 */
export default async function TruthPage({
  searchParams,
}: {
  searchParams: Promise<TruthSearchParams>
}) {
  await requireOwner()

  const range = resolveRange(await searchParams, 'mtd')
  const nowMs = renderClockMs()
  const [cockpit, extras] = await Promise.all([
    loadPerformanceCockpitData({ range }),
    loadTodayExtras(range),
  ])

  return (
    <div className="owner-page space-y-5">
      <PageHeader
        title="Truth"
        icon={Scale}
        subtitle="Where every number came from, and how far each source can be trusted right now."
      />

      <section className="owner-surface owner-surface-section" aria-labelledby="truth-sources">
        <h2 id="truth-sources" className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
          Source health
        </h2>
        <p className="mt-1 text-[12.5px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
          {/* Stated, not implied. A reader must be able to tell "this plane is fine" from "this plane
              was never established", and an absent row is the only honest way to say the latter. */}
          A source appears here only once something actually read it. A source missing from this list was
          never established — that is not the same as being down.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {cockpit.sourceHealth.map((source) => (
            <SourceHealthCard key={source.plane} source={source} nowMs={nowMs} context="truth" />
          ))}
        </div>
      </section>

      {extras.ladder
        ? <AttributionLadderPanel ladder={extras.ladder} />
        : (
          <section className="owner-surface owner-surface-section">
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
              Attribution ladder
            </h2>
            {/* An evidenced absence, never silence — the same rule the record block follows. */}
            <p className="mt-1 text-[14px] leading-6" style={{ color: 'var(--text-secondary)' }}>
              The ladder could not be built for this period
              {extras.unavailableReason ? ` (${extras.unavailableReason})` : ''}. Nothing is being hidden;
              there is nothing to show until the read succeeds.
            </p>
          </section>
        )}
    </div>
  )
}
