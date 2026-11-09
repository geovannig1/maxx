import { describe, expect, it } from 'vitest'
import { filterReviewedOutcomeMemories } from '@/lib/memory/agent-memory'

describe('agent outcome-memory review gate', () => {
  const rows = [
    { id: 'm1', source_type: 'recommendation_outcome', source_id: 'flag-pending' },
    { id: 'm2', source_type: 'recommendation_outcome', source_id: 'flag-approved' },
    { id: 'm3', source_type: 'manual', source_id: null },
  ]

  it('withholds auto-scored outcome memories until their source outcome is owner-approved', () => {
    expect(filterReviewedOutcomeMemories(rows, new Set(['flag-approved'])).map((row) => row.id))
      .toEqual(['m2', 'm3'])
  })

  it('fails closed when no approved outcome lineage is available', () => {
    expect(filterReviewedOutcomeMemories(rows, new Set()).map((row) => row.id)).toEqual(['m3'])
  })

  it('fails legacy outcome memories closed even when source_type is absent', () => {
    const legacyRows = [
      { id: 'legacy-unreviewed', memory_type: 'outcome', source_type: null, source_id: null },
      { id: 'legacy-approved', memory_type: 'outcome', source_type: null, source_id: 'flag-approved' },
      { id: 'context', memory_type: 'context', source_type: null, source_id: null },
    ]

    expect(filterReviewedOutcomeMemories(legacyRows, new Set(['flag-approved'])).map((row) => row.id))
      .toEqual(['legacy-approved', 'context'])
  })
})
