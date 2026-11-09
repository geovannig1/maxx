import { accountCurrency, accountLocale } from '@/config/business-config'
import type { ClaimedSeries } from '@/lib/cockpit/series-contract'
import { runsOfState, type ClassifiedDay } from '@/lib/cockpit/window-days'

/**
 * The delivery trend, as server-rendered SVG.
 *
 * NO CHART LIBRARY ON PURPOSE. `/dashboard` is the most-visited route and renders on the server
 * today; pulling in a charting bundle would push a client boundary and ~100KB onto it. Everything
 * here is static SVG with `var(--token)` fills, so it themes with the rest of the app, ships zero
 * JavaScript, and hover text comes from native `<title>` rather than a tooltip runtime.
 *
 * THE POINT OF THE CHART is the part most charts get wrong: the absent days. A day with no row is
 * either proven dormant or never fetched, and those are drawn differently from each other and from
 * a real zero. Nothing absent is ever drawn at the baseline, because a bar of height zero reads as
 * "we spent nothing", which is a measurement this data cannot support.
 */

const VIEWBOX = { width: 720, height: 180 }
const PADDING = { top: 12, right: 8, bottom: 22, left: 8 }
const PLOT = {
  width: VIEWBOX.width - PADDING.left - PADDING.right,
  height: VIEWBOX.height - PADDING.top - PADDING.bottom,
}

function formatValue(value: number, unit: ClaimedSeries['unit']): string {
  if (unit === 'money') return value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency(), maximumFractionDigits: 0 })
  if (unit === 'percent') return `${value.toFixed(1)}%`
  if (unit === 'ratio') return `${value.toFixed(2)}x`
  return value.toLocaleString('en-US')
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00Z`))
}

export function DeliverySeriesChart({ series }: { series: ClaimedSeries }) {
  const days = series.points as readonly ClassifiedDay[]
  if (days.length === 0) return null

  const measured = days.filter((d) => d.value !== null)
  const peak = measured.reduce((max, d) => Math.max(max, d.value ?? 0), 0)
  const scale = peak > 0 ? peak : 1
  const slot = PLOT.width / days.length
  const barWidth = Math.max(1, Math.min(slot - 1, slot * 0.72))

  const dormantRuns = runsOfState(days, 'missing_no_delivery')
  const unknownRuns = runsOfState(days, 'missing_not_synced')
  const indexOf = new Map(days.map((day, index) => [day.date, index]))
  const bandFor = (run: { start: string; end: string }) => {
    const from = indexOf.get(run.start) ?? 0
    const to = indexOf.get(run.end) ?? from
    return { x: PADDING.left + from * slot, width: Math.max(slot, (to - from + 1) * slot) }
  }

  const total = measured.reduce((sum, d) => sum + (d.value ?? 0), 0)

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        width="100%" height={VIEWBOX.height} role="img" preserveAspectRatio="none"
        aria-label={
          `${series.label} by day, ${shortDate(series.window.start)} to ${shortDate(series.window.end)}. ` +
          `${formatValue(total, series.unit)} total across ${series.coverage.measuredDays} days with delivery. ` +
          `${series.coverage.noDeliveryDays} days had no delivery; ` +
          `${series.coverage.notSyncedDays} days were never synchronised and are unknown.`
        }
      >
        <defs>
          {/* Unknown days get a hatch rather than a fill: it reads as "no information here", where a
              flat tint would read as a low value. */}
          <pattern id="unknown-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--bg-subtle)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border-strong)" strokeWidth="1.25" opacity="0.55" />
          </pattern>
        </defs>

        {dormantRuns.map((run) => {
          const band = bandFor(run)
          return (
            <rect key={`dormant-${run.start}`} x={band.x} y={PADDING.top} width={band.width} height={PLOT.height}
              fill="var(--bg-subtle)">
              <title>{`No delivery · ${shortDate(run.start)}–${shortDate(run.end)} (${run.length} days). Meta was asked and reported nothing.`}</title>
            </rect>
          )
        })}
        {unknownRuns.map((run) => {
          const band = bandFor(run)
          return (
            <rect key={`unknown-${run.start}`} x={band.x} y={PADDING.top} width={band.width} height={PLOT.height}
              fill="url(#unknown-hatch)">
              <title>{`Never synchronised · ${shortDate(run.start)}–${shortDate(run.end)} (${run.length} days). No successful sync covered these dates, so delivery is unknown — not zero.`}</title>
            </rect>
          )
        })}

        <line x1={PADDING.left} y1={PADDING.top + PLOT.height} x2={VIEWBOX.width - PADDING.right}
          y2={PADDING.top + PLOT.height} stroke="var(--border)" strokeWidth="1" />

        {days.map((day, index) => {
          if (day.value === null) return null
          const height = Math.max(1, (day.value / scale) * PLOT.height)
          return (
            <rect
              key={day.date}
              x={PADDING.left + index * slot + (slot - barWidth) / 2}
              y={PADDING.top + PLOT.height - height}
              width={barWidth} height={height} rx={barWidth > 3 ? 1.5 : 0}
              fill="var(--chart-1)"
            >
              <title>{`${shortDate(day.date)} · ${formatValue(day.value, series.unit)}`}</title>
            </rect>
          )
        })}

        <text x={PADDING.left} y={VIEWBOX.height - 6} fontSize="11" fill="var(--text-tertiary)">
          {shortDate(series.window.start)}
        </text>
        <text x={VIEWBOX.width - PADDING.right} y={VIEWBOX.height - 6} fontSize="11"
          fill="var(--text-tertiary)" textAnchor="end">
          {shortDate(series.window.end)}
        </text>
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px]"
        style={{ color: 'var(--text-tertiary)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-[2px]" style={{ background: 'var(--chart-1)' }} />
          {series.label} · {series.coverage.measuredDays} days
        </span>
        {series.coverage.noDeliveryDays > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2.5 rounded-[2px]" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }} />
            No delivery · {series.coverage.noDeliveryDays} days
          </span>
        )}
        {series.coverage.notSyncedDays > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2.5 rounded-[2px]"
              style={{ background: 'var(--bg-subtle)', borderStyle: 'dashed', borderWidth: 1, borderColor: 'var(--border-strong)' }} />
            Never synchronised · {series.coverage.notSyncedDays} days — unknown, not zero
          </span>
        )}
      </figcaption>
    </figure>
  )
}
