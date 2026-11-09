import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LineageNotice } from '@/components/report/LineageNotice'
import type { RecLineageStatus } from '@/lib/flags/generations'

// Report lineage — OUTPUT-level proof that the report page lineage surface renders ALL FIVE states
// deterministically and distinctly (replaces regex source-pins; the same shared copy backs the API and
// MCP consumers). Static server render — the component is pure/presentational.

const status = (state: RecLineageStatus['state'], committedAt: string | null = '2026-07-18T00:00:00Z'): RecLineageStatus =>
  ({ state, committedAt, parentFlagGeneration: null })

const render = (s: RecLineageStatus) => renderToStaticMarkup(<LineageNotice status={s} />)

describe('LineageNotice — five visible, distinct states', () => {
  it('current → quiet caption (explicitly visible, not just absence)', () => {
    const html = render(status('current'))
    expect(html).toContain('data-lineage="current"')
    expect(html).toContain('Recommendation snapshot: current')
  })

  it('no_snapshot → deterministic shared copy (never LLM prose)', () => {
    const html = render(status('no_snapshot', null))
    expect(html).toContain('data-lineage="no_snapshot"')
    expect(html).toContain('No committed recommendation snapshot is available for this date.')
  })

  it('last_known_complete → warning banner with the as-of timestamp', () => {
    const html = render(status('last_known_complete'))
    expect(html).toContain('data-lineage="last_known_complete"')
    expect(html).toMatch(/Last-known-complete recommendations \(as of 2026-07-18T00:00:00Z\)/)
  })

  it('unknown → "could not be verified" (never presented as current)', () => {
    const html = render(status('unknown'))
    expect(html).toContain('data-lineage="unknown"')
    expect(html).toMatch(/could not be verified/i)
    expect(html).not.toMatch(/snapshot: current/)
  })

  it('rolled_back → warning banner: historical, do not act — never disguised as staleness', () => {
    const html = render(status('rolled_back'))
    expect(html).toContain('data-lineage="rolled_back"')
    expect(html).toMatch(/rolled back/i)
    expect(html).toMatch(/do not act/i)
    expect(html).not.toMatch(/newer flag run/i) // the last_known_complete copy must NOT appear
  })

  it('all five render distinct markers (no two states collapse)', () => {
    const markers = (['current', 'no_snapshot', 'last_known_complete', 'rolled_back', 'unknown'] as const)
      .map((s) => render(status(s)))
    expect(new Set(markers).size).toBe(5)
  })
})
