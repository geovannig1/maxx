import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { applyTargetOverrides } from '@/lib/targets/target-ranges'
import { TodayPerformanceCockpit } from '@/components/dashboard/TodayPerformanceCockpit'
import type { TrackRecord } from '@/lib/cockpit/series-loader'
import type { PerformanceCockpitData } from '@/lib/cockpit/contracts'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

const page = readFileSync(join(process.cwd(), 'src/app/(dashboard)/dashboard/page.tsx'), 'utf8')
const surface = readFileSync(join(process.cwd(), 'src/components/dashboard/TodayPerformanceCockpit.tsx'), 'utf8')
const workspace = readFileSync(join(process.cwd(), 'src/components/reporting/ReportingWorkspace.tsx'), 'utf8')
const reportingHook = readFileSync(join(process.cwd(), 'src/lib/reporting/use-reporting-data.ts'), 'utf8')

function claim(id: string, label: string, value: number | null, unit: 'money' | 'count' | 'ratio' | 'percent' = 'count') {
  return {
    claimId: id, metricKey: id, label, value, unit, formula: 'governed Meta formula', definitionVersion: 3,
    source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights.account', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'act_123' }, attributionScope: 'meta_platform_modelled',
    window: { start: '2026-04-06', end: '2026-04-24', basis: 'closed_account_days', timezone: 'America/New_York' },
    comparison: { method: 'none', window: null }, asOf: '2026-04-25T12:00:00.000Z',
    availability: value === null ? { state: 'unavailable', blockerCodes: ['meta_source_unavailable'] } : { state: 'available', blockerCodes: [] },
    coverage: value === null ? { state: 'unknown', numerator: null, denominator: null } : { state: 'complete', numerator: 19, denominator: 19 },
    maturity: { state: 'settling', matureThrough: '2026-04-24' }, freshness: { state: 'fresh', observedAt: '2026-04-25T11:55:00.000Z', maxAgeHours: 30 },
    setupFingerprint: null, authority: { state: 'authoritative', policyVersion: 'performance-cockpit-v3' }, measurementKind: unit === 'ratio' || unit === 'percent' ? 'derived' : 'modelled', inputClaimIds: [],
  }
}

function fixture(): PerformanceCockpitData {
  const claims = {
    spend: claim('spend', 'Meta spend', 963.4, 'money'), pacing: claim('pacing', 'Spend pacing', null, 'percent'),
    results: claim('results', 'Meta Results', 17), cpa: claim('cpa', 'Meta cost per Result', 67.35, 'money'),
    roas: claim('roas', 'Meta Purchase ROAS', 2.18, 'ratio'), ctr: claim('ctr', 'Meta link CTR', 1.6, 'percent'),
    cpm: claim('cpm', 'Meta CPM', 64.22, 'money'), frequency: claim('frequency', 'Meta frequency', 1.29, 'ratio'),
    cpl: claim('cpl', 'Meta cost per Lead', 37.06, 'money'), todaySpend: claim('meta.partial_today_spend', 'Today so far spend', 5.31, 'money'),
    todayPace: claim('meta.partial_today_budget_pacing', 'Today budget pace', 6.2, 'percent'),
  }
  claims.todaySpend.window = { ...claims.todaySpend.window, start: '2026-04-25', end: '2026-04-25', basis: 'partial_today' }
  claims.todayPace.window = { ...claims.todayPace.window, start: '2026-04-25', end: '2026-04-25', basis: 'partial_today' }
  return {
    contractVersion: 4, account: { id: 'account-1', metaAccountId: 'act_123', name: 'Example Studio' },
    controls: { range: claims.spend.window }, clocks: { deliveryClosedThrough: '2026-04-24', conversionMatureThrough: '2026-04-24', synchronizedAt: '2026-04-25T11:55:00.000Z' },
    claims, paidPerformance: { spendClaimId: 'spend', pacingClaimId: 'pacing', resultsClaimId: 'results', costPerResultClaimId: 'cpa', purchaseRoasClaimId: 'roas', linkCtrClaimId: 'ctr', cpmClaimId: 'cpm', frequencyClaimId: 'frequency', costPerLeadClaimId: 'cpl', reachClaimId: 'meta.native_reach', optimizationRateClaimId: 'meta.optimization_events_per_week' },
    partialToday: { date: '2026-04-25', state: 'partial', claimIds: ['meta.partial_today_spend', 'meta.partial_today_budget_pacing'] }, comparison: { state: 'not_requested', window: null, claimIds: [] },
    sourceHealth: [{ plane: 'meta_delivery', state: 'available', synchronizedAt: '2026-04-25T11:55:00.000Z', blockerCodes: [], consumedByToday: true }], decisionIds: [], primaryDecisionId: null, primaryDecision: null,
  } as PerformanceCockpitData
}

describe('Today cockpit UI', () => {
  it('uses one selected-window reporting workspace without source toggles or hidden child windows', () => {
    expect(page).toContain('<ReportingWorkspace view="overview" />')
    expect(workspace).toContain('useReportingData()')
    expect(workspace).toContain('<OverviewReport data={data} />')
    expect(reportingHook).toContain('const { range, ready } = useGlobalControls()')
    expect(reportingHook).toContain('for (const section of REPORT_SOURCES)')
    expect(reportingHook).toContain('const sourceParams = new URLSearchParams(requestKey)')
    expect(reportingHook).toContain("if (section !== 'meta') sourceParams.delete('historyEntity')")
    expect(reportingHook).toMatch(/requestReportingPacket\(section, sourceParams\.toString\(\), controller.signal, refresh[,)]/)
    expect(page).not.toContain('SourceToggle')
    // The retired cockpit remains covered below as a pure component, including its no-hidden-window
    // contract. It is no longer asserted as the production dashboard entry point.
    expect(surface).not.toMatch(/7-day|30-day/)
  })

  it('renders only Meta operating metrics and the manual review boundary', () => {
    expect(surface).toContain('purchaseRoasClaimId')
    expect(surface).toContain('linkCtrClaimId')
    expect(surface).toContain('cpmClaimId')
    expect(surface).toContain('frequencyClaimId')
    expect(surface).toContain('Canonical Meta lead action only')
    expect(surface).toContain('Nothing changes in your ad account until you approve a change, and an approved change applies only with write mode on.')
    // Owner decision 2026-08-22: Today is no longer Meta-only. It now carries the first-party
    // reconciliation ladder alongside the Meta plane, with each side labelled by its date basis so
    // the two are never read as one number. The ladder's own contract test pins that separation.
    expect(surface).toContain('AttributionLadderPanel')
  })

  it('keeps three clocks, one action, and mobile-first controls visible', () => {
    expect(surface).toContain('Delivery closed through')
    expect(surface).toContain('Conversions mature through')
    expect(surface).toContain('Synchronized at')
    expect(surface).toContain('One action to review')
    expect(surface).toContain('sm:grid-cols-3')
    // A divider grid, not nested cards: cells sit on a hairline background rather than each
    // carrying its own border inside the surrounding surface.
    expect(surface).toContain('grid gap-px overflow-hidden rounded-xl sm:grid-cols-2 xl:grid-cols-3')
    expect(surface).toMatch(/min-h-\[44px\]/)
  })

  it('renders canonical Meta claims and an optional lead-cost tile', () => {
    const markup = renderToStaticMarkup(TodayPerformanceCockpit({ data: fixture(), rangeControl: null }))
    expect(markup).toContain('$963.40')
    expect(markup).toContain('Meta Purchase ROAS')
    expect(markup).toContain('2.18×')
    expect(markup).toContain('Meta link CTR')
    expect(markup).toContain('1.6%')
    expect(markup).toContain('data-today-metric="cost-per-lead"')
    expect(markup).toContain('Today so far')
    expect(markup).not.toMatch(/Acuity|checkout|amount paid|booked value|paid association/i)
  })
})

/**
 * The trend line on the cockpit.
 *
 * The existing fixture carries `comparison: { state: 'not_requested', claimIds: [] }`, so every test
 * above passes with the trend code entirely absent — they were written before trends existed and
 * cannot see them. These build the comparison the cockpit actually publishes.
 */
function trendClaim(metricKey: string, value: number | null, priorStart = '2026-03-18', priorEnd = '2026-04-05') {
  const base = claim(`${metricKey}_change`, `${metricKey} vs prior period`, value, 'percent')
  return {
    ...base,
    metricKey: `${metricKey}_change`,
    comparison: value === null
      ? { method: 'none', window: null }
      : { method: 'prior_equal_period', window: { start: priorStart, end: priorEnd, basis: 'closed_account_days', timezone: 'America/New_York' } },
    availability: value === null
      ? { state: 'unavailable', blockerCodes: ['trend_window_coverage_incomplete'] }
      : { state: 'available', blockerCodes: [] },
    inputClaimIds: value === null ? [] : ['a', 'b'],
  }
}

function withTrends(trends: Record<string, ReturnType<typeof trendClaim>>): PerformanceCockpitData {
  const data = fixture() as unknown as {
    claims: Record<string, unknown>
    comparison: { state: string; window: unknown; claimIds: string[] }
  }
  for (const [id, value] of Object.entries(trends)) data.claims[id] = value
  data.comparison = { state: 'available', window: null, claimIds: Object.keys(trends) }
  return data as unknown as PerformanceCockpitData
}

const html = (data: PerformanceCockpitData) =>
  renderToStaticMarkup(<TodayPerformanceCockpit data={data} rangeControl={null} />)

describe('the cockpit shows which way a number moved', () => {
  it('renders a RISE with a direction word, not only an arrow glyph', () => {
    // The arrow is `aria-hidden`, so a screen reader gets nothing from it. The word carries the
    // meaning; the glyph is decoration.
    const out = html(withTrends({ spend_change: trendClaim('spend', 35.2) }))
    expect(out).toContain('up 35.2%')
  })

  it('renders a FALL as down, not as a negative number the reader must interpret', () => {
    expect(html(withTrends({ spend_change: trendClaim('spend', -12.4) }))).toContain('down 12.4%')
  })

  it('renders no movement as level, which is not a rise', () => {
    const out = html(withTrends({ spend_change: trendClaim('spend', 0) }))
    expect(out).toContain('level 0.0%')
    expect(out).not.toContain('up 0.0%')
  })

  it('names the window it was compared against, on every cell', () => {
    // Under per-metric comparable windows two cells on this grid genuinely cover different periods,
    // so a reader cannot infer one cell's window from its neighbour's.
    expect(html(withTrends({ spend_change: trendClaim('spend', 35.2) }))).toContain('Mar 18 – Apr 5')
  })

  it('shows DIFFERENT windows on different cells, rather than one caption for the grid', () => {
    const out = html(withTrends({
      spend_change: trendClaim('spend', 10, '2026-03-18', '2026-04-05'),
      results_change: trendClaim('results', 20, '2026-03-25', '2026-04-05'),
    }))
    expect(out).toContain('Mar 18 – Apr 5')
    expect(out).toContain('Mar 25 – Apr 5')
  })

  it('says a comparison is MISSING rather than leaving a blank that reads as "no change"', () => {
    const out = html(withTrends({ spend_change: trendClaim('spend', null) }))
    expect(out).toContain('no percentage')
    expect(out).toContain('data-today-trend="unavailable"')
  })

  it('does NOT add a trend line to a metric whose own value is unavailable', () => {
    // A cell already saying "unavailable" does not need a second line saying its trend is
    // unavailable too.
    //
    // Uses ROAS, which HAS a cell. The first version used `pacing`, which does not: it appears only
    // inside spend's note, never as a MetricCell, so the assertion held no matter what the component
    // did and mutation proved it — rendering the trend unconditionally left every test green.
    const data = withTrends({ roas_change: trendClaim('roas', 12.5) }) as unknown as {
      claims: Record<string, { value: number | null; availability: unknown; coverage: unknown }>
    }
    data.claims.roas.value = null
    data.claims.roas.availability = { state: 'unavailable', blockerCodes: ['meta_source_unavailable'] }
    data.claims.roas.coverage = { state: 'unknown', numerator: null, denominator: null }
    const out = html(data as unknown as PerformanceCockpitData)

    // The ROAS cell shows no number…
    expect(out).toMatch(/data-today-metric="purchase-roas"[\s\S]*?—/)
    // …and carries no trend line of any kind.
    const roasCell = /data-today-metric="purchase-roas"[\s\S]*?<\/div>/.exec(out)?.[0] ?? ''
    expect(roasCell).not.toContain('data-today-trend')
  })

  it('still shows a trend on the OTHER cells when one metric is unavailable', () => {
    // Guards the case above against passing because trends stopped rendering everywhere.
    const data = withTrends({
      roas_change: trendClaim('roas', 12.5),
      spend_change: trendClaim('spend', 8.1),
    }) as unknown as { claims: Record<string, { value: number | null; availability: unknown; coverage: unknown }> }
    data.claims.roas.value = null
    data.claims.roas.availability = { state: 'unavailable', blockerCodes: ['meta_source_unavailable'] }
    data.claims.roas.coverage = { state: 'unknown', numerator: null, denominator: null }
    const out = html(data as unknown as PerformanceCockpitData)
    expect(out).toContain('up 8.1%')
  })

  it('shows nothing at all when the cockpit published no comparison', () => {
    // The pre-trend shape, still valid: an older caller supplies no comparison evidence.
    const out = html(fixture())
    expect(out).not.toContain('data-today-trend')
    expect(out).not.toContain('no percentage')
  })

  it('carries NO good/bad colour, because polarity is per metric and inverted between them', () => {
    // Results up is good; cost per Result up is bad. A green number meaning "your CPA doubled" is
    // worse than no colour, so direction is stated and the judgement left to the reader. Pinned so
    // the decision is revisited deliberately rather than drifted into.
    const out = html(withTrends({
      cpa_change: trendClaim('cpa', 35.2),
      results_change: trendClaim('results', 35.2),
    }))
    // Scoped to the trend elements. A page-wide assertion would fail on the verdict checkmark, which
    // is a legitimate use of the success colour and has nothing to do with this decision.
    const trendMarkup = out.match(/<p data-today-trend="[^"]*"[^>]*>/g) ?? []
    expect(trendMarkup.length).toBeGreaterThan(0)
    for (const element of trendMarkup) {
      expect(element).not.toMatch(/var\(--(success|danger|error|warning)\)/)
    }
    // The SAME +35.2% on two metrics where it means opposite things — a win on Results, a doubling
    // of cost per Result — renders identically. That is the decision, stated as an assertion.
    const rendered: string[] = out.match(/<p data-today-trend="available"[^>]*>.*?<\/p>/g) ?? []
    expect(rendered).toHaveLength(2)
    const [first, second] = rendered
    expect(first).toBe(second)
  })
})

describe('the evidence drawer shows what the trends were computed from', () => {
  /**
   * The drawer listed a hardcoded set of headline metrics, so a page showing "up 35.2% vs Mar 18 – Apr 5"
   * gave no way to see either number behind it. A figure whose inputs cannot be inspected is a figure
   * without its evidence.
   */
  function withTrendAndInputs() {
    const data = withTrends({ spend_change: trendClaim('spend', 35.2) }) as unknown as {
      claims: Record<string, unknown>
    }
    // The prior-period value the trend cites, as the cockpit emits it.
    data.claims['spend:prior'] = {
      ...claim('spend:prior', 'Meta spend', 712.45, 'money'),
      window: { start: '2026-03-18', end: '2026-04-05', basis: 'closed_account_days', timezone: 'America/New_York' },
    }
    ;(data.claims.spend_change as { inputClaimIds: string[] }).inputClaimIds = ['spend', 'spend:prior']
    return data as unknown as PerformanceCockpitData
  }

  it('lists the trend itself', () => {
    expect(html(withTrendAndInputs())).toContain('spend_change')
  })

  it('lists the PRIOR-period value the trend cites, which nothing showed before', () => {
    const out = html(withTrendAndInputs())
    expect(out).toContain('spend:prior')
    expect(out).toContain('2026-03-18 → 2026-04-05')
  })

  it('counts what it lists — measured against an INDEPENDENT expectation', () => {
    // The first version compared the stated count to the rendered rows. Both come from the same
    // array, so it held for any implementation: reverting the drawer to headline-only — the exact
    // regression its own comment described — left it green. A test whose two sides come from one
    // source is an identity, not an assertion.
    //
    // The expectation is now computed here, from the cockpit's own claim set: every trend, plus the
    // transitive closure of what those trends cite, plus the headline metrics.
    const data = withTrendAndInputs()
    const expected = new Set<string>(data.comparison.claimIds)
    const pending = [...data.comparison.claimIds]
    while (pending.length > 0) {
      const id = pending.pop()!
      for (const input of data.claims[id]?.inputClaimIds ?? []) {
        if (!expected.has(input)) { expected.add(input); pending.push(input) }
      }
    }
    const out = html(data)
    const rows = (out.match(/<li class="grid gap-2 border-b/g) ?? []).length
    const stated = Number(/>(\d+) claims</.exec(out)?.[1] ?? '0')

    expect(stated).toBe(rows)
    // …and the rows genuinely cover the closure, which the identity above cannot show.
    expect(rows).toBeGreaterThanOrEqual(expected.size)
    for (const id of expected) expect(out, `drawer omits ${id}`).toContain(id)
  })

  it('lists a transitive input, not only what a trend directly cites', () => {
    // A settling-window derived claim cites its own inputs in its own window. Following only the
    // trends' direct inputs stopped one level short and left those unlistable.
    const data = withTrendAndInputs() as unknown as { claims: Record<string, unknown> }
    ;(data.claims['spend:prior'] as { inputClaimIds: string[] }).inputClaimIds = ['spend:prior:deep']
    data.claims['spend:prior:deep'] = {
      ...claim('spend:prior:deep', 'Meta spend (deep input)', 42, 'money'),
      window: { start: '2026-03-18', end: '2026-04-05', basis: 'closed_account_days', timezone: 'America/New_York' },
    }
    const out = html(data as unknown as PerformanceCockpitData)
    expect(out).toContain('spend:prior:deep')
  })

  it('does not list the same claim twice when it is both headline and trend input', () => {
    // `spend` is a headline metric AND an input to `spend_change`.
    const out = html(withTrendAndInputs())
    const ids = out.match(/class="mt-1 break-words text-\[12px\]" style="color:var\(--text-tertiary\)">([^<]+)</g) ?? []
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is unchanged when the cockpit published no comparison', () => {
    const out = html(fixture())
    expect(out).not.toContain('spend_change')
  })
})

describe('the cockpit never prints a direction it cannot show', () => {
  const line = (value: number) => {
    const out = html(withTrends({ spend_change: trendClaim('spend', value) }))
    return /<p data-today-trend="available"[^>]*>(.*?)<\/p>/.exec(out)?.[1]?.replace(/<[^>]+>/g, '') ?? ''
  }

  it('a change too small to show reads as level, not as up', () => {
    // Rendered "▲ up 0.0%" — an arrow and a word contradicting the number beside them.
    expect(line(0.04)).toContain('level 0.0%')
    expect(line(0.04)).not.toContain('up 0.0%')
    expect(line(-0.04)).toContain('level 0.0%')
  })

  it('a change that survives rounding keeps its direction', () => {
    // Guards the case above against passing because every trend became "level".
    expect(line(0.4)).toContain('up 0.4%')
    expect(line(-0.4)).toContain('down 0.4%')
  })

  it('the arrow agrees with the word', () => {
    // Counts now lead the line, so the arrow sits between them and the direction word.
    expect(line(0.04)).toMatch(/■ level/)
    expect(line(5)).toMatch(/▲ up/)
    expect(line(-5)).toMatch(/▼ down/)
  })
})

describe('the arrow is decoration, and the word carries the meaning', () => {
  it('the arrow is hidden from assistive technology', () => {
    // Mutation flipped `aria-hidden="true"` to "false" and every test stayed green — while this
    // file's own comment claimed the glyph carries nothing for a screen reader. A ▲ announced aloud
    // is noise, and the direction is already in the word beside it.
    const out = html(withTrends({ spend_change: trendClaim('spend', 35.2) }))
    expect(out).toContain('<span aria-hidden="true">▲</span>')
    expect(out).not.toContain('aria-hidden="false"')
  })

  it('the direction survives with the arrow stripped out', () => {
    // The real property: remove every glyph and the line still says which way the number moved.
    const out = html(withTrends({ spend_change: trendClaim('spend', -12.4) }))
    const text = /<p data-today-trend="available"[^>]*>(.*?)<\/p>/.exec(out)?.[1] ?? ''
    expect(text.replace(/<[^>]+>/g, '').replace(/[▲▼■]/g, '')).toMatch(/down 12\.4%/)
  })
})

describe('the trend names the window it actually covers, not just the one it was measured against', () => {
  /**
   * Independent reviews found this. The cell renders the REQUESTED-window value and,
   * beneath it, a percentage measured over the COMPARABLE window — which under settling maturity is
   * shorter. Naming only the prior side let a reader take the printed number as the current side and
   * compute a prior that does not exist.
   */
  const settling = () => {
    const data = withTrends({ results_change: trendClaim('results', 30.8, '2026-03-21', '2026-04-05') }) as unknown as {
      claims: Record<string, { window: unknown }>
    }
    // The trend covers only the settled part of the requested window.
    data.claims.results_change.window = { start: '2026-04-06', end: '2026-04-17', basis: 'closed_account_days', timezone: 'America/New_York' }
    return data as unknown as PerformanceCockpitData
  }

  /** What the READER sees: markup stripped, so a wrapping fix cannot break a truth assertion. */
  const trendText = (out: string) =>
    (/<p data-today-trend="available"[^>]*>(.*?)<\/p>/.exec(out)?.[1] ?? '')
      .replace(/<[^>]+>/g, '')

  it('prints the current comparable window as well as the prior one', () => {
    expect(trendText(html(settling()))).toContain('Apr 6 – Apr 17 vs Mar 21 – Apr 5')
  })

  it('wraps each date range as a unit, so a break cannot split a date', () => {
    // Measured in headless Chromium with the real webfont: the 46-character line is 269px and the
    // 640-767px two-column band gives the cell 251px, so it broke after "Mar 25 – Apr " and orphaned
    // "5" onto its own line. Naming both windows is correct; smearing a date across two lines is not.
    const out = html(settling())
    expect(out).toContain('<span class="whitespace-nowrap">Apr 6 – Apr 17</span>')
    expect(out).toContain('<span class="whitespace-nowrap">Mar 21 – Apr 5</span>')
  })

  it('so a reader cannot mistake the headline value for the compared value', () => {
    // The headline is 17 over Apr 6-24; the percentage is measured on Apr 6-17. Both spans visible.
    const out = html(settling())
    expect(out).toContain('>17<')
    expect(trendText(out)).toContain('Apr 6 – Apr 17')
    expect(trendText(out)).toContain('Mar 21 – Apr 5')
  })

  it('still names both when the trend DOES span the full requested window', () => {
    // Spend is stamped settled, so its trend covers the whole request. Printing both sides
    // unconditionally is what makes the shorter case legible by contrast.
    expect(trendText(html(withTrends({ spend_change: trendClaim('spend', 35.2) }))))
      .toContain('Apr 6 – Apr 24 vs Mar 18 – Apr 5')
  })
})

describe('the drawer shows the numbers, not just where they came from', () => {
  const withTrendAndInputs = () => {
    const data = withTrends({ spend_change: trendClaim('spend', 35.2) }) as unknown as {
      claims: Record<string, unknown>
    }
    data.claims['spend:prior'] = {
      ...claim('spend:prior', 'Meta spend', 712.45, 'money'),
      window: { start: '2026-03-18', end: '2026-04-05', basis: 'closed_account_days', timezone: 'America/New_York' },
    }
    ;(data.claims.spend_change as { inputClaimIds: string[] }).inputClaimIds = ['spend', 'spend:prior']
    return data as unknown as PerformanceCockpitData
  }

  it('prints each claim value', () => {
    // It listed label, id, source, window and evidence state — and no figures. Opening it to check
    // what "up 35.2%" was measured against gave provenance and neither number.
    const out = html(withTrendAndInputs())
    expect(out).toContain('$712.45')   // the prior-period spend the trend cites
    expect(out).toContain('$963.40') // the current spend
  })

  it('renders an unavailable claim as a dash rather than a fabricated figure', () => {
    const out = html(withTrends({ spend_change: trendClaim('spend', 35.2) }))
    const pacingRow = /Spend pacing[\s\S]{0,400}?<\/div>/.exec(out)?.[0] ?? ''
    expect(pacingRow).toContain('Unavailable')
  })
})

describe('counts come first, and survive a refused percentage', () => {
  /**
   * At a handful of bookings a week most period-over-period percentages have a 95% Poisson interval
   * spanning zero change, so no reachable count floor makes a percentage meaningful. "17 vs 13"
   * carries everything "+30.8%" does and a buyer judges it in half a second.
   */
  const withCounts = (opts: { value: number | null; blocker?: string }) => {
    const data = withTrends({
      results_change: {
        ...trendClaim('results', opts.value ?? 0),
        value: opts.value,
        availability: opts.value === null
          ? { state: 'unavailable', blockerCodes: [opts.blocker ?? 'trend_sample_too_small'] }
          : { state: 'available', blockerCodes: [] },
        inputClaimIds: ['results', 'results:prior'],
      },
    }) as unknown as { claims: Record<string, unknown> }
    data.claims['results:prior'] = {
      ...claim('results:prior', 'Meta Results', 13),
      window: { start: '2026-03-21', end: '2026-04-05', basis: 'closed_account_days', timezone: 'America/New_York' },
    }
    return data as unknown as PerformanceCockpitData
  }
  const resultsCell = (data: PerformanceCockpitData) =>
    (/data-today-metric="appointment-results"[\s\S]*?<\/div>/.exec(html(data))?.[0] ?? '')
      .replace(/<[^>]+>/g, '')

  /**
   * The REFUSED branch names its two windows too.
   *
   * This was the whole point of sharing `TrendWindows` between the branches, and it shipped with no
   * test: every window assertion in this file covers the AVAILABLE branch. The mutation sweep proved
   * it — inverting `shown={counts !== null}` to `=== null`, which renders the windows exactly when
   * there are no counts to attach them to, left the entire suite green.
   *
   * It matters most here. Under settling maturity the headline spans the REQUESTED window while the
   * counts span the COMPARABLE one, and on a small account conversion trends refuse far more often than
   * they resolve — so the unlabelled pair sits under a different, larger number almost every day.
   */
  it('names both periods beside the counts it printed, even when the percentage is refused', () => {
    const text = resultsCell(withCounts({ value: null }))
    expect(text).toContain('no percentage')
    expect(text).toContain('17 vs 13')
    // Both periods, from the trend's own `comparison.window` — Mar 18 is the prior window the
    // comparison declares, which is the pair the counts were taken over.
    expect(text).toContain('Apr 6 – Apr 24 vs Mar 18 – Apr 5')
  })

  it('names NO periods when there were no counts to attach them to', () => {
    // The other half, varied independently: two dates above no numbers explain nothing. Asserting
    // only the positive case lets the condition be inverted or deleted.
    const noCounts = withTrends({
      results_change: {
        ...trendClaim('results', null),
        value: null,
        availability: { state: 'unavailable', blockerCodes: ['trend_window_uncomparable'] },
        inputClaimIds: [],
      },
    })
    const text = resultsCell(noCounts)
    expect(text).toContain('no percentage')
    expect(text).not.toContain(' vs Mar 18 – Apr 5')
  })

  it('shows both counts alongside the percentage', () => {
    expect(resultsCell(withCounts({ value: 30.8 }))).toContain('17 vs 13')
  })

  it('shows the counts FIRST — the percentage is no longer the headline', () => {
    const text = resultsCell(withCounts({ value: 30.8 }))
    expect(text.indexOf('17 vs 13')).toBeLessThan(text.indexOf('up 30.8%'))
  })

  it('shows the counts even when the percentage is REFUSED for a small sample', () => {
    // The case the floor creates: a refusal that used to render as an absence now carries the two
    // numbers, which is the information a buyer wanted from the percentage in the first place.
    const text = resultsCell(withCounts({ value: null }))
    expect(text).toContain('17 vs 13')
    expect(text).toContain('no percentage')
    expect(text).not.toMatch(/up |down /)
  })

  it('shows the counts when there is NO prior baseline at all', () => {
    // 0 to 3 at flat spend cannot be a percentage and is the most decision-relevant thing this
    // account produced. It used to render as "nothing to compare against" and no numbers.
    const data = withCounts({ value: null, blocker: 'trend_prior_period_zero' }) as unknown as {
      claims: Record<string, { value: number }>
    }
    data.claims['results:prior'].value = 0
    const text = resultsCell(data as unknown as PerformanceCockpitData)
    expect(text).toContain('17 vs 0')
    expect(text).toContain('nothing to compare against')
  })

  it('shows NO counts when one side has no figure — "17 vs Unavailable" is not a comparison', () => {
    // Both sides must be measured. A resolvable-but-unavailable prior claim would otherwise render
    // its placeholder text as if it were a number.
    const data = withCounts({ value: null }) as unknown as {
      claims: Record<string, { value: number | null; availability: unknown; coverage: unknown }>
    }
    data.claims['results:prior'].value = null
    data.claims['results:prior'].availability = { state: 'unavailable', blockerCodes: ['meta_results_unavailable'] }
    data.claims['results:prior'].coverage = { state: 'unknown', numerator: null, denominator: null }
    const text = resultsCell(data as unknown as PerformanceCockpitData)
    expect(text).not.toContain('Unavailable')
    expect(text).not.toContain('17 vs')
    expect(text).toContain('no percentage')
  })

  it('omits the separator when there are no counts to show', () => {
    // A component returning null is still a truthy JSX value, so the first version rendered a stray
    // leading " · " on every refusal that had no lineage.
    const text = resultsCell(withTrends({ results_change: trendClaim('results', null) }))
    expect(text).not.toMatch(/\s· no percentage/)
    expect(text).toContain('no percentage')
  })
})

/**
 * The page states the budget, and the CTA matches what is behind it.
 *
 * Two review findings, both about the page telling the owner something it could not back
 * up: a pace with no budget beside it, and the loudest control on the surface leading to an empty
 * queue while the sentence next to it said there was nothing to do.
 */
describe('what the page promises matches what is behind it', () => {
  const withToday = (dailyBudget: number | null) => {
    const data = withTrends({}) as unknown as {
      claims: Record<string, unknown>; partialToday: { claimIds: string[] }
    }
    data.claims['budget'] = {
      ...claim('budget', 'Current daily budget', dailyBudget),
      metricKey: 'meta.current_daily_budget', unit: 'money',
      availability: dailyBudget === null
        ? { state: 'unavailable', blockerCodes: ['meta_daily_budget_unavailable'] }
        : { state: 'available', blockerCodes: [] },
    }
    data.claims['today'] = {
      ...claim('today', 'Spent today so far', 64.3), metricKey: 'meta.partial_today_spend', unit: 'money',
    }
    data.claims['pace'] = {
      ...claim('pace', 'Today budget pace', 75.6), metricKey: 'meta.partial_today_budget_pacing', unit: 'percent',
    }
    data.partialToday.claimIds = ['today', 'pace', 'budget']
    return data as unknown as PerformanceCockpitData
  }

  it('names the dollar budget the pace is a percentage OF', () => {
    const out = html(withToday(85))
    expect(out).toContain('$85.00 daily budget')
  })

  it('falls back to plain words when the budget cannot be read, never to a bare percentage', () => {
    // Varied independently of the pace, which stays available — so the assertion is about the budget
    // branch and not about the whole section disappearing.
    const out = html(withToday(null))
    expect(out).toContain('current daily budget')
    expect(out).not.toContain('$85.00')
  })

  it('shouts only when there is something to act on', () => {
    // With no ready decision the accent CTA led to an empty queue while the line beside it said
    // there was nothing to do. A control that shouts and delivers nothing devalues the ones that do.
    const empty = html(withTrends({}))
    expect(empty).toContain('Nothing is ready to act on')
    expect(empty).toContain('Open decision log')
    expect(empty).not.toContain('Review this action')
  })
})

describe('the delivery status is labelled as status, not as a verdict', () => {
  it('names what it measures and stays out of the verdict slot', () => {
    const out = html(withTrends({}))
    expect(out).toContain('Data status')
    expect(out).not.toContain('Current verdict')
    expect(out).toMatch(/Meta delivery is complete and current|Meta delivery has gaps/)
  })

  it('does not render larger than the read above it', () => {
    // The defect was typographic rank, so that is what is asserted. 19px is TodayReadPanel's headline.
    const heading = /<h2 id="verdict-title"[^>]*class="([^"]*)"/.exec(html(withTrends({})))
    expect(heading, 'the status heading is no longer identifiable').not.toBeNull()
    const size = Number(/text-\[(\d+)px\]/.exec(heading![1])?.[1])
    expect(size).toBeLessThan(19)
  })
})

describe('the three numbers that turn "what happened" into "what to do"', () => {
  /**
   * All three already existed in this codebase and none was on this page.
   *   • reach — read from the same native rollup as frequency and discarded
   *   • optimization events/week vs 50 — the fact that explains why every trend here is noise
   *   • cost per Result vs the owner's target — the number a budget decision is actually made against
   */
  const withExtras = () => {
    const data = withTrends({ spend_change: trendClaim('spend', 12) }) as unknown as {
      claims: Record<string, unknown>
    }
    data.claims['meta.native_reach'] = { ...claim('meta.native_reach', 'Meta reach', 10_240), metricKey: 'meta.native_reach' }
    data.claims['meta.optimization_events_per_week'] = {
      ...claim('meta.optimization_events_per_week', 'Optimization events / week', 6.2),
      metricKey: 'meta.optimization_events_per_week',
    }
    return data as unknown as PerformanceCockpitData
  }
  const cell = (out: string, id: string) =>
    (new RegExp(`data-today-metric="${id}"[\\s\\S]*?<\\/div>`).exec(out)?.[0] ?? '').replace(/<[^>]+>/g, '')

  it('shows cost per Result against the governed target, not naked', () => {
    // `$67.35` alone says nothing. `$67.35 · target $64.00` says the owner is inside it.
    // DERIVED from the applied example target, not a pinned literal: a literal is a tripwire that fires
    // when the example number is legitimately changed — it asserts nothing about behaviour.
    const target = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
      .format(REC_THRESHOLDS.TARGET_CPA!) // set by applyExampleOwnerTargetsPerTest
    expect(cell(html(withExtras()), 'cost-per-appointment')).toContain(`target ${target}`)
  })

  it('asks for a target when the owner has set none, never a built-in amount', () => {
    applyTargetOverrides(null)
    const text = cell(html(withExtras()), 'cost-per-appointment')
    expect(text).toContain('set a target in Settings → Performance Targets')
    expect(text).not.toMatch(/target \$/)
  })

  it('shows reach in its own cell, with a label a reader can act on', () => {
    // Reach shipped TWICE — as this cell and as the frequency cell's benchmark line. The benchmark
    // slot means "a number to judge the value against" (the CPA target, 50 to exit learning); reach is
    // frequency's denominator, not a goal, so it now appears once, as a cell.
    expect(cell(html(withExtras()), 'native-reach')).toContain('10,240')
    expect(cell(html(withExtras()), 'native-frequency')).not.toContain('10,240')
  })

  it('states the learning threshold at the granularity Meta published it for', () => {
    const text = cell(html(withExtras()), 'optimization-rate')
    // PER AD SET. `thresholds.ts` records the rule as "~50 optimization events per ad set per 7 days";
    // this claim is account-level, and dropping the qualifier made Meta say something it did not
    // publish — in the flattering direction, since six events over three ad sets is two each.
    expect(text).toContain('AD SET')
    expect(text).toContain(String(REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK))
    // The benchmark's LABEL too. Emptying it survived the sweep: a bare "50" under the rate says
    // nothing about what 50 is, and the whole point of the yardstick is that it names itself.
    expect(text).toContain('needed per ad set')
  })

  it('renders the weekly rate as a whole number, not a substring that any number satisfies', () => {
    // `toContain('6')` passed for "6.2", "16", "60" and "6.25" alike — one character asserted
    // nothing. The fixture value is 6.2 and the cell must show `6`, so the assertion has to be able
    // to tell those apart.
    const text = cell(html(withExtras()), 'optimization-rate')
    expect(text).toMatch(/(^|\D)6(\D|$)/)
    expect(text).not.toContain('6.2')
  })

  it('states no verdict — no colour, no pass/fail word', () => {
    // Same decision as the trend direction: polarity is not a governed fact here, so the surface
    // gives the yardstick and lets the reader judge.
    const out = html(withExtras())
    const benchmarks = out.match(/<p data-today-benchmark[^>]*>/g) ?? []
    expect(benchmarks.length).toBeGreaterThanOrEqual(2)
    for (const b of benchmarks) {
      expect(b).not.toMatch(/var\(--(success|danger|error|warning)\)/)
      // ALSO the Tailwind route, which is how colour would actually arrive in this codebase — the
      // inline-style check alone could only fail if someone edited one hardcoded literal.
      expect(b).not.toMatch(/\b(text|bg|border)-(red|green|emerald|amber|orange|rose|yellow)-\d{2,3}\b/)
    }
    expect(out).not.toMatch(/(above|below|over|under) target/i)
  })

  it('omits the benchmark when the metric itself is unavailable', () => {
    // A yardstick beside a dash measures nothing.
    const data = withExtras() as unknown as { claims: Record<string, { value: number | null; availability: unknown }> }
    data.claims.cpa.value = null
    data.claims.cpa.availability = { state: 'unavailable', blockerCodes: ['x'] }
    expect(cell(html(data as unknown as PerformanceCockpitData), 'cost-per-appointment'))
      .not.toContain('target')
  })

  it('renders no reach cell at all when the native rollup failed', () => {
    // The two conditions are varied INDEPENDENTLY. The previous version set `value = null` and
    // `availability = unavailable` together, so EITHER half of the production guard could be deleted
    // and the test stayed green — the fixture, not the code, was doing the work.
    const unavailableOnly = withExtras() as unknown as { claims: Record<string, { value: number | null; availability: unknown }> }
    unavailableOnly.claims['meta.native_reach'].availability = { state: 'unavailable', blockerCodes: ['meta_native_reach_unavailable'] }
    expect(cell(html(unavailableOnly as unknown as PerformanceCockpitData), 'native-reach')).not.toContain('10,240')

    const valueOnly = withExtras() as unknown as { claims: Record<string, { value: number | null }> }
    valueOnly.claims['meta.native_reach'].value = null
    expect(cell(html(valueOnly as unknown as PerformanceCockpitData), 'native-reach')).not.toContain('10,240')
  })
})

describe('provenance renders on deviation from the norm, never as wallpaper', () => {
  // Ledger B′. The removed defect (MetricCell comment) was a CONSTANT "Meta · …" line under every
  // cell; the replacement renders only on deviation — unsettled maturity, stale data, non-Meta
  // source — and nothing when the number is Meta, settled, and current.
  const everyClaim = (data: PerformanceCockpitData) =>
    data as unknown as { claims: Record<string, { maturity: { state: string }; freshness: { state: string } }> }

  // Same extractor as the benchmark describe above: one cell's markup, tags stripped.
  const cell = (out: string, id: string) =>
    (new RegExp(`data-today-metric="${id}"[\\s\\S]*?<\\/div>`).exec(out)?.[0] ?? '').replace(/<[^>]+>/g, '')

  it('flags a settling number in words, beside the number', () => {
    // The fixture's claims are settling by default, so the spend cell must say so.
    expect(cell(html(fixture()), 'spend')).toContain('Still settling')
  })

  it('renders no provenance line when every claim is Meta, settled, and current', () => {
    const data = everyClaim(fixture())
    for (const claim of Object.values(data.claims)) claim.maturity.state = 'settled'
    const out = html(data as unknown as PerformanceCockpitData)
    expect(cell(out, 'spend')).not.toContain('Still settling')
    expect(cell(out, 'spend')).not.toContain('Stale data')
    expect(cell(out, 'spend')).not.toContain('Meta Ads Manager')
  })

  it('flags stale data where the number is', () => {
    const data = everyClaim(fixture())
    for (const claim of Object.values(data.claims)) claim.freshness.state = 'stale'
    expect(cell(html(data as unknown as PerformanceCockpitData), 'spend')).toContain('Stale data')
  })

  it('the drawer speaks owner words, not contract tokens', () => {
    const out = html(fixture())
    expect(out).toContain('Meta Ads Manager · daily_insights.account')
    expect(out).toContain('Complete coverage')
    expect(out).not.toContain('meta · daily_insights.account')
    expect(out).not.toMatch(/available · complete · fresh · settling/)
  })
})

describe("Maxx's record shows counts with the sample attached, never a bare percentage", () => {
  // Ledger C′′. The number that must never appear is a percentage on a small n — the cockpit's own
  // trend doctrine (above) holds that at a small account's volume no percentage is meaningful.
  const withRecord = (trackRecord: TrackRecord | null) =>
    renderToStaticMarkup(<TodayPerformanceCockpit data={fixture()} rangeControl={null} trackRecord={trackRecord} />)

  it('prints worked-of-decisive counts, the inconclusive count, and the disclaimer', () => {
    const out = withRecord({
      plays: [{ play: 'winner', worked: 3, failed: 1, inconclusive: 2 }],
      totalDecisive: 4,
      pendingReview: 0,
    })
    // Play names render through the repo's owner-word map, never as raw flag_type tokens.
    expect(out).toContain('Favorable signal')
    expect(out).not.toContain('winner')
    expect(out).toContain('3 of 4 owner-reviewed calls worked')
    expect(out).toContain('2 inconclusive')
    expect(out).toContain('Historical correlation only; no current action authority')
    expect(out).not.toMatch(/75/)
    expect(out).not.toMatch(/30 days/i)
  })

  it('shows the honest low-n state with the pending-review path forward', () => {
    const out = withRecord({ plays: [], totalDecisive: 3, pendingReview: 2 })
    expect(out).toContain('Not enough reviewed outcomes yet')
    expect(out).toContain('2 outcomes are awaiting your review')
  })

  it('states an empty record as a teaching state, not a void', () => {
    const out = withRecord({ plays: [], totalDecisive: 0, pendingReview: 0 })
    expect(out).toContain('No owner-reviewed outcomes yet')
  })

  it('says the record is temporarily unavailable when the read failed, never silent', () => {
    const out = withRecord(null)
    expect(out).toContain('temporarily unavailable')
  })

  it('renders no record block at all when the caller does not supply one', () => {
    expect(html(fixture())).not.toContain("Maxx's record")
  })
})
