'use client'
import { formatMoney } from '@/lib/utils/format-currency'
import { getTargetRange, hasTarget } from '@/lib/targets/target-ranges'
import { outcomeNoun } from '@/config/outcome-nouns'
import { SPEND_FLOORS } from '@/config/spend-floors'

export interface DaypartRow {
  hour: number     // 0-23
  day: number      // 0=Sun, 6=Sat
  cpa: number | null
  spend: number
  bookings: number
}

interface DaypartHeatmapProps {
  data: DaypartRow[]
}

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function hourLabel(h: number): string {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

// Cosmetic: "spent money, got zero bookings" and "no delivery at all" rendered as two
// near-identical greys (#E9EAEE vs #F3F4F6) — a warning-worthy hour was indistinguishable from an
// empty one, and its tooltip said "No data" over real spend.
const SPEND_NO_BOOKINGS = 'rgba(220,38,38,0.12)' // faint warning tint: money out, nothing back
const NO_DELIVERY = 'var(--bg-subtle)'

// CPA colours, best to worst, banded on the owner's CPA target: excellent (when set), healthy (the
// target), the midpoint to the maximum, the maximum (watch), and above it. With no target set a
// converting hour gets one neutral colour: there is no built-in amount to judge it against.
const CPA_COLORS = ['rgba(5,150,105,0.75)', 'rgba(5,150,105,0.35)', 'rgba(217,119,6,0.35)', 'rgba(220,38,38,0.30)']
const ABOVE_MAX = 'rgba(220,38,38,0.65)'
const CONVERTING_NO_TARGET = 'rgba(37,99,235,0.35)'

/** [upper edge, colour] pairs, best first, or null without a CPA target. */
function cpaBands(): [number, string][] | null {
  const range = getTargetRange('cpa')
  if (!hasTarget(range)) return null
  const edges = [range.excellent, range.healthy, (range.healthy + range.watch) / 2, range.watch]
  return edges.flatMap((edge, i): [number, string][] => edge === null ? [] : [[edge, CPA_COLORS[i]]])
}

export function getCellColor(cpa: number | null, spend: number, bookings: number, bands: [number, string][] | null): string {
  if (spend === 0) return NO_DELIVERY
  if (bookings === 0 || cpa === null) return spend > SPEND_FLOORS.heatmapSpendNoOutcome ? SPEND_NO_BOOKINGS : NO_DELIVERY
  if (bands === null) return CONVERTING_NO_TARGET
  return bands.find(([edge]) => cpa <= edge)?.[1] ?? ABOVE_MAX
}

function cpaLegend(bands: [number, string][] | null): [string, string][] {
  if (bands === null) return [['converting · no CPA target set (set one in Settings → Performance Targets)', CONVERTING_NO_TARGET]]
  const amount = (value: number) => formatMoney(value, { maximumFractionDigits: 0 })
  return [...bands.map(([edge, color]): [string, string] => [`≤${amount(edge)}`, color]),
    [`${amount(bands[bands.length - 1][0])}+`, ABOVE_MAX]]
}

export function DaypartHeatmap({ data }: DaypartHeatmapProps) {
  const bands = cpaBands()
  const cellMap = new Map<string, DaypartRow>()
  for (const row of data) {
    cellMap.set(`${row.day}-${row.hour}`, row)
  }

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '40px repeat(7, 32px)', gap: '2px' }}>
          {/* Header row */}
          <div />
          {days.map(d => (
            <div key={d} style={{ fontSize: '10px', color: 'var(--text-tertiary)', textAlign: 'center', paddingBottom: '4px' }}>
              {d}
            </div>
          ))}

          {/* 24 hour rows */}
          {Array.from({ length: 24 }, (_, h) => (
            <>
              {/* Axis labels are read, not decorative — tertiary ink, not disabled ink. */}
              <div
                key={`h${h}`}
                style={{ fontSize: '9px', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '6px' }}
              >
                {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
              </div>
              {Array.from({ length: 7 }, (_, d) => {
                const cell = cellMap.get(`${d}-${h}`)
                const color = getCellColor(cell?.cpa ?? null, cell?.spend ?? 0, cell?.bookings ?? 0, bands)
                // Honest states: a spend-but-zero-bookings hour is NOT "no data" — it's spend with no CPA.
                const tooltipText = cell
                  ? `${days[d]} ${hourLabel(h)}: ${
                      cell.cpa
                        ? formatMoney(cell.cpa, { maximumFractionDigits: 0 }) + ' CPA'
                        : cell.spend > 0
                          ? `no CPA (0 Meta ${outcomeNoun({ plural: false })} events on spend)`
                          : 'no delivery'
                    }, ${cell.bookings} Meta ${outcomeNoun({ plural: false })} events, ${formatMoney(cell.spend, { maximumFractionDigits: 0 })} spend`
                  : 'No delivery'
                return (
                  <div
                    key={`${d}-${h}`}
                    style={{ width: '32px', height: '20px', background: color, borderRadius: '2px' }}
                    title={tooltipText}
                  />
                )
              })}
            </>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', marginTop: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>CPA:</span>
        {(
          [
            ...cpaLegend(bands),
            [`spend, 0 Meta ${outcomeNoun({ plural: false })} events`, SPEND_NO_BOOKINGS],
            ['no delivery', NO_DELIVERY],
          ] as [string, string][]
        ).map(([label, color]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div style={{ width: '12px', height: '12px', background: color, borderRadius: '2px' }} />
            <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
