import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionQueue } from '@/components/decisions/DecisionQueue'

const root = process.cwd()
const source = (path: string) => readFileSync(join(root, path), 'utf8')

describe('release UI accessibility guardrails', () => {
  it('uses real controls for sortable tables and exposes the active direction', () => {
    const metricHeaders = source('src/components/metrics/MetricCells.tsx')
    expect(metricHeaders).toContain("aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}")
    expect(metricHeaders).toContain('<button')
    expect(metricHeaders).toContain('aria-label={`Sort by ${d.label}')

    // Pages that still own their table markup must each carry the guarantee.
    for (const path of [
      'src/app/(dashboard)/conversions/page.tsx',
    ]) {
      const table = source(path)
      expect(table).toContain("aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}")
      expect(table).toContain('<button')
    }

    for (const path of [
      'src/app/(dashboard)/performance/segments/page.tsx',
    ]) {
      const table = source(path)
      expect(table).toMatch(/aria-sort=\{sortKey === '(campaign_name|label)' \? \(sortDir === 'asc' \? 'ascending' : 'descending'\) : 'none'\}/)
      expect(table).toContain('<button')
    }

    // campaigns/adsets/ads now render through EntityTable. The guarantee moved with them and is
    // made ONCE rather than restated per page — a new entity page inherits it instead of having to
    // remember it. Assert it at the shell, and assert those pages actually use the shell.
    const shell = source('src/components/ui/EntityTable.tsx')
    expect(shell).toContain('aria-sort={col.sortKey')
    expect(shell).toContain("(active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none')")
    expect(shell).toContain('<button')
    expect(shell).toContain('aria-label={`Sort by ${col.label}')
    for (const path of [
      'src/app/(dashboard)/performance/campaigns/page.tsx',
      'src/app/(dashboard)/performance/adsets/page.tsx',
      'src/app/(dashboard)/performance/ads/page.tsx',
    ]) {
      expect(source(path)).toContain('<EntityTable')
    }
  })

  it('provides 44px semantic detail controls for every clickable performance row', () => {
    // Each page must still supply the accessible NAME for its own rows — that is entity-specific
    // and cannot be inherited. It now travels as EntityTable's `openLabel`.
    for (const path of [
      'src/app/(dashboard)/performance/campaigns/page.tsx',
      'src/app/(dashboard)/performance/adsets/page.tsx',
      'src/app/(dashboard)/performance/ads/page.tsx',
    ]) {
      const table = source(path)
      expect(table).toMatch(/aria-label=\{`Open details for \$\{|openLabel=\{\([a-z]+\) => `Open details for \$\{/)
      // `openLabel` NAMES the control; `onOpen` is what RENDERS it. Asserting only the name meant
      // deleting onOpen removed the row-open chevron from a page entirely — no control, no keyboard
      // target, no slide panel — with this accessibility suite still green.
      expect(table).toMatch(/onOpen=\{/)
      expect(table).not.toContain('className="clickable group"')
    }
    // The 44px control itself is now rendered once, by the shell, and wired to that name.
    const shell = source('src/components/ui/EntityTable.tsx')
    expect(shell).toContain('min-h-11 min-w-11')
    expect(shell).toContain("aria-label={openLabel ? openLabel(row) : 'Open details'}")
  })

  it('keeps Decisions as the sole operational queue and routes the legacy Inbox there', () => {
    const inbox = source('src/app/(dashboard)/inbox/page.tsx')
    expect(inbox).toContain("redirect('/decisions?view=tracking_repair&legacy=inbox')")
    expect(inbox).not.toContain('InboxClient')
  })

  it('names the source of a proposal in the owner\'s words, not the queue enum', () => {
    // ProposalCard documents `source` as "already in owner-facing words"; this file passed the raw
    // union straight through, so every card's eyebrow read "recommendation" and one read "outcome".
    const queue = source('src/components/decisions/DecisionQueue.tsx')
    expect(queue).not.toMatch(/source=\{item\.source\}/)
    expect(queue).toMatch(/SOURCE_LABEL\[item\.source\]/)
    // Totality is enforced by TypeScript (Record<union, string>); this guards the render path.
    expect(queue).toContain('const SOURCE_LABEL')
  })

  it('connects decision tabs and the date popover to their controlled content', () => {
    const queue = source('src/components/decisions/DecisionQueue.tsx')
    expect(queue).toContain('aria-controls={`decision-panel-${key}`}')
    const normal = renderToStaticMarkup(createElement(DecisionQueue, { items: [], initialView: 'needs_review' }))
    expect(normal).toContain('id="decision-panel-needs_review" role="tabpanel" aria-labelledby="decision-tab-needs_review"')
    const alerts = renderToStaticMarkup(createElement(DecisionQueue, { items: [], initialView: 'needs_review', filter: 'unresolved_critical_alerts' }))
    expect(alerts).toContain('role="region" aria-label="Unresolved critical alerts"')
    expect(alerts).not.toContain('role="tablist"')
    expect(alerts).not.toContain('role="tabpanel"')
    expect(queue).toContain("event.key === 'ArrowRight'")

    const dateRange = source('src/components/ui/DateRangeControl.tsx')
    expect(dateRange).toContain('aria-controls="date-range-popover"')
    expect(dateRange).toContain('id="date-range-popover"')
    expect(dateRange).toContain('aria-labelledby="date-range-title"')
  })

  it('uses the theme-aware foreground token on primary CTAs and avoids duplicated desktop date controls', () => {
    const errorBoundary = source('src/app/(dashboard)/error.tsx')
    expect(errorBoundary).toContain("color: 'var(--on-accent)'")
    expect(errorBoundary).not.toContain('text-white')

    for (const path of [
      'src/components/performance/PerformanceOverview.tsx',
      'src/components/performance/CreativePerformance.tsx',
      'src/app/(dashboard)/performance/campaigns/page.tsx',
      'src/app/(dashboard)/performance/adsets/page.tsx',
      'src/app/(dashboard)/performance/ads/page.tsx',
      'src/app/(dashboard)/performance/segments/page.tsx',
    ]) {
      expect(source(path)).toContain('className="md:hidden"')
    }
  })
})
