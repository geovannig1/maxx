import { beforeEach, describe, expect, it, vi } from 'vitest'

// Security review fix 5: literalSearchTerm strips `,()"\%*`, so a query made only of those characters
// became '' and the filter `context.ilike.%%` matched EVERY memory row. An empty term returns nothing.
const state = vi.hoisted(() => ({ orFilters: [] as string[], fromCalls: 0 }))

const row = {
  id: 'm1', memory_type: 'insight', context: 'warm retargeting', content: 'frequency capped at 3',
  tags: [], importance: 5, source_type: null, source_id: null, created_at: '2026-11-01T00:00:00Z',
}

function recordingQuery() {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'gte', 'contains', 'order', 'limit', 'in', 'update']) {
    builder[method] = vi.fn(() => builder)
  }
  builder.from = vi.fn(() => { state.fromCalls++; return builder })
  builder.or = vi.fn((filter: string) => { state.orFilters.push(filter); return builder })
  // Stands in for a database that matches every row when given an empty ilike pattern.
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [row], error: null })
  return builder
}

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => recordingQuery() }))

describe('searchMemory with a term that sanitises to empty', () => {
  beforeEach(() => {
    state.orFilters.length = 0
    state.fromCalls = 0
  })

  it.each(['(', '   ', '%%', '",()\\*'])('returns no results and sends no filter for %j', async (query) => {
    const { searchMemory } = await import('@/lib/memory/agent-memory')
    expect(await searchMemory({ query })).toEqual([])
    expect(state.orFilters).toEqual([])
    expect(state.orFilters.some((filter) => filter.includes('%%'))).toBe(false)
  })

  it('control: a real term still searches and returns matches', async () => {
    const { searchMemory } = await import('@/lib/memory/agent-memory')
    const results = await searchMemory({ query: '(warm)' })
    expect(state.orFilters).toEqual(['context.ilike.%warm%,content.ilike.%warm%'])
    expect(results.map((result) => result.id)).toEqual(['m1'])
  })
})
