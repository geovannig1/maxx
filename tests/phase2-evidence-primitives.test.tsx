import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FreshnessStrip } from '@/components/ui/FreshnessStrip'
import { DataQualityChip } from '@/components/ui/DataQualityChip'
import { ProposalCard } from '@/components/ui/ProposalCard'
import { EntityTable, type EntityColumn } from '@/components/ui/EntityTable'

/**
 * These assert the FAILURE modes these two primitives exist to prevent, not that they render.
 * A test that only proves a component produces markup is the positive-control-only mistake that
 * let a broken detector ship twice in two days.
 */

const NOW = Date.parse('2026-08-27T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe('FreshnessStrip', () => {
  it('says nothing has been observed rather than reporting an age of zero', () => {
    const html = renderToStaticMarkup(
      <FreshnessStrip label="Meta delivery" nowMs={NOW}
        freshness={{ asOf: null, staleAfterHours: 26 }} />,
    )
    expect(html).toContain('Not yet observed')
    // The whole point: an absent timestamp must never render as a fresh, confident zero.
    expect(html).not.toContain('0h old')
    expect(html).not.toContain('NaN')
  })

  it('states the age of the DATA, not of the last attempt, and shows the gap when they disagree', () => {
    // The exact shape of the teardown defect: checked 14h ago, data is 38h old.
    const html = renderToStaticMarkup(
      <FreshnessStrip label="Meta delivery" nowMs={NOW}
        freshness={{ asOf: hoursAgo(38), checkedAt: hoursAgo(14), staleAfterHours: 26 }} />,
    )
    expect(html).toContain('38h old')          // the headline is the DATA age
    expect(html).toContain('last checked 14h') // the attempt is shown, not hidden
    expect(html).toContain('stale past 26h')   // and the threshold it has crossed
  })

  it('does not cry stale while inside the threshold', () => {
    const html = renderToStaticMarkup(
      <FreshnessStrip label="Meta delivery" nowMs={NOW}
        freshness={{ asOf: hoursAgo(3), staleAfterHours: 26 }} />,
    )
    expect(html).toContain('3h old')
    expect(html).not.toContain('stale')
  })

  it('does not repeat the attempt when it agrees with the data age', () => {
    const html = renderToStaticMarkup(
      <FreshnessStrip label="Meta delivery" nowMs={NOW}
        freshness={{ asOf: hoursAgo(4), checkedAt: hoursAgo(4), staleAfterHours: 26 }} />,
    )
    expect(html).not.toContain('last checked')
  })
})

describe('DataQualityChip', () => {
  it('never renders a raw engine code to the owner', () => {
    const html = renderToStaticMarkup(
      <DataQualityChip kind="measured" blockerCodes={['meta_outcome_metrics_incomplete']} />,
    )
    // Bar 5: no enum values, no error codes, ever.
    expect(html).not.toContain('meta_outcome_metrics_incomplete')
    expect(html).toContain('Not available')
  })

  it('distinguishes a counted number from a modelled one', () => {
    expect(renderToStaticMarkup(<DataQualityChip kind="measured" />)).toContain('As reported')
    expect(renderToStaticMarkup(<DataQualityChip kind="modelled" />)).toContain('Estimated')
  })

  it('separates days never synced from days without delivery', () => {
    const notSynced = renderToStaticMarkup(
      <DataQualityChip kind="measured"
        coverage={{ totalDays: 30, measuredDays: 20, noDeliveryDays: 0, notSyncedDays: 10 }} />,
    )
    const noDelivery = renderToStaticMarkup(
      <DataQualityChip kind="measured"
        coverage={{ totalDays: 30, measuredDays: 20, noDeliveryDays: 10, notSyncedDays: 0 }} />,
    )
    // A sync gap and a delivery gap call for different actions; collapsing them hides one.
    expect(notSynced).toContain('10 not synced')
    expect(noDelivery).toContain('10 without delivery')
    expect(notSynced).not.toEqual(noDelivery)
  })

  it('stays quiet when coverage is complete', () => {
    const html = renderToStaticMarkup(
      <DataQualityChip kind="measured"
        coverage={{ totalDays: 30, measuredDays: 30, noDeliveryDays: 0, notSyncedDays: 0 }} />,
    )
    expect(html).not.toContain('of 30 days')
  })
})

describe('ProposalCard', () => {
  const base = {
    title: 'Reduce spend on Cold — Studio Reel A',
    summary: 'Spend is running ahead of the target CPA over the evidence period.',
    source: 'recommendation',
    evidenceWindow: { start: 'Aug 1', end: 'Aug 27' },
  } as const

  it('tells the owner what they can DO, never the authority enum', () => {
    const html = renderToStaticMarkup(<ProposalCard {...base} authority="diagnostic_only" />)
    // The old card printed `diagnostic_only`.replace(/_/g,' ') — English-looking, still the enum,
    // and silent about the thing that matters: Maxx cannot act on it.
    expect(html).not.toContain('diagnostic_only')
    expect(html).not.toContain('diagnostic only')
    expect(html).toContain('For your judgement')
    expect(html).toContain('no change to propose yet')
  })

  it('distinguishes the three authority tiers by what happens next', () => {
    const run = (a: 'execution_eligible' | 'owner_review' | 'diagnostic_only') =>
      renderToStaticMarkup(<ProposalCard {...base} authority={a} />)
    // "Ready to run — Maxx can carry this out" was false: write mode is off and this card's own
    // footer says it cannot change Meta. The labels name who does the work.
    expect(run('execution_eligible')).toContain('Yours to apply')
    expect(run('owner_review')).toContain('Needs your call')
    expect(run('diagnostic_only')).toContain('For your judgement')
    expect(run('execution_eligible')).not.toEqual(run('owner_review'))
  })

  it('states an absent evidence period instead of leaving it blank', () => {
    const html = renderToStaticMarkup(
      <ProposalCard {...base} authority="owner_review" evidenceWindow={null} />,
    )
    expect(html).toContain('Evidence period unavailable')
  })

  it('carries the evidence tier without a click', () => {
    const html = renderToStaticMarkup(
      <ProposalCard {...base} authority="owner_review" quality={{ kind: 'modelled' }} />,
    )
    expect(html).toContain('Estimated')
  })

  it('renders confidence in owner words and as a percent, never the raw token or score', () => {
    const html = renderToStaticMarkup(
      <ProposalCard {...base} authority="owner_review" confidence={{ score: 0.8, label: 'high' }} />,
    )
    expect(html).toContain('High confidence')
    expect(html).toContain('80%')
    expect(html).not.toContain('0.8')
  })

  it('degrades an unknown confidence label instead of leaking the enum', () => {
    const html = renderToStaticMarkup(
      <ProposalCard {...base} authority="owner_review" confidence={{ score: 0.5, label: 'very_low' }} />,
    )
    expect(html).not.toContain('very_low')
    expect(html).toContain('Confidence')
  })

  it('states unavailable confidence instead of a blank, and stays silent when not applicable', () => {
    const absent = renderToStaticMarkup(
      <ProposalCard {...base} authority="owner_review" confidence={null} />,
    )
    expect(absent).toContain('Confidence unavailable')
    const notApplicable = renderToStaticMarkup(<ProposalCard {...base} authority="owner_review" />)
    expect(notApplicable).not.toContain('Confidence unavailable')
    expect(notApplicable).not.toContain('confidence ·')
  })
})

describe('EntityTable', () => {
  type Row = { id: string; name: string }
  const rows: Row[] = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
  const columns: EntityColumn<Row>[] = [
    { key: 'name', label: 'Name', sortKey: 'name', render: (r) => r.name },
    { key: 'plain', label: 'Plain', render: () => 'x' },
  ]
  const StubIcon = () => null
  const empty = { icon: StubIcon, title: 'Nothing here', description: 'Widen the range.' }
  const base = { columns, rowKey: (r: Row) => r.id, empty, sortKey: 'name', sortDir: 'asc' as const, onSort: () => {} }

  it('computes colSpan from the columns actually rendered, not a hand-kept constant', () => {
    // All three pages carried their own `const colCount = 3 + visibleDefs.length + 2` style
    // constant. A wrong one does not fail — it silently misaligns the empty and error rows.
    const html = renderToStaticMarkup(
      <EntityTable<Row> {...base} rows={[]}
        trailingColumns={[{ key: 't', label: 'T', render: () => 't' }]}
        onOpen={() => {}} />,
    )
    // 2 leading + 1 trailing + 1 chevron = 4. renderToStaticMarkup emits the JSX prop name.
    expect(html).toContain('colSpan="4"')
  })

  it('shows an evidenced empty state rather than a blank body', () => {
    const html = renderToStaticMarkup(<EntityTable<Row> {...base} rows={[]} />)
    expect(html).toContain('Nothing here')
    expect(html).toContain('Widen the range.')
  })

  it('keeps the four states distinct — loading is not empty, error is not empty', () => {
    const loading = renderToStaticMarkup(<EntityTable<Row> {...base} rows={[]} loading />)
    const errored = renderToStaticMarkup(<EntityTable<Row> {...base} rows={[]} error="Load failed" />)
    const emptied = renderToStaticMarkup(<EntityTable<Row> {...base} rows={[]} />)
    // A loading table must never claim there is nothing to show.
    expect(loading).not.toContain('Nothing here')
    expect(errored).not.toContain('Nothing here')
    expect(errored).toContain('Load failed')
    expect(emptied).toContain('Nothing here')
  })

  it('renders trailing columns after the leading ones', () => {
    const html = renderToStaticMarkup(
      <EntityTable<Row> {...base} rows={rows}
        trailingColumns={[{ key: 'diag', label: 'Diagnostic', render: () => 'D' }]} />,
    )
    expect(html.indexOf('Diagnostic')).toBeGreaterThan(html.indexOf('Name'))
  })

  it('makes only columns with a sortKey into sort controls', () => {
    const html = renderToStaticMarkup(<EntityTable<Row> {...base} rows={rows} />)
    expect(html).toContain('aria-sort="ascending"')   // Name is sorted
    expect(html).toContain('Sort by Name')
    expect(html).not.toContain('Sort by Plain')       // Plain has no sortKey
  })

  /**
   * THE TEST THIS SUITE WAS MISSING, and the reason an independent reviewer found 7 surviving
   * mutations against a suite its author scored 16/16.
   *
   * Every EntityTable test above renders WITHOUT a `metrics` prop — the one configuration no real
   * caller uses. So `metricDefs.length` was always 0, and the test named "computes colSpan from the
   * columns actually rendered" could not detect the defect it is named after: deleting
   * `metricDefs.length` from colCount left all 4352 tests green while the empty and error rows
   * under-spanned by 5-7 columns on all three pages.
   *
   * This renders the real shape — leading + metrics + trailing + chevron — and asserts
   * header-to-body column correspondence, which is the single property that kills that whole
   * family of mutation at once.
   */
  const metricDefs = [
    { key: 'spend', label: 'Spend', header: 'Spend', format: 'currency', align: 'right' },
    { key: 'clicks', label: 'Clicks', header: 'Clicks', format: 'number', align: 'right' },
  ] as unknown as Parameters<typeof EntityTable<Row>>[0]['metrics'] extends undefined ? never
    : NonNullable<Parameters<typeof EntityTable<Row>>[0]['metrics']>['defs']

  const full = {
    ...base,
    rows,
    trailingColumns: [{ key: 'diag', label: 'Diagnostic', render: () => 'DIAG' }],
    metrics: { defs: metricDefs, forRow: () => null, windowDays: 7, showBands: false },
    onOpen: () => {},
    openLabel: (r: Row) => `Open details for ${r.name}`,
    onRetry: () => {},
  }

  it('renders exactly one body cell per header cell, with metrics present', () => {
    const html = renderToStaticMarkup(<EntityTable<Row> {...full} />)
    const headerCells = (html.match(/<th[ >]/g) ?? []).length
    const firstRow = html.split('<tr class="group">')[1] ?? ''
    // The invariant is correspondence, not a magic number — hardcoding the count is the same
    // hand-kept-constant mistake this component was built to delete.
    expect(headerCells).toBeGreaterThan(4)
    expect((firstRow.match(/<td/g) ?? []).length).toBe(headerCells)
    expect(firstRow).toContain('DIAG')                        // trailing cell has CONTENT, not just a header
  })

  it('spans the empty state across every column, metrics included', () => {
    const withRows = renderToStaticMarkup(<EntityTable<Row> {...full} />)
    const headerCells = (withRows.match(/<th[ >]/g) ?? []).length
    const html = renderToStaticMarkup(<EntityTable<Row> {...full} rows={[]} />)
    // Derived from the rendered header, so dropping metricDefs.length from colCount fails here.
    expect(html).toContain(`colSpan="${headerCells}"`)
  })

  it('keeps 44px targets and a visible focus ring on the controls it OWNS', () => {
    // Rendered WITHOUT `metrics`. With it, MetricCells contributes its own `min-h-11 w-full` and
    // focus ring, so a whole-document assertion passes even after EntityTable's button loses both
    // — which is precisely how the original per-page `toContain('min-h-11')` was vacuous, satisfied
    // by unrelated filter buttons elsewhere on the page.
    const html = renderToStaticMarkup(
      <EntityTable<Row> {...base} rows={rows} onOpen={() => {}} openLabel={(r) => `Open details for ${r.name}`} />,
    )
    const sortButton = html.split('aria-label="Sort by Name')[1]?.split('</button>')[0] ?? ''
    expect(sortButton).toContain('min-h-11')                  // the sort header control
    expect(sortButton).toContain('focus-visible:ring-2')
    const chevron = html.split('aria-label="Open details for Alpha"')[1]?.split('</button>')[0] ?? ''
    expect(chevron).toContain('min-h-11 min-w-11')            // the row-open control
    expect(chevron).toContain('focus-visible:ring-2')
  })

  it('right-aligns the sort control, not just the cell', () => {
    // `text-right` on the <th> does nothing to a flex child. /performance/adsets has a column that
    // is both sortable and right-aligned, and it rendered label-left over right-aligned numbers.
    const html = renderToStaticMarkup(
      <EntityTable<Row> {...base} rows={rows}
        columns={[{ key: 'n', label: 'Budget', sortKey: 'n', align: 'right', render: (r) => r.name }]} />,
    )
    expect(html).toContain('justify-end')
  })

  it('renders a full-width loading skeleton, not a short one', () => {
    // The skeleton row must span the same columns as a real row, or the loading state visibly
    // jumps when data lands. Nothing asserted the cell count, so hardcoding it survived.
    const html = renderToStaticMarkup(<EntityTable<Row> {...full} loading />)
    const headerCells = (html.match(/<th[ >]/g) ?? []).length
    const firstSkeletonRow = html.split('<tbody>')[1]?.split('</tr>')[0] ?? ''
    expect((firstSkeletonRow.match(/<td/g) ?? []).length).toBe(headerCells)
  })

  it('offers a retry on the error state', () => {
    const html = renderToStaticMarkup(<EntityTable<Row> {...full} rows={[]} error="Load failed" />)
    expect(html).toMatch(/Retry|retry/)
  })
})

describe('primitives degrade instead of crashing or contradicting', () => {
  it('an unmapped authority renders the most restrictive tier rather than throwing', () => {
    // `authority` reaches ProposalCard unvalidated; the only guard is a CHECK constraint three
    // modules away. A bare map lookup threw a TypeError and white-screened /decisions.
    const html = renderToStaticMarkup(
      <ProposalCard title="t" summary="s" source="x" evidenceWindow={null}
        authority={'auto_execute' as never} />,
    )
    expect(html).toContain('For your judgement')
  })

  it('an unmapped measurement kind degrades to words, never a blank pill', () => {
    const html = renderToStaticMarkup(<DataQualityChip kind={'inferred' as never} />)
    expect(html).toContain('inferred')
    expect(html).not.toContain('undefined')   // color-mix(in srgb, undefined ...) is invalid CSS
  })

  it('coverage reconciles when days are both unsynced and undelivered', () => {
    // The pure cases (10/0, 0/10) were the only ones tested; the mixed case is the only one where
    // the branch matters, and it silently dropped six days.
    expect(renderToStaticMarkup(<DataQualityChip kind="measured"
      coverage={{ totalDays: 30, measuredDays: 20, noDeliveryDays: 6, notSyncedDays: 4 }} />))
      .toContain('20 of 30 days · 4 not synced · 6 without delivery')
  })

  it('names a gap that is neither a sync gap nor a delivery gap', () => {
    expect(renderToStaticMarkup(<DataQualityChip kind="measured"
      coverage={{ totalDays: 7, measuredDays: 3, noDeliveryDays: 0, notSyncedDays: 0 }} />))
      .toContain('3 of 7 days · 4 unaccounted')
  })

  it('states provenance, not method, for a source-reported figure', () => {
    // meta.native_reach and meta.native_frequency are Meta's own ESTIMATES tagged `measured`.
    // "Counted" asserted a method the source does not guarantee.
    expect(renderToStaticMarkup(<DataQualityChip kind="measured" />)).toContain('As reported')
    expect(renderToStaticMarkup(<DataQualityChip kind="measured" />)).not.toContain('Counted')
  })
})
