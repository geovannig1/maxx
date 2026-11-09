import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Regression: trend-detector selected competitor_sources.page_name — a column that does not exist (the
// schema column is `name`). Supabase returns undefined for a missing column, so every competitor name
// resolved to undefined/'Unknown' in format trends and longevity accelerators. This locks the correct
// column and the name mapping.

type Call = [string, ...unknown[]]

function makeDb(results: Record<string, { data: unknown; error?: unknown }>) {
  const calls: Call[] = []
  let table = ''
  const builder: Record<string, unknown> = {
    from(t: string) { table = t; calls.push(['from', t]); return builder },
    select(c: string) { calls.push(['select', table, c]); return builder },
    eq(col: string, v: unknown) { calls.push(['eq', table, col, v]); return builder },
    not(col: string, op: string, v: unknown) { calls.push(['not', table, col, op, v]); return builder },
    in(col: string, v: unknown) { calls.push(['in', table, col, v]); return builder },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(results[table] ?? { data: null, error: null }).then(resolve, reject)
    },
  }
  return { client: builder, calls }
}

async function loadDetector(results: Record<string, { data: unknown; error?: unknown }>) {
  const { client, calls } = makeDb(results)
  vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => client }))
  // Guard: no LLM call should happen (non-emerging formats), but mock it fail-safe.
  vi.doMock('@/lib/ai', () => ({
    generateText: vi.fn(async () => ({ text: 'x.' })), generateStructured: vi.fn(), completeTurn: vi.fn(),
  }))
  const mod = await import('@/lib/competitors/trend-detector')
  return { detectFormatTrends: mod.detectFormatTrends, calls }
}

describe('detectFormatTrends — competitor name column', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@/lib/supabase/admin'); vi.doUnmock('@/lib/ai') })

  it('selects `name` (not the nonexistent page_name) and maps the competitor name through', async () => {
    const { detectFormatTrends, calls } = await loadDetector({
      competitor_ads: {
        data: [
          {
            id: 'ad-1',
            competitor_id: 'comp-1',
            ad_creative_bodies: ['Rent our studio'],
            ai_analysis: { format_guess: 'static image' },
            ad_delivery_start_time: '2020-01-01',
            created_at: '2020-01-01',
          },
        ],
        error: null,
      },
      competitor_sources: { data: [{ id: 'comp-1', name: 'Example Rival Studios' }] },
    })

    const trends = await detectFormatTrends('acct-1')

    // the source lookup must ask for `name`, never `page_name`
    const sourceSelect = calls.find((c) => c[0] === 'select' && c[1] === 'competitor_sources')
    expect(sourceSelect?.[2]).toBe('id, name')
    expect(calls).toContainEqual(['eq', 'competitor_sources', 'ad_account_id', 'acct-1'])
    expect(calls.some((c) => c[0] === 'select' && String(c[2]).includes('page_name'))).toBe(false)

    // and the name resolves onto the trend (not undefined/Unknown)
    expect(trends[0].example_competitor).toBe('Example Rival Studios')
  })
})
