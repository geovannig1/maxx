import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_API_ENV, anthropicMessage, anthropicText, jsonResponse, stubFetch, trapFetch, useAiEnv,
} from './helpers/ai-stub'

// Security review fix 3: the strict schema rejected harmless case/spacing variants, and a rejected ad
// kept ai_analysis = null, so every cron run re-sent the same failures to the model (unordered, no
// failure marker). Variants are normalised before validation; a final validation failure is stored as
// a marker so the ad is not reselected; transient provider failures still retry.
//
// The model is a STUB provider at the transport level: the real AI gateway and Anthropic adapter
// run, and each reply below is the text of a Messages API response. An Error reply is an HTTP 500.
const state = vi.hoisted(() => ({
  replies: [] as Array<string | Error | Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  orders: [] as Array<{ column: string; ascending: boolean }>,
}))

function stubModel() {
  return stubFetch(() => {
    // An outage persists across the SDK's one retry, so an Error reply is not consumed.
    if (state.replies[0] instanceof Error) {
      return jsonResponse({ type: 'error', error: { type: 'api_error', message: state.replies[0].message } }, 500)
    }
    const next = state.replies.shift() ?? ''
    return jsonResponse(typeof next === 'string' ? anthropicText(next) : next)
  })
}

/** In-memory competitor_sources/competitor_ads with the filters analyzeUnprocessedAds uses. */
function fakeDb() {
  return {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = []
      const sorts: Array<{ column: string; ascending: boolean }> = []
      let max = Infinity
      let patch: Record<string, unknown> | null = null
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return chain },
        in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return chain },
        is: (column: string, value: null) => { filters.push((row) => (row[column] ?? null) === value); return chain },
        order: (column: string, options: { ascending: boolean }) => {
          sorts.push({ column, ascending: options.ascending })
          state.orders.push({ column, ascending: options.ascending })
          return chain
        },
        limit: (n: number) => { max = n; return chain },
        update: (value: Record<string, unknown>) => { patch = value; return chain },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'competitor_sources') return Promise.resolve(resolve({ data: [{ id: 'source-1' }], error: null }))
          const matched = state.rows.filter((row) => filters.every((filter) => filter(row)))
          if (patch) {
            for (const row of matched) Object.assign(row, patch)
            return Promise.resolve(resolve({ data: null, error: null }))
          }
          const sorted = [...matched].sort((a, b) => {
            for (const { column, ascending } of sorts) {
              const left = String(a[column]); const right = String(b[column])
              if (left !== right) return (left < right ? -1 : 1) * (ascending ? 1 : -1)
            }
            return 0
          })
          return Promise.resolve(resolve({ data: sorted.slice(0, max), error: null }))
        },
      }
      return chain
    },
  }
}

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => fakeDb() }))

const valid = {
  angle: 'First-session discount',
  hook_type: 'bold claim',
  format_guess: 'static image',
  has_price: true,
  has_social_proof: false,
  cta_type: 'Book Now',
  tone: 'urgent',
  why_it_might_be_working: 'Hypothesis: a concrete discount may lower the first-booking barrier.',
  suggested_test_for_our_business: 'Test a first-visit offer against the current hook.',
  what_not_to_copy: 'Unverifiable scarcity claims.',
  evidence_basis: 'observed',
  inference_confidence: 'medium',
  why_it_may_not_apply: 'Different price point.',
  brand_safety_note: 'none',
}

function ad(id: string, createdAt: string) {
  return { id, competitor_id: 'source-1', ai_analysis: null, created_at: createdAt, ad_creative_bodies: ['Book today'] }
}

let model: ReturnType<typeof stubModel>

beforeEach(() => {
  state.replies = []
  state.rows = []
  state.orders = []
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  useAiEnv({ ...CLAUDE_API_ENV })
  model = stubModel()
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('analyzeCompetitorAd normalises harmless variants', () => {
  it('accepts case and spacing variants of enum and boolean strings', async () => {
    state.replies = [JSON.stringify({
      ...valid,
      evidence_basis: ' Observed ',
      inference_confidence: 'MEDIUM',
      has_price: ' True',
      has_social_proof: 'false ',
    })]
    const { analyzeCompetitorAd } = await import('@/lib/competitors/analyze-ad')
    expect(await analyzeCompetitorAd({})).toEqual(valid)
  })

  it('control: an out-of-vocabulary value is still rejected after normalising', async () => {
    state.replies = [JSON.stringify({ ...valid, inference_confidence: ' Certain ' })]
    const { analyzeCompetitorAd } = await import('@/lib/competitors/analyze-ad')
    expect(await analyzeCompetitorAd({})).toBeNull()
  })
})

describe('analyzeUnprocessedAds', () => {
  it('stores a failure marker for unusable model output and does not reselect it', async () => {
    state.rows = [ad('garbage', '2026-11-01T00:00:00Z')]
    state.replies = ['this is not json at all']
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    expect(await analyzeUnprocessedAds('account-1')).toBe(0)
    expect(state.rows[0].ai_analysis).toEqual({ analysis_status: 'invalid_model_output', failed_at: expect.any(String) })
    expect(Number.isNaN(Date.parse(String((state.rows[0].ai_analysis as Record<string, unknown>).failed_at)))).toBe(false)

    const callsAfterFirstRun = model.requests.length
    expect(callsAfterFirstRun).toBe(1)
    await analyzeUnprocessedAds('account-1')
    expect(model.requests.length).toBe(callsAfterFirstRun)
  })

  it('stores the marker for a REFUSAL rather than storing the partial text or re-sending it', async () => {
    state.rows = [ad('declined', '2026-11-01T00:00:00Z')]
    state.replies = [anthropicMessage({
      content: [{ type: 'text', text: JSON.stringify(valid) }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
    })]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    expect(await analyzeUnprocessedAds('account-1')).toBe(0)
    // The refused response carried a schema-valid object; it must not be stored as an analysis.
    expect(state.rows[0].ai_analysis).toMatchObject({ analysis_status: 'invalid_model_output' })
  })

  it('stores the marker for a max-token stop, never the truncated object', async () => {
    state.rows = [ad('truncated', '2026-11-01T00:00:00Z')]
    state.replies = [anthropicText(JSON.stringify(valid), 'max_tokens')]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    expect(await analyzeUnprocessedAds('account-1')).toBe(0)
    expect(state.rows[0].ai_analysis).toMatchObject({ analysis_status: 'invalid_model_output' })
  })

  it('asks for the analysis as a JSON schema (structured output) at low effort, with the fence intact', async () => {
    state.rows = [ad('good', '2026-11-01T00:00:00Z')]
    state.replies = [JSON.stringify(valid)]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    await analyzeUnprocessedAds('account-1')
    const body = model.requests[0].body!
    const format = (body.output_config as { format: { type: string; schema: { required: string[]; additionalProperties: boolean } } }).format
    expect(format.type).toBe('json_schema')
    expect(format.schema.additionalProperties).toBe(false)
    expect([...format.schema.required].sort()).toEqual(Object.keys(valid).sort())
    expect((body.output_config as { effort: string }).effort).toBe('low')
    expect(JSON.stringify(body.messages)).toContain('<untrusted_ad>')
  })

  it('with AI off makes no request, reads no ad and stores nothing', async () => {
    useAiEnv({ AI_PROVIDER: 'none' })
    const trap = trapFetch()
    state.rows = [ad('waiting', '2026-11-01T00:00:00Z')]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    expect(await analyzeUnprocessedAds('account-1')).toBe(0)
    expect(trap.requests).toHaveLength(0)
    expect(state.orders).toHaveLength(0)
    expect(state.rows[0].ai_analysis).toBeNull()
  })

  it('stores the marker for schema-invalid output too', async () => {
    state.rows = [ad('invalid', '2026-11-01T00:00:00Z')]
    state.replies = [JSON.stringify({ ...valid, evidence_basis: 'proven' })]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    await analyzeUnprocessedAds('account-1')
    expect(state.rows[0].ai_analysis).toMatchObject({ analysis_status: 'invalid_model_output' })
  })

  it('control: a valid analysis is stored as before', async () => {
    state.rows = [ad('good', '2026-11-01T00:00:00Z')]
    state.replies = [JSON.stringify(valid)]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    expect(await analyzeUnprocessedAds('account-1')).toBe(1)
    expect(state.rows[0].ai_analysis).toEqual(valid)
  })

  it('control: a provider failure leaves the ad unprocessed so the next run retries it', async () => {
    state.rows = [ad('transient', '2026-11-01T00:00:00Z')]
    state.replies = [new Error('provider timeout')]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    await analyzeUnprocessedAds('account-1')
    expect(state.rows[0].ai_analysis).toBeNull()
  })

  it('selects the newest unprocessed ads first, deterministically', async () => {
    state.rows = [
      ad('old', '2026-09-01T00:00:00Z'),
      ad('newest', '2026-11-05T00:00:00Z'),
      ad('middle', '2026-10-01T00:00:00Z'),
    ]
    state.replies = [JSON.stringify(valid)]
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    await analyzeUnprocessedAds('account-1', 1)
    expect(state.orders[0]).toEqual({ column: 'created_at', ascending: false })
    expect(state.rows.find((row) => row.id === 'newest')?.ai_analysis).toEqual(valid)
    expect(state.rows.filter((row) => row.ai_analysis === null).map((row) => row.id).sort()).toEqual(['middle', 'old'])
  })
})

describe('diagnostic projection of the marker', () => {
  // Security review: an all-null object rendered an empty "Observed attributes" block. The marker
  // now projects like an unanalysed ad (null), which every consumer already handles.
  it('projects a failure marker to null, like an unanalysed ad, without throwing', async () => {
    const { projectCompetitorAiObservation, projectCompetitorAdRecord } = await import('@/lib/competitors/diagnostic-projection')
    const marker = { analysis_status: 'invalid_model_output', failed_at: '2026-11-07T00:00:00Z' }
    expect(projectCompetitorAiObservation(marker)).toBeNull()
    expect(projectCompetitorAiObservation(null)).toBeNull()
    expect(projectCompetitorAdRecord({ id: 'a', ai_analysis: marker }).observed_attributes).toBeNull()
  })

  it('control: a real analysis still projects its observations', async () => {
    const { projectCompetitorAiObservation, projectCompetitorAdRecord } = await import('@/lib/competitors/diagnostic-projection')
    const analysis = { angle: 'privacy', hook_type: 'question', cta_type: 'Book Now', has_price: false }
    expect(projectCompetitorAiObservation(analysis)).toMatchObject({
      angle: 'privacy', hook_type: 'question', observed_cta_type: 'Book Now', has_price: false,
    })
    expect(projectCompetitorAdRecord({ id: 'a', ai_analysis: analysis }).observed_attributes).toMatchObject({ angle: 'privacy' })
  })
})
