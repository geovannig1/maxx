import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_API_ENV, anthropicMessage, anthropicText, jsonResponse, stubFetch, trapFetch, useAiEnv,
} from './helpers/ai-stub'

/**
 * The expert-signals relevance judge against a STUB provider. Feeds come from a mocked public-https
 * fetcher, so the only `fetch` left is the model call.
 */

const state = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  dbCalls: 0,
  feedCalls: 0,
}))

const FEED = `<rss><channel><item><title>Creative testing cadence for local studios</title>`
  + `<link>https://example.org/post-1</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`

vi.mock('@/lib/signals/feed-fetch', () => ({
  fetchPublicHttps: vi.fn(async () => {
    state.feedCalls += 1
    return new Response(FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => {
    state.dbCalls += 1
    return {
      from: (table: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => Promise.resolve(table === 'expert_sources'
            ? { data: [{ id: 'src-1', ad_account_id: 'acct', name: 'Feed', url: 'https://example.org/feed', is_active: true, last_checked_at: null }], error: null }
            : { data: [], error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          update: () => chain,
          insert: (row: Record<string, unknown>) => { state.inserts.push(row); return Promise.resolve({ error: null }) },
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: null })),
        }
        return chain
      },
    }
  },
}))

const VERDICT = {
  applies: true,
  summary: 'Weekly creative refresh cadence.',
  why_it_applies: 'Creative fatigue is a constraint at low budgets.',
  applicable_area: 'creative',
  confidence: 'medium',
}

beforeEach(() => {
  state.inserts = []
  state.dbCalls = 0
  state.feedCalls = 0
  useAiEnv({ ...CLAUDE_API_ENV })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('signals relevance judge', () => {
  it('asks for a structured verdict at low effort and stores the validated fields', async () => {
    const model = stubFetch(() => jsonResponse(anthropicText(JSON.stringify(VERDICT))))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    const result = await runSignalsFetcher('acct')

    expect(result).toMatchObject({ fetched: 1, analyzed: 1, applied: 1 })
    expect(model.requests).toHaveLength(1)
    const outputConfig = model.requests[0].body!.output_config as { effort: string; format: { type: string; schema: { required: string[] } } }
    expect(outputConfig.effort).toBe('low')
    expect(outputConfig.format.type).toBe('json_schema')
    expect([...outputConfig.format.schema.required].sort()).toEqual(['applicable_area', 'applies', 'confidence', 'summary', 'why_it_applies'])
    expect(state.inserts[0]).toMatchObject({
      applies_to_account: true, summary: VERDICT.summary, applicable_area: 'creative', confidence: 'medium',
      suggested_action: null,
    })
  })

  it('a refusal is not a verdict: the item is stored unjudged, never with the refused text', async () => {
    stubFetch(() => jsonResponse(anthropicMessage({
      content: [{ type: 'text', text: JSON.stringify({ ...VERDICT, summary: 'REFUSED TEXT' }) }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null, explanation: null },
    })))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    const result = await runSignalsFetcher('acct')

    expect(result).toMatchObject({ analyzed: 1, applied: 0 })
    expect(state.inserts[0]).toMatchObject({ applies_to_account: false, summary: 'Creative testing cadence for local studios' })
    expect(JSON.stringify(state.inserts)).not.toContain('REFUSED TEXT')
  })

  it('a max-token stop is not a verdict either', async () => {
    stubFetch(() => jsonResponse(anthropicText(JSON.stringify(VERDICT), 'max_tokens')))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')
    const result = await runSignalsFetcher('acct')
    expect(result).toMatchObject({ applied: 0 })
    expect(state.inserts[0]).toMatchObject({ applies_to_account: false })
  })

  it('with AI off it is skipped whole: no feed fetch, no database read, no model request', async () => {
    useAiEnv({ AI_PROVIDER: 'none' })
    const trap = trapFetch()
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    const result = await runSignalsFetcher('acct')

    expect(result).toEqual({ fetched: 0, analyzed: 0, applied: 0, skipped: 'ai_off' })
    expect(trap.requests).toHaveLength(0)
    expect(state.feedCalls).toBe(0)
    expect(state.dbCalls).toBe(0)
  })
})
