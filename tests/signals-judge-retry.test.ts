import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_API_ENV, anthropicMessage, anthropicText, jsonResponse, stubFetch, useAiEnv,
} from './helpers/ai-stub'

/**
 * A transient provider failure (timeout, 429, 5xx) is not a verdict about the item, so the item is
 * left unstored and judged again on a later run — at most SIGNALS_JUDGE_MAX_TRANSIENT_FAILURES times.
 * At the cap, and for refusals or unusable output, the item is stored unjudged as before.
 *
 * The database is an in-memory stand-in with the two tables this step writes, so several runs can be
 * chained the way the weekly cron chains them.
 */

const TITLE = 'Creative testing cadence for local studios'
const FEED = `<rss><channel><item><title>${TITLE}</title>`
  + `<link>https://example.org/post-1</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`

type Row = Record<string, unknown>
const db = vi.hoisted(() => ({ insights: [] as Row[], attempts: [] as Row[] }))

vi.mock('@/lib/signals/feed-fetch', () => ({
  fetchPublicHttps: vi.fn(async () => new Response(FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = []
      const rows = () => (table === 'expert_insights' ? db.insights : table === 'expert_insight_judge_attempts' ? db.attempts : [])
      const matching = () => rows().filter((row) => filters.every(([key, value]) => row[key] === value))
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return chain },
        order: () => Promise.resolve(table === 'expert_sources'
          ? { data: [{ id: 'src-1', ad_account_id: 'acct', name: 'Feed', url: 'https://example.org/feed', is_active: true, last_checked_at: null }], error: null }
          : { data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
        update: () => chain,
        insert: (row: Row) => { rows().push(row); return Promise.resolve({ error: null }) },
        upsert: (row: Row) => {
          const list = rows()
          const index = list.findIndex((existing) => existing.ad_account_id === row.ad_account_id && existing.title === row.title)
          if (index === -1) list.push(row)
          else list[index] = row
          return Promise.resolve({ error: null })
        },
        delete: () => ({
          eq: (key: string, value: unknown) => { filters.push([key, value]); return chain },
        }),
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'expert_insight_judge_attempts') {
            const keep = rows().filter((row) => !filters.every(([key, value]) => row[key] === value))
            db.attempts = keep
          }
          return Promise.resolve(resolve({ data: null, error: null }))
        },
      }
      return chain
    },
  }),
}))

const VERDICT = {
  applies: true,
  summary: 'Weekly creative refresh cadence.',
  why_it_applies: 'Creative fatigue is a constraint at low budgets.',
  applicable_area: 'creative',
  confidence: 'medium',
}

/** A provider error the SDK must not retry itself, so each run makes exactly one model request. */
function providerError(status: number): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'stub' } }), {
    status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
  })
}

beforeEach(() => {
  db.insights = []
  db.attempts = []
  useAiEnv({ ...CLAUDE_API_ENV })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('signals judge transient failures', () => {
  it('a 5xx leaves the item for the next run, which stores the real verdict', async () => {
    const model = stubFetch((_request, index) => (index === 0
      ? providerError(503)
      : jsonResponse(anthropicText(JSON.stringify(VERDICT)))))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    await runSignalsFetcher('acct')
    expect(db.insights).toEqual([])
    expect(db.attempts).toMatchObject([{ ad_account_id: 'acct', title: TITLE, transient_failures: 1, last_failure_kind: 'server' }])

    const second = await runSignalsFetcher('acct')
    expect(model.requests).toHaveLength(2)
    expect(second).toMatchObject({ analyzed: 1, applied: 1 })
    expect(db.insights).toHaveLength(1)
    expect(db.insights[0]).toMatchObject({ title: TITLE, applies_to_account: true, summary: VERDICT.summary })
    expect(db.attempts).toEqual([])
  })

  it('stops retrying at the cap: the last transient failure stores the item unjudged, then it is never asked again', async () => {
    const model = stubFetch(() => providerError(429))
    const { runSignalsFetcher, SIGNALS_JUDGE_MAX_TRANSIENT_FAILURES } = await import('@/lib/signals/fetcher')
    expect(SIGNALS_JUDGE_MAX_TRANSIENT_FAILURES).toBe(3)

    for (let run = 1; run < SIGNALS_JUDGE_MAX_TRANSIENT_FAILURES; run += 1) {
      await runSignalsFetcher('acct')
      expect(db.insights).toEqual([])
      expect(db.attempts).toMatchObject([{ transient_failures: run, last_failure_kind: 'rate_limit' }])
    }
    await runSignalsFetcher('acct')
    expect(db.insights).toHaveLength(1)
    expect(db.insights[0]).toMatchObject({ title: TITLE, applies_to_account: false, summary: TITLE })
    expect(db.attempts).toEqual([])

    await runSignalsFetcher('acct')
    expect(model.requests).toHaveLength(SIGNALS_JUDGE_MAX_TRANSIENT_FAILURES)
    expect(db.insights).toHaveLength(1)
  })

  it('a refusal stays terminal: stored unjudged on the first run, no retry record', async () => {
    const model = stubFetch(() => jsonResponse(anthropicMessage({
      content: [{ type: 'text', text: JSON.stringify(VERDICT) }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null, explanation: null },
    })))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    await runSignalsFetcher('acct')
    await runSignalsFetcher('acct')

    expect(model.requests).toHaveLength(1)
    expect(db.insights).toHaveLength(1)
    expect(db.insights[0]).toMatchObject({ applies_to_account: false, summary: TITLE })
    expect(db.attempts).toEqual([])
  })

  it('output that is not JSON stays terminal too', async () => {
    const model = stubFetch(() => jsonResponse(anthropicText('not json')))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    await runSignalsFetcher('acct')
    await runSignalsFetcher('acct')

    expect(model.requests).toHaveLength(1)
    expect(db.insights).toHaveLength(1)
    expect(db.attempts).toEqual([])
  })

  it('a connection failure (reset, DNS) leaves the item for the next run, bounded by the cap', async () => {
    const model = stubFetch((_request, index) => {
      if (index < 2) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
      return jsonResponse(anthropicText(JSON.stringify(VERDICT)))
    })
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    await runSignalsFetcher('acct')
    expect(db.insights).toEqual([])
    expect(db.attempts).toMatchObject([{ title: TITLE, transient_failures: 1, last_failure_kind: 'network' }])

    const second = await runSignalsFetcher('acct')
    expect(model.requests.length).toBeGreaterThanOrEqual(3)
    expect(second).toMatchObject({ analyzed: 1, applied: 1 })
    expect(db.insights[0]).toMatchObject({ title: TITLE, applies_to_account: true })
    expect(db.attempts).toEqual([])
  })

  it('a client error (400) is not transient', async () => {
    stubFetch(() => providerError(400))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')

    await runSignalsFetcher('acct')

    expect(db.insights).toHaveLength(1)
    expect(db.attempts).toEqual([])
  })
})

describe('signals judge business context', () => {
  const promptOf = (body: Record<string, unknown> | null) => JSON.stringify([body?.system, body?.messages])

  it('states no example-profile fact when the business profile is unconfigured', async () => {
    const model = stubFetch(() => jsonResponse(anthropicText(JSON.stringify(VERDICT))))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')
    await runSignalsFetcher('acct')
    const prompt = promptOf(model.requests[0].body)
    expect(prompt).not.toMatch(/Springfield|daylight|photo studio|hyper-local|booking business/i)
    expect(prompt).toContain('the business, a business advertising on Meta')
  })

  it('states the configured business as configured (control)', async () => {
    vi.resetModules()
    vi.stubEnv('BUSINESS_PROFILE_JSON', JSON.stringify({ name: 'Northwind Bikes', description: 'bicycle repair shop', city: 'Lyon' }))
    const model = stubFetch(() => jsonResponse(anthropicText(JSON.stringify(VERDICT))))
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')
    await runSignalsFetcher('acct')
    expect(promptOf(model.requests[0].body)).toContain('Northwind Bikes, bicycle repair shop in Lyon')
    vi.resetModules()
  })
})

describe('transient AI failure classification', () => {
  it('treats timeouts, 429, 5xx and network failures as transient and everything else as terminal', async () => {
    const { transientAiFailureKind } = await import('@/lib/signals/judge-attempts')
    const ai = await import('@/lib/ai')
    const { OperationTimeoutError } = await import('@/lib/cron/time-budget')

    expect(transientAiFailureKind(new ai.AiTimeoutError())).toBe('timeout')
    expect(transientAiFailureKind(new OperationTimeoutError('signals judge', 20_000))).toBe('timeout')
    expect(transientAiFailureKind(new ai.AiProviderError('rate_limit', 429))).toBe('rate_limit')
    expect(transientAiFailureKind(new ai.AiProviderError('server', 503))).toBe('server')
    // A transport failure with no HTTP status (connection reset, DNS, socket closed) says nothing about
    // the item either: transient, bounded by the same cap.
    expect(transientAiFailureKind(new ai.AiProviderError('network', null))).toBe('network')
    for (const terminal of [
      new ai.AiRefusalError(null), new ai.AiInvalidOutputError(), new ai.AiMaxTokensError(), new ai.AiIncompleteError(null),
      new ai.AiProviderError('bad_request', 400), new ai.AiProviderError('auth', 401), new ai.AiProviderError('not_found', 404),
      new ai.AiProviderError('invalid_response', null), new ai.AiDisabledError('off'),
      new Error('signals judge timed out after 20000ms'), 'timeout',
    ]) {
      expect(transientAiFailureKind(terminal), String(terminal)).toBeNull()
    }
  })

  it('withTimeout rejects with an OperationTimeoutError that keeps its message', async () => {
    vi.useFakeTimers()
    const { withTimeout, OperationTimeoutError } = await import('@/lib/cron/time-budget')
    const pending = withTimeout(new Promise(() => undefined), 50, 'probe').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(51)
    const error = await pending
    expect(error).toBeInstanceOf(OperationTimeoutError)
    expect((error as Error).message).toBe('probe timed out after 50ms')
  })
})
