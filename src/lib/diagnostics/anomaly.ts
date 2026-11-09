// Anomaly EXPLANATION engine — turns "CPL spiked 40%" into "CPL +40% — driven mostly by leads falling
// 30% (denominator), concentrated in 'Lookalike — Cold'." Two honest decompositions, no hand-waving:
//
//   1. Arithmetic driver: a ratio metric is value = numerator ÷ denominator. We split the change into
//      the part caused by the numerator moving vs the denominator moving (the two parts sum EXACTLY to
//      the total change), so we can name which one actually drove it.
//   2. Entity attribution: which campaign/ad-set moved the metric most, weighted by its share of spend,
//      so a 200%-CPL swing on a $3 campaign doesn't get blamed for an account-level move.
//
// Every explanation carries a Trust score from the data behind it — a spike on thin data is reported as
// low-trust, not asserted. Pure functions; the route assembles the inputs.

import { computeTrust, type TrustContext, type TrustScore } from '@/lib/trust/trust'
import type { EntityMetrics } from '@/lib/metrics/aggregate'
import { formatMoney } from '@/lib/utils/format-currency'

export type MetricDirection = 'lower_is_better' | 'higher_is_better'

/** One efficiency/outcome metric spec: how to read its value and split it into numerator ÷ denominator.
 *  Shared by the /api/diagnostics/anomalies route and the anomaly-report gatherer. */
export interface AnomalyMetricSpec {
  key: string
  label: string
  unit: '$' | '%' | 'x' | ''
  direction: MetricDirection
  revenueClaim: boolean
  pick: (m: EntityMetrics) => number | null
  num: { label: string; pick: (m: EntityMetrics) => number }
  den: { label: string; pick: (m: EntityMetrics) => number }
}

export const ANOMALY_METRIC_SPECS: AnomalyMetricSpec[] = [
  { key: 'cpl', label: 'CPL', unit: '$', direction: 'lower_is_better', revenueClaim: false, pick: (m) => m.cpl, num: { label: 'spend', pick: (m) => m.spend }, den: { label: 'leads', pick: (m) => m.leads } },
  { key: 'cpa', label: 'Cost / Booking', unit: '$', direction: 'lower_is_better', revenueClaim: true, pick: (m) => m.cpa, num: { label: 'spend', pick: (m) => m.spend }, den: { label: 'bookings', pick: (m) => m.bookings } },
  { key: 'cpc', label: 'CPC', unit: '$', direction: 'lower_is_better', revenueClaim: false, pick: (m) => m.cpc, num: { label: 'spend', pick: (m) => m.spend }, den: { label: 'clicks', pick: (m) => m.clicks } },
  { key: 'cpm', label: 'CPM', unit: '$', direction: 'lower_is_better', revenueClaim: false, pick: (m) => m.cpm, num: { label: 'spend', pick: (m) => m.spend }, den: { label: 'impressions', pick: (m) => m.impressions } },
  { key: 'ctr', label: 'CTR', unit: '%', direction: 'higher_is_better', revenueClaim: false, pick: (m) => m.ctr, num: { label: 'clicks', pick: (m) => m.clicks }, den: { label: 'impressions', pick: (m) => m.impressions } },
]

export interface RatioParts {
  numerator: { label: string; current: number; previous: number }
  denominator: { label: string; current: number; previous: number }
}

export interface EntityMovement {
  id: string
  name: string
  spendShare: number // 0..1 — share of current-window spend (caps the blame)
  metricCurrent: number | null
  metricPrevious: number | null
}

export interface RankedMover extends EntityMovement {
  deltaPct: number | null
  impact: number // |deltaPct| × spendShare — the spend-weighted move
}

export interface MetricChangeInput {
  key: string
  label: string
  current: number | null
  previous: number | null
  direction: MetricDirection
  unit: '$' | '%' | 'x' | ''
  ratio?: RatioParts
  entities?: EntityMovement[]
  /** Evidence behind the metric, so the anomaly inherits an honest trust score. */
  trustCtx?: TrustContext
  /** |%| change at/above which this is worth surfacing. Default 10. */
  noiseFloorPct?: number
}

export type AnomalyDirection = 'improved' | 'worsened' | 'flat' | 'unknown'
export type AnomalySeverity = 'high' | 'medium' | 'low' | 'none'

export interface AnomalyExplanation {
  key: string
  label: string
  current: number | null
  previous: number | null
  changePct: number | null
  direction: AnomalyDirection
  severity: AnomalySeverity
  driver: string | null
  topMovers: RankedMover[]
  headline: string
  trust: TrustScore | null
}

const EPS = 1e-9

function fmt(value: number, unit: '$' | '%' | 'x' | ''): string {
  if (unit === '$') return `${formatMoney(value)}`
  if (unit === '%') return `${value.toFixed(2)}%`
  if (unit === 'x') return `${value.toFixed(2)}x`
  return value.toFixed(2)
}

function pct(a: number, b: number): number | null {
  if (Math.abs(b) < EPS) return null
  return ((a - b) / b) * 100
}

/** Split a ratio's change into numerator-driven vs denominator-driven parts (they sum to the total). */
export function ratioDriver(r: RatioParts): { driver: 'numerator' | 'denominator'; numEffect: number; denEffect: number; numPct: number | null; denPct: number | null } | null {
  const { numerator: n, denominator: d } = r
  if (Math.abs(d.current) < EPS || Math.abs(d.previous) < EPS) return null
  const numEffect = (n.current - n.previous) / d.previous
  const denEffect = n.current / d.current - n.current / d.previous
  const driver = Math.abs(denEffect) >= Math.abs(numEffect) ? 'denominator' : 'numerator'
  return { driver, numEffect, denEffect, numPct: pct(n.current, n.previous), denPct: pct(d.current, d.previous) }
}

/** Rank entities by spend-weighted metric movement so small-spend swings don't dominate. */
export function rankMovers(entities: EntityMovement[], minSpendShare = 0.05): RankedMover[] {
  return entities
    .map((e) => {
      const deltaPct = e.metricCurrent != null && e.metricPrevious != null ? pct(e.metricCurrent, e.metricPrevious) : null
      const impact = deltaPct != null ? Math.abs(deltaPct) * e.spendShare : 0
      return { ...e, deltaPct, impact }
    })
    .filter((e) => e.spendShare >= minSpendShare && e.impact > 0)
    .sort((a, b) => b.impact - a.impact)
}

export function explainMetricChange(input: MetricChangeInput): AnomalyExplanation {
  const { key, label, current, previous, direction, unit } = input
  const noiseFloor = input.noiseFloorPct ?? 10
  const changePct = current != null && previous != null ? pct(current, previous) : null

  let dir: AnomalyDirection = 'unknown'
  if (changePct != null) {
    if (Math.abs(changePct) < 0.5) dir = 'flat'
    else {
      const rose = changePct > 0
      dir = direction === 'lower_is_better' ? (rose ? 'worsened' : 'improved') : rose ? 'improved' : 'worsened'
    }
  }

  // Severity: only "bad" movements past the floor are anomalies worth flagging.
  let severity: AnomalySeverity = 'none'
  const mag = changePct != null ? Math.abs(changePct) : 0
  if (dir === 'worsened') {
    if (mag >= 40) severity = 'high'
    else if (mag >= 20) severity = 'medium'
    else if (mag >= noiseFloor) severity = 'low'
  }

  // Arithmetic driver.
  let driver: string | null = null
  if (input.ratio) {
    const rd = ratioDriver(input.ratio)
    if (rd) {
      const part = rd.driver === 'denominator' ? input.ratio.denominator : input.ratio.numerator
      const partPct = rd.driver === 'denominator' ? rd.denPct : rd.numPct
      if (partPct != null && Math.abs(partPct) >= 1) {
        const moveWord = partPct > 0 ? 'rising' : 'falling'
        driver = `driven mostly by ${part.label} ${moveWord} ${Math.abs(partPct).toFixed(0)}% (${rd.driver})`
      }
    }
  }

  // Entity attribution.
  const topMovers = input.entities ? rankMovers(input.entities).slice(0, 3) : []

  // Trust in the anomaly itself.
  const trust = input.trustCtx ? computeTrust(input.trustCtx) : null

  // Headline.
  const headline = buildHeadline({ label, current, previous, changePct, dir, unit, driver, topMovers, trust })

  return { key, label, current, previous, changePct, direction: dir, severity, driver, topMovers, headline, trust }
}

function buildHeadline(a: {
  label: string
  current: number | null
  previous: number | null
  changePct: number | null
  dir: AnomalyDirection
  unit: '$' | '%' | 'x' | ''
  driver: string | null
  topMovers: RankedMover[]
  trust: TrustScore | null
}): string {
  if (a.changePct == null || a.current == null) return `${a.label}: not enough data to compare.`
  const sign = a.changePct > 0 ? '+' : ''
  const arrow = a.dir === 'worsened' ? '▲' : a.dir === 'improved' ? '▼' : '→'
  let s = `${a.label} ${arrow} ${sign}${a.changePct.toFixed(0)}% (${fmt(a.previous ?? 0, a.unit)} → ${fmt(a.current, a.unit)})`
  if (a.driver) s += ` — ${a.driver}`
  const mover = a.topMovers[0]
  if (mover && mover.deltaPct != null) {
    s += `, concentrated in “${mover.name}” (${(mover.spendShare * 100).toFixed(0)}% of spend, ${mover.deltaPct > 0 ? '+' : ''}${mover.deltaPct.toFixed(0)}%)`
  }
  s += '.'
  if (a.trust && !a.trust.meetsBar) s += ` Trust ${a.trust.score}% — ${a.trust.level}.`
  return s
}

/** Run several metrics and return only the notable anomalies (worsened past the floor), worst first. */
export function summarizeAnomalies(inputs: MetricChangeInput[]): AnomalyExplanation[] {
  const sevRank: Record<AnomalySeverity, number> = { high: 3, medium: 2, low: 1, none: 0 }
  return inputs
    .map(explainMetricChange)
    .filter((a) => a.severity !== 'none')
    .sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
}
