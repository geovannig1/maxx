import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * getRecommendationsByGeneration — per-row lineage quarantine, not all-or-nothing.
 *
 * The reader used to throw "MetricClaim lineage is incomplete; report recommendations were withheld"
 * whenever `verified.size !== rows.length`. Two things were wrong with that.
 *
 * 1. It contradicted the publisher. buildRecommendationMetricClaimBindings deliberately returns an
 *    EMPTY lineage array when a source clock, entity, window or finite Meta value is absent — its own
 *    comment says the row is then quarantined. Claim-less rows are a designed outcome, not corruption.
 *    The open-recommendation reader in the same file already treats them per row, filtering and
 *    recording a `metric_claim_lineage_invalid` reason with an affected count.
 *
 * 2. The verdict depended on a display limit. The query applied `.limit(limit)` BEFORE the lineage
 *    check, and the report calls it with limit=8, so whether the read threw depended on which rows
 *    sorted into the first eight. The open-recommendation reader carries an explicit comment warning
 *    against exactly that ordering.
 *
 * Consequence: when a minority of published recommendations had no lineage, all of them were
 * withheld and the daily report committed with zero recommendations.
 *
 * The genuine fail-stop — an authority READ error, where a failure must not look like an empty
 * generation — is separate and is retained.
 */

const store = readFileSync(join(process.cwd(), 'src/lib/recommendations/store.ts'), 'utf8')

function reportReaderBody(): string {
  const start = store.indexOf('export async function getRecommendationsByGeneration')
  expect(start).toBeGreaterThan(-1)
  // The function ends at the next top-level export.
  const rest = store.slice(start + 1)
  const end = rest.indexOf('\nexport ')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('report recommendation reader quarantines per row', () => {
  const body = reportReaderBody()

  it('no longer fails the whole read merely because the verified COUNT is short', () => {
    expect(body).not.toMatch(/verifiedMetricClaimRecommendations\.size !== \w+\.length/)
  })

  it('STILL fail-stops on a row that asserts lineage which does not resolve', () => {
    // This is corruption or tampering: the row claims evidence that is not there. A durable report
    // must never be committed over it. tests/recommendation-store-live-filter.test.ts pins the
    // behaviour end-to-end; this pins the shape of the condition that produces it.
    expect(body).toContain('assertsUnresolvedLineage')
    expect(body).toContain('MetricClaim lineage is incomplete')
    expect(body).toMatch(/metric_claim_ids\.length : 0\) > 0/)
  })

  it('keeps the fail-stop for a genuine authority read failure', () => {
    // A read error must never be indistinguishable from an empty generation.
    expect(body).toContain('MetricClaim lineage read failed')
    expect(body).toContain('throw new Error')
  })

  it('filters to lineage-verified rows and applies the display limit AFTER that filter', () => {
    const filterAt = body.indexOf('.filter((row) => verifiedMetricClaimRecommendations.has(row.id))')
    const sliceAt = body.indexOf('.slice(0, Math.max(0, limit))')
    expect(filterAt).toBeGreaterThan(-1)
    expect(sliceAt).toBeGreaterThan(filterAt)
    // The query itself must not pre-truncate to `limit`, or lineage is judged on a display slice.
    expect(body).not.toContain('.limit(limit)')
    expect(body).toContain('.limit(GENERATION_LINEAGE_SCAN_CAP)')
  })

  it('announces what it dropped instead of silently shrinking the report', () => {
    expect(body).toContain('console.warn')
    expect(body).toMatch(/quarantined/i)
  })

  it('reads action decisions for the rows it will actually return', () => {
    // Reading them for the pre-filter set would fetch authority for rows the report never shows.
    const sliceAt = body.indexOf('.slice(0, Math.max(0, limit))')
    const decisionsAt = body.indexOf('readActionDecisionsBySource')
    expect(decisionsAt).toBeGreaterThan(sliceAt)
  })
})
