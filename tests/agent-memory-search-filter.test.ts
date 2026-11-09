import { beforeEach, describe, expect, it, vi } from 'vitest'

// searchMemory interpolates the caller's query into a PostgREST `or=(...)` filter. A query carrying
// `,` `(` `)` would otherwise append its own clauses (e.g. `id.not.is.null`) to that filter.
const state = vi.hoisted(() => ({ orFilters: [] as string[] }))

function recordingQuery() {
  const builder: Record<string, unknown> = {}
  for (const method of ['from', 'select', 'eq', 'gte', 'contains', 'order', 'limit', 'in', 'update']) {
    builder[method] = vi.fn(() => builder)
  }
  builder.or = vi.fn((filter: string) => {
    state.orFilters.push(filter)
    return builder
  })
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null })
  return builder
}

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => recordingQuery() }))

/** Split a PostgREST logic-tree body on top-level commas, as the server does. */
function topLevelClauses(filter: string): string[] {
  const clauses: string[] = []
  let depth = 0
  let quoted = false
  let current = ''
  for (const char of filter) {
    if (char === '"') quoted = !quoted
    if (!quoted && char === '(') depth++
    if (!quoted && char === ')') depth--
    if (!quoted && depth === 0 && char === ',') {
      clauses.push(current)
      current = ''
      continue
    }
    current += char
  }
  clauses.push(current)
  return clauses
}

describe('searchMemory filter construction', () => {
  beforeEach(() => {
    state.orFilters.length = 0
  })

  it('cannot add a filter clause through the search term', async () => {
    const { searchMemory } = await import('@/lib/memory/agent-memory')
    for (const query of ['x%,id.not.is.null', 'x),and(id.not.is.null', 'a"b\\c*d(e)f']) {
      state.orFilters.length = 0
      await searchMemory({ query })
      expect(state.orFilters).toHaveLength(1)
      const clauses = topLevelClauses(state.orFilters[0])
      expect(clauses).toHaveLength(2)
      expect(clauses[0]).toMatch(/^context\.ilike\.%[^%*,()"\\]*%$/)
      expect(clauses[1]).toMatch(/^content\.ilike\.%[^%*,()"\\]*%$/)
      expect(state.orFilters[0]).not.toMatch(/[,(]id\.not/)
    }
  })

  it('control: a normal word still searches both columns', async () => {
    const { searchMemory } = await import('@/lib/memory/agent-memory')
    await searchMemory({ query: 'warm retargeting' })
    expect(state.orFilters).toEqual(['context.ilike.%warm retargeting%,content.ilike.%warm retargeting%'])
  })
})
