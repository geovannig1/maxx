import Link from 'next/link'
import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Clock3, Database } from 'lucide-react'
import type { MetricClaim, PerformanceCockpitData } from '@/lib/cockpit/contracts'
import {
  AVAILABILITY_LABEL,
  CLAIM_SOURCE_LABEL,
  COVERAGE_LABEL,
  FRESHNESS_LABEL,
  MATURITY_LABEL,
} from '@/lib/cockpit/contracts'
import type { ClaimedSeries } from '@/lib/cockpit/series-contract'
import type { TrackRecord } from '@/lib/cockpit/series-loader'
import type { AttributionLadder } from '@/lib/cockpit/attribution-ladder'
import { blockerLabel } from '@/lib/diagnostics/blocker-labels'
import { flagDiagnosticLabel } from '@/components/ui/badges'
import { DataQualityChip } from '@/components/ui/DataQualityChip'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import type { GroupPerformance, TodayRead } from '@/lib/cockpit/audience-performance'
import { AttributionLadderPanel } from '@/components/dashboard/AttributionLadderPanel'
import { TodayReadPanel } from '@/components/dashboard/TodayReadPanel'
import { PlaneHealthStrip, SourceHealthCard } from '@/components/dashboard/PlaneHealth'
import { AudiencePerformanceTable } from '@/components/dashboard/AudiencePerformanceTable'
import { DeliverySeriesChart } from '@/components/charts/DeliverySeriesChart'
import { accountCurrency, accountLocale, accountTimezone } from '@/config/business-config'
import { outcomeNoun } from '@/config/outcome-nouns'

/**
 * The deviation-only cell flags (Ledger B′). Empty when the number is Meta, settled, and current.
 * The label tables live in contracts.ts beside the enums — this surface's source is guarded against
 * business-plane vocabulary (tests/owner-dashboard-briefing-ui.test.ts), and a constant "Meta · …"
 * line under every cell shipped once here and was removed: a constant signal is wallpaper, and
 * wallpaper trains the owner to skim past the signals that actually vary.
 */
function provenanceFlags(claim: MetricClaim): string[] {
  const flags: string[] = []
  if (claim.source.system !== 'meta') flags.push(CLAIM_SOURCE_LABEL[claim.source.system])
  if (claim.maturity.state === 'settling' || claim.maturity.state === 'partial') {
    flags.push(MATURITY_LABEL[claim.maturity.state])
  }
  if (claim.freshness.state !== 'fresh') flags.push(FRESHNESS_LABEL[claim.freshness.state])
  return flags
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
// Cents are kept at every size. A general design heuristic says round money in display type, but
// this surface exists to be reconciled line-by-line against Ads Manager, where an exact figure is
// the point.
const MONEY_FORMAT = new Intl.NumberFormat(accountLocale(), { style: 'currency', currency: accountCurrency() })

function formatDate(value: string | null): string {
  if (!value) return 'Unavailable'
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: accountTimezone() }).format(date)
}

function formatTime(value: string | null): string {
  if (!value) return 'Unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: accountTimezone() }).format(date)
}

function claimValue(claim: MetricClaim): string {
  if (claim.availability.state !== 'available' || claim.value === null) return 'Unavailable'
  if (typeof claim.value === 'string') return claim.value
  if (claim.unit === 'money') return MONEY_FORMAT.format(claim.value)
  if (claim.unit === 'ratio') return `${claim.value.toFixed(2)}×`
  if (claim.unit === 'percent') return `${claim.value.toFixed(1)}%`
  return NUMBER_FORMAT.format(claim.value)
}

/**
 * An unavailable number is unknown, not bad. It is rendered quietly, in the ink ramp rather than in
 * the warning colour, with the reason in plain words underneath — a designed state, not an alarm.
 * The reason goes through `blockerLabel` so no raw enum ever reaches the owner.
 */
/** `Jul 12 – Jul 31`, compact enough to sit under a number. */
function windowLabel(window: { start: string; end: string }): string {
  const short = (value: string) => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: accountTimezone(),
  }).format(new Date(`${value}T12:00:00Z`))
  return `${short(window.start)} – ${short(window.end)}`
}

/**
 * The change against the prior period, stated without a verdict.
 *
 * NO RED OR GREEN, DELIBERATELY. Polarity is per metric and inverted between them: Results up is
 * good, cost per Result up is bad, CPM up is bad, CTR up is good, frequency up depends on a fatigue
 * band this surface does not know. Colouring direction requires declaring which way is good for each
 * metric, and a green number meaning "your CPA doubled" is worse than no colour at all — an actively
 * misleading signal on the surface built to prevent them. Direction and magnitude are stated; the
 * judgement is the reader's until polarity is a governed fact rather than a component's guess.
 *
 * AND THE WINDOW IS ALWAYS NAMED, because under per-metric comparable windows two cells on this same
 * grid genuinely cover different periods — spend over the whole request, conversions only to the
 * settle boundary. A reader cannot infer one cell's window from its neighbour's.
 */
/**
 * "17 vs 13" — the two measured numbers, formatted as the metric they came from.
 *
 * Returns a STRING, not an element. A component returning null is still a truthy JSX value, so
 * `{counts ? … : null}` around one always renders its separator and the line began with a stray " · ".
 */
function trendCounts(trend: MetricClaim, claims: Record<string, MetricClaim>): string | null {
  const [currentId, priorId] = trend.inputClaimIds
  const current = currentId ? claims[currentId] : undefined
  const prior = priorId ? claims[priorId] : undefined
  if (!current || !prior) return null
  if (current.availability.state !== 'available' || prior.availability.state !== 'available') return null
  return `${claimValue(current)} vs ${claimValue(prior)}`
}

/**
 * COUNTS FIRST, percentage second — and counts even when the percentage is refused.
 *
 * "17 vs 13 bookings" carries everything "+30.8%" does, without the false precision, and a buyer
 * judges it in half a second. On a small account, most percentages that clear the sample floor still
 * have a 95% Poisson interval spanning zero change. At a handful of bookings a week no reachable count
 * floor makes a percentage meaningful — roughly 47 events per side would be needed for a ±50%
 * interval, which is months of data.
 *
 * So the percentage is no longer the headline, and a REFUSED trend still shows its two numbers. The
 * case that matters most is the one that used to render as an absence: 0 bookings last period and 3
 * this one, at flat spend, is the most decision-relevant thing such an account can produce, and
 * it cannot be a percentage at all.
 */
/**
 * The two periods a trend line covers, named.
 *
 * Shared by both branches so they cannot drift: the refusal branch shipped without it, which is the
 * branch this account is almost always in. `shown` suppresses the pair when there are no counts to
 * attach it to — naming two windows above no numbers explains nothing.
 *
 * Each range wraps as a UNIT. Measured in headless Chromium with the real webfont: the 46-character
 * line is 269px and the two-column band at 640-767px gives the cell 251px, so it broke after
 * "Jul 19 – Jul " and orphaned "31" onto its own line. Naming both windows is correct; smearing a
 * date across two lines is not.
 */
function TrendWindows({ trend, shown }: { trend: MetricClaim; shown: boolean }) {
  const prior = trend.comparison.window
  if (!prior || !shown) return null
  return (
    <>
      {' · '}
      <span className="whitespace-nowrap">{windowLabel(trend.window)}</span>
      {' vs '}
      <span className="whitespace-nowrap">{windowLabel(prior)}</span>
    </>
  )
}

function TrendLine({ trend, claims }: { trend: MetricClaim | null; claims: Record<string, MetricClaim> }) {
  if (!trend) return null
  const counts = trendCounts(trend, claims)
  const available = trend.availability.state === 'available' && typeof trend.value === 'number'
  if (!available) {
    // NOT blank. An absent line reads as "no change", and "we could not compare" is a different
    // statement — the exact conflation this contract exists to prevent.
    return (
      <p data-today-trend="unavailable" className="mt-1.5 text-[12px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
        {counts ? <><span className="whitespace-nowrap">{counts}</span>{' · '}</> : null}
        no percentage · {blockerLabel(trend.availability.blockerCodes[0] ?? 'source_unavailable')}
        {/* THE WINDOWS BELONG HERE TOO. They were rendered only in the available branch, whose own
            comment gives the reason they are needed: under settling maturity the headline spans the
            REQUESTED window and the counts span the COMPARABLE one. This is the branch that lands on
            this account — conversion trends refuse far more often than they resolve — so the two
            unlabelled counts sat directly under a different, larger number with nothing to
            distinguish them. Naming the windows in the branch that resolves and omitting them in the
            branch that refuses puts the disclosure everywhere except where it is needed. */}
        <TrendWindows trend={trend} shown={counts !== null} />
      </p>
    )
  }
  // ROUNDED FIRST, and the direction taken from what is actually printed. Reading the sign off the
  // raw value rendered a 0.04% change as "▲ up 0.0%" — an arrow and a word contradicting the number
  // beside them, on one line. Whatever is shown and whatever is said must be the same figure.
  const value = Number((trend.value as number).toFixed(1))
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '■'
  return (
    <p data-today-trend="available" className="mt-1.5 text-[12px] leading-5 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
      {counts ? <><span className="whitespace-nowrap">{counts}</span>{' · '}</> : null}
      <span aria-hidden="true">{arrow}</span>{' '}
      {value > 0 ? 'up' : value < 0 ? 'down' : 'level'} {Math.abs(value).toFixed(1)}%
      {/* BOTH windows, always. The headline above this line spans the REQUESTED window; the trend
          spans the COMPARABLE one, and under settling maturity those differ — a cell can read "25
          Results" over Apr 6-24 above a percentage measured on Apr 6-17. Naming only the prior side
          let a reader take the printed number as the current side and compute a prior that does not
          exist. The chat's `claimLine` has always printed both; the page had not. */}
      <TrendWindows trend={trend} shown />
    </p>
  )
}

/**
 * A governed number to judge the value AGAINST — not a verdict, a yardstick.
 *
 * A cost per result on its own tells the owner nothing; beside the owner's target it shows where it
 * stands against that target. Both numbers already exist in `REC_THRESHOLDS` and neither was on this
 * page. Same for the learning threshold: `LEARNING_EXIT_EVENTS_PER_WEEK` is 50, and a small account
 * running a handful a week is far below it — the single fact that explains why its conversion trends are noise.
 *
 * Deliberately no colour and no pass/fail word — the polarity question this surface has already
 * declined to answer. It states the two numbers and lets the reader do the comparison, which is the
 * one thing a yardstick has to do.
 */
/** The owner's CPA target as a benchmark line; with none set the line asks for one. */
function cpaBenchmark(target: number | null): { label: string; value: string } {
  return target === null
    ? { label: 'No target —', value: 'set a target in Settings → Performance Targets' }
    : { label: 'target', value: MONEY_FORMAT.format(target) }
}

function BenchmarkLine({ claim, label, value }: { claim: MetricClaim; label: string; value: string }) {
  if (claim.availability.state !== 'available' || claim.value === null) return null
  return (
    <p data-today-benchmark className="mt-1.5 text-[12px] leading-5 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
      <span className="whitespace-nowrap">{label} {value}</span>
    </p>
  )
}

function MetricCell({ claim, note, testId, trend = null, claims, benchmark = null }: {
  claim: MetricClaim; note: string; testId: string; trend?: MetricClaim | null
  claims: Record<string, MetricClaim>
  benchmark?: { label: string; value: string } | null
}) {
  const available = claim.availability.state === 'available' && claim.value !== null
  // The chip renders every blocker through the label table, not just the first one.
  const blockers = claim.availability.state === 'unavailable' ? claim.availability.blockerCodes : null
  return (
    <div data-today-metric={testId} className="min-w-0 p-4" style={{ background: 'var(--bg-surface)' }}>
      <p className="section-label">{claim.label}</p>
      <p className="stat-value mt-2" style={available ? undefined : { color: 'var(--text-tertiary)' }}>
        {available ? claimValue(claim) : '—'}
      </p>
      {/* Only under a metric that HAS a value: a cell already saying "unavailable" does not need a
          second line explaining that its trend is unavailable too. */}
      {available && <TrendLine trend={trend} claims={claims} />}
      {benchmark && <BenchmarkLine claim={claim} label={benchmark.label} value={benchmark.value} />}
      <p className="mt-2 text-[12.5px] leading-5" style={{ color: 'var(--text-secondary)' }}>{note}</p>
      {/* Evidence tier travels WITH the number (bar 4). Rendered only when there is something to
          say: a claim marked available whose value is still null said nothing here before, and
          still says nothing, rather than labelling an absent number.
          This replaced a hand-written template that printed `Meta · measured` under every available
          cell — `measurementKind` is an internal contract axis, and blocker-labels.ts exists exactly
          because raw codes were reaching the owner. That leak survived earlier passes because a
          template is not a label table. */}
      {(available || blockers) && (
        <div className="mt-1.5">
          <DataQualityChip kind={claim.measurementKind} blockerCodes={blockers} compact />
          {/* Deviation-only provenance (Ledger B′). Supplements the chip, never replaces it, and
              renders nothing for a Meta, settled, current number — the section badge already says
              "Meta only", and a constant line per cell is wallpaper. */}
          {provenanceFlags(claim).length > 0 && (
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              {provenanceFlags(claim).join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function EvidenceRow({ claim }: { claim: MetricClaim }) {
  // Owner words via the label tables, never raw contract tokens — this drawer printed
  // `meta · daily_insights.account` and `available · complete · fresh · settling` until Ledger B′.
  const coverage = claim.coverage.denominator === null
    ? COVERAGE_LABEL[claim.coverage.state]
    : `${claim.coverage.numerator ?? 0}/${claim.coverage.denominator} · ${COVERAGE_LABEL[claim.coverage.state]}`
  return <li className="grid gap-2 border-b py-4 last:border-b-0 md:grid-cols-[minmax(190px,1.1fr)_repeat(3,minmax(130px,1fr))]" style={{ borderColor: 'var(--border)' }}>
    {/* THE VALUE. This drawer listed provenance and no figures, so opening it to check what
        "up 35.2%" was measured against gave a source, a window and an evidence state — and neither
        number. A claim you cannot read the value of is not evidence you can inspect. */}
    <div><p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{claim.label}</p><p className="mt-1 text-[16px] font-bold tabular-nums" style={{ color: claim.availability.state === 'available' ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{claimValue(claim)}</p><p className="mt-1 break-words text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{claim.claimId}</p></div>
    <div><p className="text-[12px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>Source</p><p className="mt-1 text-[14px]" style={{ color: 'var(--text-secondary)' }}>{CLAIM_SOURCE_LABEL[claim.source.system]} · {claim.source.head}</p></div>
    <div><p className="text-[12px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>Window</p><p className="mt-1 text-[14px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{claim.window.start} → {claim.window.end}</p><p className="mt-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Closed account days · {claim.window.timezone}</p></div>
    <div><p className="text-[12px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>Evidence state</p><p className="mt-1 text-[14px]" style={{ color: 'var(--text-secondary)' }}>{AVAILABILITY_LABEL[claim.availability.state]} · {coverage} · {FRESHNESS_LABEL[claim.freshness.state]} · {MATURITY_LABEL[claim.maturity.state]}</p></div>
  </li>
}

/**
 * Read once per render, outside any component body. This tree is server-rendered, so a clock read
 * here is legitimate — but keeping it out of the component keeps the components pure and testable.
 */
function renderClockMs(): number {
  return Date.now()
}

function Clock({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0">
    <p className="section-label">{label}</p>
    <p className="mt-1 text-[13px] font-semibold tabular-nums" style={{ color: 'var(--text-secondary)' }}>{value}</p>
    <p className="mt-0.5 text-[12px] leading-4" style={{ color: 'var(--text-tertiary)' }}>{detail}</p>
  </div>
}

export function TodayPerformanceCockpit({
  data, rangeControl, ladder = null, spendSeries = null, read = null, audiences = [], concepts = [],
  trackRecord,
}: {
  data: PerformanceCockpitData
  rangeControl: React.ReactNode
  ladder?: AttributionLadder | null
  spendSeries?: ClaimedSeries | null
  read?: TodayRead | null
  audiences?: GroupPerformance[]
  concepts?: GroupPerformance[]
  /** Ledger C′′. `undefined` = caller has no record concept (renders nothing); `null` = the read
   * failed (renders an evidenced absence, never silence). */
  trackRecord?: TrackRecord | null
}) {
  const { claims, paidPerformance } = data
  const spend = claims[paidPerformance.spendClaimId]
  const pacing = claims[paidPerformance.pacingClaimId]
  const results = claims[paidPerformance.resultsClaimId]
  const costPerResult = claims[paidPerformance.costPerResultClaimId]
  const purchaseRoas = claims[paidPerformance.purchaseRoasClaimId]
  const linkCtr = claims[paidPerformance.linkCtrClaimId]
  const cpm = claims[paidPerformance.cpmClaimId]
  const frequency = claims[paidPerformance.frequencyClaimId]
  const costPerLead = paidPerformance.costPerLeadClaimId ? claims[paidPerformance.costPerLeadClaimId] : null
  // BY ID, like every cell above. These two were resolved with
  // `Object.values(claims).find((c) => c.metricKey === key)`, and the claim set holds the same
  // metricKey once per compared window — so `.find()` returned the PRIOR window's claim and the page
  // printed last period's reach and a learning rate 20× off, under this period's heading.
  const reach = claims[paidPerformance.reachClaimId] ?? null
  const optimizationRate = claims[paidPerformance.optimizationRateClaimId] ?? null
  const partialTodayClaims = data.partialToday.claimIds.map((claimId) => claims[claimId]).filter(Boolean)
  const partialTodaySpend = partialTodayClaims.find((claim) => claim.metricKey === 'meta.partial_today_spend')
  const partialTodayPacing = partialTodayClaims.find((claim) => claim.metricKey === 'meta.partial_today_budget_pacing')
  // The DOLLAR budget, not only the percentage of it. "87.0% of current daily budget" never said
  // what the budget is, and "should I scale" is decided against the owner-approved ceiling, not against a ratio.
  const dailyBudget = partialTodayClaims.find((claim) => claim.metricKey === 'meta.current_daily_budget')
  const primaryDecisionHref = data.primaryDecisionId ? `/decisions?decision=${encodeURIComponent(data.primaryDecisionId)}` : '/decisions'
  // `reach` and `optimizationRate` BELONG HERE. They were omitted, so they reached the drawer only as
  // transitive inputs of their own trend claims — and with `MAXX_COCKPIT_TRENDS=off`, or on any window
  // too recent to compare, there are no trend claims. Two numbers then rendered on a page whose whole
  // premise is that every number on it is inspectable, with no evidence row and no entry in the
  // "{n} claims" count.
  const headlineClaims = [spend, pacing, results, costPerResult, purchaseRoas, linkCtr, cpm, frequency, costPerLead, reach, optimizationRate, ...partialTodayClaims].filter((claim): claim is MetricClaim => Boolean(claim))
  // Trends are keyed off the metric they describe, from the ids the cockpit itself published. Looked
  // up by metricKey rather than by rebuilding the id, because the id encodes the COMPARABLE window,
  // which differs per metric and is not the requested range.
  const trendByMetric = new Map<string, MetricClaim>(
    data.comparison.claimIds
      .map((claimId) => claims[claimId])
      .filter((claim): claim is MetricClaim => Boolean(claim))
      .map((claim) => [claim.metricKey.replace(/_change$/, ''), claim]),
  )
  const trendFor = (claim: MetricClaim | null) => (claim ? trendByMetric.get(claim.metricKey) ?? null : null)
  /**
   * The evidence drawer shows the evidence, INCLUDING what the trends were computed from.
   *
   * It used to list a hardcoded set of headline metrics, so a page showing "up 35.2% vs Mar 18 – Apr 5"
   * offered no way to see either number behind it. A trend whose two inputs cannot be inspected is a
   * figure without its evidence, which is the one thing this surface is not allowed to be.
   *
   * Order is deliberate: headline metrics first, then the trends, then the prior-period values the
   * trends cite. A reader opening this is checking a number they just read, and finds it in the same
   * order they read it.
   */
  const trendClaims = data.comparison.claimIds
    .map((claimId) => claims[claimId])
    .filter((claim): claim is MetricClaim => Boolean(claim))
  const alreadyShown = new Set([...headlineClaims, ...trendClaims].map((claim) => claim.claimId))
  // TRANSITIVE, like the closure the builder computes. Following only the trends' DIRECT inputs
  // stopped one level short: a settling-window `cost_per_result` prior claim cites its own spend and
  // results over that window, and those were absent from the drawer — so "a figure without its
  // evidence" was still true one level down.
  const trendInputs: MetricClaim[] = []
  const pending = trendClaims.flatMap((claim) => claim.inputClaimIds)
  while (pending.length > 0) {
    const claimId = pending.pop()!
    if (alreadyShown.has(claimId)) continue
    alreadyShown.add(claimId)
    const claim = claims[claimId]
    if (!claim) continue
    trendInputs.push(claim)
    pending.push(...claim.inputClaimIds)
  }
  const visibleClaims = [...headlineClaims, ...trendClaims, ...trendInputs]
  // Ledger G: was `data.sourceHealth[0]`. Positional access was safe only while the array was
  // schema-pinned to exactly one row. Now that other planes can be present, position no longer
  // identifies the plane — the contract guarantees meta_delivery is PRESENT, not that it is first.
  const metaHealth = data.sourceHealth.find((source) => source.plane === 'meta_delivery')
  const deliveryReady = metaHealth?.state === 'available'

  return <div className="owner-page" aria-labelledby="today-title">
    <header className="owner-surface owner-surface-section">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="section-label">Today</p>
          <h1 id="today-title" className="text-[20px] font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>Meta performance cockpit</h1>
          <div className="mt-2 flex items-center gap-2 text-[14px] font-semibold tabular-nums" style={{ color: 'var(--text-secondary)' }}><CalendarDays aria-hidden="true" className="size-4 shrink-0" /><span>{formatDate(data.controls.range.start)} – {formatDate(data.controls.range.end)}</span></div>
          <p className="mt-1 text-[12.5px] leading-5" style={{ color: 'var(--text-tertiary)' }}>Closed account days · {accountTimezone()} · today is excluded</p>
        </div>
        <div className="md:hidden">{rangeControl}</div>
      </div>
    </header>

    {read && <TodayReadPanel read={read} />}

    <PlaneHealthStrip sources={data.sourceHealth} />

    <section className="owner-surface owner-surface-section" aria-labelledby="verdict-title"><div className="flex items-start gap-3">{deliveryReady ? <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0" style={{ color: 'var(--success)' }} /> : <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" style={{ color: 'var(--warning)' }} />}<div className="min-w-0 flex-1">{/* A DATA STATUS, not a verdict — and it must not outrank the read above it.
              "Current verdict" over "Meta delivery is ready for review" put the ETL's health in the
              slot a reader takes for the account's judgement, in 20px bold, one pixel LARGER than
              `TodayReadPanel`'s 19px headline — which is the only sentence on this page that names an
              entity and a direction. The status is worth showing; it is not the verdict. */}
              <p className="section-label">Data status</p><h2 id="verdict-title" className="text-[16px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{deliveryReady ? 'Meta delivery is complete and current for this period' : 'Meta delivery has gaps in this period'}</h2><p className="mt-2 max-w-3xl text-[14px] leading-6" style={{ color: 'var(--text-secondary)' }}>Maxx provides review-first advice. Nothing changes in your ad account until you approve a change, and an approved change applies only with write mode on.</p></div></div>
      <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--border)' }}><p className="section-label">One action to review</p><div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-[14px] font-semibold leading-5" style={{ color: data.primaryDecision ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{data.primaryDecision?.summary ?? 'Nothing is ready to act on. The numbers above are the read.'}</p>{/* THE CTA MATCHES WHAT IS BEHIND IT. This was the loudest control on the page — full accent
                fill — and with no ready decision it led to an empty queue while the line beside it
                said there was nothing to do. A button that shouts and then delivers nothing teaches
                the owner to stop trusting the ones that don't. Accent only when there IS an action;
                otherwise a quiet link, honestly labelled as a log rather than as an action. */}
              <Link href={primaryDecisionHref} className="owner-button min-h-[44px] shrink-0" style={data.primaryDecision
                ? { background: 'var(--accent)', color: 'var(--on-accent)', textDecoration: 'none' }
                : { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', textDecoration: 'none' }}>{data.primaryDecision ? 'Review this action' : 'Open decision log'} <ArrowRight aria-hidden="true" className="size-4" /></Link></div></div>
      {/* Data clocks are furniture, not the hero: they qualify the verdict rather than answer it. */}
      <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-3" style={{ borderColor: 'var(--border)' }} aria-label="Data clocks">
        <Clock label="Delivery closed through" value={formatDate(data.clocks.deliveryClosedThrough)} detail="Meta delivery included in this view" />
        <Clock label="Conversions mature through" value={formatDate(data.clocks.conversionMatureThrough)} detail="Platform-modelled results may still settle" />
        <Clock label="Synchronized at" value={formatTime(data.clocks.synchronizedAt)} detail="Most recent Meta delivery update" />
      </div>
      {/* Maxx's record (Ledger C′′). Counts-first, never a bare percentage: at a small account's volume
          a percentage on n<6 is noise, and the floor refuses to print one. Neutral text on purpose —
          a green "75%" would read as an endorsement the sample cannot carry. */}
      {trackRecord !== undefined && (
        <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--border)' }} aria-label="Maxx's record">
          <p className="section-label">Maxx&rsquo;s record</p>
          {trackRecord === null ? (
            <p className="mt-2 text-[13px] leading-5" style={{ color: 'var(--text-secondary)' }}>
              Maxx&rsquo;s record is temporarily unavailable — the outcome store could not be read.
            </p>
          ) : trackRecord.plays.length === 0 ? (
            <>
              <p className="mt-2 text-[13px] leading-5" style={{ color: 'var(--text-secondary)' }}>
                {trackRecord.totalDecisive === 0
                  ? 'No owner-reviewed outcomes yet — the record builds as you review decision outcomes.'
                  : 'Not enough reviewed outcomes yet to show a record.'}
                {trackRecord.pendingReview > 0 && ` ${trackRecord.pendingReview} outcome${trackRecord.pendingReview === 1 ? ' is' : 's are'} awaiting your review.`}
              </p>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                Across all reviewed outcomes. Historical correlation only; no current action authority.
              </p>
            </>
          ) : (
            <>
              <ul className="mt-2 space-y-1">
                {trackRecord.plays.map((play) => (
                  <li key={play.play} className="text-[13px] leading-5" style={{ color: 'var(--text-secondary)' }}>
                    {/* Owner words via the repo's label map — raw flag_type tokens never render here. */}
                    {play.play === 'unknown' ? 'Unclassified' : flagDiagnosticLabel(play.play)}: {play.worked} of {play.worked + play.failed} owner-reviewed calls worked
                    {play.inconclusive > 0 ? ` · ${play.inconclusive} inconclusive` : ''}
                  </li>
                ))}
              </ul>
              {trackRecord.pendingReview > 0 && (
                <p className="mt-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  {trackRecord.pendingReview} outcome{trackRecord.pendingReview === 1 ? ' is' : 's are'} awaiting your review.
                </p>
              )}
              {/* The population claim renders only when a population was actually read — under the
                  unavailable state "across all reviewed outcomes" would assert something unread. */}
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                Across all reviewed outcomes. Historical correlation only; no current action authority.
              </p>
            </>
          )}
        </div>
      )}
    </section>

    {ladder && <AttributionLadderPanel ladder={ladder} />}

    {spendSeries && spendSeries.points.length > 0 && (
      <section className="owner-surface owner-surface-section" aria-labelledby="trend-title">
        <p className="section-label">Delivery over time</p>
        <h2 id="trend-title" className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>{spendSeries.label} by day</h2>
        <div className="mt-4"><DeliverySeriesChart series={spendSeries} /></div>
      </section>
    )}

    <AudiencePerformanceTable audiences={audiences} concepts={concepts} />

    <section className="owner-surface owner-surface-section" aria-labelledby="paid-performance-title">
      <div className="flex items-start justify-between gap-4"><div><p className="section-label">Meta Ads Manager</p><h2 id="paid-performance-title" className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>Paid performance</h2></div><span className="rounded-full border px-2.5 py-1 text-[12px] font-semibold" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>Meta only</span></div>
      {/* A divider grid, not a grid of cards: the design system forbids nesting a card inside a surface. */}
      <div className="mt-4 grid gap-px overflow-hidden rounded-xl sm:grid-cols-2 xl:grid-cols-3" style={{ background: 'var(--border)' }}>
        <MetricCell claim={spend} trend={trendFor(spend)} claims={claims} testId="spend" note={`Authoritative Meta spend · pace: ${claimValue(pacing)}`} />
        <MetricCell claim={results} trend={trendFor(results)} claims={claims} testId="appointment-results" note={`Meta ${outcomeNoun({ plural: false })} events credited to these ads — Meta's own count, not your recorded ${outcomeNoun()}`} />
        <MetricCell claim={costPerResult} trend={trendFor(costPerResult)} claims={claims} benchmark={cpaBenchmark(REC_THRESHOLDS.TARGET_CPA)} testId="cost-per-appointment" note={`What each Meta ${outcomeNoun({ plural: false })} event cost, by Meta's count`} />
        <MetricCell claim={purchaseRoas} trend={trendFor(purchaseRoas)} claims={claims} testId="purchase-roas" note="Canonical Meta purchase value ÷ same-window Meta spend" />
        <MetricCell claim={linkCtr} trend={trendFor(linkCtr)} claims={claims} testId="link-ctr" note="How often people clicked through · watch it, don't act on it alone" />
        <MetricCell claim={cpm} trend={trendFor(cpm)} claims={claims} testId="cpm" note="Meta spend per 1,000 impressions" />
        {/* NO reach benchmark here. Reach shipped twice on one screen — as this cell's benchmark line
            AND as its own cell below. Worse than redundant: `BenchmarkLine` is defined as "a governed
            number to judge the value AGAINST", and its two other uses are goals (the owner's CPA target,
            50 to exit learning). Reach is frequency's DENOMINATOR, not a target to move toward, so putting
            it in the yardstick slot teaches the reader that grey line means two different things. */}
        <MetricCell claim={frequency} trend={trendFor(frequency)} claims={claims} testId="native-frequency" note="How many times the average person saw an ad in this period" />
        {optimizationRate && <MetricCell claim={optimizationRate} claims={claims} testId="optimization-rate"
          // PER AD SET is the rule; this number is the whole ACCOUNT. `thresholds.ts` states the
          // provenance as "~50 optimization events per ad set per 7 days — META-PUBLISHED", and the
          // claim carries `entity.level: 'account'`. Dropping the qualifier made Meta say something it
          // did not publish, and in the flattering direction: twelve events spread over three ad sets is
          // four each, not twelve. The same discipline this repo already forces on the 5×-CPA heuristic.
          note={`Meta ${outcomeNoun({ plural: false })} events per week across the whole account · Meta needs ~50 per AD SET to exit learning, so more ad sets means further away`}
          benchmark={{ label: 'needed per ad set', value: String(REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK) }} />}
        {reach && <MetricCell claim={reach} claims={claims} testId="native-reach"
          note="How many different people saw an ad · the denominator under frequency" />}
        {costPerLead && <MetricCell claim={costPerLead} trend={trendFor(costPerLead)} claims={claims} testId="cost-per-lead" note="Canonical Meta lead action only" />}
      </div>
    </section>

    <section className="owner-surface owner-surface-section" aria-labelledby="today-so-far-title"><div className="flex items-start gap-3"><Clock3 aria-hidden="true" className="mt-0.5 size-5 shrink-0" style={{ color: 'var(--accent)' }} /><div><p className="section-label">Partial delivery only</p><h2 id="today-so-far-title" className="text-[18px] font-bold" style={{ color: 'var(--text-primary)' }}>Today so far</h2><p className="mt-1 text-[14px] leading-5" style={{ color: 'var(--text-secondary)' }}>{partialTodaySpend?.availability.state === 'available' ? `${claimValue(partialTodaySpend)} spent today so far · ${partialTodayPacing ? claimValue(partialTodayPacing) : 'Unavailable'} of the ${dailyBudget?.availability.state === 'available' ? claimValue(dailyBudget) : 'current'} daily budget` : 'Intraday pacing is unavailable'} and does not affect the closed-period verdict.</p></div></div></section>

    <details className="owner-surface group"><summary className="owner-button min-h-[44px] w-full cursor-pointer justify-between px-5 py-3 text-[14px]" style={{ color: 'var(--text-primary)' }}><span className="flex items-center gap-2"><Database aria-hidden="true" className="size-4" /> Meta evidence and diagnostics</span><span className="text-[12px] font-normal" style={{ color: 'var(--text-tertiary)' }}>{visibleClaims.length} claims</span></summary><div className="border-t px-5 pb-2" style={{ borderColor: 'var(--border)' }}><section className="py-5" aria-labelledby="source-health-title"><h3 id="source-health-title" className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>Source health</h3><div className="mt-3 flex flex-col gap-3">{data.sourceHealth.map((source) => <SourceHealthCard key={source.plane} source={source} nowMs={renderClockMs()} />)}</div></section><ul>{visibleClaims.map((claim) => <EvidenceRow key={claim.claimId} claim={claim} />)}</ul></div></details>
  </div>
}
