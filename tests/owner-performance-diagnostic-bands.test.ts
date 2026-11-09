import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('owner performance tables remain evidence-only without proven target provenance', () => {
  // campaigns/adsets/ads render their metric cells through EntityTable, so they declare
  // `showBands: false` on its metrics prop rather than on MetricBodyCells directly. segments
  // still renders MetricBodyCells itself. Either form satisfies the same invariant: no
  // provisional good/bad bands on an owner performance table.
  it.each([
    'src/app/(dashboard)/performance/campaigns/page.tsx',
    'src/app/(dashboard)/performance/adsets/page.tsx',
    'src/app/(dashboard)/performance/ads/page.tsx',
    'src/app/(dashboard)/performance/segments/page.tsx',
  ])('%s renders raw metrics without provisional good/bad bands', (path) => {
    const source = read(path)
    // The bare `showBands:\s*false` alternation matched anywhere in the file — including a comment.
    // `showBands: true, // invariant: showBands: false` passed it, with the full suite green. Anchor
    // the positive to the metrics object literal, and forbid the violation itself.
    expect(source).toMatch(/<MetricBodyCells[^>]*showBands=\{false\}|metrics=\{\{[\s\S]{0,400}?showBands:\s*false/)
    expect(source).not.toMatch(/showBands[=:]\s*\{?\s*true/)
  })

  // STRONGER than the per-page check above: the shared shell must DEFAULT to no bands, so a page
  // that forgets the flag still cannot ship a provisional verdict. Before the shell existed this
  // guarantee had to be restated on every page, and a new page could silently omit it.
  it('EntityTable defaults to no bands when a caller omits the flag', () => {
    expect(read('src/components/ui/EntityTable.tsx'))
      .toMatch(/showBands=\{metrics\.showBands \?\? false\}/)
  })

  it.each([
    'src/app/(dashboard)/performance/campaigns/page.tsx',
    'src/app/(dashboard)/performance/adsets/page.tsx',
  ])('%s does not render fixed CPL/frequency target verdicts', (path) => {
    const source = read(path)
    expect(source).not.toMatch(/\bRangeBadge\b|\bCpaBar\b|\bgetTargetRange\b/)
    expect(source).not.toMatch(/Under target|Near limit|Over limit|Excellent|Critical\b/)
  })
})
